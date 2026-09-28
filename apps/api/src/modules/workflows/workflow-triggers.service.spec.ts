import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpException } from '@nestjs/common';
import {
  WorkflowTriggersService, isOwnScheduleSchedulerId, ownSchedulerEntry, repeatJobKeyOf, scheduleCronsOf, scheduleSchedulerId,
} from './workflow-triggers.service';
import { matchWebhookSecret, parseWebhookSecrets, webhookSignature } from './webhook-secret';
import { WorkflowDefinition } from './workflow-types';

const WF = 'wf-1111-2222';
const OTHER_WF = 'wf-9999-8888';
const RAW_TS = String(Date.now());
const EVENT = 'evt-1';
const BODY = Buffer.from('{"a":1}', 'utf8');
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const dec = (c: string) => Buffer.from(c, 'base64').toString('utf8');

interface Row { id: string; token: string; workflowId: string; enabled: boolean; secretEncrypted: string }

function makeWebhookRow(plaintext: string, token = 'tok-1'): Row {
  return { id: 'wh-1', token, workflowId: WF, enabled: true, secretEncrypted: enc(plaintext) };
}

/**
 * `getJobSchedulers()` 的**真实形状**（BullMQ 5.81.5 实测）：条目里**没有 `id`**，调度器 id 就是 `key`。
 * 夹具必须与被测的真实数据源同形——曾用 `{id}` 夹具掩盖了"归属集合恒空 → 归档永不清理"的真实缺陷。
 * `id` 仅历史 legacy（`keyToData`）才有；`undefined` 是 md5 裸键的空洞。
 */
type SchedulerEntry = { key?: string; id?: string | null; pattern?: string } | undefined;

