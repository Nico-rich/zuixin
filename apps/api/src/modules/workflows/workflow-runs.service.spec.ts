import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowRunsService } from './workflow-runs.service';

const WF = 'wf-1';
const USER = 'u-1';
const V1_DEF = { triggers: [{ type: 'manual' }], steps: [{ id: 'v1-step', type: 'output' }] };
const V2_DEF = { triggers: [{ type: 'manual' }], steps: [{ id: 'v2-step', type: 'output' }] };
const PUBLISHED_V1 = { id: 'ver-1', version: 1, status: 'published', definition: V1_DEF };

function make(opts: { existingRun?: Record<string, unknown> | null; version?: Record<string, unknown>; run?: Record<string, unknown> } = {}) {
  const prisma = {
    workflow: { findFirst: vi.fn(async () => ({ id: WF, userId: USER, projectId: 'p-1' })) },
    // 显式返回类型：`mockResolvedValueOnce(null)`（未发布/无版本分支）需要它
    workflowVersion: { findFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => opts.version ?? PUBLISHED_V1) },
    workflowRun: {
      findFirst: vi.fn(async () => opts.existingRun ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: data.id as string, status: data.status as string, ...data,
        ...(opts.run ?? {}),
      })),
    },
  };
  const queue = { name: 'workflow', add: vi.fn(async () => ({ id: 'job-1' })) };
  const events = { publish: vi.fn(async () => undefined) };
  const audit = { write: vi.fn(async () => undefined) };
  const billing = { recordUsage: vi.fn(async () => undefined) };
  const quota = { assertQuota: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
  const svc = new WorkflowRunsService(
    prisma as never, queue as never, events as never, audit as never, billing as never, quota as never,
  );
  return { svc, prisma, queue, audit, billing, quota };
}

beforeEach(() => vi.clearAllMocks());

/**
 * M10-P5 D4/M9-01：run 创建即写 `definitionSnapshot`。
 * createRun 是 manual/webhook/schedule/event + retry 的**唯一入口** → 一处写入即全覆盖。
 */
describe('WorkflowRunsService.createRun 定义快照（M10-P5 D4/M9-01）', () => {
  it('创建 run 时写入该版本的**定义副本**（快照 = 执行期的权威来源，与 versionId 同一时刻锁定）', async () => {
    const { svc, prisma, queue, quota } = make();
    await svc.createRun(USER, { workflowId: WF, triggerType: 'manual', idempotencyKey: 'k-1' });
    const data = prisma.workflowRun.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.versionId).toBe('ver-1');
    expect(data.definitionSnapshot).toEqual(V1_DEF); // 深拷贝意义上的副本（同一 JSON 值）
    expect(data.status).toBe('queued');
    expect(data.triggerType).toBe('manual');
    expect(quota.assertQuota).toHaveBeenCalledWith(USER, undefined, 'workflow_run', 1, data.id);
    expect(queue.add).toHaveBeenCalledWith('execute', { runId: data.id }, expect.objectContaining({ jobId: `wf-${data.id}` }));
  });

  it('四种触发（manual/webhook/schedule/event）都经同一入口 → 都带快照', async () => {
    for (const triggerType of ['manual', 'webhook', 'schedule', 'event'] as const) {
      const { svc, prisma } = make();
      await svc.createRun(USER, { workflowId: WF, triggerType, idempotencyKey: `k-${triggerType}` });
      const data = prisma.workflowRun.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.definitionSnapshot, `${triggerType} 触发必须写快照`).toEqual(V1_DEF);
      expect(data.triggerType).toBe(triggerType);
    }
  });

  it('幂等：同键已存在 → 直接返回既有 run，绝不产生第二个 run（也不再预留配额）', async () => {
    const existing = { id: 'run-old', status: 'running' };
    const { svc, prisma, quota, audit } = make({ existingRun: existing });
    await expect(svc.createRun(USER, { workflowId: WF, triggerType: 'manual', idempotencyKey: 'k-1' })).resolves.toBe(existing);
    expect(prisma.workflowRun.create).not.toHaveBeenCalled();
    expect(quota.assertQuota).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('并发同键 P2002 → 返回既有 run（部分唯一索引为最终防线）', async () => {
    const { svc, prisma } = make();
    const conflict = Object.assign(new Error('unique'), { code: 'P2002' });
    prisma.workflowRun.create
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ id: 'run-won', status: 'queued' });
    prisma.workflowRun.findFirst
      .mockResolvedValueOnce(null) // 先查：不存在
      .mockResolvedValueOnce({ id: 'run-won', status: 'queued' }); // 冲突后回查
    await expect(svc.createRun(USER, { workflowId: WF, triggerType: 'manual', idempotencyKey: 'k-1' }))
      .resolves.toMatchObject({ id: 'run-won' });
  });

  it('retry：新 run 锁定**当前最新 published 版本**的定义（绝不重新打开旧 run；attempt+1）', async () => {
    const { svc, prisma } = make({ version: { id: 'ver-2', version: 2, status: 'published', definition: V2_DEF } });
    prisma.workflowRun.findFirst.mockResolvedValueOnce({
      id: 'run-old', workflowId: WF, status: 'failed', attempt: 1, input: { a: 1 }, triggerType: 'manual',
    });
    await svc.retry(USER, 'run-old');
    const data = prisma.workflowRun.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.versionId).toBe('ver-2');
    expect(data.definitionSnapshot).toEqual(V2_DEF); // 快照与 versionId 同源同刻
    expect(data.attempt).toBe(2);
    expect(data.idempotencyKey).toBe('run-old:retry:2');
    expect('update' in prisma.workflowRun).toBe(false); // 旧 run 绝不被改写（连写入口都不存在）
  });

  it('非终态 run 不可重试；定义缺失 → 明确拒绝（版本锁定不变量）', async () => {
    const running = make();
    running.prisma.workflowRun.findFirst.mockResolvedValueOnce({ id: 'r', workflowId: WF, status: 'running', attempt: 1 });
    await expect(running.svc.retry(USER, 'r')).rejects.toMatchObject({ code: 'WORKFLOW_RUN_NOT_RETRYABLE' });

    const unpublished = make({ version: undefined });
    unpublished.prisma.workflowVersion.findFirst.mockResolvedValueOnce(null);
    await expect(unpublished.svc.createRun(USER, { workflowId: WF, triggerType: 'manual' }))
      .rejects.toMatchObject({ code: 'WORKFLOW_NOT_PUBLISHED' });
  });
});
