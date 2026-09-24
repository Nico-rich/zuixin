import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { aggregateRunUsage } from '../usage/usage.service';
import { RunTimeline, TimelineItem, TimelineItemType } from './timeline.types';

/** 同 timestamp 时的确定性排序权重（run → step → tool → task → artifact → usage） */
const TYPE_ORDER: Record<TimelineItemType, number> = {
  'run.started': 0, 'run.completed': 0, 'run.failed': 0, 'run.cancelled': 0, 'run.timeout': 0,
  'step.tool_call': 1, 'step.final': 1,
  'tool.started': 2, 'tool.completed': 2, 'tool.failed': 2,
  'task.created': 3, 'task.completed': 3, 'task.failed': 3,
  'artifact.created': 4,
  'usage.summary': 5,
};

/** run 终态标题（全状态覆盖 + 兜底，避免 Partial 索引） */
const RUN_STATUS_TITLES: Record<string, string> = {
  completed: 'Agent 完成',
  failed: 'Agent 失败',
  cancelled: 'Agent 已取消',
  timeout: 'Agent 超时',
};

/**
 * Timeline 投影服务——只读投影，不写任何 Event 表。
 * 单次 run include 查询（steps/toolCalls/tasks+model/artifacts）+ UsageService 聚合（复用 P4，不重复计算）。
 * 敏感数据安全化：ToolCall raw input/output 不进 Timeline（summary 化）；凭证/内部路径零暴露。
 */
