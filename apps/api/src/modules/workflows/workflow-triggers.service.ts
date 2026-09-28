import { HttpException, HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { EventBusService } from '../../core/events/event-bus.service';
import { WORKFLOW_QUEUE } from '../../core/queue/queue.module';
import { addJobBestEffort, QUEUE_ADD_TIMEOUT_MS } from '../../core/queue/bounded-add';
import { withDeadline } from '../../core/redis/redis-resilience';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowDefinition } from './workflow-types';
import { AuditService } from '../audit/audit.service';
import { WEBHOOK_LIMITS, checkJsonComplexity, isPlainPayload } from '../security/payload-guard';
import {
  matchWebhookSecret, parseWebhookSecrets, serializeWebhookSecrets, webhookSecretGraceMs,
} from './webhook-secret';

const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;
/** M8-P8：webhook 载荷体积硬上限（与 main.ts express.raw limit 一致；服务层再校验一次） */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
/** M8-P8：鉴权失败的统一文案（绝不区分不存在/禁用/签名错/时间戳错——防 token 探测） */
export const WEBHOOK_REJECT_MESSAGE = 'webhook 鉴权失败';

/**
 * schedule 调度器 id（**可寻址**：BullMQ 5 Job Scheduler 的 id 即 repeatable 的 key）。
 * M10-P5 X-06 修复前用裸 repeatable：该版本下 `getRepeatableJobs()` 的 `key` 是 md5、`id` 字段为空，
 * 按 `j.id === 'wf-sched-<wf>'` 过滤**永不命中** → 归档不注销、cron 变更叠加成多个调度器。
 * 多 cron 时按索引后缀区分（`wf-sched-<wf>#1`…），归属判定 = 精确 id 或该前缀。
 */
export function scheduleSchedulerId(workflowId: string, index = 0): string {
  return index === 0 ? `wf-sched-${workflowId}` : `wf-sched-${workflowId}#${index}`;
}

/** 是否本 workflow 的调度器 id（前缀含 `#` 索引，绝不误伤其他 workflow——uuid 定长） */
export function isOwnScheduleSchedulerId(workflowId: string, id: string): boolean {
  const base = `wf-sched-${workflowId}`;
  return id === base || id.startsWith(`${base}#`);
}

/**
 * 从 delayed job 反查其所属调度器 key：优先 `opts.repeatJobKey`，否则解析 jobId `repeat:<key>:<millis>`。
 * 非 repeatable（普通延迟 job）→ null。
 */
export function repeatJobKeyOf(job: { id?: string | null; opts?: { repeatJobKey?: string } }): string | null {
  const explicit = job.opts?.repeatJobKey;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const id = job.id ?? '';
  const prefix = 'repeat:';
  if (!id.startsWith(prefix)) return null;
  const end = id.lastIndexOf(':');
  return end > prefix.length ? id.slice(prefix.length, end) : null;
}

/**
 * `getJobSchedulers()` 条目 → 本 workflow 的调度器句柄（**删除句柄 = `key`**）。
 *
 * BullMQ 5.81.5 实测（`job-scheduler.js` 的 `transformSchedulerData`）：条目**没有 `id` 字段**——
 * 新建式调度器的 id 就是 `key`（= zset 成员 = `upsertJobScheduler(id)` 传入的 id）。
 * 只读 `s.id` 恒为 undefined → 归属集合恒空 → 归档/删除永不清理（Mock 曾用 `{id}` 掩盖此事实）。
 * Pre-M10 裸 repeatable 走 `keyToData`（`key` 形如 `scheduled:wf-sched-<wf>:<end>:<tz>:<pattern>`）时才**同时**有
 * `id`（= `wf-sched-<wf>`）——因此归属判定看 `key` 与 `id` 两者（兼容历史遗留），
 * 删除一律用 `key`（`removeJobScheduler` 需要的正是 zset 成员本身，含冒号的 legacy key 同样有效）。
 */
