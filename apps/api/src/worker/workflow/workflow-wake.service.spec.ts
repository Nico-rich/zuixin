import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { EventBusService } from '../../core/events/event-bus.service';
import { WorkflowWakeService } from './workflow-wake.service';

/**
 * M9-P4 时间窗 wait 的唤醒面（单测）：到期条件唤醒 / 早到重新武装 / 非时间等待不上手 / 终态绝不复活。
 * 不变量：判定完全依赖 DB 事实（落库期限），绝不依赖作业携带的期限，绝不提前前进。
 */
function makeService(over: {
  run?: { id: string; status: string; currentStep: number } | null;
  row?: { stepType: string; status: string; output: unknown } | null;
  wokenCount?: number;
  /** D2-04：wakeByAgentRun 的目标查询（waiting + waitingOnAgentRunId 命中的父 run） */
  wakeTarget?: { id: string } | null;
  /** D2-04：订阅后校验读到的子 run 状态（null = 行缺失） */
  child?: { status: string } | null;
} = {}) {
  const added: Array<{ data: unknown; opts: Record<string, unknown> }> = [];
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    workflowRun: {
      findUnique: vi.fn(async () => over.run ?? null),
      findFirst: vi.fn(async () => over.wakeTarget ?? null),
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return { count: over.wokenCount ?? 1 };
      }),
    },
    workflowStepRun: {
      findUnique: vi.fn(async () => over.row ?? null),
    },
    agentRun: {
      findUnique: vi.fn(async () => over.child ?? null),
    },
  };
  const queue = {
    name: 'workflow',
    add: vi.fn(async (_name: string, data: unknown, opts: Record<string, unknown>) => {
      added.push({ data, opts });
      return { id: 'job-1' };
    }),
  };
  // EventBusService 语义替身：handler 按 channel 登记在 Set（subscribe 加入 / unsubscribe 精确移除 / emit 分发）
  const handlersByChannel = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const events = {
    subscribe: vi.fn(async (channel: string, handler: (event: Record<string, unknown>) => void) => {
      if (!handlersByChannel.has(channel)) handlersByChannel.set(channel, new Set());
      handlersByChannel.get(channel)!.add(handler);
    }),
    unsubscribe: vi.fn((channel: string, handler: (event: Record<string, unknown>) => void) => {
      const set = handlersByChannel.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) handlersByChannel.delete(channel);
    }),
  };
  const emit = (channel: string, event: Record<string, unknown>) => {
    for (const h of [...(handlersByChannel.get(channel) ?? [])]) h(event);
  };
  const subscribedChannels = () => [...handlersByChannel.keys()];
  // 夹具保持裸对象（vi.fn 的 mock 面可断言/可改行为）；仅在注入点做类型转换
  const service = new WorkflowWakeService(
    prisma as unknown as PrismaService, queue as never, events as unknown as EventBusService,
  );
  return { service, added, updates, prisma, events, emit, subscribedChannels };
}

const waitingTimeRow = (untilMs: number) => ({
  stepType: 'wait', status: 'waiting', output: { kind: 'time', waitingUntil: new Date(untilMs).toISOString() },
});

