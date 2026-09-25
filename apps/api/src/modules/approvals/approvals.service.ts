import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { AgentRunResumeTrigger } from '../../core/agent-run-resume/agent-run-resume-trigger.service';
import { EventBusService, agentRunChannel } from '../../core/events/event-bus.service';
import { WORKFLOW_APPROVAL_DECIDED_CHANNEL } from '../../core/events/workflow-channels';

const DECIDED = ['approved', 'rejected', 'expired', 'cancelled'] as const;

/**
 * M7-P1 Approval 读/决（API 侧；创建由 Engine 经持久化边界完成）：
 * - 身份：全部 `findFirst({id, userId})` 首条件（404 防枚举）；agentRunId/toolCallId 绑定由服务端写入；
 * - 决断：条件更新 `status:'requested'`（+ 未过期），count=0 即竞态输家——approve/reject/cancel/expire
 *   只有一个赢家；终态绝不复活；
 * - 决断后唤醒 AgentRun（复用 M6 wakeWaitingRunByApproval；条件更新 + claim 三重幂等，绝不产生重复执行）；
 * - 过期：懒检查（读时标记）+ recoverStale 兜底（waiting run 的审批过期 → expire + 唤醒）。
 */
@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger('Approvals');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AgentRunResumeTrigger) private readonly resume: AgentRunResumeTrigger,
    @Inject(EventBusService) private readonly events: EventBusService,
  ) {}

  /** 懒过期：requested 且 expiresAt 已过 → expired（返回是否发生变更） */
  private async lazilyExpire(id: string): Promise<boolean> {
    const done = await this.prisma.approval.updateMany({
      where: { id, status: 'requested', expiresAt: { lt: new Date() } },
      data: { status: 'expired' },
    });
    return done.count > 0;
  }

  /** 归属校验（userId 首条件，404 防枚举） */
  private async requireOwned(userId: string, id: string) {
    const a = await this.prisma.approval.findFirst({ where: { id, userId } });
    if (!a) throw new AppError(ErrorCode.NOT_FOUND, '审批不存在');
    return a;
  }

  async list(userId: string, filters: { projectId?: string | null; status?: string; agentRunId?: string }) {
    const where = {
      userId,
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.agentRunId ? { agentRunId: filters.agentRunId } : {}),
      ...(filters.status ? { status: filters.status as never } : {}),
    };
    // 懒过期：命中列表的 requested 行先做条件过期（终态绝不复活）
    await this.prisma.approval.updateMany({
      where: { ...where, status: 'requested', expiresAt: { lt: new Date() } },
      data: { status: 'expired' },
    });
    return this.prisma.approval.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, userId: true, projectId: true, agentRunId: true, toolCallId: true,
        status: true, riskLevel: true, reason: true, payload: true, expiresAt: true,
        approvedAt: true, rejectedAt: true, cancelledAt: true, createdAt: true, updatedAt: true,
      },
    });
  }

  async get(userId: string, id: string) {
    const a = await this.requireOwned(userId, id);
    if (a.status === 'requested') await this.lazilyExpire(id); // 读时过期（读后状态以下方查询为准）
    return this.prisma.approval.findFirst({
      where: { id, userId },
      select: {
        id: true, userId: true, projectId: true, agentRunId: true, toolCallId: true,
        status: true, riskLevel: true, reason: true, payload: true, expiresAt: true,
        approvedAt: true, rejectedAt: true, cancelledAt: true, createdAt: true, updatedAt: true,
      },
    });
  }

  /**
   * 决断（approve/reject/cancel 共用）：
   * - 条件更新 requested（且未过期）→ 目标态；count=0 → 已决/已过期（分别 409）；
   * - 赢家唤醒 AgentRun（waiting+waitingOnApprovalId 精确匹配；deadline 已过 → timeout 不复活）。
   */
  private async decide(
    userId: string, id: string,
    target: 'approved' | 'rejected' | 'cancelled',
  ) {
    const a = await this.requireOwned(userId, id);
    if (a.status !== 'requested') {
      throw new AppError(ErrorCode.APPROVAL_NOT_PENDING, '审批已处理');
    }
    const done = await this.prisma.approval.updateMany({
      where: {
        id, userId, status: 'requested',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      data: {
        status: target,
        ...(target === 'approved' ? { approvedAt: new Date() } : {}),
        ...(target === 'rejected' ? { rejectedAt: new Date() } : {}),
        ...(target === 'cancelled' ? { cancelledAt: new Date() } : {}),
      },
    });
    if (done.count === 0) {
      // 竞态输家：并发 decide 或已过期 → 过期优先归因（懒过期落库）
      if (a.expiresAt && a.expiresAt.getTime() <= Date.now()) {
        await this.prisma.approval.updateMany({ where: { id, userId, status: 'requested' }, data: { status: 'expired' } });
        throw new AppError(ErrorCode.APPROVAL_EXPIRED, '审批已过期');
      }
      throw new AppError(ErrorCode.APPROVAL_NOT_PENDING, '审批已处理');
    }
    // 观察通道（SSE 实时）+ 唤醒（条件更新去重；已终态 run 唤醒 no-op）
    if (a.agentRunId) {
      await this.events.publish(agentRunChannel(a.agentRunId), { type: 'approval.decided', approvalId: id, runId: a.agentRunId, status: target })
        .catch(() => undefined);
      await this.resume.wakeWaitingRunByApproval(a.agentRunId, id);
    }
    // M7-P6：workflow 审批步骤 → 全局通道唤醒（Worker 侧 WorkflowWakeService 订阅；recoverStale 兜底）
    if (a.workflowRunId) {
      await this.events.publish(WORKFLOW_APPROVAL_DECIDED_CHANNEL, { approvalId: id, workflowRunId: a.workflowRunId, status: target })
        .catch(() => undefined);
    }
    this.logger.log({ id, target }, 'Approval 已决断');
    return this.prisma.approval.findFirst({ where: { id, userId } });
  }

  approve(userId: string, id: string) {
    return this.decide(userId, id, 'approved');
  }

  reject(userId: string, id: string) {
    return this.decide(userId, id, 'rejected');
  }

  /** 用户撤销自己的 pending 审批（run 仍 waiting → 唤醒，resume 按 cancelled 失败回喂） */
  cancel(userId: string, id: string) {
    return this.decide(userId, id, 'cancelled');
  }

  /** run 终态/取消时的附带清理（best-effort；不唤醒——run 已终态） */
  async cancelPendingForRun(runId: string): Promise<void> {
    await this.prisma.approval.updateMany({
      where: { agentRunId: runId, status: 'requested' },
      data: { status: 'cancelled', cancelledAt: new Date() },
    }).catch(() => undefined);
  }
}