export function ownSchedulerEntry(
  entry: { key?: unknown; id?: unknown; pattern?: unknown } | null | undefined,
  workflowId: string,
): { id: string; pattern: string | null } | null {
  const key = typeof entry?.key === 'string' && entry.key.length > 0 ? entry.key : null;
  if (!key) return null;
  const legacyId = typeof entry?.id === 'string' && entry.id.length > 0 ? entry.id : null;
  if (!isOwnScheduleSchedulerId(workflowId, key) && (legacyId == null || !isOwnScheduleSchedulerId(workflowId, legacyId))) return null;
  return { id: key, pattern: typeof entry?.pattern === 'string' ? entry.pattern : null };
}

/** 定义中的 schedule cron 全集（顺序=定义顺序 → 调度器索引稳定） */
export function scheduleCronsOf(definition: WorkflowDefinition): string[] {
  return (definition.triggers ?? [])
    .filter((t) => t.type === 'schedule' && typeof t.cron === 'string' && t.cron.trim().length > 0)
    .map((t) => t.cron as string);
}

/**
 * M7-P6 触发器（webhook/schedule/event；manual 由 API 直入）：
 * - webhook：HMAC-SHA256 签名（secret AES at rest，校验时解密 + timingSafeEqual）；
 *   **Pre-M9 签名契约（对外，固定顺序）**：`signature = hex(HMAC_SHA256(secret, timestamp + eventId + rawBody))`，
 *   其中 timestamp 为 `X-Hook-Timestamp` 原始字符串、eventId 为 `X-Hook-Event-ID`、rawBody 为**未经解析的原始字节**
 *   （HTTP 层 express.raw 保留）。三者任一处被改动签名即失效 → 时间戳不再可被"重签"绕过。
 *   容忍窗 ±5min（超窗 → 401 WEBHOOK_TIMESTAMP_STALE）+ eventId 防重放（WebhookDelivery UNIQUE，重复 → 409 WEBHOOK_REPLAY）；
 *   **M10-P5 SA-18 双 secret 过渡窗**：轮换后旧 secret 在新 secret 生效后的过渡窗内仍验签（见 webhook-secret.ts）；
 * - schedule：BullMQ **Job Scheduler**（发布/重发布幂等同步 = 注册新 cron + 注销旧 cron 与遗留项；归档注销）；
 * - event：EventBus 订阅 → run（幂等键 = event id 或载荷摘要）。
 * 幂等：所有触发器 → WorkflowRunsService.createRun（唯一键去重，同一触发绝不产生第二个 run）。
 */
@Injectable()
export class WorkflowTriggersService implements OnModuleInit {
  private readonly logger = new Logger('WorkflowTriggers');
  /** 进程内 event 订阅登记（重注册去重） */
  private readonly eventSubscriptions = new Map<string, Set<string>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(EventBusService) private readonly events: EventBusService,
    @Inject(WorkflowRunsService) private readonly runs: WorkflowRunsService,
    @InjectQueue(WORKFLOW_QUEUE) private readonly workflowQueue: Queue,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** 启动自愈：已发布且带 schedule/event 触发器的工作流重新注册（重启后调度不丢） */
  async onModuleInit(): Promise<void> {
    const published = await this.prisma.workflow.findMany({
      where: { status: 'published' },
      include: { versions: { where: { status: 'published' }, orderBy: { version: 'desc' }, take: 1 } },
    }).catch(() => []);
    for (const wf of published) {
      const def = wf.versions[0]?.definition as unknown as WorkflowDefinition | undefined;
      if (!def) continue;
      // M10-P5 X-06：启动自愈同样走幂等同步（一并清掉 Windows 上的历史遗留重复调度器）
      await this.syncSchedules(wf.id, scheduleCronsOf(def)).catch(() => undefined);
      for (const t of def.triggers ?? []) {
        if (t.type === 'event' && t.event) await this.registerEvent(wf.id, t.event);
      }
    }
    this.logger.log({ count: published.length }, '已恢复 published 工作流的 schedule/event 触发器');
  }

