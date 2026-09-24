import { RunUsageAggregate } from '../usage/usage.service';

/**
 * Timeline 投影 DTO（数据源 = 现有 AgentRun/Step/ToolCall/GenerationTask/Artifact/UsageRecord，
 * 不新建任何 Event 表）。type 复用 SSE 事件命名语义，但这是持久化投影，不是实时事件。
 */
export type TimelineItemType =
  | 'run.started' | 'run.waiting' | 'run.completed' | 'run.failed' | 'run.cancelled' | 'run.timeout'
  | 'step.tool_call' | 'step.final'
  | 'tool.started' | 'tool.completed' | 'tool.failed'
  | 'task.created' | 'task.completed' | 'task.failed'
  | 'artifact.created'
  // M7-P1：Approval 项（id 幂等演进：requested → approved/rejected/expired/cancelled）
  | 'approval.requested' | 'approval.approved' | 'approval.rejected' | 'approval.expired' | 'approval.cancelled'
  | 'usage.summary';

export interface TimelineItem {
  id: string;
  type: TimelineItemType;
  status: 'success' | 'failed' | 'running' | 'info';
  timestamp: string;
  title: string;
  summary?: string;
  durationMs?: number;
  /** 安全元数据（不包含 raw input/output/凭证） */
  metadata?: Record<string, unknown>;
}

export interface RunTimeline {
  runId: string;
  agentId: string;
  agentName: string;
  agentVersion: number;
  status: string;
  startedAt: string;
  completedAt: string | null;
  items: TimelineItem[];
  usage: RunUsageAggregate | null;
}
