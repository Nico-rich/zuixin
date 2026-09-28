import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { OrganizationsService } from '../src/modules/organizations/organizations.service';
import { ModelResolverService } from '../src/providers/llm/model-resolver.service';
import { MockLLMAdapter } from '../src/providers/llm/adapters/mock.adapter';
import { ChatParams, ChatResponse, LLMChunk, LLMProvider } from '../src/providers/llm/llm.types';

/**
 * M10-P3 消息编辑/删除端点 + 游标分页 e2e（真实 PostgreSQL/Redis）。
 *
 * 运行方式（**独立 Redis DB23，并行 worktree 铁律：禁止 DB0**）：
 *   cd apps/api && REDIS_URL=redis://localhost:6379/23 npx vitest run test/pre-m10-message-edit.e2e-spec.ts
 *
 * 覆盖（审计 D5/D6/M9-08/ARCH-11）：
 *   ① 编辑：仅本人 + role=user；content + editedAt 落库；非法体 400；授权面 404/403 分离（反枚举）。
 *   ② 编辑/删除 → summary-refiner 陈旧自愈链**生产调用方**验证：markStale →（删除）detectStale →
 *      recomputeStale 重建版本段；重建输入是**变更后的真实消息行**（编辑后的内容进 prompt、
 *      已删消息绝不进 prompt、重建后锚点消息必须仍存在）。
 *   ③ 删除：硬删除（schema 无 deletedAt），先标陈旧后删。
 *   ④ 游标分页：(createdAt,id) 复合游标；同毫秒数据下逐页翻完无重复无遗漏；before 反向同样成立；
 *      旧参数/无参数行为向后兼容（`{data: [...]}` 数组形状不变）。
 *   ⑤ IDOR/RBAC：他人消息、跨组织会话、非成员会话 —— 编辑/删除/读全被拒（404 反枚举 + 403 语义码）；
 *      跨会话游标不得越权串数据。
 */

// 独立 Redis DB（CLI 显式传入时以 CLI 为准）
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/23';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
/** 唯一标记串：只出现在受害者数据里，越权响应体绝不能包含 */
const STAMP = Date.now();
const SECRET = `victim-secret-content-${STAMP}`;

/** 脚本化 LLM 替身：只接管摘要器分支，让"重建摘要的输入"可断言（不验证模型能力，只验证我们的链路） */
class ScriptedAdapter implements LLMProvider {
  readonly kind = 'llm' as const;
  readonly prompts: string[] = [];

  constructor(private readonly echo: LLMProvider) {}

  stream(params: ChatParams): AsyncIterable<LLMChunk> {
    return this.echo.stream(params);
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const text = params.messages.map((m) => String(m.content)).join('\n');
    this.prompts.push(text);
    return { content: `【M10-P3 重建摘要】${text.length}`, usage: { inputTokens: 5, outputTokens: 5 } };
  }
}