  /**
   * 发布/重发布时注册（webhook 行 / schedule 调度器 / event 订阅）。
   * M10-P5 X-06：schedule 用**一次** syncSchedules 覆盖全部 cron ——
   * 定义里 cron 变更/删除同样在此收敛（旧 cron 被注销，绝不叠加）。
   */
  async registerTriggers(workflowId: string, definition: WorkflowDefinition): Promise<{ webhook: { token: string; secret: string | null } | null }> {
    let webhook: { token: string; secret: string | null } | null = null;
    for (const t of definition.triggers ?? []) {
      if (t.type === 'webhook') webhook = await this.ensureWebhook(workflowId);
      if (t.type === 'event' && t.event) await this.registerEvent(workflowId, t.event);
    }
    await this.syncSchedules(workflowId, scheduleCronsOf(definition));
    return { webhook };
  }

  /** 归档/删除时注销（schedule = 同步到空集合，一次收敛） */
  async unregisterTriggers(workflowId: string, definition: WorkflowDefinition): Promise<void> {
    for (const t of definition.triggers ?? []) {
      if (t.type === 'event' && t.event) await this.unregisterEvent(workflowId, t.event);
    }
    await this.syncSchedules(workflowId, []);
  }

  /**
   * webhook 端点凭据：首次生成（secret 仅此时返回明文一次）；后续发布返回既有 token（secret=null）。
   * 首建仍写**裸 secret**格式（Pre-M10 兼容：解析侧对裸串按"单代 current"处理）——
   * 盘上格式的升级只由轮换触发，历史行/未轮换行保持原样，绝不因格式迁移误拒投递。
   */
  async ensureWebhook(workflowId: string): Promise<{ token: string; secret: string | null }> {
    const existing = await this.prisma.workflowWebhook.findFirst({ where: { workflowId, enabled: true } });
    if (existing) return { token: existing.token, secret: null };
    const token = randomBytes(16).toString('hex');
    const secret = randomBytes(32).toString('hex');
    await this.prisma.workflowWebhook.create({
      data: { workflowId, token, secretEncrypted: this.crypto.encrypt(secret) },
    });
    this.logger.log({ workflowId }, 'webhook 凭据已生成（secret 仅返回一次）');
    return { token, secret };
  }

