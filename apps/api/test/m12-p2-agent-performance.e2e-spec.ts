import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { TaskIntent } from '@ai-agent/shared';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { AgentRegistryService } from '../src/agents/agent-registry.service';
import { AnalyticsService, periodOf } from '../src/modules/analytics/analytics.service';

/**
 * M12-P2 Agent 表现回流 e2e（真实 PostgreSQL；不起 Worker/HTTP——直接驱动服务图）：
 *
 * 闭环：真实 AgentRun 行 → AnalyticsService.refreshOrganization（真实聚合，含 byAgent 分桶）
 *       → AgentRegistryService.resolveForIntent（同一意图的**多候选**按失败率打破静态顺序）。
 *
 * 本 e2e 专门覆盖单元测试覆盖不到的**集成断层**：写入侧归因键（AgentRun.agentId = Agent 主键 id）
 * 与读取侧 slug → 主键映射（media/builtin 实例 id 为 slug）必须对齐——对不上则永远读不到表现数据、
 * 排序静默退化为静态顺序（单测里两边都是 mock，无法发现）。
 *
 * 另覆盖红线：候选集合/工具集/版本由版本配置决定，表现数据**只影响顺序**；
 * 无数据 / 样本不足 / 默认单候选映射 → 逐字回退既有静态行为（零漂移）。
 */
const intent = (): TaskIntent => ({ type: 'chat', confidence: 0.9, parameters: { prompt: '你好' } }) as unknown as TaskIntent;

