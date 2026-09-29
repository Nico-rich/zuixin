import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { csrfProtection } from '../src/modules/auth/csrf.middleware';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { ContextAssembler } from '../src/core/context/context-assembler';
import { ModelResolverService } from '../src/providers/llm/model-resolver.service';
import { MockLLMAdapter } from '../src/providers/llm/adapters/mock.adapter';
import { SummaryRefinerService } from '../src/core/memory/summary-refiner.service';
import { MemoryCandidateService, memoryContentHash } from '../src/core/memory/memory-candidate.service';
import { MemoryLifecycleService } from '../src/core/memory/memory-lifecycle.service';
import { lifecycleOf, MEMORY_LIFECYCLE_KEY, MEMORY_ORIGIN_KEY } from '../src/core/memory/memory-provenance';
import { ChatParams, ChatResponse, LLMChunk, LLMProvider } from '../src/providers/llm/llm.types';

const XRW = { 'X-Requested-With': 'XMLHttpRequest' };
/** 摘要文本的独占标记（真实对话行里绝不出现 → 可用于断言"摘要文本未进入提炼输入"） */
const SUMMARY_MARK = '【摘要段#';

/**
 * 真实对话轮次（刻意避开 Mock 替身的工具触发词：图/视频/方案/记住/检索……
 * 否则会走工具调用分支，跑不到纯对话摘要链路）。
 */
const ROUNDS = [
  '我们从今天开始聊长期偏好',
  '以后都用黑金配色，尺寸统一 2000×2000',
  '标题用大字报排版',
  '包装盒用哑光材质',
  '客服话术保持简洁',
  '价格区间维持在中端',
];

/**
 * 脚本化 LLM 替身：
 * - stream：委托真实 MockLLMAdapter（chat SSE 全链路行为不变）；
 * - chat：按 system prompt 分支（摘要器 / 记忆提炼器 / 其它）返回确定性内容——
 *   e2e 只验证**我们的**链路（版本链/三态/上下文注入），不验证模型能力。
 */
class ScriptedAdapter implements LLMProvider {
  readonly kind = 'llm' as const;
  readonly calls: ChatParams[] = [];
  private summarySeq = 0;
  private extractSeq = 0;

  constructor(private readonly echo: LLMProvider) {}