  /**
   * M10-P5 SA-18：webhook secret 轮换（**双 secret 过渡窗**）。
   *
   * 语义（测试锁定，见 webhook-secret.ts）：
   * - 新随机 current 立即生效；**原 current 降级为 previous** 并在过渡窗内继续接受其签名
   *   （发送方有窗口切换密钥，投递不中断）；
   * - 过渡窗后 previous 的签名 → 409 `WEBHOOK_SECRET_ROTATION_REQUIRED`（可诊断，且只有持过旧密钥者可达）；
   * - **只保留一代**：再次轮换会用当前 current 覆盖 previous → 更早一代立即失效（绝不累积多代旧密钥）；
   * - `WEBHOOK_SECRET_GRACE_MS = 0` → 不保留 previous（立即切换，旧密钥即刻失效）。
   *
   * 新 secret 明文**仅本响应返回一次**（与首建一致）；DB 只存密文信封；日志/审计绝不含密钥材料。
   */
  async rotateWebhook(workflowId: string, actorUserId: string): Promise<{ token: string; secret: string; previousSecretExpiresAt: string | null }> {
    const existing = await this.prisma.workflowWebhook.findFirst({ where: { workflowId, enabled: true } });
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND, '工作流未启用 webhook 触发器');
    const graceMs = webhookSecretGraceMs();
    const prev = parseWebhookSecrets(this.crypto.decrypt(existing.secretEncrypted));
    const secret = randomBytes(32).toString('hex');
    const previousExpiresAt = graceMs > 0 ? Date.now() + graceMs : null;
    await this.prisma.workflowWebhook.update({
      where: { id: existing.id },
      data: {
        secretEncrypted: this.crypto.encrypt(serializeWebhookSecrets({
          current: secret,
          previous: previousExpiresAt != null ? prev.current : null,
          previousExpiresAt,
        })),
      },
    });
    // 审计（best-effort；metadata 经 maskSensitive 二次脱敏，且此处本就只记非密钥事实）
    await this.audit.write({
      userId: actorUserId, action: 'workflow_webhook.secret_rotated',
      targetType: 'workflow_webhook', targetId: existing.token,
      metadata: {
        workflowId, graceMs,
        previousSecretExpiresAt: previousExpiresAt != null ? new Date(previousExpiresAt).toISOString() : null,
      },
    });
    this.logger.log({ workflowId, graceMs }, 'webhook secret 已轮换（旧 secret 在过渡窗内仍可验签）');
    return {
      token: existing.token, secret,
      previousSecretExpiresAt: previousExpiresAt != null ? new Date(previousExpiresAt).toISOString() : null,
    };
  }

  /**
   * 签名 + timestamp + 防重放验证（任何失败均不泄露内部细节）。
   *
   * Pre-M9 修复：签名串从"仅 rawBody"改为 **`timestamp + eventId + rawBody`**（顺序固定，字面拼接，无分隔符）。
   * 旧格式未覆盖 timestamp/eventId → 攻击者可在容忍窗内**无限重放**同一份载荷（eventId 可每次换新，
   * WebhookDelivery 的 UNIQUE 形同虚设）。现在 timestamp/eventId 一经改动签名即失效。
   *
   * 校验顺序（**刻意为之**，兼顾反枚举与可诊断性）：
   * 1. 结构性缺参（无 timestamp/eventId、timestamp 非数字）→ 统一文案 401（与"未知 token/坏签名"不可区分）；
   * 2. HMAC 校验（M10-P5 起为**双代比对**：current 优先、previous 次之）→ 均不通过则统一文案 401
   *    （**未持密钥者永远止步于此，响应与 token 是否存在无关 → 不可枚举**）；
   * 2b. previous 命中但已过过渡窗 → 409 `WEBHOOK_SECRET_ROTATION_REQUIRED`（仅持过旧密钥者可达）；
   * 3. 时间窗 ±5min → 超窗 `WEBHOOK_TIMESTAMP_STALE`（仅"签名有效"者可达，不构成枚举信道）；
   * 4. eventId 唯一约束 → 重放 `WEBHOOK_REPLAY`(409)。
   */
  async verifyWebhook(token: string, rawBody: Buffer, headers: { signature?: string; timestamp?: string; eventId?: string }): Promise<{ workflowId: string; eventId: string }> {
    // M8-P8：体积上限（defense in depth —— express.raw limit 之外的二次校验；超限不进入 HMAC/解析/落库）
    if (rawBody.length > WEBHOOK_MAX_BODY_BYTES) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'webhook 载荷超过大小限制');
    }
    const webhook = await this.prisma.workflowWebhook.findUnique({ where: { token } });
    // M8-P8：错误文案统一为单一措辞（不区分"不存在/已禁用/签名错/结构缺参"——防 token 探测与状态枚举）
    if (!webhook || !webhook.enabled) throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, WEBHOOK_REJECT_MESSAGE);
    // Pre-M9：timestamp/eventId 参与签名 → 缺参或非法一律走统一拒绝（不留"半校验"状态）
    const rawTimestamp = headers.timestamp ?? '';
    const eventId = headers.eventId ?? '';
    const ts = Number(rawTimestamp);
    if (!rawTimestamp || !eventId || !Number.isFinite(ts)) {
      throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, WEBHOOK_REJECT_MESSAGE);
    }
    // M10-P5 SA-18：双 secret 过渡窗——解密信封后**逐代**恒定时间比对。
    // 签名串：timestamp + eventId + body（顺序固定并文档化；签名覆盖全部可被重放利用的字段）。
    const secrets = parseWebhookSecrets(this.crypto.decrypt(webhook.secretEncrypted));
    const verdict = matchWebhookSecret(secrets, {
      rawTimestamp, eventId, rawBody, provided: headers.signature ?? '', nowMs: Date.now(),
    });
    if (verdict === 'none') {
      throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, WEBHOOK_REJECT_MESSAGE);
    }
    if (verdict === 'previous_expired') {
      // 只有**真正持有过旧 secret**的发送方才可能命中 previous → 可诊断而不构成 token 枚举信道。
      // 该错误码未进入全局异常过滤器映射（跨 Phase 文件不改）→ 此处自带 HttpException 显式 409，
      // 与 shared/errors.ts 中 WEBHOOK_SECRET_ROTATION_REQUIRED 的语义一致（发送方须改用新 secret）。
      this.logger.warn({ workflowId: webhook.workflowId }, 'webhook 使用已过期的上一代 secret（须完成轮换切换）');
      throw new HttpException(
        { code: ErrorCode.WEBHOOK_SECRET_ROTATION_REQUIRED, message: 'webhook 上一代密钥已过期，请使用新密钥' },
        HttpStatus.CONFLICT,
      );
    }
    if (verdict === 'previous') {
      // 观测：过渡窗内的旧密钥投递（不含任何密钥材料）
      this.logger.log({ workflowId: webhook.workflowId }, 'webhook 使用过渡窗内的上一代 secret（接受）');
    }
    // 签名有效之后才判定时间窗（未持密钥者到不了这里 → 不构成枚举信道）
    if (Math.abs(Date.now() - ts) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
      throw new AppError(ErrorCode.WEBHOOK_TIMESTAMP_STALE, `webhook 时间戳超出容忍窗口（±${WEBHOOK_TIMESTAMP_TOLERANCE_MS / 60_000} 分钟）`);
    }
    // 防重放：同一 eventId 只接受一次（UNIQUE 约束为最终防线）
    try {
      await this.prisma.webhookDelivery.create({
        data: {
          webhookId: webhook.id, eventId,
          payloadHash: createHash('sha256').update(rawBody).digest('hex'),
          status: 'accepted',
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        await this.prisma.webhookDelivery.create({
          data: {
            webhookId: webhook.id, eventId: `${eventId}:dup:${Date.now()}`,
            payloadHash: createHash('sha256').update(rawBody).digest('hex'),
            status: 'duplicate',
          },
        }).catch(() => undefined);
        throw new AppError(ErrorCode.WEBHOOK_REPLAY, '重复的 webhook 事件');
      }
      throw err;
    }
    return { workflowId: webhook.workflowId, eventId };
  }

  /** webhook 载荷 → workflow run（幂等键 = sha256(workflowId:eventId)） */
  async handleWebhook(token: string, rawBody: Buffer, headers: { signature?: string; timestamp?: string; eventId?: string }): Promise<{ runId: string }> {
    const { workflowId, eventId } = await this.verifyWebhook(token, rawBody, headers);
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawBody.toString('utf8'));
      // M8-P8：载荷必须是 JSON 对象（数组/标量拒绝）+ 结构复杂度上限（防深嵌套/超宽对象放大）
      if (!isPlainPayload(parsed)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'webhook 载荷必须是 JSON 对象');
      const complexity = checkJsonComplexity(parsed, WEBHOOK_LIMITS);
      if (!complexity.ok) throw new AppError(ErrorCode.VALIDATION_ERROR, `webhook 载荷被拒绝：${complexity.reason}`);
      payload = parsed;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'webhook 载荷必须是 JSON');
    }
    const wf = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!wf) throw new AppError(ErrorCode.NOT_FOUND, '工作流不存在');
    const idempotencyKey = createHash('sha256').update(`${workflowId}:${eventId}`).digest('hex');
    const run = await this.runs.createRun(wf.userId, {
      workflowId, triggerType: 'webhook', triggerId: eventId, idempotencyKey, payload,
    });
    await this.prisma.workflowWebhook.update({ where: { token }, data: { lastDeliveredAt: new Date() } }).catch(() => undefined);
    await this.audit.write({
      userId: wf.userId, action: 'webhook.accepted', projectId: wf.projectId,
      targetType: 'workflow_webhook', targetId: token, workflowRunId: run.id,
      metadata: { workflowId, eventId },
    });
    return { runId: run.id };
  }

  /** 单 cron 注册（兼容入口；等价于一次只含该 cron 的同步） */
  async registerSchedule(workflowId: string, cron: string): Promise<void> {
    await this.syncSchedules(workflowId, [cron]);
  }

  /** 归档/删除：注销本 workflow 的**全部** schedule（= 同步到空集合） */
  async removeSchedule(workflowId: string): Promise<void> {
    await this.syncSchedules(workflowId, []);
  }

  /**
   * M10-P5 X-06：schedule 重发布 = **幂等同步**（注册期望集合 → 注销不再需要的本 workflow 调度器）。
   *
   * 为什么不是"先删后建"：先删会留出"零调度"窗口（此刻进程崩溃 → 定时触发彻底丢失）。
   * 因此**先增**（缺位/变更的期望 cron 逐个 upsert），**全部就位后**才清理多余项。
   *
   * 失败语义（测试锁定）：
   * - 任一次读取（getJobSchedulers/getDelayed）失败 → **只增不删**（归属未知时绝不盲删他人调度器）；
   * - 任一次 upsert 失败且该 id 原本不存在 → 放弃清理（宁可留下旧调度器，也不冒"零调度"风险）；
   * - 单次 upsert/remove 均 best-effort（有界超时 + 告警）：发布/归档流程不因队列抖动失败。
   */
  async syncSchedules(workflowId: string, crons: readonly string[]): Promise<void> {
    const desired = [...new Set(crons.filter((c): c is string => typeof c === 'string' && c.trim().length > 0))];
    const desiredIds = new Map(desired.map((cron, index) => [scheduleSchedulerId(workflowId, index), cron]));
    const owned = await this.ownedSchedulers(workflowId);
    // ① 先增：缺位或 cron 已变更的期望项（`upsertJobScheduler` 就地更新 pattern —— 变更即重发布）
    let missing = 0;
    const inPlace = new Set<string>();
    for (const [id, cron] of desiredIds) {
      const already = owned?.find((o) => o.id === id);
      if (already && already.pattern === cron) { inPlace.add(id); continue; }
      const ok = await this.upsertSchedule(workflowId, id, cron);
      if (ok || already) inPlace.add(id);
      else missing += 1;
    }
    if (owned == null) {
      this.logger.warn({ workflowId }, 'schedule 同步：无法读取既有调度器，本轮只增不删');
      return;
    }
    if (missing > 0) {
      this.logger.warn({ workflowId, missing }, 'schedule 同步：存在未注册成功的期望 cron，跳过清理（绝不留下零调度）');
      return;
    }
    // ② 后删：期望集合之外的**本 workflow** 调度器（含 Pre-M10 遗留的 md5 裸 repeatable）
    for (const o of owned) {
      if (desiredIds.has(o.id)) continue;
      await this.removeScheduler(o.id);
    }
    this.logger.log({ workflowId, crons: desired }, 'schedule 触发器已同步');
  }

  /**
   * 本 workflow 现有的调度器（`{id, pattern}`，`id` 即为 `removeJobScheduler` 需要的**删除句柄**）。
   * **返回 null = 归属未知**（读取超时/失败）——调用方据此只增不删。
   */
  private async ownedSchedulers(workflowId: string): Promise<Array<{ id: string; pattern: string | null }> | null> {
    const owned = new Map<string, string | null>();
    try {
      const schedulers = await withDeadline(
        this.workflowQueue.getJobSchedulers(0, -1, true),
        QUEUE_ADD_TIMEOUT_MS,
        `getJobSchedulers:${workflowId}`,
      );
      for (const s of schedulers ?? []) {
        // 遗留 md5 键无 hash → transformSchedulerData 返回 undefined（数组有洞，需过滤）
        const entry = ownSchedulerEntry(s, workflowId);
        if (entry) owned.set(entry.id, entry.pattern);
      }
      // 遗留（Pre-M10 裸 repeatable）：zset key 是 md5、无 hash，getJobSchedulers 无法归属
      // → 用下一轮 delayed job 反查（`repeat:<key>:<millis>` + job.data.workflowId）。
      const delayed = await withDeadline(this.workflowQueue.getDelayed(0, -1), QUEUE_ADD_TIMEOUT_MS, `getDelayed:${workflowId}`);
      for (const job of delayed ?? []) {
        const key = repeatJobKeyOf(job);
        if (!key) continue;
        if (isOwnScheduleSchedulerId(workflowId, key)) { if (!owned.has(key)) owned.set(key, null); continue; }
        if ((job.data as { workflowId?: string } | undefined)?.workflowId === workflowId) owned.set(key, null);
      }
    } catch (err) {
      this.logger.warn({ workflowId }, `schedule 同步：读取既有调度器失败（只增不删）: ${(err as Error).message}`);
      return null;
    }
    return [...owned].map(([id, pattern]) => ({ id, pattern }));
  }

  /** 注册/更新单个调度器（有界 + best-effort；失败返回 false，绝不冒泡） */
  private async upsertSchedule(workflowId: string, id: string, cron: string): Promise<boolean> {
    try {
      const job = await withDeadline(
        this.workflowQueue.upsertJobScheduler(id, { pattern: cron }, {
          name: 'scheduled',
          data: { kind: 'scheduled', workflowId },
          opts: { removeOnComplete: true, removeOnFail: true },
        }),
        QUEUE_ADD_TIMEOUT_MS,
        `upsertJobScheduler:${id}`,
      );
      return job != null;
    } catch (err) {
      this.logger.warn({ workflowId, cron }, `schedule 注册失败（best-effort，可重新发布重试）: ${(err as Error).message}`);
      return false;
    }
  }

  /** 注销单个调度器（有界 + best-effort） */
  private async removeScheduler(id: string): Promise<boolean> {
    try {
      return (await withDeadline(
        this.workflowQueue.removeJobScheduler(id),
        QUEUE_ADD_TIMEOUT_MS,
        `removeJobScheduler:${id}`,
      )) === true;
    } catch (err) {
      this.logger.warn({ schedulerId: id }, `schedule 注销失败（best-effort）: ${(err as Error).message}`);
      return false;
    }
  }

  /** 调度触发（repeatable job 消费；e2e 直调模拟）——幂等键 = 1 分钟时间桶 */
  async tickScheduled(workflowId: string): Promise<void> {
    const wf = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!wf || wf.status !== 'published') return;
    const bucket = Math.floor(Date.now() / 60_000);
    await this.runs.createRun(wf.userId, {
      workflowId, triggerType: 'schedule', triggerId: `sched:${bucket}`,
      idempotencyKey: `sched:${workflowId}:${bucket}`,
    });
    this.logger.log({ workflowId, bucket }, 'schedule 触发 → 创建 workflow run');
  }

  /** event 触发订阅（幂等键 = event.id 或载荷摘要） */
  async registerEvent(workflowId: string, channel: string): Promise<void> {
    const key = channel;
    if (this.eventSubscriptions.get(key)?.has(workflowId)) return;
    if (!this.eventSubscriptions.has(key)) {
      this.eventSubscriptions.set(key, new Set());
      await this.events.subscribe(key, (event) => {
        for (const wfId of this.eventSubscriptions.get(key) ?? []) {
          void this.handleEvent(wfId, event).catch(() => undefined);
        }
      });
    }
    this.eventSubscriptions.get(key)!.add(workflowId);
  }

  async unregisterEvent(workflowId: string, channel: string): Promise<void> {
    this.eventSubscriptions.get(channel)?.delete(workflowId);
  }

  async handleEvent(workflowId: string, event: Record<string, unknown>): Promise<void> {
    const wf = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!wf || wf.status !== 'published') return;
    const eventId = (event.id as string | undefined) ?? createHash('sha256').update(JSON.stringify(event)).digest('hex').slice(0, 16);
    await this.runs.createRun(wf.userId, {
      workflowId, triggerType: 'event', triggerId: eventId,
      idempotencyKey: `event:${workflowId}:${eventId}`,
      payload: event,
    });
    this.logger.log({ workflowId, eventId }, 'event 触发 → 创建 workflow run');
  }
}