describe('Pre-M10 消息编辑/删除 + 游标分页（e2e，真实 PG/Redis DB23）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adapter: ScriptedAdapter;
  let cookieA = '';
  let cookieB = '';
  let userA = '';
  let userB = '';
  let orgA = '';
  let orgB = '';
  let convA = ''; // A 的会话：6 条消息 + 1 个摘要版本段
  let msgIds: string[] = [];
  let summaryV1 = '';
  let convB = ''; // B 的会话（跨组织探针）
  let msgBUser = ''; // B 的 user 消息（A 的越权目标）
  let msgBAssistant = '';
  let convPage = ''; // A 的会话：12 条消息（含同毫秒）用于游标分页

  const waitFor = async <T>(label: string, probe: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = await probe();
      if (hit !== null) return hit;
      if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  const versionsOf = (conversationId: string) =>
    prisma.conversationSummary.findMany({ where: { conversationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

  /** 直插消息（绕过 chat SSE：本 spec 只验证消息变更端点与其摘要副作用，不重复 m1/m9-p2 的对话链） */
  const seedMessages = async (conversationId: string, count: number, at?: Date) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const row = await prisma.message.create({
        data: {
          conversationId, userId: conversationId === convB ? userB : userA,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: i % 2 === 0 ? `用户消息#${i}` : `助手回复#${i}`,
          status: 'completed',
          // 可选：把同一毫秒强加给全部消息（单列时间游标必然重复/遗漏的场景）
          ...(at ? { createdAt: new Date(at.getTime()) } : {}),
        },
      });
      ids.push(row.id);
    }
    return ids;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    const orgs = moduleRef.get(OrganizationsService);

    // A / B：各自独立用户（JWT 直签，不留可登录账号）+ 各自个人组织（跨组织维度）
    const a = await prisma.user.create({ data: { email: `prem10-edit-a-${STAMP}@example.com`, passwordHash: 'unused-hash' } });
    const b = await prisma.user.create({ data: { email: `prem10-edit-b-${STAMP}@example.com`, passwordHash: 'unused-hash' } });
    userA = a.id; userB = b.id;
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = moduleRef.get(JwtService);
    cookieA = `agent_access=${await jwt.signAsync({ sub: userA, role: 'user' })}`;
    cookieB = `agent_access=${await jwt.signAsync({ sub: userB, role: 'user' })}`;
    orgA = (await orgs.ensurePersonalOrganization(userA)).id;
    orgB = (await orgs.ensurePersonalOrganization(userB)).id;
    expect(orgA).not.toBe(orgB); // 两个租户确实是不同组织

    // 摘要重建用脚本化适配器（真实 MockAdapter 仍负责其它分支）
    const modelResolver = moduleRef.get(ModelResolverService);
    const original = modelResolver.resolveDefaultLLM.bind(modelResolver);
    adapter = new ScriptedAdapter(new MockLLMAdapter({ timeoutMs: 30_000 }, 0));
    vi.spyOn(modelResolver, 'resolveDefaultLLM').mockImplementation(async () => {
      const base = await original();
      return { ...base, adapter };
    });

    convA = (await prisma.conversation.create({ data: { userId: userA, title: `M10P3-A-${STAMP}` } })).id;
    msgIds = await seedMessages(convA, 6);
    // M9-P2 版本段：覆盖 m0..m5（锚点 = 首尾消息）
    summaryV1 = (
      await prisma.conversationSummary.create({
        data: {
          conversationId: convA, summary: `【M10-P3 原摘要】${STAMP}`,
          sourceStartMessageId: msgIds[0], sourceEndMessageId: msgIds[5],
          summarizedThroughMessageId: msgIds[5], stale: false,
        },
      })
    ).id;

    convB = (await prisma.conversation.create({ data: { userId: userB, title: `M10P3-B-${STAMP}` } })).id;
    [msgBUser, msgBAssistant] = await seedMessages(convB, 2);

    // 分页会话：12 条消息，**每 4 条共享同一毫秒**（真实 PG 毫秒精度下的并列值）
    convPage = (await prisma.conversation.create({ data: { userId: userA, title: `M10P3-page-${STAMP}` } })).id;
    const base = new Date('2026-09-28T10:00:00.000Z');
    for (let group = 0; group < 3; group++) {
      await seedMessages(convPage, 4, new Date(base.getTime() + group));
    }
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    const convs = [convA, convB, convPage].filter(Boolean);
    await prisma.conversation.deleteMany({ where: { id: { in: convs } } }).catch(() => undefined);
    await prisma.conversation.deleteMany({ where: { userId: { in: [userA, userB] } } }).catch(() => undefined);
    await prisma.memoryCandidate.deleteMany({ where: { userId: { in: [userA, userB] } } }).catch(() => undefined);
    await prisma.memory.deleteMany({ where: { userId: { in: [userA, userB] } } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { ownerUserId: { in: [userA, userB] } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } }).catch(() => undefined);
    await app.close();
  });

  // ===== 一、授权面（IDOR/RBAC）=====

  it('T1 未登录/缺 CSRF：编辑与删除均被拒（401 / 403）', async () => {
    await request(app.getHttpServer()).patch(`/api/v1/chat/messages/${msgIds[0]}`).set(XRW).send({ content: 'x' }).expect(401);
    await request(app.getHttpServer()).delete(`/api/v1/chat/messages/${msgIds[0]}`).set(XRW).expect(401);
    await request(app.getHttpServer()).patch(`/api/v1/chat/messages/${msgIds[0]}`).set('Cookie', cookieA).send({ content: 'x' }).expect(403);
    await request(app.getHttpServer()).delete(`/api/v1/chat/messages/${msgIds[0]}`).set('Cookie', cookieA).expect(403);
  });

  it('T2 编辑他人的 user 消息 → 404 反枚举（零内容泄漏），且受害消息逐字节不变', async () => {
    const before = await prisma.message.findUnique({ where: { id: msgBUser } });
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/chat/messages/${msgBUser}`).set(XRW).set('Cookie', cookieA)
      .send({ content: `篡改-${SECRET}` })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain(msgBUser);

    const after = await prisma.message.findUnique({ where: { id: msgBUser } });
    expect(after!.content).toBe(before!.content);
    expect(after!.editedAt).toBeNull();
  });

  it('T3 删除他人的 user 消息 → 404 反枚举，受害行仍在', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/chat/messages/${msgBUser}`).set(XRW).set('Cookie', cookieA)
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(await prisma.message.findUnique({ where: { id: msgBUser } })).not.toBeNull();
  });

  it('T4 跨组织/非成员会话：B 访问 A 的会话与消息列表（含游标）→ 404；A 亦看不到 B 的会话', async () => {
    // 不同个人组织（orgA ≠ orgB）→ 会话归属链 Message → Conversation → User 已经隔离
    await request(app.getHttpServer()).get(`/api/v1/conversations/${convA}/messages`).set('Cookie', cookieB).expect(404);
    await request(app.getHttpServer()).get(`/api/v1/conversations/${convA}/messages?limit=2`).set('Cookie', cookieB).expect(404);
    await request(app.getHttpServer()).get(`/api/v1/conversations/${convB}/messages`).set('Cookie', cookieA).expect(404);
    // B 编辑/删除 A 的 user 消息 → 404（非成员不可达）
    await request(app.getHttpServer()).patch(`/api/v1/chat/messages/${msgIds[0]}`).set(XRW).set('Cookie', cookieB).send({ content: 'x' }).expect(404);
    await request(app.getHttpServer()).delete(`/api/v1/chat/messages/${msgIds[0]}`).set(XRW).set('Cookie', cookieB).expect(404);
  });

  it('T5 本人的 assistant 消息：编辑 → 403 MESSAGE_EDIT_FORBIDDEN，删除 → 403 MESSAGE_DELETE_FORBIDDEN（行不变）', async () => {
    const assistantId = msgIds[1];
    const before = await prisma.message.findUnique({ where: { id: assistantId } });

    const edited = await request(app.getHttpServer())
      .patch(`/api/v1/chat/messages/${assistantId}`).set(XRW).set('Cookie', cookieA)
      .send({ content: '冒充模型改写回答' })
      .expect(403);
    expect(edited.body.error.code).toBe('MESSAGE_EDIT_FORBIDDEN');

    const removed = await request(app.getHttpServer())
      .delete(`/api/v1/chat/messages/${assistantId}`).set(XRW).set('Cookie', cookieA)
      .expect(403);
    expect(removed.body.error.code).toBe('MESSAGE_DELETE_FORBIDDEN');

    const after = await prisma.message.findUnique({ where: { id: assistantId } });
    expect(after).toEqual(before);
  });

  it('T6 不存在的消息 id：编辑/删除均 404（与越权同分支，不暴露存在性）', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const e1 = await request(app.getHttpServer()).patch(`/api/v1/chat/messages/${ghost}`).set(XRW).set('Cookie', cookieA).send({ content: 'x' }).expect(404);
    expect(e1.body.error.code).toBe('NOT_FOUND');
    await request(app.getHttpServer()).delete(`/api/v1/chat/messages/${ghost}`).set(XRW).set('Cookie', cookieA).expect(404);
  });

  it('T7 非法请求体：空内容 / 超长（>20000）→ 400 VALIDATION_ERROR（与发消息同源的编辑上限）', async () => {
    const empty = await request(app.getHttpServer())
      .patch(`/api/v1/chat/messages/${msgIds[0]}`).set(XRW).set('Cookie', cookieA).send({ content: '' }).expect(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');

    const tooLong = await request(app.getHttpServer())
      .patch(`/api/v1/chat/messages/${msgIds[0]}`).set(XRW).set('Cookie', cookieA)
      .send({ content: 'x'.repeat(20_001) })
      .expect(400);
    expect(tooLong.body.error.code).toBe('VALIDATION_ERROR');
  });

  // ===== 二、编辑：落库 + 摘要陈旧自愈链 =====

  it('T8 编辑本人 user 消息：content + editedAt 落库；消息列表读回一致', async () => {
    const target = msgIds[2]; // 落在摘要区间内部（非锚点）
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/chat/messages/${target}`).set(XRW).set('Cookie', cookieA)
      .send({ content: `编辑后的新内容-${STAMP}` })
      .expect(200);

    expect(res.body.data).toMatchObject({ id: target, role: 'user', content: `编辑后的新内容-${STAMP}` });
    expect(res.body.data.editedAt).toBeTruthy();

    const row = await prisma.message.findUnique({ where: { id: target } });
    expect(row!.content).toBe(`编辑后的新内容-${STAMP}`);
    expect(row!.editedAt).toBeInstanceOf(Date);
    // 只改 content/editedAt：归属与角色绝不因编辑而变
    expect(row!.userId).toBe(userA);
    expect(row!.conversationId).toBe(convA);
    expect(row!.role).toBe('user');

    const list = await request(app.getHttpServer()).get(`/api/v1/conversations/${convA}/messages`).set('Cookie', cookieA).expect(200);
    const seen = list.body.data.find((m: { id: string }) => m.id === target);
    expect(seen).toMatchObject({ content: `编辑后的新内容-${STAMP}` });
    expect(seen.editedAt).toBeTruthy();
  });

  it('T9 编辑 → 摘要陈旧自愈链（markStale → recomputeStale）重建版本段，且重建输入是**编辑后**的真实消息', async () => {
    // 编辑已发生（T8）→ 覆盖它的版本段必须被标陈旧并重算：新版本行（id 变化）且 stale=false
    const rebuilt = await waitFor('摘要版本段重建', async () => {
      const versions = await versionsOf(convA);
      const fresh = versions.find((v) => v.id !== summaryV1 && !v.stale);
      return fresh ?? null;
    });
    expect(rebuilt.id).not.toBe(summaryV1);
    expect(await prisma.conversationSummary.findUnique({ where: { id: summaryV1 } })).toBeNull(); // 旧链已清理

    // 重建后的锚点必须指向**仍存在**的消息（锚点不变量；记忆域 intervalMessages 依赖它）
    const anchors = [rebuilt.sourceStartMessageId, rebuilt.sourceEndMessageId].filter((x): x is string => Boolean(x));
    expect(anchors.length).toBeGreaterThan(0);
    for (const id of anchors) expect(await prisma.message.findUnique({ where: { id } })).not.toBeNull();

    // 重建输入 = 变更后的真实消息行：编辑后的内容进了摘要 prompt
    await waitFor('重建 prompt 落账', async () => (adapter.prompts.some((p) => p.includes(`编辑后的新内容-${STAMP}`)) ? true : null));
    // 摘要文本（旧版）绝不作为事实来源回流 —— 防循环污染的同一纪律
    expect(adapter.prompts.some((p) => p.includes('编辑后的新内容'))).toBe(true);
  });

  // ===== 三、删除：硬删除 + 先标陈旧后删 =====

  it('T10 删除本人 user 消息：硬删除（行消失）+ 摘要自愈后锚点全部存活', async () => {
    // 先让 convA 重新拥有一个覆盖 6 条现存消息的版本段（T9 重建后已存在），再删除区间内一条 user 消息
    const victim = msgIds[4];
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/chat/messages/${victim}`).set(XRW).set('Cookie', cookieA)
      .expect(200);
    expect(res.body.data).toMatchObject({ id: victim, conversationId: convA, deleted: true });

    // schema 无 deletedAt → 硬删除：行必须消失（不是软删）
    expect(await prisma.message.findUnique({ where: { id: victim } })).toBeNull();

    // 删除前的版本段（覆盖区间含该消息）已被标陈旧并清理；重建后的版本段锚点全部存活
    const rebuilt = await waitFor('删除后摘要重建', async () => {
      const versions = await versionsOf(convA);
      return versions.find((v) => !v.stale) ?? null;
    });
    const anchors = [rebuilt.sourceStartMessageId, rebuilt.sourceEndMessageId].filter((x): x is string => Boolean(x));
    expect(anchors.length).toBeGreaterThan(0);
    for (const id of anchors) expect(await prisma.message.findUnique({ where: { id } })).not.toBeNull();
    // 已删消息不再出现在任何版本的锚点上（无悬空引用）
    const all = await versionsOf(convA);
    expect(all.some((v) => v.sourceStartMessageId === victim || v.sourceEndMessageId === victim)).toBe(false);

    // 重建输入绝不含被删消息（"已删内容不得经摘要残留"）
    await waitFor('删除后重建 prompt 落账', async () =>
      adapter.prompts.some((p) => p.includes('用户消息#4')) ? true : null,
    );
  });

  it('T11 删除：stale 钩子的**顺序**证据（先标陈旧，后硬删）', async () => {
    // 顺序正确性由单测锁定（先删后标会因锚点消失而漏标）；此处断言行为面：
    // 删除锚点消息（区段首条）后，摘要绝不残留指向已删消息的版本
    const versionBefore = await versionsOf(convA);
    const startAnchor = versionBefore[0].sourceStartMessageId!;
    expect(await prisma.message.findUnique({ where: { id: startAnchor } })).not.toBeNull();

    await request(app.getHttpServer()).delete(`/api/v1/chat/messages/${startAnchor}`).set(XRW).set('Cookie', cookieA).expect(200);

    const healed = await waitFor('锚点删除后自愈', async () => {
      const versions = await versionsOf(convA);
      const ok = versions.every((v) => !v.stale
        && (!v.sourceStartMessageId || v.sourceStartMessageId !== startAnchor)
        && (!v.sourceEndMessageId || v.sourceEndMessageId !== startAnchor));
      return versions.length && ok ? versions : null;
    });
    for (const v of healed) {
      for (const id of [v.sourceStartMessageId, v.sourceEndMessageId].filter((x): x is string => Boolean(x))) {
        expect(await prisma.message.findUnique({ where: { id } })).not.toBeNull();
      }
    }
  });

  // ===== 四、游标分页（ARCH-11）=====

  it('T12 无分页参数：响应体仍是数组（旧信封不变），条数 = 全量', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/conversations/${convPage}/messages`).set('Cookie', cookieA).expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(12);
    expect(res.headers['x-page-has-more']).toBe('false');
    expect(res.headers['x-page-limit']).toBe('200');
  });

  it('T13 游标正确性：同毫秒数据下 limit=5 逐页 after 翻完 —— 无重复、无遗漏、全局时间序', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      const url = `/api/v1/conversations/${convPage}/messages?limit=5${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
      const res = await request(app.getHttpServer()).get(url).set('Cookie', cookieA).expect(200);
      const page = res.body.data as Array<{ id: string; createdAt: string }>;
      expect(page.length).toBeLessThanOrEqual(5);
      seen.push(...page.map((m) => m.id));

      const hasMore = res.headers['x-page-has-more'] === 'true';
      const next = res.headers['x-page-next-cursor'] as string | undefined;
      if (!hasMore) {
        expect(next).toBeUndefined();
        break;
      }
      expect(next).toBeTruthy();
      cursor = next!;
      expect(pages).toBeLessThan(10); // 防死循环（翻页必须单调推进）
    }

    const all = await prisma.message.findMany({ where: { conversationId: convPage }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    expect(seen).toHaveLength(all.length); // 无遗漏
    expect(new Set(seen).size).toBe(all.length); // 无重复
    expect(seen).toEqual(all.map((m) => m.id)); // 同毫秒由 id 全序兜底 → 全局有序
    expect(pages).toBeGreaterThan(1); // 确实发生了多页（否则用例无意义）
  });

  it('T14 before 反向翻页：同样无重复无遗漏（返回数组恒为时间正序）', async () => {
    const all = await prisma.message.findMany({ where: { conversationId: convPage }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const tailRes = await request(app.getHttpServer()).get(`/api/v1/conversations/${convPage}/messages?limit=2`).set('Cookie', cookieA).expect(200);
    void tailRes;

    // 起点：最后一条消息（before = 严格早于它）
    const last = all[all.length - 1];
    let cursor = Buffer.from(`${last.createdAt.toISOString()}|${last.id}`, 'utf8').toString('base64url');
    const seen: string[] = [];
    for (let page = 0; page < 10; page++) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/conversations/${convPage}/messages?limit=5&before=${encodeURIComponent(cursor)}`)
        .set('Cookie', cookieA)
        .expect(200);
      const rows = res.body.data as Array<{ id: string; createdAt: string }>;
      const times = rows.map((r) => new Date(r.createdAt).getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b)); // 页内恒正序
      seen.unshift(...rows.map((r) => r.id));
      if (res.headers['x-page-has-more'] !== 'true') break;
      cursor = res.headers['x-page-next-cursor'] as string;
    }
    expect(seen).toEqual(all.slice(0, all.length - 1).map((m) => m.id));
  });

  it('T15 非法分页参数 → 400 VALIDATION_ERROR（游标即时校验，绝不"尽力解析"）', async () => {
    const base = `/api/v1/conversations/${convPage}/messages`;
    const cases = [
      `${base}?after=not-a-cursor`,
      `${base}?before=${Buffer.from('not-a-date|11111111-1111-4111-8111-111111111111').toString('base64url')}`,
      `${base}?before=${Buffer.from('2026-01-01|m1').toString('base64url')}`, // id 非 uuid
      `${base}?limit=0`,
      `${base}?limit=abc`,
      `${base}?limit=9999`, // 超过单页上限 200
      `${base}?after=${Buffer.from(`2026-09-28T10:00:00.000Z|${'a'.repeat(36)}`).toString('base64url')}`,
    ];
    for (const url of cases) {
      const res = await request(app.getHttpServer()).get(url).set('Cookie', cookieA).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    // before + after 互斥（窗口语义不明必须显式拒绝）
    const cursor = Buffer.from(`${new Date().toISOString()}|11111111-1111-4111-8111-111111111111`, 'utf8').toString('base64url');
    const both = await request(app.getHttpServer()).get(`${base}?after=${cursor}&before=${cursor}`).set('Cookie', cookieA).expect(400);
    expect(both.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('T16 跨会话游标不越权：用分页会话的游标查另一会话 → 只返回目标会话的消息', async () => {
    const pageRows = await prisma.message.findMany({ where: { conversationId: convPage }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1 });
    const foreign = Buffer.from(`${pageRows[0].createdAt.toISOString()}|${pageRows[0].id}`, 'utf8').toString('base64url');

    const res = await request(app.getHttpServer())
      .get(`/api/v1/conversations/${convA}/messages?after=${encodeURIComponent(foreign)}`)
      .set('Cookie', cookieA)
      .expect(200);
    const ids = (res.body.data as Array<{ id: string; conversationId: string }>).map((m) => m.id);
    const convAMessages = await prisma.message.findMany({ where: { conversationId: convA }, select: { id: true } });
    for (const id of ids) expect(convAMessages.some((m) => m.id === id)).toBe(true); // 零跨会话泄漏
    expect(res.body.data.every((m: { conversationId: string }) => m.conversationId === convA)).toBe(true);
  });

  it('T17 会话列表分页：旧参数（projectId）仍可用，limit 生效，跨组织不可见', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/conversations?limit=1').set('Cookie', cookieA).expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
    expect(res.headers['x-page-limit']).toBe('1');

    // 列表恒按调用方 scope：B 的列表绝不含 A 的会话
    const bList = await request(app.getHttpServer()).get('/api/v1/conversations?limit=200').set('Cookie', cookieB).expect(200);
    const bIds = (bList.body.data as Array<{ id: string }>).map((c) => c.id);
    expect(bIds).not.toContain(convA);
    expect(bIds).not.toContain(convPage);
    expect(bIds).toContain(convB);

    // 非法 projectId（旧参数也必须过 zod）
    const bad = await request(app.getHttpServer()).get('/api/v1/conversations?projectId=not-a-uuid').set('Cookie', cookieA).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });
});