describe('M12-P2 Agent 表现回流 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let analytics: AnalyticsService;
  let registry: AgentRegistryService;

  const stamp = Date.now();
  const slugBad = `m12p2-bad-${stamp}`; // 静态顺序在前（表现差）
  const slugGood = `m12p2-good-${stamp}`; // 静态顺序在后（表现好）
  let badAgentId = '';
  let goodAgentId = '';
  let userId = '';
  let orgId = '';
  let originalPolicy: unknown = null;
  let originalExists = false;
  const runIds: string[] = [];

  const seedRun = async (agentId: string, status: 'completed' | 'failed', durationMs: number): Promise<void> => {
    const now = new Date();
    const run = await prisma.agentRun.create({
      data: { userId, agentId, status, startedAt: new Date(now.getTime() - durationMs), completedAt: now, maxSteps: 8 },
      select: { id: true },
    });
    runIds.push(run.id);
  };

  const writePolicy = async (value: unknown): Promise<void> => {
    await prisma.systemSetting.upsert({
      where: { key: 'routingPolicy' },
      create: { key: 'routingPolicy', value: value as never },
      update: { value: value as never },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    analytics = moduleRef.get(AnalyticsService);
    registry = moduleRef.get(AgentRegistryService);

    // 专用用户 + 个人组织（与种子/其他 spec 隔离）
    const user = await prisma.user.create({ data: { email: `m12p2-${stamp}@example.com`, passwordHash: 'unused-hash' } });
    userId = user.id;
    const org = await prisma.organization.create({
      data: {
        id: `personal-${user.id}`, name: 'M12P2', slug: `personal-${user.id}`, isPersonal: true, ownerUserId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
      },
    });
    orgId = org.id;

    // 同一意图的两个候选（kind=custom → 通用 Loop Agent；slug 唯一）
    const makeAgent = async (slug: string, name: string): Promise<string> => {
      const agent = await prisma.agent.create({ data: { slug, name, kind: 'custom', scope: 'system', builtin: false, enabled: true } });
      const version = await prisma.agentVersion.create({
        data: { agentId: agent.id, version: 1, status: 'published', systemPrompt: `你是${name}`, tools: ['knowledge.search'], temperature: 0.7 },
      });
      await prisma.agent.update({ where: { id: agent.id }, data: { activeVersionId: version.id } });
      return agent.id;
    };
    badAgentId = await makeAgent(slugBad, 'M12P2 差助手');
    goodAgentId = await makeAgent(slugGood, 'M12P2 好助手');

    // 真实运行记录：bad = 全失败，good = 全成功（各 ≥ minSamples 终态样本）
    for (let i = 0; i < 10; i += 1) await seedRun(badAgentId, 'failed', 100);
    for (let i = 0; i < 10; i += 1) await seedRun(goodAgentId, 'completed', 200);

    // 既有 routingPolicy 备份（全量套件共享该单例配置，afterAll 必须逐字还原）
    const existing = await prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    originalPolicy = existing?.value ?? null;
    originalExists = !!existing;

    await registry.refresh(); // 载入两个新 Agent
  });

  afterAll(async () => {
    // 聚合行 organizationId 为 SetNull → 必须先删（防孤儿行污染其他 spec）
    await prisma.analyticsAggregate.deleteMany({ where: { organizationId: orgId } }).catch(() => undefined);
    await prisma.agentRunMessage.deleteMany({ where: { runId: { in: runIds } } }).catch(() => undefined);
    await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } }).catch(() => undefined);
    // AgentRun.agentId 为 Restrict → run 删净后才能删 Agent（版本随 agent 级联）
    await prisma.agent.deleteMany({ where: { id: { in: [badAgentId, goodAgentId] } } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    // 还原全局 routingPolicy（绝不给后续 spec 留自定义映射）
    if (originalExists) await writePolicy(originalPolicy).catch(() => undefined);
    else await prisma.systemSetting.deleteMany({ where: { key: 'routingPolicy' } }).catch(() => undefined);
    await app.close();
  });

  it('闭环：真实 run → 真实聚合 → 同一意图两候选按失败率打破静态顺序（归因键对齐 Agent 主键）', async () => {
    const period = periodOf(new Date());
    const refreshed = await analytics.refreshOrganization(orgId, period);
    expect(refreshed).toMatchObject({ organizationId: orgId, period });

    // 真实聚合行确实带 byAgent 分桶（与 run 表逐项一致）
    const stats = await analytics.agentMetrics({ organizationId: orgId, days: 1 });
    const byId = new Map(stats.agents.map((a) => [a.agentId, a]));
    expect(byId.get(goodAgentId)).toMatchObject({ runs: 10, completed: 10, failureRate: 0, terminal: 10 });
    expect(byId.get(badAgentId)).toMatchObject({ runs: 10, failed: 10, failureRate: 1, terminal: 10 });

    // 两条消费路径口径一致：按失败率升序 = 表现好者在前
    const ordered = [...stats.agents].sort((a, b) => a.failureRate - b.failureRate);
    expect(ordered[0]!.agentId).toBe(goodAgentId);

    // 静态顺序刻意把差候选放前 → 排序必须把它换下去
    await writePolicy({ agentMapping: { chat: [slugBad, slugGood] } });
    const picked = await registry.resolveForIntent(intent());
    expect(picked).toBe(registry.get(slugGood));
    expect(picked.id).toBe(goodAgentId); // 返回实例仍是注册表实例（候选集合不变，只是顺序）
    expect(registry.list().map((a) => a.id)).toEqual(expect.arrayContaining([badAgentId, goodAgentId]));
  });

  it('表现数据缺失（无聚合行）→ 逐字回退静态顺序（零行为漂移）', async () => {
    await prisma.analyticsAggregate.deleteMany({ where: { organizationId: orgId, kind: 'agent' } });
    expect(await analytics.agentMetrics({ organizationId: orgId, days: 1 })).toMatchObject({ agents: [] });
    expect(await registry.resolveForIntent(intent())).toBe(registry.get(slugBad)); // 映射内第一个
  });

  it('样本不足（terminal < minSamples）→ 静态顺序；policy 放开 minSamples 后立刻生效（真实配置驱动）', async () => {
    await analytics.refreshOrganization(orgId, periodOf(new Date()));
    await writePolicy({ agentMapping: { chat: [slugBad, slugGood] }, performanceRanking: { minSamples: 50 } });
    expect(await registry.resolveForIntent(intent())).toBe(registry.get(slugBad));

    await writePolicy({ agentMapping: { chat: [slugBad, slugGood] }, performanceRanking: { minSamples: 5 } });
    expect(await registry.resolveForIntent(intent())).toBe(registry.get(slugGood)); // 聚合行早已就位，改配置即生效
  });

  it('默认单候选映射（chat→general-assistant）→ 既有行为逐字不变（绝不因表现数据改选/改权限）', async () => {
    if (originalExists) await writePolicy(originalPolicy);
    else await prisma.systemSetting.deleteMany({ where: { key: 'routingPolicy' } });

    const picked = await registry.resolveForIntent(intent());
    expect(picked).toBe(registry.get('general-assistant'));
    expect(picked.id).not.toBe(goodAgentId); // 表现好的临时 Agent 绝不越权顶替默认映射
  });
});
