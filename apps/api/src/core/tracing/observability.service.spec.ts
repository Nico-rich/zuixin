import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObservabilityService } from './observability.service';
import { TraceContext } from './trace-context';

function makeService() {
  const prisma = {
    metricSample: { create: vi.fn().mockResolvedValue({ id: 'm1' }), findMany: vi.fn().mockResolvedValue([]) },
    agentRun: { findUnique: vi.fn().mockResolvedValue({ userId: 'u1', project: { organizationId: 'org-1' } }) },
    workflowRun: { findUnique: vi.fn().mockResolvedValue({ userId: 'u1', workflow: { organizationId: 'org-2' } }) },
    organization: { findFirst: vi.fn().mockResolvedValue({ id: 'org-personal' }) },
  };
  const svc = new ObservabilityService(prisma as never);
  return { svc, prisma };
}

describe('ObservabilityService（M8-P3 指标采样/读取）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('recordMetric：写 MetricSample（labels + organizationId 取自 TraceContext，labels 附带 traceId）', async () => {
    const { svc, prisma } = makeService();
    await TraceContext.runWithContext({ traceId: 'trace-1', organizationId: 'org-ctx' }, async () => {
      await svc.recordMetric('request_count', 1, 'count', { method: 'GET', path: '/api/v1/projects' });
    });
    expect(prisma.metricSample.create).toHaveBeenCalledTimes(1);
    const data = prisma.metricSample.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ name: 'request_count', value: 1, unit: 'count', organizationId: 'org-ctx' });
    expect(data.labels).toMatchObject({ method: 'GET', path: '/api/v1/projects', traceId: 'trace-1' });

    // 显式 organizationId 优先于上下文；无 labels 且无上下文 → labels null
    await svc.recordMetric('queue_depth', 3, 'count', { queue: 'image' }, null);
    expect(prisma.metricSample.create.mock.calls[1][0].data).toMatchObject({ organizationId: null });
    await svc.recordMetric('error_count', 1);
    expect(prisma.metricSample.create.mock.calls[2][0].data).toMatchObject({ labels: null, organizationId: null });
  });

  it('recordMetric：写入失败仅 warn，绝不抛错（best-effort）', async () => {
    const { svc, prisma } = makeService();
    prisma.metricSample.create.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.recordMetric('request_count', 1)).resolves.toBeUndefined();
  });

  it('recordRunDuration：归属解析 run 行（agent_run → project.organizationId；workflow_run → workflow.organizationId）+ userId 标签', async () => {
    const { svc, prisma } = makeService();
    await svc.recordRunDuration('agent_run', 'run-1', 123, { outcome: 'finished' });
    expect(prisma.agentRun.findUnique).toHaveBeenCalledWith({ where: { id: 'run-1' }, select: { userId: true, project: { select: { organizationId: true } } } });
    expect(prisma.metricSample.create.mock.calls[0][0].data).toMatchObject({
      name: 'agent_run_duration_ms', value: 123, unit: 'ms', organizationId: 'org-1',
    });
    expect(prisma.metricSample.create.mock.calls[0][0].data.labels).toMatchObject({ runId: 'run-1', userId: 'u1', outcome: 'finished' });

    await svc.recordRunDuration('workflow_run', 'wf-run-1', 456);
    expect(prisma.metricSample.create.mock.calls[1][0].data).toMatchObject({ name: 'workflow_duration_ms', value: 456, organizationId: 'org-2' });
  });

  it('recordRunDuration：无 project 的 run 走个人组织兜底（与 Billing 归因同源）；run 行缺失则无组织标签', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findUnique.mockResolvedValueOnce({ userId: 'u1', project: null });
    await svc.recordRunDuration('agent_run', 'run-2', 5);
    expect(prisma.organization.findFirst).toHaveBeenCalledWith({ where: { ownerUserId: 'u1', isPersonal: true, deletedAt: null }, select: { id: true } });
    expect(prisma.metricSample.create.mock.calls[0][0].data).toMatchObject({ organizationId: 'org-personal' });

    prisma.agentRun.findUnique.mockResolvedValueOnce(null);
    await svc.recordRunDuration('agent_run', 'run-missing', 6);
    expect(prisma.metricSample.create.mock.calls[1][0].data).toMatchObject({ organizationId: null, labels: { runId: 'run-missing' } });
  });

  it('recordRunDuration：归属解析失败降级为无组织标签（采样本身不受影响）', async () => {
    const { svc, prisma } = makeService();
    prisma.agentRun.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.recordRunDuration('agent_run', 'run-x', 9)).resolves.toBeUndefined();
    expect(prisma.metricSample.create.mock.calls[0][0].data).toMatchObject({ name: 'agent_run_duration_ms', organizationId: null });
  });

  it('list：userId 首条件（labels.userId）；带 organizationId 时组织样本 ∪ 本人样本；limit 收敛到 [1,500]', async () => {
    const { svc, prisma } = makeService();
    await svc.list('u1', { name: 'request_count', limit: 9999 });
    expect(prisma.metricSample.findMany.mock.calls[0][0]).toMatchObject({ take: 500, orderBy: { sampledAt: 'desc' } });
    expect(prisma.metricSample.findMany.mock.calls[0][0].where).toMatchObject({
      AND: [{ name: 'request_count' }, { labels: { path: ['userId'], equals: 'u1' } }],
    });

    await svc.list('u1', { organizationId: 'org-1', limit: 0 });
    const second = prisma.metricSample.findMany.mock.calls[1][0];
    expect(second.take).toBe(1); // 收敛下界 1（HTTP 面由控制器把缺失/0 归一为 100）
    expect(second.where).toMatchObject({
      AND: [{ OR: [{ organizationId: 'org-1' }, { labels: { path: ['userId'], equals: 'u1' } }] }],
    });
  });
});
