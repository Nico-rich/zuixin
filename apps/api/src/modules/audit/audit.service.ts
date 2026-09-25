import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditInput {
  userId: string;
  action: string;
  projectId?: string | null;
  targetType?: string;
  targetId?: string;
  agentRunId?: string;
  toolCallId?: string;
  approvalId?: string;
  externalActionId?: string;
  workflowRunId?: string;
  connectionId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * M7-P9 审计（关键行为追踪：who/what/when/which project/run/tool/approval/action）：
 * 写入失败绝不阻断主流程（best-effort——审计是观测面，不做业务事务）；读取 userId 首条件（防枚举）。
 */
@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async write(input: AuditInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        userId: input.userId, action: input.action,
        projectId: input.projectId ?? null,
        targetType: input.targetType, targetId: input.targetId,
        agentRunId: input.agentRunId, toolCallId: input.toolCallId,
        approvalId: input.approvalId, externalActionId: input.externalActionId,
        workflowRunId: input.workflowRunId, connectionId: input.connectionId,
        metadata: (input.metadata ?? null) as never,
      },
    }).catch(() => undefined); // best-effort
  }

  async list(userId: string, filters: { action?: string; targetType?: string; take?: number } = {}) {
    return this.prisma.auditLog.findMany({
      where: { userId, ...(filters.action ? { action: filters.action } : {}), ...(filters.targetType ? { targetType: filters.targetType } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.take ?? 50, 200),
    });
  }
}