  stream(params: ChatParams): AsyncIterable<LLMChunk> {
    return this.echo.stream(params);
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const system = params.messages
      .filter((m) => m.role === 'system')
      .map((m) => String(m.content))
      .join('\n');
    if (system.includes('对话摘要器')) {
      this.summarySeq += 1;
      return {
        content: `${SUMMARY_MARK}${this.summarySeq}】黑金配色与 2000×2000 尺寸`,
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    }
    if (system.includes('记忆提炼器')) {
      this.extractSeq += 1;
      const n = this.extractSeq;
      return {
        content: JSON.stringify({
          memories: [
            { content: `长期偏好#${n}：黑金配色 + 2000×2000`, category: 'preference', importance: 85, confidence: 0.9 },
            { content: `待确认候选#${n}：标题排版待定`, category: 'preference', importance: 60, confidence: 0.6 },
          ],
        }),
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    }
    // M2 旧提取器（"记忆提取器"）等其它路径：空结果（不产生噪声数据）
    return { content: JSON.stringify({ memories: [] }), usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

/**
 * M9-P2 Advanced Memory e2e（真实 PG/Redis + 真实 chat SSE 全链路）。
 *
 * 覆盖：真实对话若干轮 → 达阈值生成摘要版本段 → 区间锚点/追溯 → 候选三态提炼 →
 * 自动提升 active 记忆 → 后续上下文组装注入（【对话摘要】+【用户长期记忆】）→
 * 增量第二版链上前版 → 提炼幂等 → 回滚 → 陈旧标记/重算 → 删除会话（隐私传播）→ 用户删除（FK 级联）。
 *
 * 防循环污染断言：记忆提炼的 prompt 只含真实对话行，绝不含摘要文本。
 * 独立临时用户（uuid 邮箱）+ 临时 JWT，避免与其他 e2e 套件共享 DB 数据。
 */
describe('M9-P2 Advanced Memory（增量摘要 × 候选提炼 × 上下文注入）e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let assembler: ContextAssembler;
  let summaries: SummaryRefinerService;
  let candidates: MemoryCandidateService;
  let lifecycle: MemoryLifecycleService;
  let adapter: ScriptedAdapter;
  let cookie = '';
  let userId = '';
  let orgId = '';
  let convId = '';
  /** M12-P3 用例中的"他人"用户（跨用户隔离断言后级联清除） */
  let otherUserId = '';

  const stamp = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1_000;
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
  const hoursAgo = (n: number) => new Date(Date.now() - n * 60 * 60_000);

  async function chatRound(message: string): Promise<void> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/chat')
      .set(XRW)
      .set('Cookie', cookie)
      .send(convId ? { message, conversationId: convId } : { message })
      .buffer(true)
      .parse((r: { on: (e: string, cb: (c?: Buffer) => void) => void }, cb: (err: Error | null, body?: string) => void) => {
        let s = '';
        r.on('data', (c?: Buffer) => { if (c) s += c.toString('utf8'); });
        r.on('end', () => cb(null, s));
      })
      .expect(200);
    const text = String(res.body ?? '');
    expect(text).toContain('event: message_end'); // 每轮流式正常收尾（终态必落库）
    if (!convId) {
      const m = text.match(/"conversationId":"([0-9a-f-]{36})"/);
      expect(m).toBeTruthy();
      convId = m![1];
    }
  }

  /** 轮询等待 fire-and-forget 的记忆推进（摘要/候选在 SSE 收尾后异步产生） */
  async function waitFor<T>(label: string, probe: () => Promise<T | null>, timeoutMs = 25_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = await probe();
      if (hit !== null) return hit;
      if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const versionsOf = (conversationId: string) =>
    prisma.conversationSummary.findMany({ where: { conversationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

  const messagesOf = (conversationId: string) =>
    prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, role: true, content: true },
    });

  const waitForVersions = (conversationId: string, atLeast = 1) =>
    waitFor('摘要版本行', async () => {
      const rows = await versionsOf(conversationId);
      return rows.length >= atLeast ? rows : null;
    });

  const waitForCandidates = (summaryId: string) =>
    waitFor('记忆候选行（三态）', async () => {
      const rows = await prisma.memoryCandidate.findMany({ where: { sourceSummaryId: summaryId } });
      return rows.length >= 2 ? rows : null;
    });

  beforeAll(async () => {
    process.env.MOCK_DELAY_MS = '0';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.use('/api/v1', csrfProtection);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    assembler = moduleRef.get(ContextAssembler);
    summaries = moduleRef.get(SummaryRefinerService);
    candidates = moduleRef.get(MemoryCandidateService);
    lifecycle = moduleRef.get(MemoryLifecycleService);

    const user = await prisma.user.create({
      data: { email: `m9p2-${stamp}@example.com`, passwordHash: 'unused-hash' },
    });
    userId = user.id;
    orgId = `personal-${userId}`;
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = app.get(JwtService);
    cookie = `agent_access=${await jwt.signAsync({ sub: userId, role: 'user' })}`;

    // LLM 只替换 chat 分支（保留真实 stream → chat SSE 全链路不变），其余解析字段保持生产同源
    const modelResolver = moduleRef.get(ModelResolverService);
    const original = modelResolver.resolveDefaultLLM.bind(modelResolver);
    adapter = new ScriptedAdapter(new MockLLMAdapter({ timeoutMs: 30_000 }, 0));
    vi.spyOn(modelResolver, 'resolveDefaultLLM').mockImplementation(async () => {
      const base = await original();
      return { ...base, adapter };
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (otherUserId) await prisma.user.deleteMany({ where: { id: otherUserId } }).catch(() => undefined);
    await prisma.quotaReservation.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    await prisma.usageLedgerEntry.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    await prisma.usageRecord.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.analyticsAggregate.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    await prisma.agentRun.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.conversation.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.memoryCandidate.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.memory.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.subscription.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { ownerUserId: userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    await app.close();
  });

  it('T1 真实对话 3 轮 → 达阈值生成首个摘要版本段（区间锚点/parent=null/tokenCount）', async () => {
    for (const m of ROUNDS.slice(0, 3)) await chatRound(m);
    expect(convId).toBeTruthy();

    const versions = await waitForVersions(convId);
    expect(versions).toHaveLength(1);
    const v1 = versions[0];

    const msgs = await messagesOf(convId);
    expect(msgs).toHaveLength(6); // 3 轮 × (user + assistant)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(v1.parentSummaryId).toBeNull();
    expect(v1.stale).toBe(false);
    expect(v1.sourceStartMessageId).toBe(msgs[0].id);
    expect(v1.sourceEndMessageId).toBe(msgs[5].id);
    expect(v1.summarizedThroughMessageId).toBe(msgs[5].id);
    expect(v1.summary).toContain(`${SUMMARY_MARK}1】`);
    expect(v1.tokenCount).toBeGreaterThan(0);
  });

  it('T2 摘要区间 → 候选三态提炼 → 达阈值自动提升 active 记忆（双向追溯 + 防循环）', async () => {
    const [v1] = await versionsOf(convId);
    const rows = await waitForCandidates(v1.id);
    expect(rows).toHaveLength(2);

    const active = rows.find((c) => c.status === 'active')!;
    const pending = rows.find((c) => c.status === 'candidate')!;
    expect(active.content).toContain('长期偏好#1');
    expect(active.promotedAt).toBeInstanceOf(Date);
    expect(pending.content).toContain('待确认候选#1');
    expect(pending.promotedAt).toBeNull();
    expect(rows.every((c) => c.sourceSummaryId === v1.id)).toBe(true);

    // 提升落既有 Memory 表（active）→ 进度上下文（Memory ≠ Candidate：候选表不直接进上下文）
    const memory = await prisma.memory.findFirst({ where: { userId, content: active.content } });
    expect(memory).toBeTruthy();
    expect(memory!.status).toBe('active');
    expect(memory!.scope).toBe('user'); // 会话未挂项目 → 用户级
    expect(memory!.source).toBe('extractor');
    expect(memory!.sourceMessageId).toBe(v1.sourceEndMessageId);
    expect(memory!.metadata).toMatchObject({ memoryCandidateId: active.id, sourceSummaryId: v1.id });

    // 防循环污染：提炼 prompt 只含真实对话行，绝不含摘要文本
    const extractPrompts = adapter.calls
      .filter((c) => c.messages.some((m) => String(m.content).includes('记忆提炼器')))
      .map((c) => c.messages.map((m) => String(m.content)).join('\n'));
    expect(extractPrompts.length).toBeGreaterThan(0);
    const promptText = extractPrompts.join('\n');
    expect(promptText).toContain('以后都用黑金配色，尺寸统一 2000×2000'); // 真实对话行
    expect(promptText).not.toContain(SUMMARY_MARK); // 摘要文本绝不作为提炼输入
  });

  it('T3 上下文组装：摘要块 + active 记忆注入；未提升候选不进上下文', async () => {
    const { blocks } = await assembler.assemble({ userId, conversationId: convId });

    const summary = blocks.find((b) => b.scope === 'summary');
    expect(summary).toBeTruthy();
    expect(summary!.content).toContain('【对话摘要】');
    expect(summary!.content).toContain(`${SUMMARY_MARK}1】`);
    expect(summary!.order).toBe(30);
    expect(summary!.source).toMatchObject({ version: 1 });

    const memory = blocks.find((b) => b.scope === 'user' && b.content.includes('长期偏好#1'));
    expect(memory).toBeTruthy();
    expect(memory!.content).toContain('【用户长期记忆】');

    // 候选表不是上下文数据源（candidate 未提升 → 绝不出现）
    expect(blocks.some((b) => b.content.includes('待确认候选'))).toBe(false);
    // 顺序：用户记忆(20) 在摘要(30) 之前
    expect(blocks.findIndex((b) => b.scope === 'user')).toBeLessThan(blocks.findIndex((b) => b.scope === 'summary'));
  });

  it('T4 增量：再 3 轮 → 第二版链上前版（追加不变式 + 区间不重叠 + 版本段可裁）', async () => {
    for (const m of ROUNDS.slice(3)) await chatRound(m);

    const versions = await waitForVersions(convId, 2);
    const [v1, v2] = versions;
    const msgs = await messagesOf(convId);
    expect(msgs).toHaveLength(12);

    expect(v2.parentSummaryId).toBe(v1.id);
    expect(v2.stale).toBe(false);
    expect(v2.sourceStartMessageId).toBe(msgs[6].id); // 新段起点 = 上版终点之后
    expect(v2.sourceEndMessageId).toBe(msgs[11].id);
    expect(v2.sourceStartMessageId).not.toBe(v1.sourceStartMessageId);
    expect(v2.summary.startsWith(v1.summary)).toBe(true); // 追加不变式：前版全文 + 增量段
    expect(v2.summary).toContain(`${SUMMARY_MARK}2】`);
    expect(v2.tokenCount).toBeGreaterThanOrEqual(v1.tokenCount);

    const chain = await summaries.latestUsable(convId);
    expect(chain).toMatchObject({ summaryId: v2.id, version: 2 });
    expect(chain!.segments).toHaveLength(2);
    expect(chain!.segments[0]).toBe(v1.summary);
    expect(chain!.segments[1]).toContain(`${SUMMARY_MARK}2】`);
    expect(chain!.text).toBe(v2.summary);

    // 第二版的候选同样提炼（内容去重：与第一版不同 → 各自提升，追溯指向各自摘要行）
    const v2Rows = await waitForCandidates(v2.id);
    expect(v2Rows.find((c) => c.status === 'active')!.content).toContain('长期偏好#2');
    const memory2 = await prisma.memory.findFirst({ where: { userId, content: { contains: '长期偏好#2' } } });
    expect(memory2!.metadata).toMatchObject({ sourceSummaryId: v2.id });
  });

  it('T5 提炼幂等：同一摘要版本重复提炼 → 跳过（不重复落库、不重复调模型）', async () => {
    const rows = await prisma.memoryCandidate.findMany({ where: { userId } });
    const summaryIds = [...new Set(rows.map((r) => r.sourceSummaryId).filter((x): x is string => Boolean(x)))];
    expect(summaryIds.length).toBeGreaterThan(0);
    const callsBefore = adapter.calls.length;
    const r = await candidates.extractFromSummary(summaryIds[0]);
    expect(r.skipped).toBe('already_extracted');
    expect(adapter.calls.length).toBe(callsBefore);
  });

  it('T6 回滚：删除最新版 → 前版恢复为 current；未提升候选清理、已提升记忆保留', async () => {
    const [v1, v2] = await versionsOf(convId);
    const r = await summaries.rollback(convId);
    expect(r.removedId).toBe(v2.id);
    expect(r.removedCandidates).toBe(1); // v2 的未提升候选被清理
    expect(r.current!.id).toBe(v1.id);

    expect(await prisma.conversationSummary.count({ where: { conversationId: convId } })).toBe(1);
    expect(await prisma.memoryCandidate.count({ where: { sourceSummaryId: v2.id, status: 'candidate' } })).toBe(0);
    expect(await prisma.memoryCandidate.count({ where: { sourceSummaryId: v2.id, status: 'active' } })).toBe(1);

    // 唯一约束已移除 → "当前摘要" = 最新版（orderBy createdAt desc + take 1），回滚后即前版
    const current = await summaries.current(convId);
    expect(current!.id).toBe(v1.id);
    expect((await summaries.latestUsable(convId))!.version).toBe(1);

    const { blocks } = await assembler.assemble({ userId, conversationId: convId });
    const summary = blocks.find((b) => b.scope === 'summary')!;
    expect(summary.content).toContain(`${SUMMARY_MARK}1】`);
    expect(summary.content).not.toContain(`${SUMMARY_MARK}2】`);
  });

  it('T7 陈旧：区间内消息被编辑/删除 → 标 stale 不进上下文 → 重算重建', async () => {
    const msgs = await messagesOf(convId);
    const editedId = msgs[2].id; // 落在 v1 覆盖区间内

    // 消息编辑/删除路径的钩子（当前无编辑端点，钩子已在服务就绪）
    expect(await summaries.markStale(convId, [editedId])).toBe(1);
    expect(await summaries.latestUsable(convId)).toBeNull();
    const before = await assembler.assemble({ userId, conversationId: convId });
    expect(before.blocks.some((b) => b.scope === 'summary')).toBe(false);

    // 真实删除被编辑消息 → 重算：删旧链 + 强制重建（不重复覆盖、不产生错位版本）
    await prisma.message.delete({ where: { id: editedId } });
    const rec = await summaries.recomputeStale(convId);
    expect(rec.removed).toBe(1);
    expect(rec.created).toHaveLength(1);

    const current = await summaries.current(convId);
    expect(current!.stale).toBe(false);
    expect(current!.summary).toContain(`${SUMMARY_MARK}3】`);
    const after = await assembler.assemble({ userId, conversationId: convId });
    expect(after.blocks.find((b) => b.scope === 'summary')!.content).toContain(`${SUMMARY_MARK}3】`);
  });

  it('T8 隐私删除传播：删除会话 → 摘要版本链与未提升候选一并清除（软删除不触发 FK 级联）', async () => {
    expect(await prisma.conversationSummary.count({ where: { conversationId: convId } })).toBeGreaterThan(0);
    const activeBefore = await prisma.memory.count({ where: { userId, status: 'active' } });

    await request(app.getHttpServer())
      .delete(`/api/v1/conversations/${convId}`)
      .set(XRW)
      .set('Cookie', cookie)
      .expect(200);

    const conv = await prisma.conversation.findUnique({ where: { id: convId } });
    expect(conv!.deletedAt).toBeInstanceOf(Date); // 软删除语义不变
    expect(await prisma.conversationSummary.count({ where: { conversationId: convId } })).toBe(0);
    // 已提升的 active 记忆是用户级长期事实（由用户在记忆管理中处置），不在会话删除的传播范围
    expect(await prisma.memory.count({ where: { userId, status: 'active' } })).toBe(activeBefore);
  });

  it('T9 用户删除：memory / memoryCandidate 随 onDelete: Cascade 清除', async () => {
    const temp = await prisma.user.create({ data: { email: `m9p2-del-${stamp}@example.com`, passwordHash: 'unused-hash' } });
    await prisma.memory.create({
      data: { userId: temp.id, scope: 'user', content: '级联校验记忆', category: 'other', importance: 50, status: 'active', source: 'manual' },
    });
    await prisma.memoryCandidate.create({
      data: { userId: temp.id, content: '级联校验候选', contentHash: 'cascade-check-hash', category: 'other', importance: 50, confidence: 0.5, status: 'candidate' },
    });
    await prisma.user.delete({ where: { id: temp.id } });
    expect(await prisma.memory.count({ where: { userId: temp.id } })).toBe(0);
    expect(await prisma.memoryCandidate.count({ where: { userId: temp.id } })).toBe(0);
  });

  // ===================== M12-P3 记忆生命周期（来源闸门 / 结果驱动 / decide 接线）=====================
  // 三条改造线在**真实 PG**上端到端跑通：
  // ① 来源可信度闸门（审计风险 2）——LLM 来源候选**即使**有成功执行证据也绝不自动升格；
  // ② outcome 驱动的提升/衰减/淘汰（证据 = 真实 AgentRun(completed) + 该 run 的成功 UsageRecord）；
  // ③ `MemoryCandidateService.decide()` 的 HTTP 接线 + 与 memories 域同口径的 IDOR 纪律。

  /** 真实"成功执行"事实链（生命周期唯一的提升证据来源；**绝不**用 Feedback 评分——表无来源列，Agent 可自打分） */
  async function successRun(uid: string, completedAt: Date): Promise<void> {
    const agent = (await prisma.agent.findFirst({ select: { id: true } }))!;
    const run = await prisma.agentRun.create({
      data: { userId: uid, agentId: agent.id, status: 'completed', startedAt: completedAt, completedAt },
    });
    await prisma.usageRecord.create({
      data: {
        userId: uid, organizationId: orgId, runId: run.id, kind: 'llm_chat', status: 'success',
        inputTokens: 10, outputTokens: 10, estimatedCost: 0, createdAt: completedAt,
      },
    });
  }

  /**
   * 校验"作为证据被写进生命周期簿记的 run"真实、成功、且**晚于参考时刻**。
   * 不断言等于某一条具体 run：证据面是"窗口内任意成功执行"，巡逻取最新命中（这本身也是语义的一部分）。
   */
  async function assertEvidenceRun(runId: unknown, uid: string, reference: Date): Promise<void> {
    expect(typeof runId).toBe('string');
    const run = (await prisma.agentRun.findUnique({ where: { id: runId as string } }))!;
    expect(run.userId).toBe(uid);
    expect(run.status).toBe('completed');
    expect(run.completedAt!.getTime()).toBeGreaterThan(reference.getTime()); // 因果：证据不早于使用/创建
  }

  const memoryById = (id: string) => prisma.memory.findUnique({ where: { id } });
  /** 错误响应可比对形状（requestId 天然不同，不属于泄漏面） */
  const errorOf = (res: { body?: { error?: { code?: string; message?: string } } }) =>
    ({ code: res.body?.error?.code, message: res.body?.error?.message });

  it('T10 decide 接线：人工裁决走 HTTP（提升落 Memory / 驳回不落）；跨用户与幽灵 id 不可区分、零写入', async () => {
    const P = '/api/v1/memories/candidates';

    // RBAC：未认证 → 401（且不泄漏"该 id 是否存在"）
    expect((await request(app.getHttpServer()).patch(`${P}/${randomUUID()}/decide`).set(XRW).send({ decision: 'active' })).status).toBe(401);
    // zod 闸门：非法 decision → 400（在任何查库之前）
    expect((await request(app.getHttpServer()).patch(`${P}/${randomUUID()}/decide`).set(XRW).set('Cookie', cookie).send({ decision: 'promote' })).status).toBe(400);

    // 跨用户 / 幽灵 id：**逐字段同形**（防枚举：绝不给越权者"存在性"信息差）+ 零写入
    otherUserId = (await prisma.user.create({ data: { email: `m9p2-other-${stamp}@example.com`, passwordHash: 'unused-hash' } })).id;
    const foreignContent = `他人候选#m12p3-${stamp}`;
    const foreign = await prisma.memoryCandidate.create({
      data: { userId: otherUserId, content: foreignContent, contentHash: memoryContentHash(foreignContent), category: 'other', importance: 50, confidence: 0.5, status: 'candidate' },
    });
    const cross = await request(app.getHttpServer()).patch(`${P}/${foreign.id}/decide`).set(XRW).set('Cookie', cookie).send({ decision: 'active' });
    const ghost = await request(app.getHttpServer()).patch(`${P}/${randomUUID()}/decide`).set(XRW).set('Cookie', cookie).send({ decision: 'active' });
    expect(cross.status).toBe(404);
    expect(ghost.status).toBe(404);
    expect(errorOf(cross)).toEqual({ code: 'NOT_FOUND', message: '记忆候选不存在' });
    expect(errorOf(ghost)).toEqual(errorOf(cross));
    expect(await prisma.memoryCandidate.findUnique({ where: { id: foreign.id } })).toMatchObject({ status: 'candidate' });
    expect(await prisma.memory.count({ where: { userId: otherUserId } })).toBe(0);

    // 列表面：只出本人的候选（集合相等 = 用户级隔离）
    const list = await request(app.getHttpServer()).get(P).set('Cookie', cookie).expect(200);
    const listed = (list.body.data as Array<{ id: string }>).map((r) => r.id).sort();
    const own = (await prisma.memoryCandidate.findMany({ where: { userId, status: 'candidate' }, select: { id: true } })).map((r) => r.id).sort();
    expect(listed).toEqual(own);
    expect(listed).not.toContain(foreign.id);

    // 人工提升：候选行 → active + 落 Memory(status=active) + 可追溯锚（**人工**裁决不受来源闸门限制——闸门的落点就是人）
    const content = `裁决-提升#m12p3-${stamp}`;
    const mine = await prisma.memoryCandidate.create({
      data: { userId, content, contentHash: memoryContentHash(content), category: 'other', importance: 70, confidence: 0.9, status: 'candidate' },
    });
    const ok = await request(app.getHttpServer()).patch(`${P}/${mine.id}/decide`).set(XRW).set('Cookie', cookie).send({ decision: 'active' }).expect(200);
    expect(ok.body.data).toMatchObject({ id: mine.id, status: 'active' });
    expect(await prisma.memoryCandidate.findUnique({ where: { id: mine.id } })).toMatchObject({ status: 'active' });
    const promoted = (await prisma.memory.findFirst({ where: { userId, content } }))!;
    expect(promoted).toMatchObject({ status: 'active', source: 'extractor', scope: 'user' });
    expect(promoted.metadata).toMatchObject({
      memoryCandidateId: mine.id,
      [MEMORY_ORIGIN_KEY]: 'extractor',
      [MEMORY_LIFECYCLE_KEY]: { promotedBy: 'human', source: 'memory-candidate' },
    });
    // 重复裁决 → 404（幂等：绝不二次提升、绝不产生第二条 Memory）
    expect((await request(app.getHttpServer()).patch(`${P}/${mine.id}/decide`).set(XRW).set('Cookie', cookie).send({ decision: 'active' })).status).toBe(404);
    expect(await prisma.memory.count({ where: { userId, content } })).toBe(1);

    // 人工驳回：候选行 → rejected；**绝不**落 Memory（驳回不是"晚点生效"）
    const rejectContent = `裁决-驳回#m12p3-${stamp}`;
    const rejectRow = await prisma.memoryCandidate.create({
      data: { userId, content: rejectContent, contentHash: memoryContentHash(rejectContent), category: 'other', importance: 50, confidence: 0.5, status: 'candidate' },
    });
    await request(app.getHttpServer()).patch(`${P}/${rejectRow.id}/decide`).set(XRW).set('Cookie', cookie).send({ decision: 'rejected' }).expect(200);
    expect(await prisma.memoryCandidate.findUnique({ where: { id: rejectRow.id } })).toMatchObject({ status: 'rejected' });
    expect(await prisma.memory.count({ where: { userId, content: rejectContent } })).toBe(0);
  });

  it('T11 来源闸门（红线条）：成功执行证据只升格人工/提炼来源候选；LLM 来源与历史无标注候选绝不自动升格', async () => {
    const createdAt = hoursAgo(3); // 已过静默期（1h），仍在回看窗口（30d）内
    const trusted = await prisma.memory.create({
      data: { userId, scope: 'user', content: `闸门-人工来源#${stamp}`, category: 'preference', importance: 60, status: 'candidate', source: 'manual', createdAt },
    });
    // LLM 经工具打分派生（feedback.submit 带 toolCallId → origin=agent）
    const llm = await prisma.memory.create({
      data: {
        userId, scope: 'user', content: `闸门-LLM来源#${stamp}`, category: 'other', importance: 60, status: 'candidate', source: 'feedback', createdAt,
        metadata: { kind: 'performance', subjectType: 'artifact', subjectId: 'a1', derivedFrom: 'feedback', [MEMORY_ORIGIN_KEY]: 'agent' },
      },
    });
    // 历史行（本次改造前落库，无显式标注）→ 无法证明来源 → 兜底最低信任
    const legacy = await prisma.memory.create({
      data: { userId, scope: 'user', content: `闸门-历史无标注#${stamp}`, category: 'other', importance: 60, status: 'candidate', source: 'feedback', createdAt },
    });
    await successRun(userId, new Date(createdAt.getTime() + 5 * 60_000)); // 三条都有"可用"证据

    const r = await lifecycle.sweep({ now: new Date(), userBudget: 2_000 });
    expect(r.promoted).toBeGreaterThanOrEqual(1);

    const trustedAfter = (await memoryById(trusted.id))!;
    expect(trustedAfter.status).toBe('active');
    const trustedLc = lifecycleOf(trustedAfter.metadata);
    expect(trustedLc.promotedBy).toBe('outcome');
    await assertEvidenceRun(trustedLc.promotedByRunId, userId, createdAt);
    // 闸门：证据齐备也不升格（LLM 来源 / 无标注历史行）
    expect((await memoryById(llm.id))!.status).toBe('candidate');
    expect((await memoryById(legacy.id))!.status).toBe('candidate');

    // 未升格的候选绝不进上下文（即便它刚被喂了"成功执行"证据）
    const conv = await prisma.conversation.create({ data: { userId, title: 'M12-P3 上下文校验' } });
    const { blocks } = await assembler.assemble({ userId, conversationId: conv.id });
    const injected = blocks.map((b) => b.content).join('\n');
    expect(injected).toContain(`闸门-人工来源#${stamp}`);
    expect(injected).not.toContain(`闸门-LLM来源#${stamp}`);
    expect(injected).not.toContain(`闸门-历史无标注#${stamp}`);
  });

  it('T12 结果驱动生命周期：验证提升 / 长期未用降级退出上下文 / 降级过期淘汰；人工恢复不被服务端无声推翻', async () => {
    const used = hoursAgo(2);
    const conv = await prisma.conversation.create({ data: { userId, title: 'M12-P3 生命周期校验' } });
    // ① 新鲜（被用过）+ 相关成功执行 → importance 上调 + 记验证锚（同一次使用只验证一次）
    const fresh = await prisma.memory.create({
      data: { userId, scope: 'user', content: `生命周期-验证提升#${stamp}`, category: 'preference', importance: 50, status: 'active', source: 'manual', lastUsedAt: used },
    });
    await successRun(userId, new Date(used.getTime() + 5 * 60_000));
    // ② 长期未用（创建与使用都在窗口外）+ importance 触地板 → 同一次巡逻即降级（退出上下文）
    const stale = await prisma.memory.create({
      data: { userId, scope: 'user', content: `生命周期-衰减降级#${stamp}`, category: 'other', importance: 30, status: 'active', source: 'manual', createdAt: daysAgo(60), lastUsedAt: daysAgo(60) },
    });
    // ③ 已被降级且 demotedAt 超出淘汰窗口、无人恢复 → 淘汰（rejected；**行保留**，绝不物理删）
    const evictable = await prisma.memory.create({
      data: {
        userId, scope: 'user', content: `生命周期-淘汰#${stamp}`, category: 'other', importance: 20, status: 'candidate', source: 'manual',
        createdAt: daysAgo(90), lastUsedAt: daysAgo(90), metadata: { [MEMORY_LIFECYCLE_KEY]: { demotedAt: daysAgo(60).toISOString(), demoteReason: 'stale' } },
      },
    });

    const r = await lifecycle.sweep({ now: new Date(), userBudget: 2_000 });
    expect(r.verified).toBeGreaterThanOrEqual(1);
    expect(r.demoted).toBeGreaterThanOrEqual(1);
    expect(r.evicted).toBeGreaterThanOrEqual(1);

    const freshAfter = (await memoryById(fresh.id))!;
    expect(freshAfter.importance).toBe(60); // 50 + 验证提升步长
    const freshLc = lifecycleOf(freshAfter.metadata);
    expect(freshLc.lastVerifiedUseAt).toBe(used.toISOString()); // 幂等锚：这次使用已被验证
    await assertEvidenceRun(freshLc.lastVerifiedRunId, userId, used);
    const staleAfter = (await memoryById(stale.id))!;
    expect(staleAfter.status).toBe('candidate'); // 已退出上下文
    expect(lifecycleOf(staleAfter.metadata)).toMatchObject({ demoteReason: 'stale' });
    expect((await memoryById(evictable.id))!.status).toBe('rejected'); // 淘汰：行保留、永久退出上下文

    // 退出上下文（对上下文组装**可见**）：降级/淘汰的内容绝不进注入
    const after = await assembler.assemble({ userId, conversationId: conv.id });
    const injected = after.blocks.map((b) => b.content).join('\n');
    expect(injected).not.toContain(`生命周期-衰减降级#${stamp}`);
    expect(injected).not.toContain(`生命周期-淘汰#${stamp}`);

    // 人工恢复（PATCH /memories/:id → active）：记 userAffirmedAt；此后服务端衰减**绝不**无声推翻人工裁决
    await request(app.getHttpServer()).patch(`/api/v1/memories/${stale.id}`).set(XRW).set('Cookie', cookie).send({ status: 'active' }).expect(200);
    const recovered = (await memoryById(stale.id))!;
    expect(recovered.status).toBe('active');
    expect(lifecycleOf(recovered.metadata)).toMatchObject({ demoteReason: 'stale' }); // 既有簿记保留（不覆盖）
    expect(typeof lifecycleOf(recovered.metadata).userAffirmedAt).toBe('string');
    const importanceAtRecovery = recovered.importance;
    await lifecycle.sweep({ now: new Date(), userBudget: 2_000 }); // lastUsedAt 仍在窗口外
    const kept = (await memoryById(stale.id))!;
    expect(kept.status).toBe('active');
    expect(kept.importance).toBe(importanceAtRecovery);
    expect(lifecycleOf(kept.metadata).decayedAt).toBeUndefined(); // 该行零写入

    // 阳性对照：人工恢复后确实回到上下文（证明上面的"不在"是降级造成，而非被注入条数上限裁掉）
    const back = await assembler.assemble({ userId, conversationId: conv.id });
    expect(back.blocks.some((b) => b.content.includes(`生命周期-衰减降级#${stamp}`))).toBe(true);
  });
});
