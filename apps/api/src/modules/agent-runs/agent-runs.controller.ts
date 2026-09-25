import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
import { Request, Response } from 'express';
import { AgentRunsService } from './agent-runs.service';
import { AgentRunTimelineService } from './agent-run-timeline.service';
import { CreateAgentRunSchema } from './agent-runs.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RateLimit, RateLimitGuard } from '../../core/rate-limit/rate-limit.guard';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { EventBusService, agentRunChannel } from '../../core/events/event-bus.service';
import { SSEWriter, SSESink } from '../chat/sse-writer';
import { TimelineItem } from './timeline.types';

const TERMINAL = ['completed', 'failed', 'cancelled', 'timeout'];

@Controller('agent-runs')
@UseGuards(JwtAuthGuard)
export class AgentRunsController {
  constructor(
    @Inject(AgentRunsService) private readonly runs: AgentRunsService,
    @Inject(AgentRunTimelineService) private readonly timeline: AgentRunTimelineService,
    @Inject(EventBusService) private readonly eventBus: EventBusService,
  ) {}

  @Get()
  list(@Req() req: Request & { user: AuthedUser }, @Query('conversationId') conversationId?: string) {
    if (!conversationId) throw new AppError(ErrorCode.VALIDATION_ERROR, '缺少 conversationId');
    return this.runs.listByConversation(req.user.userId, conversationId);
  }

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.runs.get(req.user.userId, id);
  }

  /** M6-P3 异步入口：创建即返回（201 {runId, status:'queued'}），执行在 Worker 进程；M7-P9 限流 60/min */
  @Post()
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'agent-run-create', limit: 300, windowMs: 60_000 })
  @UsePipes(new ZodValidationPipe(CreateAgentRunSchema))
  create(@Req() req: Request & { user: AuthedUser }, @Body() dto: { agentId?: string; conversationId?: string | null; projectId?: string | null; message: string }) {
    return this.runs.createAsync(req.user.userId, dto);
  }

  /** Timeline 投影（持久化历史；浏览器刷新后可完整恢复，不依赖 SSE） */
  @Get(':id/timeline')
  timelineOf(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.timeline.build(req.user.userId, id);
  }

  /** M6-P5 Cancel：queued/running/waiting → cancelled（原子条件更新；已终态 409，越权 404） */
  @Post(':id/cancel')
  cancel(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.runs.cancel(req.user.userId, id);
  }

  /** M6-P5 Retry：终态 run → 新 run（retryOfRunId 血缘 + attempt+1；幂等唯一索引，越权 404） */
  @Post(':id/retry')
  retry(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.runs.retry(req.user.userId, id);
  }

  /**
   * M6-P6 SSE 观察端点（GET /agent-runs/:id/events）：
   * - 连接建立 → timeline.snapshot（Timeline 投影 items，确定性排序）；
   * - 随后实时转发 worker 经 EventBus 发布的 agent-run:{runId} 通道事件（尽力而为）；
   * - Last-Event-ID（SSE 标准头）：重连时按投影确定性顺序过滤，只补缺失段——丢失的实时事件由快照补齐；
   * - 断线不影响 Runtime（执行在 worker；本端点只读 DB + 总线）；run 已终态 → 快照即最终事实，流结束；
   * - 越权/不存在 → 404（防枚举）。
   */
  @Get(':id/events')
  async events(
    @Req() req: Request & { user: AuthedUser },
    @Res() res: Response,
    @Param('id') id: string,
    @Headers('last-event-id') lastEventId?: string,
  ) {
    const run = await this.runs.getStatus(req.user.userId, id); // 归属校验（404 防枚举）
    const snapshot = await this.timeline.build(req.user.userId, id);
    const terminal = TERMINAL.includes(run.status);

    const writer = new SSEWriter(res as unknown as SSESink);
    writer.init();
    const heartbeat = setInterval(() => writer.ping(), 15000);
    try {
      // 断点过滤：按投影确定性排序（timestamp → TYPE_ORDER → id）只补缺失段；未知 id → 全量（客户端自行去重）
      const items = filterAfter(snapshot.items, lastEventId);
      writer.event('timeline.snapshot', {
        runId: id, status: run.status,
        agentName: snapshot.agentName, agentVersion: snapshot.agentVersion,
        startedAt: snapshot.startedAt, completedAt: snapshot.completedAt,
        items,
        usage: snapshot.usage,
        terminal,
      });
      if (terminal) return; // 终态：投影即最终事实（P6-6 完成后重连可见最终状态）

      // 实时转发；run 到达终态事件时主动收流（干净 EOF——客户端知道观察结束）
      let resolveClose: (() => void) | null = null;
      const handler = (evt: Record<string, unknown>) => {
        writer.event((evt.type as string) ?? 'event', evt);
        if (['run.completed', 'run.failed', 'run.cancelled', 'run.timeout'].includes(evt.type as string) && resolveClose) {
          resolveClose();
        }
      };
      await this.eventBus.subscribe(agentRunChannel(id), handler);
      await new Promise<void>((resolve) => {
        resolveClose = resolve;
        res.on('close', () => resolve()); // 客户端断开即返回（SSE 断线不影响 Runtime）
      });
      resolveClose = null;
      this.eventBus.unsubscribe(agentRunChannel(id), handler);
    } finally {
      clearInterval(heartbeat);
      writer.end();
    }
  }
}

/**
 * Last-Event-ID 断点过滤：items 已按 (timestamp, TYPE_ORDER, id) 确定性排序。
 * 断点项本身重发（snapshot items 是 id 幂等的 upsert——同一事实的状态演进，如 task.created → task.completed
 * 同 id 不同 type），只跳过断点之前的段；未知 id（异常/旧客户端）→ 全量，客户端按 id upsert。
 */
function filterAfter(items: TimelineItem[], lastEventId: string | undefined): TimelineItem[] {
  if (!lastEventId) return items;
  const idx = items.findIndex((i) => i.id === lastEventId);
  return idx >= 0 ? items.slice(idx) : items;
}
