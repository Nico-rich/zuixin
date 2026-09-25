import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthStatus, ModelType, ProviderType } from '@prisma/client';
import { RoutingService } from './routing.service';
import { CircuitBreakerService } from '../../core/circuit-breaker/circuit-breaker.service';
import { KVStore } from '../../core/circuit-breaker/kv-store.interface';
import { AppError } from '../../common/errors/app-error';

/** 内存 KV（真实熔断状态机 + 假存储：单测不依赖 Redis） */
function memoryKV() {
  const store = new Map<string, string>();
  const kv: KVStore = {
    incr: async (k) => { const n = Number(store.get(k) ?? '0') + 1; store.set(k, String(n)); return n; },
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => { store.set(k, v); },
    setNX: async (k, v) => { if (store.has(k)) return false; store.set(k, v); return true; },
    del: async (k) => { store.delete(k); },
  };
  return { kv, store };
}

let clock = 1_700_000_000_000;

function makeModel(input: {
  id: string; type?: ModelType; capabilities?: Record<string, unknown>; enabled?: boolean;
  priority?: number; inputPrice?: number; outputPrice?: number; unitPrice?: number;
}) {
  return {
    id: input.id, providerId: '', name: `name-${input.id}`, apiModelId: `api-${input.id}`,
    type: input.type ?? ModelType.llm, capabilities: input.capabilities ?? {}, contextWindow: 128000,
    inputPrice: input.inputPrice ?? 0, outputPrice: input.outputPrice ?? 0, unitPrice: input.unitPrice ?? 0,
    enabled: input.enabled ?? true, priority: input.priority ?? 100, isDefault: false,
    createdAt: new Date(), updatedAt: new Date(),
  };
}

function makeProvider(input: {
  id: string; type?: ProviderType; adapter?: string; enabled?: boolean; priority?: number;
  healthStatus?: HealthStatus; retryConfig?: unknown; models: ReturnType<typeof makeModel>[];
}) {
  return {
    id: input.id, name: `prov-${input.id}`, type: input.type ?? ProviderType.llm,
    adapter: input.adapter ?? 'mock', baseUrl: '', apiKeyEncrypted: '',
    enabled: input.enabled ?? true, priority: input.priority ?? 100, timeoutMs: 60000,
    retryConfig: (input.retryConfig ?? null) as never,
    healthStatus: input.healthStatus ?? HealthStatus.healthy, health: null,
    createdAt: new Date(), updatedAt: new Date(),
    models: input.models.map((m) => ({ ...m, providerId: input.id })),
  };
}

function makePolicy(input: {
  id: string; providerId: string; organizationId?: string | null; allow?: boolean; priority?: number;
  costCeilingPerRequest?: number | null; enabled?: boolean;
}) {
  return {
    id: input.id, organizationId: input.organizationId ?? 'org-1', providerId: input.providerId,
    allow: input.allow ?? true, priority: input.priority ?? 100,
    costCeilingPerRequest: input.costCeilingPerRequest ?? null, costCeilingMonthly: null,
    dataPolicy: null, enabled: input.enabled ?? true, createdAt: new Date(), updatedAt: new Date(),
  };
}

function makeSut(rows: {
  providers: ReturnType<typeof makeProvider>[];
  policies?: ReturnType<typeof makePolicy>[];
  capabilities?: Array<{ providerId: string; capability: string }>;
}) {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const prisma = {
    provider: {
      findMany: vi.fn(async ({ where }: { where?: { type?: { in?: string[] } } } = {}) =>
        rows.providers.filter((p) => !where?.type?.in || where.type.in.includes(p.type))),
    },
    providerCapability: { findMany: vi.fn(async () => rows.capabilities ?? []) },
    providerPolicy: { findMany: vi.fn(async () => rows.policies ?? []) },
    routingDecision: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `decision-${created.length + 1}`, ...data };
        created.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updated.push({ where, data });
        return { id: where.id, ...data };
      }),
      findMany: vi.fn(async () => []),
    },
  };
  const { kv, store } = memoryKV();
  const breaker = new CircuitBreakerService(kv, () => clock);
  const svc = new RoutingService(prisma as never, breaker);
  return { svc, prisma, breaker, store, created, updated };
}

const cheapLLM = () => makeModel({ id: 'cheap', inputPrice: 10, outputPrice: 30 });     // 0.04 / 1k+1k
const priceyLLM = () => makeModel({ id: 'pricey', inputPrice: 100, outputPrice: 100 }); // 0.2 / 1k+1k