@Injectable()
export class AgentRunTimelineService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async build(userId: string, runId: string): Promise<RunTimeline> {
    const run = await this.prisma.agentRun.findFirst({
      where: { id: runId, userId },
      include: {
        steps: {
          orderBy: { stepIndex: 'asc' },
          include: { toolCalls: { orderBy: { startedAt: 'asc' } } },
        },
        agent: { select: { id: true, slug: true, name: true } },
        agentVersion: { select: { id: true, version: true, status: true } },
        tasks: { orderBy: { createdAt: 'asc' }, include: { model: { select: { name: true } } } },
        artifacts: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, '运行不存在');

    const items: TimelineItem[] = [];

    // 1. run 边界（终态映射：failed→run.failed，绝不伪装 completed）
    items.push({
      id: `run-${run.id}`, type: 'run.started', status: 'info',
      timestamp: run.startedAt.toISOString(), title: 'Agent 开始执行',
    });

    // 2. steps + toolCalls
    for (const step of run.steps) {
      if (step.type === 'tool_call') {
        items.push({
          id: `step-${step.id}`, type: 'step.tool_call',
          status: step.status === 'failed' ? 'failed' : 'info',
          timestamp: step.startedAt.toISOString(),
          title: `步骤 ${step.stepIndex + 1}`,
          summary: `${step.toolCalls.length} 个工具调用`,
          durationMs: step.completedAt ? step.completedAt.getTime() - step.startedAt.getTime() : undefined,
        });
        for (const call of step.toolCalls) {
          items.push({
            id: `tool-${call.id}`, type: 'tool.started', status: 'info',
            timestamp: call.startedAt.toISOString(),
            title: `🔧 ${call.toolName}`,
          });
          const failed = call.status === 'failed';
          items.push({
            id: `tool-end-${call.id}`, type: failed ? 'tool.failed' : 'tool.completed',
            status: failed ? 'failed' : 'success',
            timestamp: (call.completedAt ?? call.startedAt).toISOString(),
            title: failed ? `🔧 ${call.toolName}` : `🔧 ${call.toolName}`,
            summary: this.safeToolSummary(call.toolName, call.output),
            durationMs: call.durationMs ?? undefined,
          });
        }
      } else if (step.type === 'final') {
        const out = step.output as { finalStatus?: string } | null;
        items.push({
          id: `step-${step.id}`, type: 'step.final',
          status: step.status === 'completed' ? 'success' : 'failed',
          timestamp: (step.completedAt ?? step.startedAt).toISOString(),
          title: '最终回答',
          summary: out?.finalStatus === 'completed' ? '已完成' : '未正常完成',
        });
      }
    }

    // 3. GenerationTask（P3 关联 runId/toolCallId）
    for (const task of run.tasks) {
      const failed = task.status === 'failed' || task.status === 'cancelled';
      const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
      items.push({
        id: `task-${task.id}`, type: terminal ? (failed ? 'task.failed' : 'task.completed') : 'task.created',
        status: terminal ? (failed ? 'failed' : 'success') : 'running',
        timestamp: (terminal ? task.completedAt : task.createdAt)!.toISOString(),
        title: `${task.type === 'image' ? '🖼 图片生成' : '🎬 视频生成'}`,
        summary: task.statusMessage ?? task.status,
        durationMs: terminal && task.startedAt ? task.completedAt!.getTime() - task.startedAt.getTime() : undefined,
        metadata: { taskId: task.id, model: task.model?.name ?? undefined, progress: task.progress ?? undefined },
      });
    }

    // 4. Artifact（P3 关联 runId/toolCallId）
    for (const artifact of run.artifacts) {
      items.push({
        id: `artifact-${artifact.id}`, type: 'artifact.created', status: 'success',
        timestamp: artifact.createdAt.toISOString(),
        title: `📄 ${artifact.title}`,
        summary: artifact.summary ?? artifact.type,
        metadata: { artifactId: artifact.id, type: artifact.type },
      });
    }

    // 5. run 终态（按状态生成对应项，不伪造）
    const terminalType = {
      completed: 'run.completed', failed: 'run.failed',
      cancelled: 'run.cancelled', timeout: 'run.timeout',
      running: null, queued: null,
    }[run.status] as TimelineItemType | null;
    if (terminalType) {
      items.push({
        id: `run-end-${run.id}`, type: terminalType,
        status: run.status === 'completed' ? 'success' : 'failed',
        timestamp: (run.completedAt ?? run.startedAt).toISOString(),
        title: RUN_STATUS_TITLES[run.status] ?? run.status,
        durationMs: run.completedAt ? run.completedAt.getTime() - run.startedAt.getTime() : undefined,
      });
    }

    // 6. Usage 汇总（复用 P4 聚合，不重复计算）
    const usage = await aggregateRunUsage(this.prisma, userId, runId).catch(() => null);
    if (usage) {
      items.push({
        id: `usage-${run.id}`, type: 'usage.summary', status: 'info',
        timestamp: (run.completedAt ?? new Date()).toISOString(),
        title: '用量汇总',
        summary: `LLM 回合 ${usage.llmRounds} · 图片 ${usage.imageCount} · 视频 ${usage.videoSeconds}s · 失败 ${usage.failedCalls}`,
        metadata: {
          totalTokens: usage.totalTokens, totalCost: usage.totalCost,
          llmCost: usage.llmCost, imageCost: usage.imageCost, videoCost: usage.videoCost,
        },
      });
    }

    // 排序：timestamp ASC + 同 timestamp 按类型权重 + id 兜底（deterministic）
    items.sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp) ||
      ((TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)) ||
      a.id.localeCompare(b.id),
    );

    return {
      runId: run.id,
      agentId: run.agent.id,
      agentName: run.agent.name,
      agentVersion: run.agentVersion?.version ?? 0,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      items,
      usage,
    };
  }

  /** 安全摘要：只提取已知工具的结构化结果，绝不放 raw input/output/prompt */
  private safeToolSummary(toolName: string, output: unknown): string | undefined {
    const o = output as Record<string, unknown> | undefined;
    if (!o) return undefined;
    switch (toolName) {
      case 'image.generate': case 'video.generate':
        return `已创建生成任务`;
      case 'knowledge.search':
        return `找到 ${o.count ?? 0} 条相关片段`;
      case 'artifact.create':
        return '制品已创建';
      case 'memory.create_candidate':
        return '已记录记忆候选';
      default:
        return '执行完成';
    }
  }
}
