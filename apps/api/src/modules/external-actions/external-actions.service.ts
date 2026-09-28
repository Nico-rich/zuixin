import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { CredentialService } from '../connections/credentials.service';
import { ExternalActionProvidersService } from './external-action-providers.service';
import { AuditService } from '../audit/audit.service';
import { BillingService } from '../billing/billing.service';
import { QuotaService } from '../billing/quota.service';
import { assertApprovalBinding, hashPayload } from '../approvals/approval-binding';

/** Pre-M9 C2：claim 失败轮询赢家终态的时长上限 */
const EXECUTING_POLL_MS = 20_000;

/** Pre-M9 G7：executing 残留行视为"执行者已死"的静默阈值（健康执行远短于此：单次 provider 调用） */
const EXECUTING_STALE_MS = Number(process.env.EXTERNAL_ACTION_STALE_MS) || 10 * 60_000;

/** Pre-M9 G7：远端状态查询单次上限（恢复绝不无限期挂住清扫周期） */
const RECOVER_QUERY_TIMEOUT_MS = 15_000;

/** M7-P3 风险分级（快照入库；financial/destructive → high，external_action → medium，其余 low） */
export function classifyRisk(permission: string): 'low' | 'medium' | 'high' {
  if (permission === 'financial' || permission === 'destructive') return 'high';
  if (permission === 'external_action') return 'medium';
  return 'low';
}

export interface ExecuteExternalActionInput {
  userId: string;
  projectId?: string;
  agentRunId?: string;
  toolCallId?: string;
  /** P6 Workflow 审批步骤直连（toolCallId 场景外） */
  approvalId?: string;
  connectionId?: string;
  provider: string;
  actionType: string;
  payload: Record<string, unknown>;
  permission: string;
  /** 业务幂等键：同一键绝不重复执行外部动作（Engine ToolCall 幂等键 / Workflow 步骤键） */
  idempotencyKey: string;
  signal: AbortSignal;
}

/**
 * M7-P3 External Action 执行服务（副作用唯一出口 + 审计面）：
 * 执行链：审批复核（绝不只信 LLM）→ 风险分级 → 幂等裁决（唯一键 + executing 残留行复用）
 * → 连接校验（凭证服务端解密注入 Adapter，绝不进行内 input）→ Provider Adapter → 行终态。
 * - 幂等：UNIQUE(userId, provider, idempotencyKey) + executing 残留行复用同一 externalRequestId；
 * - 审批复核（P9-5 防线）：toolCallId 关联 Approval 必须 approved（或直接给定 approvalId）；
 * - 取消：signal aborted → 行 cancelled(AGENT_CANCELLED)，错误上抛（Engine 识别取消）；
 * - Pre-M9 G7：executing 残留行（执行者崩溃）由 recoverExecutingAction 按**远端真实状态**收口，
 *   绝不重复执行 provider 副作用（远端幂等键只用于去重，不用于重放）。
 */