describe('WorkflowWakeService.wakeByWaitDue（M9-P4 时间窗 wait 唤醒）', () => {
  it('到期：waiting → queued（条件更新 + 清 lease）+ 放行 claim（绝不复活终态）', async () => {
    const { service, updates } = makeService({
      run: { id: 'run-1', status: 'waiting', currentStep: 1 },
      row: waitingTimeRow(Date.now() - 1_000), // 已到期
    });
    expect(await service.wakeByWaitDue('run-1')).toBe(true);
    expect(updates[0]).toMatchObject({ status: 'queued', workerId: null, leaseUntil: null, heartbeatAt: null });
  });

  it('早到（未到期）：**绝不提前前进** → 不上手 + 重新武装同一 jobId 的延迟作业（去重）', async () => {
    const until = Date.now() + 60_000;
    const { service, added, updates } = makeService({
      run: { id: 'run-1', status: 'waiting', currentStep: 1 },
      row: waitingTimeRow(until),
    });
    expect(await service.wakeByWaitDue('run-1')).toBe(false);
    expect(updates).toHaveLength(0); // 绝不改状态
    expect(added).toHaveLength(1);   // 重新武装（同一期限 → 同一 jobId）
    expect((added[0].opts as { jobId: string }).jobId).toBe(`wf-run-1-wait-${until}`);
    expect((added[0].data as { kind?: string }).kind).toBe('wait-wake');
  });

  it('等待对象是审批/子 run（非时间窗 wait）→ 不上手（各自唤醒路径负责）', async () => {
    const approvals = makeService({
      run: { id: 'run-1', status: 'waiting', currentStep: 1 },
      row: { stepType: 'approval', status: 'waiting', output: null },
    });
    expect(await approvals.service.wakeByWaitDue('run-1')).toBe(false);
    expect(approvals.added).toHaveLength(0);
    const noDeadline = makeService({
      run: { id: 'run-1', status: 'waiting', currentStep: 1 },
      row: { stepType: 'wait', status: 'waiting', output: { kind: 'agent_run', childRunId: 'c1' } },
    });
    expect(await noDeadline.service.wakeByWaitDue('run-1')).toBe(false);
  });

  it('run 已非 waiting：终态绝不复活；已 queued（其他唤醒路径已置位）→ 放行 claim', async () => {
    for (const status of ['completed', 'failed', 'cancelled', 'timeout', 'running']) {
      const { service, updates } = makeService({ run: { id: 'run-1', status, currentStep: 1 } });
      expect(await service.wakeByWaitDue('run-1')).toBe(false);
      expect(updates).toHaveLength(0);
    }
    const queued = makeService({ run: { id: 'run-1', status: 'queued', currentStep: 1 } });
    expect(await queued.service.wakeByWaitDue('run-1')).toBe(true);
    expect(queued.updates).toHaveLength(0); // 无状态可改，交给 claim 裁决
    const missing = makeService({ run: null });
    expect(await missing.service.wakeByWaitDue('run-x')).toBe(false);
  });

  it('到期但条件更新 count=0（与外部终态竞争）→ 不上手（绝不重复接管）', async () => {
    const { service, added } = makeService({
      run: { id: 'run-1', status: 'waiting', currentStep: 1 },
      row: waitingTimeRow(Date.now() - 1_000),
      wokenCount: 0,
    });
    expect(await service.wakeByWaitDue('run-1')).toBe(false);
    expect(added).toHaveLength(0);
  });

  it('scheduleWaitWake：唯一 jobId 含期限 + kind=wait-wake（不投递即唤醒）', async () => {
    const { service, added } = makeService({});
    const until = Date.now() + 3_000;
    expect(await service.scheduleWaitWake('run-1', until)).toBe(true);
    expect((added[0].opts as { jobId: string }).jobId).toBe(`wf-run-1-wait-${until}`);
    expect((added[0].opts as { delay: number }).delay).toBeGreaterThanOrEqual(0);
    expect(added[0].data).toEqual({ runId: 'run-1', kind: 'wait-wake' });
  });
});

/**
 * D2-04：waiting-on-child 观察订阅的回收（对称 M10-P10 X-05 delegation）。
 * 回归靶心：原实现 `watchChildRun` 每次进入 waiting 都 `events.subscribe(agentRunChannel(childRunId), ...)`
 * 一个新闭包且终态后从不 unsubscribe——EventBusService 的 handler 表是进程内常驻结构，
 * 长驻 worker 每等待一次就残留一条闭包（内存随等待次数线性增长；同一 childRunId 重入等待还会**多份投递**）。
 * 契约：终态事件 / 订阅后校验 / 唤醒路径（含 recoverStale 兜底）→ 订阅必须消失；
 *       丢订阅绝不丢唤醒——唤醒的事实源永远是 DB 条件更新（+ recoverStale 兜底巡检）。
 */
