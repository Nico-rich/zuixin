import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventPlatformService, EventConsumer, eventChannel } from './event-platform.service';

function makeEnvelope(over: Record<string, unknown> = {}) {
  return {
    id: 'env-1', eventId: 'evt-1', eventType: 'order.created', version: 1, organizationId: 'org-1',
    projectId: null, actorId: null, aggregateType: null, aggregateId: null, payload: { n: 1 },
    occurredAt: new Date(), traceId: null, status: 'published', attempts: 0, lastError: null,
    consumedAt: null, createdAt: new Date(), ...over,
  };
}

function makeService() {
  const prisma = {
    eventEnvelope: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => makeEnvelope(data)),
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  const auth = { require: vi.fn().mockResolvedValue('owner') };
  const bus = { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn().mockResolvedValue(undefined), unsubscribe: vi.fn() };
  const svc = new EventPlatformService(prisma as never, auth as never, bus as never);
  return { svc, prisma, bus, auth };
}

describe('EventPlatformService（M8-P5 事件平台：幂等/重试/死信/重投）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publish：落库为事实 + EventBus 实时通知（表是事实，通知只是通道）', async () => {
    const { svc, prisma, bus } = makeService();
    const res = await svc.publish({ eventId: 'evt-1', eventType: 'order.created', organizationId: 'org-1', payload: { n: 1 } });
    expect(res.created).toBe(true);
    expect(res.event.status).toBe('published');
    expect(bus.publish).toHaveBeenCalledWith(eventChannel('order.created'), expect.objectContaining({ eventId: 'evt-1' }));
  });

  it('publish 幂等：P2002 → 返回已有行状态，绝不重复入库/重复通知', async () => {
    const { svc, prisma, bus } = makeService();
    prisma.eventEnvelope.create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.eventEnvelope.findUnique.mockResolvedValueOnce(makeEnvelope({ status: 'dead', attempts: 3, lastError: 'boom' }));
    const res = await svc.publish({ eventId: 'evt-1', eventType: 'order.created' });
    expect(res.created).toBe(false);
    expect(res.event.status).toBe('dead');
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('deliver：成功 → 条件更新 consumed（唯一赢家）+ consumedAt', async () => {
    const { svc, prisma } = makeService();
    prisma.eventEnvelope.findUnique.mockResolvedValue(makeEnvelope());
    const handler = vi.fn().mockResolvedValue(undefined);
    const consumer: EventConsumer = { name: 'c1', eventTypes: ['order.created'], handler };
    expect(await svc.deliver(consumer, 'evt-1')).toBe('consumed');
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt-1', attempt: 1, payload: { n: 1 } }));
    expect(prisma.eventEnvelope.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { eventId: 'evt-1', status: { in: ['published', 'failed'] } },
      data: expect.objectContaining({ status: 'consumed' }),
    }));
  });

  it('deliver：失败重试 → dead（attempts=maxAttempts + lastError）；绝不无限重试', async () => {
    const { svc, prisma } = makeService();
    prisma.eventEnvelope.findUnique.mockResolvedValue(makeEnvelope());
    const handler = vi.fn().mockRejectedValue(new Error('消费者炸了'));
    const consumer: EventConsumer = { name: 'c1', eventTypes: ['order.created'], handler, maxAttempts: 3, backoffMs: 0 };
    expect(await svc.deliver(consumer, 'evt-1')).toBe('dead');
    expect(handler).toHaveBeenCalledTimes(3);
    expect(prisma.eventEnvelope.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { eventId: 'evt-1', status: { in: ['published', 'failed'] } },
      data: expect.objectContaining({ status: 'dead', attempts: 3, lastError: '消费者炸了' }),
    }));
  });

  it('deliver：失败后重试成功 → consumed（中间态 failed 被覆盖）', async () => {
    const { svc, prisma } = makeService();
    prisma.eventEnvelope.findUnique.mockResolvedValue(makeEnvelope());
    const handler = vi.fn().mockRejectedValueOnce(new Error('第一次失败')).mockResolvedValueOnce(undefined);
    const consumer: EventConsumer = { name: 'c1', eventTypes: ['order.created'], handler, maxAttempts: 3, backoffMs: 0 };
    expect(await svc.deliver(consumer, 'evt-1')).toBe('consumed');
    expect(handler).toHaveBeenCalledTimes(2);
    const statuses = prisma.eventEnvelope.updateMany.mock.calls.map((c) => (c[0] as { data: { status: string } }).data.status);
    expect(statuses).toEqual(['failed', 'consumed']);
  });

  it('deliver 防重放：已 consumed → skipped（handler 绝不再次调用）', async () => {
    const { svc, prisma } = makeService();
    prisma.eventEnvelope.findUnique.mockResolvedValue(makeEnvelope({ status: 'consumed' }));
    const handler = vi.fn();
    expect(await svc.deliver({ name: 'c1', eventTypes: ['order.created'], handler }, 'evt-1')).toBe('skipped');
    expect(handler).not.toHaveBeenCalled();
    expect(prisma.eventEnvelope.updateMany).not.toHaveBeenCalled();
  });

  it('subscribe：按 eventType 挂通道；同名重复订阅忽略；unsubscribe 清理总线 handler', async () => {
    const { svc, bus } = makeService();
    await svc.subscribe({ name: 'c1', eventTypes: ['order.created'], handler: vi.fn() });
    await svc.subscribe({ name: 'c1', eventTypes: ['order.created'], handler: vi.fn() }); // 重复 → 忽略
    expect(bus.subscribe).toHaveBeenCalledTimes(1);
    await svc.unsubscribe('c1');
    expect(bus.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('G10 冻结：生产进程禁止注册消费者（抛 FORBIDDEN，绝不挂总线）', async () => {
    const { svc, bus } = makeService();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(svc.subscribe({ name: 'c1', eventTypes: ['order.created'], handler: vi.fn() }))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(bus.subscribe).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('G10 冻结：Coordinator 批准的显式豁免（EVENT_PLATFORM_ALLOW_SUBSCRIBE=1）才放行', async () => {
    const { svc, bus } = makeService();
    const prevEnv = process.env.NODE_ENV;
    const prevFlag = process.env.EVENT_PLATFORM_ALLOW_SUBSCRIBE;
    process.env.NODE_ENV = 'production';
    process.env.EVENT_PLATFORM_ALLOW_SUBSCRIBE = '1';
    try {
      await svc.subscribe({ name: 'c-approved', eventTypes: ['order.created'], handler: vi.fn() });
      expect(bus.subscribe).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevFlag === undefined) delete process.env.EVENT_PLATFORM_ALLOW_SUBSCRIBE;
      else process.env.EVENT_PLATFORM_ALLOW_SUBSCRIBE = prevFlag;
    }
  });

  it('G10 冻结：无消费者的事件仍幂等落库（facts 优先），仅通知通道无接收方', async () => {
    const { svc, prisma } = makeService();
    const res = await svc.publish({ eventId: 'evt-frozen', eventType: 'scheduler.job.completed', organizationId: 'org-1' });
    expect(res).toMatchObject({ created: true, consumers: 0 }); // 冻结期不做中继：行长期停留在 published
    expect(prisma.eventEnvelope.create).toHaveBeenCalledTimes(1);
    expect(res.event.status).toBe('published');
  });

  it('redeliver：dead → published（attempts 归零）+ 重新投递成功 → consumed', async () => {
    const { svc, prisma } = makeService();
    const handler = vi.fn().mockResolvedValue(undefined);
    await svc.subscribe({ name: 'c1', eventTypes: ['order.created'], handler });
    prisma.eventEnvelope.findUnique
      .mockResolvedValueOnce(makeEnvelope({ status: 'dead', attempts: 3, lastError: 'boom' })) // redeliver 入口读
      .mockResolvedValueOnce(makeEnvelope({ status: 'published', attempts: 0 }))               // deliver 读
      .mockResolvedValueOnce(makeEnvelope({ status: 'consumed', attempts: 1 }));               // 回读结果
    const res = await svc.redeliver('u1', 'evt-1');
    expect(res.redelivered).toBe(true);
    expect(res.event.status).toBe('consumed');
    expect(prisma.eventEnvelope.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { eventId: 'evt-1', status: 'dead' },
      data: expect.objectContaining({ status: 'published', attempts: 0 }),
    }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('redeliver：已 consumed → 400；非 dead（published）→ 400（不掩盖未决状态）', async () => {
    const { svc, prisma } = makeService();
    prisma.eventEnvelope.findUnique.mockResolvedValueOnce(makeEnvelope({ status: 'consumed' }));
    await expect(svc.redeliver('u1', 'evt-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    prisma.eventEnvelope.findUnique.mockResolvedValueOnce(makeEnvelope({ status: 'published' }));
    prisma.eventEnvelope.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.redeliver('u1', 'evt-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('list/deadLetterList：组织维度 + 状态过滤（成员身份经 auth 校验）', async () => {
    const { svc, prisma, auth } = makeService();
    await svc.list('u1', { organizationId: 'org-1', status: 'published', eventType: 'order.created' });
    expect(auth.require).toHaveBeenCalledWith('u1', 'org-1');
    expect(prisma.eventEnvelope.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: 'org-1', eventType: 'order.created', status: 'published' },
    }));
    await svc.deadLetterList('u1', { organizationId: 'org-1' });
    expect(prisma.eventEnvelope.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { organizationId: 'org-1', status: 'dead' },
    }));
  });
});