@Injectable()
export class ExternalActionsService {
  private readonly logger = new Logger('ExternalActions');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CredentialService) private readonly credentials: CredentialService,
    @Inject(ExternalActionProvidersService) private readonly providers: ExternalActionProvidersService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(QuotaService) private readonly quota: QuotaService,
  ) {}

  /**
   * 审批复核：绝不只信 Engine/LLM——执行前必须存在 approved 的 Approval 且**绑定与本次执行的动作一致**
   * （否则抛出，永不返回 null）。两条授权来源的绑定口径（均由 approvals 模块同一 helper 读写）：
   * - approvalId（工作流审批步骤直连）：绑定口径 = (actionType, 渲染后的载荷) —— 审批步骤创建时即绑定
   *   下游 external_action 步骤的具体动作；
   * - toolCallId（引擎审批门）：绑定口径 = (工具名, 工具入参) —— 引擎审批门按工具调用绑定。此处再校验
   *   ①审批确实绑定到该 ToolCall 行的 (toolName, input)；②**本次真正执行的动作**必须与已批准工具入参里的
   *   actionType/payload 逐项一致（子动作一致）——调用方无法用"另一个绑定的审批"解锁本动作，
   *   也无法在执行时把动作换成别的（载荷比较用同一稳定序列化摘要）。
   */
  private async verifyApproval(userId: string, input: ExecuteExternalActionInput): Promise<{ id: string; riskLevel: string }> {
    let approval: { id: string; status: string; userId: string; riskLevel: string; payload: unknown } | null = null;
    if (input.approvalId) {
      approval = await this.prisma.approval.findFirst({ where: { id: input.approvalId, userId } });
    } else if (input.toolCallId) {
      approval = await this.prisma.approval.findFirst({
        where: { toolCallId: input.toolCallId, userId },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (!approval) throw new AppError(ErrorCode.TOOL_DENIED, '缺少审批记录，外部动作被拒绝');
    if (approval.status !== 'approved') throw new AppError(ErrorCode.TOOL_DENIED, '审批未通过，外部动作被拒绝');

    if (input.toolCallId) {
      // 引擎路径：审批行的绑定口径是 (工具名, 工具入参)——以 ToolCall 行为事实源重算比对
      const row = await this.prisma.toolCall.findUnique({
        where: { id: input.toolCallId }, select: { toolName: true, input: true },
      });
      if (!row) throw new AppError(ErrorCode.TOOL_DENIED, '缺少工具调用记录，外部动作被拒绝');
      assertApprovalBinding({
        payload: approval.payload, actionType: row.toolName, action: row.input, reason: `工具 ${row.toolName}`,
      });
      const approved = (row.input ?? {}) as { actionType?: unknown; payload?: unknown };
      const approvedPayload = approved.payload ?? {};
      const executedPayload = input.payload ?? {};
      if (approved.actionType !== input.actionType
        || hashPayload(approvedPayload) !== hashPayload(executedPayload)) {
        throw new AppError(
          ErrorCode.APPROVAL_BINDING_MISMATCH,
          `审批绑定的动作与本次执行不一致（批准=${String(approved.actionType)}，实际=${input.actionType}），拒绝执行`,
        );
      }
      return { id: approval.id, riskLevel: approval.riskLevel };
    }

    // 工作流/直连路径：绑定口径 = (actionType, 载荷)。摘要取自 input.actionType/input.payload（即将发给 provider 的同一份数据）
    assertApprovalBinding({
      payload: approval.payload, actionType: input.actionType, action: input.payload ?? {},
      reason: `外部动作 ${input.actionType}`,
    });
    return { id: approval.id, riskLevel: approval.riskLevel };
  }

  async execute(input: ExecuteExternalActionInput): Promise<Record<string, unknown>> {
    const provider = this.providers.get(input.provider);
    if (!provider) throw new AppError(ErrorCode.PROVIDER_UNSUPPORTED, '不支持的外部动作 Provider');

    // 1. 审批复核（防线 1：服务端事实，不信任调用方）；风险分级快照 = Approval.riskLevel（P1 审批门分类结果）
    const approval = await this.verifyApproval(input.userId, input);

    // 2. 幂等裁决：completed → 复用结果（绝不重复执行）
    const existing = await this.prisma.externalAction.findUnique({
      where: { userId_provider_idempotencyKey: { userId: input.userId, provider: input.provider, idempotencyKey: input.idempotencyKey } },
    });
    if (existing && existing.status === 'completed' && existing.result != null) {
      return this.toView(existing);
    }

    // 3. 连接校验（行创建之前——校验失败绝不留下孤儿行；凭证服务端解密，绝不进行内 input/结果/日志）
    const connection = await this.resolveConnection(input);
    const accessToken = await this.credentials.getAccessToken(connection.id);
    if (!accessToken) throw new AppError(ErrorCode.CONNECTION_NOT_ACTIVE, '连接缺少有效凭证');

    // 3.5 M8-P2 配额裁决（服务端；external_api_call）；Pre-M9 C1：幂等键作预留 refId（终态释放）
    const quota = await this.quota.assertQuota(input.userId, input.projectId ?? null, 'external_api_call', 1, input.idempotencyKey);

    // 4. 行获取/创建（创建时即生成稳定 externalRequestId——崩溃重试同一键传给 provider 去重）
    const actionId = existing?.id
      ?? (await this.createRow(input, approval, quota.organizationId)).id;
    const row = await this.prisma.externalAction.findUnique({ where: { id: actionId } });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, '外部动作不存在');
    if (row.status === 'cancelled') throw new AppError(ErrorCode.APPROVAL_CANCELLED, '外部动作已取消');

    // 5. Pre-M9 C2 claim-then-execute（(status, startedAt) 双字段乐观 CAS——真正的互斥）：
    //    WHERE 在 UPDATE 时刻求值：赢家把 startedAt 改成 now，输家的旧 startedAt 条件立刻失配 → count=0。
    //    可 claim 态：pending_approval（首执行）/ failed（tool retryPolicy 重试）/ executing（崩溃续跑——
    //    run lease 已过期意味着原执行者已死；provider 侧以同一 externalRequestId 去重，副作用依然 exactly-once）。
    const claim = await this.prisma.externalAction.updateMany({
      where: {
        id: actionId,
        status: row.status as never,
        startedAt: row.startedAt, // null（pending）或旧值（failed/executing）——CAS 令牌
      },
      data: { status: 'executing', startedAt: new Date(), approvalId: approval.id, connectionId: connection.id },
    });
    if (claim.count === 0) {
      return this.awaitExistingOutcome(actionId, input);
    }
    const externalRequestId = row.externalRequestId ?? randomUUID();

    try {
      const result = await provider.execute({
        provider: input.provider, actionType: input.actionType, payload: input.payload,
        externalRequestId, connectionId: connection.id, accessToken: accessToken.token, signal: input.signal,
      });
      const done = await this.prisma.externalAction.updateMany({
        where: { id: actionId, status: 'executing' },
        data: { status: 'completed', completedAt: new Date(), result: result as never },
      });
      if (done.count === 0) return this.awaitExistingOutcome(actionId, input); // 被接管/外部终态 → 读事实
      this.logger.log({ actionId, provider: input.provider, actionType: input.actionType }, '外部动作完成');
      await this.audit.write({
        userId: input.userId, action: 'external_action.executed', projectId: input.projectId,
        targetType: 'external_action', targetId: actionId, externalActionId: actionId,
        agentRunId: input.agentRunId, toolCallId: input.toolCallId, approvalId: approval.id,
        connectionId: connection.id,
        metadata: { provider: input.provider, actionType: input.actionType, status: 'completed' },
      });
      // M8-P2 计量（幂等键 = 动作 id；重放/重试绝不重复计量）
      await this.billing.recordUsage({
        userId: input.userId, projectId: input.projectId, kind: 'external_api_call', quantity: 1,
        runId: input.agentRunId, toolCallId: input.toolCallId, idempotencyKey: `ea:${actionId}`,
      }).catch(() => undefined);
      await this.quota.release(input.idempotencyKey, 'external_api_call').catch(() => undefined);
      const completed = await this.prisma.externalAction.findUnique({ where: { id: actionId } });
      return this.toView(completed ?? { ...row, status: 'completed', result: result as never });
    } catch (err) {
      const aborted = input.signal.aborted;
      const appErr = err instanceof AppError ? err : new AppError(ErrorCode.PROVIDER_UNKNOWN, (err as Error).message);
      await this.prisma.externalAction.updateMany({
        where: { id: actionId, status: 'executing' },
        data: aborted
          ? { status: 'cancelled', completedAt: new Date(), errorCode: ErrorCode.AGENT_CANCELLED, error: '执行已取消' }
          : { status: 'failed', completedAt: new Date(), errorCode: appErr.code, error: appErr.message },
      }).catch(() => null);
      await this.audit.write({
        userId: input.userId, action: 'external_action.executed', projectId: input.projectId,
        targetType: 'external_action', targetId: actionId, externalActionId: actionId,
        agentRunId: input.agentRunId, toolCallId: input.toolCallId, approvalId: approval.id,
        connectionId: connection.id,
        metadata: { provider: input.provider, actionType: input.actionType, status: aborted ? 'cancelled' : 'failed', errorCode: appErr.code },
      });
      await this.quota.release(input.idempotencyKey, 'external_api_call').catch(() => undefined);
      this.logger.warn({ actionId, errorCode: appErr.code }, '外部动作失败/取消');
      if (aborted) throw err; // AbortError 上抛：Engine 识别为取消
      throw appErr;
    }
  }

  /**
   * Pre-M9 G7：**executing 残留行恢复**——执行者进程崩溃/重启后本地无人推进，但**远端可能早已执行成功**。
   * 只有 provider 是权威：对声明 `remoteStatus` 的 provider 反查真实状态并落终态，
   * **绝不重复执行副作用**（远端是既成事实，重放会二次下单/二次扣款）。
   * - completed → 条件更新（status='executing'）落 completed + 审计 + 计量 + 配额释放；
   * - failed    → 条件更新落 failed（错误来自 provider）+ 审计 + 配额释放；
   * - processing/unknown（无适配器、查询失败、连接不可用、竞态已终态）→ 保持 executing，绝不伪造终态。
   */
  async recoverExecutingAction(actionId: string): Promise<'completed' | 'failed' | 'processing' | 'unknown'> {
    const row = await this.prisma.externalAction.findUnique({ where: { id: actionId } });
    if (!row || row.status !== 'executing' || !row.externalRequestId) return 'unknown';
    const provider = this.providers.get(row.provider);
    if (!provider?.remoteStatus) return 'unknown'; // 平台不支持状态查询 → 由业务重试（同键去重）接管
    const connection = row.connectionId
      ? await this.prisma.connection.findFirst({ where: { id: row.connectionId, userId: row.userId } }).catch(() => null)
      : null;
    if (!connection || connection.status !== 'active') return 'unknown';
    const accessToken = await this.credentials.getAccessToken(connection.id).catch(() => null);
    if (!accessToken) return 'unknown';
    let status;
    try {
      status = await provider.remoteStatus({
        provider: row.provider, actionType: row.actionType, payload: (row.input ?? {}) as Record<string, unknown>,
        externalRequestId: row.externalRequestId, connectionId: connection.id, accessToken: accessToken.token,
        signal: AbortSignal.timeout(RECOVER_QUERY_TIMEOUT_MS),
      });
    } catch (err) {
      // 查询失败 ≠ 动作失败：保持 executing（远端状态未知，任何终态都是伪造）
      this.logger.warn({ actionId, err: (err as Error).message }, '外部动作远端状态查询失败，保持 executing');
      return 'unknown';
    }
    if (!status || status.status === 'processing') return 'processing';
    if (status.status === 'failed') {
      const failed = await this.prisma.externalAction.updateMany({
        where: { id: actionId, status: 'executing' },
        data: {
          status: 'failed', completedAt: new Date(),
          errorCode: status.errorCode ?? ErrorCode.PROVIDER_UNKNOWN, error: status.error ?? '远端动作失败',
        },
      });
      if (failed.count === 0) return 'unknown'; // 竞态：已被正常路径终态
      await this.audit.write({
        userId: row.userId, action: 'external_action.executed', projectId: row.projectId,
        targetType: 'external_action', targetId: actionId, externalActionId: actionId,
        agentRunId: row.agentRunId ?? undefined, toolCallId: row.toolCallId ?? undefined,
        approvalId: row.approvalId ?? undefined, connectionId: connection.id,
        metadata: { provider: row.provider, actionType: row.actionType, status: 'failed', recovered: true, errorCode: status.errorCode ?? ErrorCode.PROVIDER_UNKNOWN },
      });
      await this.quota.release(row.idempotencyKey, 'external_api_call').catch(() => undefined);
      this.logger.warn({ actionId, provider: row.provider }, '外部动作按远端真实状态恢复为 failed');
      return 'failed';
    }
    const done = await this.prisma.externalAction.updateMany({
      where: { id: actionId, status: 'executing' },
      data: { status: 'completed', completedAt: new Date(), result: (status.result ?? null) as never },
    });
    if (done.count === 0) return 'unknown';
    await this.audit.write({
      userId: row.userId, action: 'external_action.executed', projectId: row.projectId,
      targetType: 'external_action', targetId: actionId, externalActionId: actionId,
      agentRunId: row.agentRunId ?? undefined, toolCallId: row.toolCallId ?? undefined,
      approvalId: row.approvalId ?? undefined, connectionId: connection.id,
      metadata: { provider: row.provider, actionType: row.actionType, status: 'completed', recovered: true },
    });
    // 计量幂等键 = 动作 id：与正常完成路径同一把键 → 恢复绝不重复计量
    await this.billing.recordUsage({
      userId: row.userId, projectId: row.projectId ?? undefined, kind: 'external_api_call', quantity: 1,
      runId: row.agentRunId ?? undefined, toolCallId: row.toolCallId ?? undefined, idempotencyKey: `ea:${actionId}`,
    }).catch(() => undefined);
    await this.quota.release(row.idempotencyKey, 'external_api_call').catch(() => undefined);
    this.logger.log({ actionId, provider: row.provider }, '外部动作按远端真实状态恢复为 completed（未重复执行）');
    return 'completed';
  }

  /**
   * Pre-M9 G7：批量恢复**静默过久**的 executing 行（周期清扫调用，幂等、多实例安全）。
   * 只处理 startedAt 超过阈值的行（正常执行中的行绝不被触碰）；单个失败不影响其余。
   */
  async recoverStaleExecutingActions(olderThanMs: number = EXECUTING_STALE_MS): Promise<{ scanned: number; recovered: number }> {
    const rows = await this.prisma.externalAction.findMany({
      where: { status: 'executing', startedAt: { lt: new Date(Date.now() - olderThanMs) } },
      select: { id: true }, orderBy: { startedAt: 'asc' }, take: 50,
    });
    let recovered = 0;
    for (const row of rows) {
      const outcome = await this.recoverExecutingAction(row.id)
        .catch((err) => { this.logger.warn({ actionId: row.id, err: (err as Error).message }, '外部动作恢复失败（跳过，等待下次清扫）'); return 'unknown' as const; });
      if (outcome === 'completed' || outcome === 'failed') recovered++;
    }
    if (rows.length > 0) this.logger.log({ scanned: rows.length, recovered }, '外部动作残留 executing 行恢复完成');
    return { scanned: rows.length, recovered };
  }

  /**
   * Pre-M9 C2：claim 失败（并发执行者 / 残留行被接管）→ 有界轮询赢家终态。
   * 绝不自行执行 provider 副作用——同键动作的副作用有且只有赢家一次。
   */
  private async awaitExistingOutcome(actionId: string, input: ExecuteExternalActionInput): Promise<Record<string, unknown>> {
    const deadline = Date.now() + EXECUTING_POLL_MS;
    while (Date.now() < deadline) {
      const row = await this.prisma.externalAction.findUnique({ where: { id: actionId } });
      if (row?.status === 'completed' && row.result != null) return this.toView(row);
      if (row?.status === 'failed' || row?.status === 'cancelled') {
        throw new AppError(ErrorCode.PROVIDER_UNKNOWN, row.error ?? '外部动作已失败');
      }
      if (!row) throw new AppError(ErrorCode.NOT_FOUND, '外部动作不存在');
      if (input.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new AppError(ErrorCode.EXTERNAL_ACTION_IN_PROGRESS, '外部动作正在执行中，请稍后重试');
  }

  /** 连接解析：显式 connectionId（归属校验）或该 provider 的第一个 active 连接 */
  private async resolveConnection(input: ExecuteExternalActionInput) {
    const where = input.connectionId
      ? { id: input.connectionId, userId: input.userId }
      : { userId: input.userId, provider: input.provider, status: 'active' as const };
    const connection = input.connectionId
      ? await this.prisma.connection.findFirst({ where })
      : await this.prisma.connection.findFirst({ where, orderBy: { createdAt: 'asc' } });
    if (!connection) throw new AppError(ErrorCode.NOT_FOUND, '连接不存在或不可用');
    if (connection.status === 'revoked') throw new AppError(ErrorCode.CONNECTION_REVOKED, '连接已吊销，请重新连接');
    if (connection.status === 'expired') throw new AppError(ErrorCode.CONNECTION_NOT_ACTIVE, '连接已过期，请刷新后重试');
    return connection;
  }

  private async createRow(input: ExecuteExternalActionInput, approval: { id: string; riskLevel: string }, organizationId: string) {
    try {
      return await this.prisma.externalAction.create({
        data: {
          userId: input.userId, projectId: input.projectId ?? null,
          organizationId, // Pre-M9 T1：组织归属写入（配额裁决返回的权威归属）
          agentRunId: input.agentRunId ?? null, toolCallId: input.toolCallId ?? null,
          approvalId: approval.id, provider: input.provider, actionType: input.actionType,
          permission: input.permission, riskLevel: approval.riskLevel,
          input: input.payload as never, status: 'pending_approval', idempotencyKey: input.idempotencyKey,
          // Pre-M9 C2：稳定远端幂等键在行创建时生成（崩溃重试同一键 → provider 去重）
          externalRequestId: randomUUID(),
        },
      });
    } catch (err) {
      // 并发同键：查重复用（绝不产生第二行）
      if ((err as { code?: string }).code === 'P2002') {
        const won = await this.prisma.externalAction.findUnique({
          where: { userId_provider_idempotencyKey: { userId: input.userId, provider: input.provider, idempotencyKey: input.idempotencyKey } },
        });
        if (won) return won;
      }
      throw err;
    }
  }

  /** 审计投影（无凭证字段——凭证从未进入本表） */
  private toView(row: {
    id: string; status: string; provider: string; actionType: string; permission: string;
    riskLevel: string; input: unknown; result: unknown; errorCode: string | null; error: string | null;
    externalRequestId: string | null; agentRunId: string | null; toolCallId: string | null;
    approvalId: string | null; connectionId: string | null; startedAt: Date | null; completedAt: Date | null; createdAt: Date;
  }): Record<string, unknown> {
    return {
      externalActionId: row.id, status: row.status, provider: row.provider, actionType: row.actionType,
      permission: row.permission, riskLevel: row.riskLevel,
      externalRequestId: row.externalRequestId, agentRunId: row.agentRunId, toolCallId: row.toolCallId,
      approvalId: row.approvalId, connectionId: row.connectionId,
      input: row.input, result: row.result, errorCode: row.errorCode, error: row.error,
      startedAt: row.startedAt, completedAt: row.completedAt, createdAt: row.createdAt,
    };
  }

  async list(userId: string, agentRunId?: string) {
    return this.prisma.externalAction.findMany({
      where: { userId, ...(agentRunId ? { agentRunId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, status: true, provider: true, actionType: true, permission: true, riskLevel: true,
        externalRequestId: true, agentRunId: true, toolCallId: true, approvalId: true, connectionId: true,
        input: true, result: true, errorCode: true, error: true, startedAt: true, completedAt: true, createdAt: true,
      },
    });
  }

  async get(userId: string, id: string) {
    const row = await this.prisma.externalAction.findFirst({
      where: { id, userId },
      select: {
        id: true, status: true, provider: true, actionType: true, permission: true, riskLevel: true,
        externalRequestId: true, agentRunId: true, toolCallId: true, approvalId: true, connectionId: true,
        input: true, result: true, errorCode: true, error: true, startedAt: true, completedAt: true, createdAt: true,
      },
    });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, '外部动作不存在');
    return row;
  }
}