describe('WorkflowWakeService（D2-04 子 run 订阅回收：终态/唤醒后绝不常驻）', () => {
  beforeEach(() => vi.clearAllMocks());

  const CHILD = 'child-1';
  const CHANNEL = `agent-run:${CHILD}`;

  it('终态事件到达 → **先解绑再唤醒**（总线 handler 表清空、Map 回落；唤醒照常走 DB 条件更新）', async () => {
    const { service, prisma, events, emit, subscribedChannels } = makeService({ wakeTarget: { id: 'run-1' } });
    await service.watchChildRun(CHILD);
    expect(subscribedChannels()).toEqual([CHANNEL]);
    expect(service.pendingChildSubscriptions()).toBe(1);

    emit(CHANNEL, { type: 'run.completed' });
    await vi.waitFor(() => expect(prisma.workflowRun.updateMany).toHaveBeenCalledTimes(1));
    expect(events.unsubscribe).toHaveBeenCalledWith(CHANNEL, expect.any(Function));
    expect(subscribedChannels()).toEqual([]); // 精确解绑（不是只删自己的 Map）
    expect(service.pendingChildSubscriptions()).toBe(0);
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'run-1', status: 'waiting', waitingOnAgentRunId: CHILD },
      data: expect.objectContaining({ status: 'queued', waitingOnAgentRunId: null }),
    }));
  });

  it('非终态事件（run.started/text.delta）绝不触发唤醒、订阅保留（子 run 仍在跑）', async () => {
    const { service, prisma, events, emit, subscribedChannels } = makeService({ wakeTarget: { id: 'run-1' } });
    await service.watchChildRun(CHILD);
    emit(CHANNEL, { type: 'run.started' });
    emit(CHANNEL, { type: 'text.delta', text: 'x' });
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.workflowRun.findFirst).not.toHaveBeenCalled();
    expect(events.unsubscribe).not.toHaveBeenCalled();
    expect(subscribedChannels()).toEqual([CHANNEL]);
    expect(service.pendingChildSubscriptions()).toBe(1);
  });

  it('同一 childRunId 重入等待 → 先回收旧 handler 再订阅（绝不双份投递）；终态后迟到事件不再投递', async () => {
    const { service, prisma, events, emit, subscribedChannels } = makeService({ wakeTarget: { id: 'run-1' } });
    await service.watchChildRun(CHILD);
    await service.watchChildRun(CHILD); // 重入（resume 再进 waiting）
    expect(events.unsubscribe).toHaveBeenCalledTimes(1);
    expect(service.pendingChildSubscriptions()).toBe(1);
    expect((subscribedChannels() as string[]).filter((c) => c === CHANNEL)).toHaveLength(1);

    emit(CHANNEL, { type: 'run.completed' });
    await vi.waitFor(() => expect(prisma.workflowRun.findFirst).toHaveBeenCalledTimes(1));
    emit(CHANNEL, { type: 'run.completed' }); // 迟到/重复事件
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.workflowRun.findFirst).toHaveBeenCalledTimes(1); // 绝无第二次唤醒调用
  });

  it('唤醒路径三段全回收：无 waiting 目标 / 条件更新竞争失败（count=0）/ 唤醒成功', async () => {
    const orphan = makeService({ wakeTarget: null });
    await orphan.service.watchChildRun(CHILD);
    expect(await orphan.service.wakeByAgentRun(CHILD)).toEqual({ woken: false });
    expect(orphan.service.pendingChildSubscriptions()).toBe(0); // 无人再等 → 订阅永不触发

    const raced = makeService({ wakeTarget: { id: 'run-1' }, wokenCount: 0 });
    await raced.service.watchChildRun(CHILD);
    expect(await raced.service.wakeByAgentRun(CHILD)).toEqual({ woken: false });
    expect(raced.service.pendingChildSubscriptions()).toBe(0); // 竞争失败（已被他人唤醒/终态）

    const won = makeService({ wakeTarget: { id: 'run-1' } });
    await won.service.watchChildRun(CHILD);
    expect(await won.service.wakeByAgentRun(CHILD)).toEqual({ woken: true });
    expect(won.service.pendingChildSubscriptions()).toBe(0);
  });

  it('订阅后校验：子 run 在「落 waiting」与「订阅建立」之间已终态（终态事件已发布丢失）→ 立即按 DB 事实唤醒 + 回收', async () => {
    const { service, prisma, events, subscribedChannels } = makeService({
      wakeTarget: { id: 'run-1' }, child: { status: 'completed' },
    });
    await service.watchChildRun(CHILD);
    expect(prisma.agentRun.findUnique).toHaveBeenCalledWith({ where: { id: CHILD }, select: { status: true } });
    expect(events.unsubscribe).toHaveBeenCalledWith(CHANNEL, expect.any(Function));
    expect(subscribedChannels()).toEqual([]);
    expect(service.pendingChildSubscriptions()).toBe(0);
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledTimes(1); // 绝不丢唤醒
  });

  it('订阅后校验：子 run 未终态 / 行缺失 / 查询失败 → 订阅保留（等待照常，recoverStale 兜底）', async () => {
    for (const child of [{ status: 'running' }, { status: 'queued' }, null]) {
      const { service, events } = makeService({ wakeTarget: { id: 'run-1' }, child });
      await service.watchChildRun(CHILD);
      expect(events.unsubscribe).not.toHaveBeenCalled();
      expect(service.pendingChildSubscriptions()).toBe(1);
    }
    const err = makeService({ wakeTarget: { id: 'run-1' } });
    err.prisma.agentRun.findUnique.mockRejectedValueOnce(new Error('db down'));
    await err.service.watchChildRun(CHILD); // 抖绝不冒泡（等待状态不受影响）
    expect(err.service.pendingChildSubscriptions()).toBe(1);
  });

  it('订阅建立失败（EventBus 有界订阅显式抛错）→ 绝不登记（不留"看似已订阅"的假象）', async () => {
    const { service, events, subscribedChannels } = makeService({});
    events.subscribe.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.watchChildRun(CHILD)).rejects.toThrow('redis down');
    expect(service.pendingChildSubscriptions()).toBe(0);
    expect(subscribedChannels()).toEqual([]);
  });

  it('不变量：订阅丢失（事件丢失 → 兜底巡检回收）绝不丢唤醒——wakeByAgentRun 仍按 DB 事实唤醒并投递唯一 jobId', async () => {
    const { service, prisma, added, subscribedChannels } = makeService({ wakeTarget: { id: 'run-1' } });
    await service.watchChildRun(CHILD);
    service.clearChildSubscription(CHILD); // 兜底路径/重复回收（幂等）
    service.clearChildSubscription(CHILD); // 再次调用 = no-op，绝不误删他人
    expect(subscribedChannels()).toEqual([]);
    expect(await service.wakeByAgentRun(CHILD)).toEqual({ woken: true });
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledTimes(1);
    expect(added).toHaveLength(1); // 唤醒投递照常（唯一 jobId：绝不复用创建时的键）
    expect(added[0].data).toEqual({ runId: 'run-1' });
    expect(String((added[0].opts as { jobId: string }).jobId)).toMatch(/^wf-run-1-wake-\d+$/);
  });
});