describe('M8-P7 RoutingService（服务端 deterministic 路由）', () => {
  beforeEach(() => { clock = 1_700_000_000_000; vi.clearAllMocks(); });

  it('候选过滤：provider.enabled=false → 剔除（reasonCode=disabled），选中另一个', async () => {
    const { svc, created } = makeSut({
      providers: [
        makeProvider({ id: 'p-a', enabled: false, models: [cheapLLM()] }),
        makeProvider({ id: 'p-b', models: [priceyLLM()] }),
      ],
    });
    const r = await svc.route({ capability: 'text_generation', organizationId: 'org-1' });
    expect(r.providerId).toBe('p-b');
    const a = r.candidates.find((c) => c.providerId === 'p-a')!;
    expect(a).toMatchObject({ accepted: false, reasonCode: 'disabled', estimatedCost: 0.04 });
    expect(r.candidates.find((c) => c.providerId === 'p-b')!.reasonCode).toBe('selected');
    expect(created[0]).toMatchObject({ capability: 'text_generation', providerId: 'p-b', organizationId: 'org-1' });
  });

  it('策略 deny：组织禁止的 provider 即使最便宜也硬剔除（reasonCode=policy_deny）+ 策略按组织隔离查询', async () => {
    const { svc, prisma, created } = makeSut({
      providers: [
        makeProvider({ id: 'p-a', models: [cheapLLM()] }),
        makeProvider({ id: 'p-b', models: [priceyLLM()] }),
      ],
      policies: [makePolicy({ id: 'pol-1', providerId: 'p-a', allow: false })],
    });
    const r = await svc.route({ capability: 'text_generation', organizationId: 'org-1' });
    expect(r.providerId).toBe('p-b');
    expect(r.candidates.find((c) => c.providerId === 'p-a')).toMatchObject({ reasonCode: 'policy_deny', policyId: 'pol-1' });
    expect(r.reasonCode).toBe('policy_allow'); // “本可胜出却被策略拒绝”才是决定因素
    expect(prisma.providerPolicy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1', enabled: true } }),
    );
    expect(created[0]).toMatchObject({ reasonCode: 'policy_allow' });
  });

  it('策略 allow 优先组 + 策略优先级覆盖 provider 优先级（低值优先）', async () => {
    const { svc } = makeSut({
      providers: [
        makeProvider({ id: 'p-a', priority: 1, models: [cheapLLM()] }),
        makeProvider({ id: 'p-b', priority: 999, models: [priceyLLM()] }),
      ],
      policies: [makePolicy({ id: 'pol-b', providerId: 'p-b', allow: true, priority: 10 })],
    });
    const r = await svc.route({ capability: 'text_generation', organizationId: 'org-1' });
    expect(r.providerId).toBe('p-b');
    expect(r.policyId).toBe('pol-b');
    expect(r.reasonCode).toBe('policy_allow'); // allow 优先组决定
  });

  it('provider 优先级先于成本：优先级低者胜，即使更贵', async () => {
    const { svc } = makeSut({
      providers: [
        makeProvider({ id: 'p-a', priority: 200, models: [cheapLLM()] }),
        makeProvider({ id: 'p-b', priority: 10, models: [priceyLLM()] }),
      ],
    });
    const r = await svc.route({ capability: 'text_generation', organizationId: 'org-1' });
    expect(r.providerId).toBe('p-b');
    expect(r.reasonCode).toBe('capability_match');
  });

  it('同优先级按成本排序（低者胜）+ estimatedCost 落库 + reasonCode=cost_optimal', async () => {
    const { svc, created } = makeSut({
      providers: [
        makeProvider({ id: 'p-b', models: [priceyLLM()] }),
        makeProvider({ id: 'p-a', models: [cheapLLM()] }),
      ],
    });
    const r = await svc.route({ capability: 'text_generation' });
    expect(r.providerId).toBe('p-a');
    expect(r.estimatedCost).toBeCloseTo(0.04, 6);
    expect(r.reasonCode).toBe('cost_optimal');
    expect(created[0]).toMatchObject({ estimatedCost: 0.04, providerId: 'p-a' });
  });

  it('完全同质时按 providerId 兜底排序（确定性，与输入顺序无关）', async () => {
    const { svc } = makeSut({
      providers: [
        makeProvider({ id: 'p-z', models: [cheapLLM()] }),
        makeProvider({ id: 'p-a', models: [cheapLLM()] }),
      ],
    });
    expect((await svc.route({ capability: 'text_generation' })).providerId).toBe('p-a');
  });

  it('成本上限：估算超 policy.costCeilingPerRequest → 剔除（reasonCode=cost_ceiling）', async () => {
    const { svc } = makeSut({
      providers: [
        makeProvider({ id: 'p-a', models: [cheapLLM()] }),
        makeProvider({ id: 'p-b', models: [priceyLLM()] }),
      ],
      policies: [makePolicy({ id: 'pol-a', providerId: 'p-a', allow: true, costCeilingPerRequest: 0.01 })],
    });
    const r = await svc.route({ capability: 'text_generation', organizationId: 'org-1' });
    expect(r.providerId).toBe('p-b');
    expect(r.candidates.find((c) => c.providerId === 'p-a')).toMatchObject({ reasonCode: 'cost_ceiling', estimatedCost: 0.04 });
    expect(r.reasonCode).toBe('cost_optimal');
  });

  it('预算放大后成本上限会拒绝（budget 参与估算）', async () => {
    const { svc } = makeSut({
      providers: [makeProvider({ id: 'p-a', models: [cheapLLM()] })],
      policies: [makePolicy({ id: 'pol-a', providerId: 'p-a', costCeilingPerRequest: 0.05 })],
    });
    const ok = await svc.route({ capability: 'text_generation', organizationId: 'org-1', budget: { inputTokens: 1000, outputTokens: 1000 } });
    expect(ok.providerId).toBe('p-a');
    await expect(
      svc.route({ capability: 'text_generation', organizationId: 'org-1', budget: { inputTokens: 100_000, outputTokens: 100_000 } }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('健康过滤：healthStatus=unhealthy → 剔除（reasonCode=unhealthy）；decision 记为 health_score', async () => {
    const { svc } = makeSut({
      providers: [
        makeProvider({ id: 'p-a', healthStatus: HealthStatus.unhealthy, models: [cheapLLM()] }),
        makeProvider({ id: 'p-b', models: [priceyLLM()] }),
      ],
    });
    const r = await svc.route({ capability: 'text_generation' });
    expect(r.providerId).toBe('p-b');
    expect(r.candidates.find((c) => c.providerId === 'p-a')!.reasonCode).toBe('unhealthy');
    expect(r.reasonCode).toBe('health_score');
  });

  it('熔断 open → 剔除（reasonCode=circuit_open）；冷却后半开放行（探测）', async () => {
    const { svc, breaker } = makeSut({
      providers: [
        makeProvider({ id: 'p-a', models: [cheapLLM()] }),
        makeProvider({ id: 'p-b', models: [priceyLLM()] }),
      ],
    });
    await breaker.recordFailure('p-a', { failureThreshold: 1, cooldownSec: 60 });
    const open = await svc.route({ capability: 'text_generation' });
    expect(open.providerId).toBe('p-b');
    expect(open.candidates.find((c) => c.providerId === 'p-a')).toMatchObject({ reasonCode: 'circuit_open', breakerState: 'open' });
    expect(open.reasonCode).toBe('circuit_open');

    clock += 61_000; // 冷却结束 → half_open 允许探测
    const half = await svc.route({ capability: 'text_generation' });
    expect(half.providerId).toBe('p-a');
    expect(half.candidates.find((c) => c.providerId === 'p-a')!.breakerState).toBe('half_open');
  });

  it('能力不匹配的 provider 根本不是候选（按 Provider.type 收窄 + 模型/声明双源匹配）', async () => {
    const { svc, prisma } = makeSut({
      providers: [
        makeProvider({ id: 'p-img', type: ProviderType.image, models: [makeModel({ id: 'm-img', type: ModelType.image, unitPrice: 0.01 })] }),
        makeProvider({ id: 'p-a', models: [cheapLLM()] }),
      ],
    });
    const r = await svc.route({ capability: 'text_generation' });
    expect(r.candidates.map((c) => c.providerId)).toEqual(['p-a']);
    expect(prisma.provider.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { type: { in: ['llm'] } } }));
  });

  it('声明能力但无合格模型 → reasonCode=no_model（配置漂移可见，不静默选中）', async () => {
    const { svc } = makeSut({
      providers: [
        makeProvider({ id: 'p-a', models: [makeModel({ id: 'm-a', capabilities: { tools: true } })] }),
        makeProvider({ id: 'p-b', models: [makeModel({ id: 'm-b', capabilities: {} })] }),
      ],
      capabilities: [{ providerId: 'p-b', capability: 'function_calling' }],
    });
    const r = await svc.route({ capability: 'function_calling' });
    expect(r.providerId).toBe('p-a');
    expect(r.candidates.find((c) => c.providerId === 'p-b')).toMatchObject({ reasonCode: 'no_model', modelId: null, accepted: false });
  });

  it('function_calling/vision：llm 类型不够，必须显式声明（模型或平台声明）', async () => {
    const plain = makeSut({ providers: [makeProvider({ id: 'p-a', models: [makeModel({ id: 'm-a' })] })] });
    await expect(plain.svc.route({ capability: 'vision' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

    const declared = makeSut({
      providers: [makeProvider({ id: 'p-a', models: [makeModel({ id: 'm-a', capabilities: { vision: true, functionCalling: true } })] })],
    });
    expect((await declared.svc.route({ capability: 'vision' })).providerId).toBe('p-a');
    expect((await declared.svc.route({ capability: 'function_calling' })).providerId).toBe('p-a');
  });

  it('无可用候选 → PROVIDER_UNAVAILABLE（AppError）+ 仍写审计行（providerId=null, reasonCode=denied）', async () => {
    const { svc, created } = makeSut({
      providers: [
        makeProvider({ id: 'p-a', enabled: false, models: [cheapLLM()] }),
        makeProvider({ id: 'p-b', healthStatus: HealthStatus.unhealthy, models: [priceyLLM()] }),
      ],
    });
    await expect(svc.route({ capability: 'text_generation', organizationId: 'org-1' }))
      .rejects.toBeInstanceOf(AppError);
    await expect(svc.route({ capability: 'text_generation', organizationId: 'org-1' }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const row = created[0];
    expect(row).toMatchObject({ providerId: null, reasonCode: 'denied', capability: 'text_generation' });
    expect((row.candidates as Array<{ reasonCode: string }>).map((c) => c.reasonCode).sort()).toEqual(['disabled', 'unhealthy']);
  });

  it('回退链：首选抛错 → 自动切下一个（最多 2 次回退），决策改写为 fallback，成败喂熔断器', async () => {
    const { svc, store, updated } = makeSut({
      providers: [
        makeProvider({ id: 'p-a', models: [cheapLLM()] }),
        makeProvider({ id: 'p-b', models: [priceyLLM()] }),
      ],
    });
    const r = await svc.route({ capability: 'text_generation', runId: 'run-1' });
    expect(r.providerId).toBe('p-a');
    expect(r.chain.map((t) => t.providerId)).toEqual(['p-a', 'p-b']);

    const calls: string[] = [];
    const out = await r.invoke(async (target) => {
      calls.push(target.providerId);
      if (target.providerId === 'p-a') throw new Error('provider 500');
      return `ok:${target.apiModelId}`;
    });
    expect(calls).toEqual(['p-a', 'p-b']);
    expect(out).toBe('ok:api-pricey');
    expect(updated[0].data).toMatchObject({ providerId: 'p-b', reasonCode: 'fallback' });
    expect(store.get('cb:p-a:consecutiveFailures')).toBe('1');
    expect(store.get('cb:p-b:success')).toBe('1');
  });

  it('回退上限 2：第 4 个候选不会被调用；全失败抛最后一次错误（不静默成功）', async () => {
    const { svc, store } = makeSut({
      providers: ['p-a', 'p-b', 'p-c', 'p-d'].map((id) => makeProvider({ id, models: [cheapLLM()] })),
    });
    const r = await svc.route({ capability: 'text_generation' });
    expect(r.chain).toHaveLength(3); // 首选 + 2 回退

    const calls: string[] = [];
    await expect(r.invoke(async (target) => {
      calls.push(target.providerId);
      throw new Error(`boom:${target.providerId}`);
    })).rejects.toThrow('boom:p-c');
    expect(calls).toEqual(['p-a', 'p-b', 'p-c']);
    expect(store.get('cb:p-d:consecutiveFailures')).toBeUndefined();
  });

  it('能力不合法 → VALIDATION_ERROR（不写决策行）', async () => {
    const { svc, created } = makeSut({ providers: [] });
    await expect(svc.route({ capability: 'nope' as never })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(created).toHaveLength(0);
  });

  it('审计查询：runId + 组织集合过滤透传（只给 runId 时不越权读平台级决策）', async () => {
    const { svc, prisma } = makeSut({ providers: [] });
    await svc.listDecisions({ organizationIds: ['org-1', 'org-2'], runId: 'run-9', limit: 10 });
    expect(prisma.routingDecision.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: { in: ['org-1', 'org-2'] }, runId: 'run-9' }, take: 10,
    }));
  });

  it('决策行记录 requestId/traceId/runId/taskId（审计可回溯到调用链）', async () => {
    const { svc, created } = makeSut({ providers: [makeProvider({ id: 'p-a', models: [cheapLLM()] })] });
    await svc.route({
      capability: 'text_generation', organizationId: 'org-1',
      requestId: 'req-1', traceId: 'trace-1', runId: 'run-1', taskId: 'task-1',
    });
    expect(created[0]).toMatchObject({
      organizationId: 'org-1', requestId: 'req-1', traceId: 'trace-1', runId: 'run-1', taskId: 'task-1',
    });
  });
});
