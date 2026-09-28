import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TraceContext } from '../../core/tracing/trace-context';

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
  // ===== M8-P3：租户归属 + 全链路关联 + 结果/原因 =====
  organizationId?: string | null;
  actorId?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  result?: string | null;
  reason?: string | null;
}

/**
 * 脱敏键匹配（大小写不敏感；子串命中即脱敏——宁可多脱，绝不漏脱）：
 * password / passwd / passwordHash / accessToken / refreshToken / apiKey / api_key / secret /
 * token / authorization / cookie / credential / encryptedValue / encrypted。
 */
const SENSITIVE_KEY = /password|passwd|access_?token|refresh_?token|api[_-]?key|secret|token|authorization|cookie|credential|encrypted/i;

const MASK = '***';
const MAX_DEPTH = 8;

/**
 * 递归脱敏：命中脱敏键的值整体替换为 '***'（键保留，便于审计定位字段是否存在）；
 * 数组逐项递归；Date/原始值原样（不做键匹配的误伤）；超深（>8 层）直接截断为空对象防环。
 */
export function maskSensitive<T>(value: T, depth = 0): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => maskSensitive(item, depth + 1)) as unknown as T;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (depth >= MAX_DEPTH) return {} as T;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? MASK : maskSensitive(raw, depth + 1);
  }
  return out as T;
}

/** 邮箱掩码：保留 @ 前前缀 + '***'（域名等其余部分全部丢弃；缺失 @ 时整体丢弃） */
export function maskEmail(email: string): string {
  const prefix = email.split('@')[0] ?? '';
  return prefix ? `${prefix}${MASK}` : MASK;
}

/**
 * M7-P9 审计（关键行为追踪：who/what/when/which project/run/tool/approval/action；M8-P3 增强）：
 * 写入失败绝不阻断主流程（best-effort——审计是观测面，不做业务事务）；
 * requestId/traceId 未显式传入时从 TraceContext 自动取值（HTTP 中间件 / Worker 上下文）；
 * metadata 一律强制脱敏（凭证/密钥类字段绝不落库）。
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async write(input: AuditInput): Promise<void> {
    const ctx = TraceContext.current();
    await this.prisma.auditLog.create({
      data: {
        userId: input.userId, action: input.action,
        projectId: input.projectId ?? null,
        targetType: input.targetType, targetId: input.targetId,
        agentRunId: input.agentRunId ?? ctx?.runId, toolCallId: input.toolCallId ?? ctx?.toolCallId,
        approvalId: input.approvalId, externalActionId: input.externalActionId,
        workflowRunId: input.workflowRunId ?? ctx?.workflowRunId, connectionId: input.connectionId,
        organizationId: input.organizationId ?? ctx?.organizationId ?? null,
        actorId: input.actorId ?? input.userId,
        requestId: input.requestId ?? ctx?.requestId ?? null,
        traceId: input.traceId ?? ctx?.traceId ?? null,
        result: input.result ?? null,
        reason: input.reason ?? null,
        metadata: maskSensitive(input.metadata ?? null) as never,
      },
    }).catch((err: Error) => {
      // M10-P1 D13：best-effort ≠ 静默。审计写失败必须**可见**（此前是 `.catch(() => undefined)` 完全吞掉，
      // 运行期无法从日志发现"审计面已经失灵"）。只记 action 与错误消息——绝不复述 metadata（可能含尚未脱敏的输入）。
      this.logger.warn(`审计写入失败（业务不受影响；审计面已降级）: action=${input.action} err=${err.message}`);
    });
  }

  async list(userId: string, filters: { action?: string; targetType?: string; take?: number } = {}) {
    return this.prisma.auditLog.findMany({
      where: { userId, ...(filters.action ? { action: filters.action } : {}), ...(filters.targetType ? { targetType: filters.targetType } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.take ?? 50, 200),
    });
  }
}