function make(opts: {
  webhook?: Row | null;
  schedulers?: SchedulerEntry[];
  delayed?: Array<{ id: string; data: Record<string, unknown> }>;
} = {}) {
  let webhook: Row | null = opts.webhook ?? null;
  const prisma = {
    workflowWebhook: {
      findUnique: vi.fn(async () => webhook),
      findFirst: vi.fn(async () => webhook),
      update: vi.fn(async ({ data }: { data: { secretEncrypted: string } }) => {
        webhook = { ...(webhook as Row), ...data };
        return webhook;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => { webhook = data; return data; }),
    },
    webhookDelivery: { create: vi.fn(async () => ({ id: 'del-1' })) },
    workflow: { findUnique: vi.fn(async () => ({ id: WF, userId: 'u1', projectId: null, status: 'published' })) },
  };
  const crypto = { encrypt: vi.fn((s: string) => enc(s)), decrypt: vi.fn((c: string) => dec(c)) };
  const events = { subscribe: vi.fn(async () => undefined) };
  const runs = { createRun: vi.fn(async () => ({ id: 'run-1' })) };
  // 入参显式声明：`.mock.calls[i][j]` 才可被断言（零参 mock 的 calls 元素类型是空元组）。
  const queue = {
    getJobSchedulers: vi.fn(async (_start?: number, _end?: number, _asc?: boolean) => opts.schedulers ?? []),
    getDelayed: vi.fn(async (_start?: number, _end?: number) => opts.delayed ?? []),
    upsertJobScheduler: vi.fn(async (_id: string, _repeat: { pattern: string }, _template?: unknown) => ({ id: 'job-1' })),
    removeJobScheduler: vi.fn(async (_id: string) => true),
  };
  const audit = { write: vi.fn(async (_entry: Record<string, unknown>) => undefined) };
  const svc = new WorkflowTriggersService(
    prisma as never, crypto as never, events as never, runs as never, queue as never, audit as never,
  );
  return { svc, prisma, crypto, events, runs, queue, audit, currentSecret: () => webhook?.secretEncrypted ?? null };
}

afterEach(() => { delete process.env.WEBHOOK_SECRET_GRACE_MS; });
beforeEach(() => vi.clearAllMocks());

/** M10-P5 X-06：schedule 调度器归属判定 + 多 cron 索引（纯函数） */
describe('schedule 调度器命名/归属（M10-P5 X-06）', () => {
  it('id 可寻址且**绝不误伤**其他 workflow；多 cron 用索引后缀区分', () => {
    expect(scheduleSchedulerId(WF)).toBe(`wf-sched-${WF}`);
    expect(scheduleSchedulerId(WF, 0)).toBe(`wf-sched-${WF}`);
    expect(scheduleSchedulerId(WF, 2)).toBe(`wf-sched-${WF}#2`);
    expect(isOwnScheduleSchedulerId(WF, `wf-sched-${WF}`)).toBe(true);
    expect(isOwnScheduleSchedulerId(WF, `wf-sched-${WF}#3`)).toBe(true);
    expect(isOwnScheduleSchedulerId(WF, `wf-sched-${OTHER_WF}`)).toBe(false);
    expect(isOwnScheduleSchedulerId(WF, '')).toBe(false);
    // 前缀相近但不含 `#` 分隔 → 不算归属（防"前缀撞车"误删）
    expect(isOwnScheduleSchedulerId(WF, `wf-sched-${WF}x`)).toBe(false);
  });

  it('repeatJobKeyOf：opts.repeatJobKey 优先；否则解析 jobId `repeat:<key>:<millis>`；非 repeatable → null', () => {
    expect(repeatJobKeyOf({ id: 'repeat:abc:175', opts: { repeatJobKey: 'sched-1' } })).toBe('sched-1');
    expect(repeatJobKeyOf({ id: 'repeat:md5key:1750000000000', opts: {} })).toBe('md5key');
    expect(repeatJobKeyOf({ id: `wf-1`, opts: {} })).toBeNull();
    expect(repeatJobKeyOf({ id: 'repeat:broken', opts: {} })).toBeNull();
    expect(repeatJobKeyOf({ id: null, opts: {} })).toBeNull();
  });

  it('scheduleCronsOf：只取 schedule 且 cron 非空的触发器（定义顺序 = 调度器索引顺序）', () => {
    const def: WorkflowDefinition = {
      triggers: [
        { type: 'schedule', cron: '0 9 * * 1' },
        { type: 'webhook' },
        { type: 'schedule', cron: '  ' },
        { type: 'schedule', cron: '30 10 * * 2' },
      ],
      steps: [],
    };
    expect(scheduleCronsOf(def)).toEqual(['0 9 * * 1', '30 10 * * 2']);
    expect(scheduleCronsOf({ triggers: [], steps: [] })).toEqual([]);
  });

  /**
   * **真实数据源形状**（`transformSchedulerData` 实测输出）：`{key, name, next, pattern, ...}`，**无 `id`**。
   * 若这里改用 `{id}` 夹具，归档/删除清理会"假绿"——真实环境里 `s.id` 恒为 undefined，归属集合恒空。
   */
  it('ownSchedulerEntry：id 取自 `key`（真实形状无 id）；删除句柄 = zset 成员', () => {
    const real = { key: `wf-sched-${WF}`, name: 'scheduled', next: 1, pattern: '0 9 * * 1' };
    expect(ownSchedulerEntry(real, WF)).toEqual({ id: `wf-sched-${WF}`, pattern: '0 9 * * 1' });
    expect(ownSchedulerEntry({ ...real, key: `wf-sched-${WF}#2` }, WF)).toEqual({ id: `wf-sched-${WF}#2`, pattern: '0 9 * * 1' });
    // 他人调度器 / 前缀撞车 / 空洞（md5 裸键无 hash）→ 一律不归属
    expect(ownSchedulerEntry({ key: `wf-sched-${OTHER_WF}`, pattern: '0 1 * * *' }, WF)).toBeNull();
    expect(ownSchedulerEntry({ key: `wf-sched-${WF}x`, pattern: '0 1 * * *' }, WF)).toBeNull();
    expect(ownSchedulerEntry(undefined, WF)).toBeNull();
    expect(ownSchedulerEntry({ pattern: '0 1 * * *' }, WF)).toBeNull();
    // pattern 缺失 → null（调用方按"cron 未知"处理 → 重注册而非误判为已就绪）
    expect(ownSchedulerEntry({ key: `wf-sched-${WF}` }, WF)).toEqual({ id: `wf-sched-${WF}`, pattern: null });
  });

  it('ownSchedulerEntry：legacy `keyToData` 形状（key 带冒号 + id=人类 id）→ 归属成立且删除句柄是 key', () => {
    // Pre-M10：`queue.add('scheduled', …, {jobId:'wf-sched-<wf>', repeat})` → keyToData 解析出 id
    const legacy = { key: `scheduled:wf-sched-${WF}:0::0 9 * * 1`, name: 'scheduled', id: `wf-sched-${WF}`, pattern: '0 9 * * 1' };
    const owned = ownSchedulerEntry(legacy, WF);
    expect(owned?.id).toBe(legacy.key); // 删除必须用 zset 成员本身（含冒号的 legacy key）
    expect(owned?.pattern).toBe('0 9 * * 1');
    // legacy 但不是本 workflow（id 不同、key 也不匹配）→ 不归属
    expect(ownSchedulerEntry({ ...legacy, id: `wf-sched-${OTHER_WF}`, key: `scheduled:${'ab'.repeat(16)}:0::0 1 * * *` }, WF)).toBeNull();
  });
});

/** M10-P5 X-06：schedule 重发布 = 幂等同步（注册期望 → 清理多余），失败绝不破坏既有注册 */
describe('WorkflowTriggersService.syncSchedules（M10-P5 X-06 重发布）', () => {
  it('首次发布：注册期望 cron（Job Scheduler id 稳定），无多余项可清理', async () => {
    const { svc, queue } = make();
    await svc.syncSchedules(WF, ['0 9 * * 1']);
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      `wf-sched-${WF}`, { pattern: '0 9 * * 1' },
      expect.objectContaining({ name: 'scheduled', data: { kind: 'scheduled', workflowId: WF } }),
    );
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it('幂等：cron 未变 → 不重复注册、不注销（重发布不产生第二份调度器 = X-06 根因）', async () => {
    const { svc, queue } = make({ schedulers: [{ key: `wf-sched-${WF}`, pattern: '0 9 * * 1' }] });
    await svc.syncSchedules(WF, ['0 9 * * 1']);
    await svc.syncSchedules(WF, ['0 9 * * 1']);
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it('cron 变更 → 就地更新同一调度器（旧 cron 随之失效，绝不叠加）', async () => {
    const { svc, queue } = make({ schedulers: [{ key: `wf-sched-${WF}`, pattern: '0 9 * * 1' }] });
    await svc.syncSchedules(WF, ['30 10 * * 4']);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(`wf-sched-${WF}`, { pattern: '30 10 * * 4' }, expect.anything());
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it('多 cron：索引后缀注册；多余索引与 Pre-M10 遗留 md5 调度器一并注销', async () => {
    const { svc, queue } = make({
      schedulers: [{ key: `wf-sched-${WF}#9`, pattern: '0 3 * * *' }],
      delayed: [{ id: `repeat:${'f'.repeat(32)}:1750000000000`, data: { workflowId: WF } }],
    });
    await svc.syncSchedules(WF, ['0 9 * * 1', '30 10 * * 4']);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(`wf-sched-${WF}`, { pattern: '0 9 * * 1' }, expect.anything());
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(`wf-sched-${WF}#1`, { pattern: '30 10 * * 4' }, expect.anything());
    const removed = queue.removeJobScheduler.mock.calls.map((c) => c[0]);
    expect(removed).toContain(`wf-sched-${WF}#9`);
    expect(removed).toContain('f'.repeat(32)); // 遗留 md5 键（仅靠 delayed job 归属）
    expect(removed).not.toContain(`wf-sched-${WF}`);
  });

  it('归属隔离：其他 workflow 的调度器/重复作业绝不注销', async () => {
    const { svc, queue } = make({
      schedulers: [{ key: `wf-sched-${OTHER_WF}`, pattern: '0 1 * * *' }],
      delayed: [
        { id: `repeat:${'e'.repeat(32)}:1750000000000`, data: { workflowId: OTHER_WF } },
        { id: `repeat:${'d'.repeat(32)}:1750000000000`, data: {} }, // 无 workflowId 归属 → 不碰
        { id: 'wf-run-abc', data: { runId: 'r1' } },               // 非 repeatable 延迟作业 → 不碰
      ],
    });
    await svc.syncSchedules(WF, []);
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it('失败不破坏既有注册：upsert 抛错时不注销任何东西（宁可留旧，也绝不出现零调度窗口）', async () => {
    const { svc, queue } = make({ schedulers: [{ key: `wf-sched-${WF}`, pattern: '0 9 * * 1' }] });
    queue.upsertJobScheduler.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.syncSchedules(WF, ['30 10 * * 4'])).resolves.toBeUndefined();
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.removeJobScheduler).not.toHaveBeenCalled(); // 既有注册仍在
  });

  it('期望项注册失败（原本不存在）→ 放弃清理（不让"少注册"变成"零调度"）', async () => {
    const { svc, queue } = make({
      schedulers: [{ key: `wf-sched-${WF}#7`, pattern: '0 3 * * *' }],
    });
    queue.upsertJobScheduler.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.syncSchedules(WF, ['0 9 * * 1'])).resolves.toBeUndefined();
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it('读取既有注册失败 → 只增不删（归属未知时绝不盲删）', async () => {
    const { svc, queue } = make({ delayed: [{ id: `repeat:${'c'.repeat(32)}:1`, data: { workflowId: WF } }] });
    queue.getJobSchedulers.mockRejectedValueOnce(new Error('redis timeout'));
    await svc.syncSchedules(WF, ['0 9 * * 1']);
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it('归档（cron 集合为空）= 注销全部本 workflow 调度器；registerSchedule 语义不变', async () => {
    const archived = make({
      schedulers: [{ key: `wf-sched-${WF}`, pattern: '0 9 * * 1' }, { key: `wf-sched-${WF}#1`, pattern: '0 10 * * 2' }],
    });
    await archived.svc.removeSchedule(WF);
    expect(archived.queue.removeJobScheduler.mock.calls.map((c) => c[0]).sort())
      .toEqual([`wf-sched-${WF}`, `wf-sched-${WF}#1`].sort());

    const fresh = make(); // 无既有注册 → 注册一次
    await fresh.svc.registerSchedule(WF, '0 9 * * 1');
    expect(fresh.queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
  });

  it('发布/重发布注册路径：一次同步覆盖定义里的全部 cron（cron 删除同样收敛）', async () => {
    const { svc, queue } = make({ schedulers: [{ key: `wf-sched-${WF}#1`, pattern: '0 10 * * 2' }] });
    const def: WorkflowDefinition = {
      triggers: [{ type: 'schedule', cron: '0 9 * * 1' }, { type: 'event', event: 'ch-1' }],
      steps: [{ id: 'a', type: 'output' }],
    };
    await svc.registerTriggers(WF, def);
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith(`wf-sched-${WF}#1`); // 定义里已删除的第 2 个 cron 被注销
    const archived: WorkflowDefinition = { triggers: [{ type: 'schedule', cron: '0 9 * * 1' }], steps: [] };
    queue.removeJobScheduler.mockClear();
    await svc.unregisterTriggers(WF, archived);
    // 归档 = 注销全部既有调度器（mock 中仅剩 #1 这一份）
    expect(queue.removeJobScheduler.mock.calls.map((c) => c[0])).toEqual([`wf-sched-${WF}#1`]);
  });
});

/** M10-P5 SA-18：双 secret 过渡窗（服务层接线：验签代际 + 轮换 + 审计） */
describe('WorkflowTriggersService webhook 双 secret（M10-P5 SA-18）', () => {
  const verify = (svc: WorkflowTriggersService, signature: string, eventId = EVENT) =>
    svc.verifyWebhook('tok-1', BODY, { signature, timestamp: RAW_TS, eventId });

  it('current 命中：接受（并落防重放行）', async () => {
    const { svc, prisma, currentSecret } = make({ webhook: makeWebhookRow(NEW) });
    const sig = webhookSignature(NEW, RAW_TS, EVENT, BODY);
    // M10 Final Audit H6：verifyWebhook 返回 webhookId（run 成功后投递行提升 accepted 需要）
    await expect(verify(svc, sig)).resolves.toEqual({ workflowId: WF, eventId: EVENT, webhookId: 'wh-1' });
    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    expect(currentSecret()).toBe(enc(NEW)); // 验签不写库
  });

  it('Pre-M10 遗留行（裸 secret）按 current 处理：升级前后**不误拒**', async () => {
    const { svc } = make({ webhook: makeWebhookRow(OLD) });
    await expect(verify(svc, webhookSignature(OLD, RAW_TS, EVENT, BODY))).resolves.toMatchObject({ workflowId: WF });
  });

  it('过渡窗内 previous 命中：接受（发送方有窗口切换密钥）', async () => {
    const envelope = JSON.stringify({ v: 2, current: NEW, previous: OLD, previousExpiresAt: Date.now() + 60_000 });
    const { svc } = make({ webhook: makeWebhookRow(envelope) });
    await expect(verify(svc, webhookSignature(OLD, RAW_TS, EVENT, BODY))).resolves.toMatchObject({ workflowId: WF });
  });

  it('过渡窗后 previous 命中：409 WEBHOOK_SECRET_ROTATION_REQUIRED（可诊断，且只有持过旧密钥者可达）', async () => {
    const envelope = JSON.stringify({ v: 2, current: NEW, previous: OLD, previousExpiresAt: Date.now() - 1 });
    const { svc, prisma } = make({ webhook: makeWebhookRow(envelope) });
    const err = await verify(svc, webhookSignature(OLD, RAW_TS, EVENT, BODY)).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(409);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'WEBHOOK_SECRET_ROTATION_REQUIRED' });
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled(); // 拒绝发生在防重放落库之前
  });

  it('两代都不匹配 → 401 统一文案（未持密钥者止步于此，不构成枚举信道）', async () => {
    const envelope = JSON.stringify({ v: 2, current: NEW, previous: OLD, previousExpiresAt: Date.now() + 60_000 });
    const { svc, prisma } = make({ webhook: makeWebhookRow(envelope) });
    const err = await verify(svc, webhookSignature('c'.repeat(64), RAW_TS, EVENT, BODY)).catch((e) => e);
    expect(err).toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    expect(err.message).toBe('webhook 鉴权失败');
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    // 未知 token / 已禁用 同样 → 401 同文案（不可区分）
    const missing = await make().svc.verifyWebhook('nope', BODY, { signature: 'x', timestamp: RAW_TS, eventId: EVENT }).catch((e) => e);
    expect(missing).toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID', message: 'webhook 鉴权失败' });
  });

  it('rotateWebhook：current→previous + 新 current；旧 secret 在窗内仍验签、新 secret 立即生效', async () => {
    process.env.WEBHOOK_SECRET_GRACE_MS = '1000';
    const { svc, audit, currentSecret } = make({ webhook: makeWebhookRow(OLD) });
    const before = Date.now();
    const res = await svc.rotateWebhook(WF, 'owner-1');
    expect(res.token).toBe('tok-1');
    expect(res.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.secret).not.toBe(OLD);
    expect(Date.parse(res.previousSecretExpiresAt as string)).toBeGreaterThanOrEqual(before + 1000);
    const stored = parseWebhookSecrets(dec(currentSecret() as string));
    expect(stored.current).toBe(res.secret);
    expect(stored.previous).toBe(OLD);
    // 旧 secret 仍可验签（previous），新 secret 立即可用（current）
    expect(matchWebhookSecret(stored, {
      rawTimestamp: RAW_TS, eventId: EVENT, rawBody: BODY, provided: webhookSignature(OLD, RAW_TS, EVENT, BODY), nowMs: Date.now(),
    })).toBe('previous');
    expect(matchWebhookSecret(stored, {
      rawTimestamp: RAW_TS, eventId: EVENT, rawBody: BODY, provided: webhookSignature(res.secret, RAW_TS, EVENT, BODY), nowMs: Date.now(),
    })).toBe('current');
    // 轮换后旧 secret 走完整体验签路径 → 接受
    await expect(verify(svc, webhookSignature(OLD, RAW_TS, EVENT, BODY))).resolves.toMatchObject({ workflowId: WF });
  });

  it('审计：记录轮换事实但**绝不含密钥材料**（新旧 secret 都不出现在审计 payload 中）', async () => {
    const { svc, audit } = make({ webhook: makeWebhookRow(OLD) });
    const res = await svc.rotateWebhook(WF, 'owner-1');
    expect(audit.write).toHaveBeenCalledTimes(1);
    const arg = audit.write.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      userId: 'owner-1', action: 'workflow_webhook.secret_rotated',
      targetType: 'workflow_webhook', targetId: 'tok-1',
    });
    const raw = JSON.stringify(arg);
    expect(raw).not.toContain(OLD);
    expect(raw).not.toContain(res.secret);
  });

  it('只保留一代：再次轮换后更早的 secret 立即失效（绝不累积多代旧密钥）', async () => {
    process.env.WEBHOOK_SECRET_GRACE_MS = '60000';
    const { svc, currentSecret } = make({ webhook: makeWebhookRow(OLD) });
    const first = await svc.rotateWebhook(WF, 'owner-1');
    const second = await svc.rotateWebhook(WF, 'owner-1');
    expect(second.secret).not.toBe(first.secret);
    const stored = parseWebhookSecrets(dec(currentSecret() as string));
    expect(stored.current).toBe(second.secret);
    expect(stored.previous).toBe(first.secret); // 只保留刚被替换的那一代
    const verdict = (secret: string) => matchWebhookSecret(stored, {
      rawTimestamp: RAW_TS, eventId: EVENT, rawBody: BODY,
      provided: webhookSignature(secret, RAW_TS, EVENT, BODY), nowMs: Date.now(),
    });
    expect(verdict(second.secret)).toBe('current');
    expect(verdict(first.secret)).toBe('previous');
    expect(verdict(OLD)).toBe('none'); // 更早一代已被挤出（不是 previous_expired —— 是彻底不认识）
  });

  it('WEBHOOK_SECRET_GRACE_MS=0 → 立即切换（不保留 previous，旧密钥即刻失效）', async () => {
    process.env.WEBHOOK_SECRET_GRACE_MS = '0';
    const { svc, currentSecret } = make({ webhook: makeWebhookRow(OLD) });
    const res = await svc.rotateWebhook(WF, 'owner-1');
    expect(res.previousSecretExpiresAt).toBeNull();
    const stored = parseWebhookSecrets(dec(currentSecret() as string));
    expect(stored).toEqual({ current: res.secret, previous: null, previousExpiresAt: null });
    await expect(verify(svc, webhookSignature(OLD, RAW_TS, EVENT, BODY))).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
  });

  it('未启用 webhook 的工作流 → 404（不泄露"是否有 webhook"之外的任何信息）', async () => {
    const { svc } = make({ webhook: null });
    await expect(svc.rotateWebhook(WF, 'owner-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
