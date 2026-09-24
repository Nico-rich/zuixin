import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { CredentialService } from '../connections/credentials.service';
import { ExternalActionProvidersService } from './external-action-providers.service';

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
 * - 取消：signal aborted → 行 cancelled(AGENT_CANCELLED)，错误上抛（Engine 识别取消）。
 */
@Injectable()
export class ExternalActionsService {
  private readonly logger = new Logger('ExternalActions');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CredentialService) private readonly credentials: CredentialService,
    @Inject(ExternalActionProvidersService) private readonly providers: ExternalActionProvidersService,
  ) {}

  /** 审批复核：绝不只信 Engine/LLM——执行前必须存在 approved 的 Approval 且绑定一致（否则抛出，永不返回 null） */
  private async verifyApproval(userId: string, input: ExecuteExternalActionInput): Promise<{ id: string; riskLevel: string }> {
    let approval: { id: string; status: string; userId: string; riskLevel: string } | null = null;
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
    return { id: approval.id, riskLevel: approval.riskLevel };
  }

  async execute(input: ExecuteExternalActionInput): Promise<Record<string, unknown>> {
    const provider = this.providers.get(input.provider);
    if (!provider) throw new AppError(ErrorCode.PROVIDER_UNSUPPORTED, '不支持的外部动作 Provider');

    // 1. 审批复核（防线 1：服务端事实，不信任调用方）；风险分级快照 = Approval.riskLevel（P1 审批门分类结果）
    const approval = await this.verifyApproval(input.userId, input);

    // 2. 幂等裁决：completed → 复用结果（绝不重复执行）；executing/failed 残留 → 复用行 + 同一 externalRequestId 继续
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

    // 4. 行获取/创建 + 执行（executing + startedAt；失败/取消落终态后上抛——Engine/调用方决定后续）
    const actionId = existing?.id
      ?? (await this.createRow(input, approval)).id;
    const externalRequestId = existing?.externalRequestId ?? randomUUID();
    await this.prisma.externalAction.update({
      where: { id: actionId },
      data: { status: 'executing', startedAt: new Date(), externalRequestId, approvalId: approval.id, connectionId: connection.id },
    });
    try {
      const result = await provider.execute({
        provider: input.provider, actionType: input.actionType, payload: input.payload,
        externalRequestId, connectionId: connection.id, accessToken: accessToken.token, signal: input.signal,
      });
      const done = await this.prisma.externalAction.update({
        where: { id: actionId },
        data: { status: 'completed', completedAt: new Date(), result: result as never },
      });
      this.logger.log({ actionId, provider: input.provider, actionType: input.actionType }, '外部动作完成');
      return this.toView(done);
    } catch (err) {
      const aborted = input.signal.aborted;
      const appErr = err instanceof AppError ? err : new AppError(ErrorCode.PROVIDER_UNKNOWN, (err as Error).message);
      const row = await this.prisma.externalAction.update({
        where: { id: actionId },
        data: aborted
          ? { status: 'cancelled', completedAt: new Date(), errorCode: ErrorCode.AGENT_CANCELLED, error: '执行已取消' }
          : { status: 'failed', completedAt: new Date(), errorCode: appErr.code, error: appErr.message },
      }).catch(() => null);
      this.logger.warn({ actionId, errorCode: appErr.code }, '外部动作失败/取消');
      if (aborted) throw err; // AbortError 上抛：Engine 识别为取消
      throw appErr;
    }
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

  private async createRow(input: ExecuteExternalActionInput, approval: { id: string; riskLevel: string }) {
    try {
      return await this.prisma.externalAction.create({
        data: {
          userId: input.userId, projectId: input.projectId ?? null,
          agentRunId: input.agentRunId ?? null, toolCallId: input.toolCallId ?? null,
          approvalId: approval.id, provider: input.provider, actionType: input.actionType,
          permission: input.permission, riskLevel: approval.riskLevel,
          input: input.payload as never, status: 'pending_approval', idempotencyKey: input.idempotencyKey,
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
