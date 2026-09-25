import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsageService } from './usage.service';

function makeService() {
  const prisma = {
    model: {
      findUnique: vi.fn().mockResolvedValue({ id: 'm1', inputPrice: 2, outputPrice: 6, unitPrice: 0.15 }),
    },
    usageRecord: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'ur-1', ...data })),
    },
    agentRun: {
      findUnique: vi.fn().mockResolvedValue({ userId: 'u1', project: { organizationId: 'org-proj' } }),
    },
    generationTask: {
      findUnique: vi.fn().mockResolvedValue({ userId: 'u1', runId: null }),
    },
    conversation: {
      findUnique: vi.fn().mockResolvedValue({ userId: 'u1', project: { organizationId: 'org-conv' } }),
    },
    message: {
      findUnique: vi.fn().mockResolvedValue({ conversationId: 'c1' }),
    },
  };
  const billing = { recordUsage: vi.fn().mockResolvedValue(undefined) };
  const orgs = {
    ensurePersonalOrganization: vi.fn().mockResolvedValue({ id: 'personal-u1' }),
  };
  const svc = new UsageService(prisma as never, billing as never, orgs as never);
  return { svc, prisma, billing, orgs };
}

const chatInput = (over: Record<string, unknown> = {}) => ({
  userId: 'u1', conversationId: 'c1', messageId: 'm1', providerId: 'p1', modelId: 'm1',
  inputTokens: 1000, outputTokens: 500, latencyMs: 100, status: 'success' as const,
  ...over,
});

describe('UsageService（Pre-M9 T1 组织归因 + D1 账本镜像 + R1 成本）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('T1：调用方已知 organizationId 直传写入（绝不重新解析）', async () => {
    const { svc, prisma, orgs } = makeService();
    await svc.recordChatUsage(chatInput({ organizationId: 'org-direct' }));
    expect(prisma.usageRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: 'org-direct' }),
    }));
    expect(orgs.ensurePersonalOrganization).not.toHaveBeenCalled();
  });

  it('T1：归因链——run → 项目组织（run 的 project.organizationId 优先）', async () => {
    const { svc, prisma } = makeService();
    await svc.recordChatUsage(chatInput({ runId: 'run-1' }));
    expect(prisma.usageRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: 'org-proj' }),
    }));
  });

  it('T1：归因链——conversation → 项目组织', async () => {
    const { svc, prisma } = makeService();
    await svc.recordChatUsage(chatInput({ runId: undefined }));
    expect(prisma.usageRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: 'org-conv' }),
    }));
  });

  it('T1：归因链兜底——个人组织（无 run/会话/消息关联）', async () => {
    const { svc, prisma, orgs } = makeService();
    prisma.conversation.findUnique.mockResolvedValue(null);
    await svc.recordChatUsage(chatInput({ runId: undefined }));
    expect(prisma.usageRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: 'personal-u1' }),
    }));
    expect(orgs.ensurePersonalOrganization).toHaveBeenCalledWith('u1');
  });

  it('R1：成本 = (in*inPrice + out*outPrice)/1M（模型价格目录，全库唯一计价点）', async () => {
    const { svc, prisma } = makeService();
    await svc.recordChatUsage(chatInput({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    // (1M*2 + 1M*6)/1M = 8
    expect(prisma.usageRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ estimatedCost: 8 }),
    }));
  });

  it('D1：每条 llm_chat 记录派生 llm_tokens + llm_cost 两行镜像（usageRecordId 关联 + 幂等键）', async () => {
    const { svc, billing } = makeService();
    await svc.recordChatUsage(chatInput());
    expect(billing.recordUsage).toHaveBeenCalledTimes(2);
    const calls = billing.recordUsage.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'llm_tokens', quantity: 1500, usageRecordId: 'ur-1', idempotencyKey: 'ur:ur-1:llm_tokens', organizationId: 'org-conv' }),
      expect.objectContaining({ kind: 'llm_cost', usageRecordId: 'ur-1', idempotencyKey: 'ur:ur-1:llm_cost', organizationId: 'org-conv' }),
    ]));
    expect(calls[0].quantity).toBe(1500);
    // cost = (1000*2 + 500*6)/1M = 0.005
    expect(calls[1].quantity).toBeCloseTo(0.005, 9);
  });

  it('D1：失败回合零 token → 不产生空账本行', async () => {
    const { svc, billing } = makeService();
    await svc.recordChatUsage(chatInput({ inputTokens: 0, outputTokens: 0, status: 'failed', errorCode: 'PROVIDER_TIMEOUT' }));
    expect(billing.recordUsage).not.toHaveBeenCalled();
  });

  it('D1：媒体记录派生 image_generation 镜像（失败 attempt 至少 1 单位——事实列仍记 0）', async () => {
    const { svc, prisma, billing } = makeService();
    await svc.recordMediaUsage({
      userId: 'u1', taskId: 't1', kind: 'image', providerId: 'p1', modelId: 'm1',
      imageCount: 0, videoSeconds: 0, latencyMs: 100, status: 'failed', errorCode: 'MEDIA_TASK_TIMEOUT',
    });
    expect(prisma.usageRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: 'personal-u1', imageCount: 0 }),
    }));
    expect(billing.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image_generation', quantity: 1 }));
  });
});
