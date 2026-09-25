import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { LIMITS } from '@ai-agent/shared';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { mapProviderError, ProviderLikeError } from '../../common/errors/provider-error';
import { PrismaService } from '../prisma/prisma.service';
import { StorageAdapter } from '../../core/storage/storage.types';
import { EventBusService } from '../../core/events/event-bus.service';
import { UsageService } from '../usage/usage.service';
import { IMAGE_QUEUE, VIDEO_QUEUE } from '../../core/queue/queue.module';
import { MediaExecutor, MediaExecResult } from './media-types';
import { AgentRunResumeTrigger } from '../../core/agent-run-resume/agent-run-resume-trigger.service';
import { QuotaService } from '../billing/quota.service';

export interface PrepareMediaInput {
  userId: string;
  type: 'image' | 'video';
  conversationId?: string;
  messageId?: string;
  params: Record<string, unknown>;
  /** 幂等键（ToolCall 透传）：UNIQUE 兜底，同一 ToolCall 重试绝不产生第二个任务 */
  idempotencyKey?: string;
  /** AgentRun/ToolCall 追溯（非 Agent 场景留空——由调用链显式传递，服务不自行猜测） */
  runId?: string;
  toolCallId?: string;
}

const MAX_DOWNLOAD_ATTEMPTS = 3;

/**
 * 统一媒体生成基础设施（M3 演进自 ImageGenerationService）：
 * Chat / 未来 Agent / Workflow 平等入口 → GenerationTask 生命周期 → MediaExecutor（image/video 各自独立）。
 *
 * 任务生命周期保证（M3 可靠性要求）：
 * - 原子 claim：updateMany({status:'pending'}→processing)，多 Worker/重复消费安全；
 * - 全局超时：executor 内绝对 deadline 检查 + 独立清扫 job（media-cleanup）兜底；
 * - 单任务单结果：终态写入全部条件更新（status='processing'），清扫竞态下不会产生第二个结果；
 * - usage 归因：attempt 时即写 task.providerId/modelId，失败也有归因。
 */
@Injectable()
export class MediaGenerationService {
  private readonly logger = new Logger('MediaGeneration');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject('STORAGE_ADAPTER') private readonly storage: StorageAdapter,
    @Inject(EventBusService) private readonly events: EventBusService,
    @Inject(UsageService) private readonly usage: UsageService,
    @InjectQueue(IMAGE_QUEUE) private readonly imageQueue: Queue,
    @InjectQueue(VIDEO_QUEUE) private readonly videoQueue: Queue,
    @Inject('MEDIA_EXECUTORS') private readonly executors: Map<string, MediaExecutor>,
    @Inject(AgentRunResumeTrigger) private readonly resume: AgentRunResumeTrigger,
    @Inject(QuotaService) private readonly quota: QuotaService,
  ) {}

  /** 便捷入口：图片任务（M2 API 兼容） */
  prepareImageTask(input: Omit<PrepareMediaInput, 'type'>) {
    return this.prepareMediaTask({ ...input, type: 'image' });
  }

  /** 便捷入口：视频任务 */
  prepareVideoTask(input: Omit<PrepareMediaInput, 'type'>) {
    return this.prepareMediaTask({ ...input, type: 'video' });
  }

  /** 入口 1（HTTP 侧）：组织配额裁决（Pre-M9 A3：计划权益，绝不读 systemSetting 全局日限）+ 建任务(pending) + 按类型入队 */
  async prepareMediaTask(input: PrepareMediaInput) {
    // A3：媒体限额并入 Plan entitlements（imageDaily/videoDaily/imageMonthly/videoSecondsMonthly）；
    // 项目归属经会话解析（个人会话 → 个人组织），与 organizationFor 语义一致
    const projectId = input.conversationId
      ? (await this.prisma.conversation.findUnique({ where: { id: input.conversationId }, select: { projectId: true } }).catch(() => null))?.projectId ?? null
      : null;
    const params = input.params as { count?: number; n?: number; duration?: number };
    const quantity = input.type === 'image'
      ? Math.min(Math.max(Number(params.count ?? params.n ?? 1) || 1, 1), 50)
      : (Number(params.duration) || 5);
    // Pre-M9 C1：taskId 预生成作预留 refId（终态释放见 execute/failTask/清扫；TTL 兜底）
    const taskId = randomUUID();
    await this.quota.assertQuota(input.userId, projectId, input.type === 'image' ? 'image_generation' : 'video_seconds', quantity, taskId);

    try {
      const task = await this.prisma.generationTask.create({
        data: {
          id: taskId,
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          type: input.type,
          status: 'pending',
          statusMessage: '排队中',
          input: input.params as never,
          idempotencyKey: input.idempotencyKey,
          runId: input.runId,
          toolCallId: input.toolCallId,
        },
      });
      const queue = input.type === 'image' ? this.imageQueue : this.videoQueue;
      await queue.add('generate', { taskId: task.id }, { attempts: 1, removeOnComplete: true, removeOnFail: true });
      return task;
    } catch (err) {
      // 幂等键冲突（UNIQUE）：同一 ToolCall 重试 → 返回已有任务，绝不产生第二个任务
      if (input.idempotencyKey && (err as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.generationTask.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (existing) {
          this.logger.warn({ taskId: existing.id }, '幂等键命中，返回已有任务');
          return existing;
        }
      }
      throw err;
    }
  }

  /** 入口 2（Worker 侧）：统一任务执行——终态必落库、单任务单结果 */
  async executeTask(taskId: string): Promise<void> {
    const task = await this.prisma.generationTask.findUnique({ where: { id: taskId } });
    if (!task || task.status !== 'pending') return; // 已取消/已处理/已清扫 → 幂等跳过

    // 原子 claim（多 Worker / 队列重复消费安全）
    const claimed = await this.prisma.generationTask.updateMany({
      where: { id: taskId, status: 'pending' },
      data: { status: 'processing', statusMessage: '处理中', startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return;
    const startedAt = Date.now();

    const executor = this.executors.get(task.type);
    if (!executor) {
      await this.failTask(taskId, ErrorCode.INTERNAL, `未注册的媒体执行器: ${task.type}`, startedAt);
      return;
    }

    const deadline = startedAt + (task.type === 'video' ? LIMITS.VIDEO_TASK_TIMEOUT_MS : LIMITS.IMAGE_TASK_TIMEOUT_MS);
    const ctx = {
      task,
      deadline,
      publishProgress: async (progress: number, message: string) => {
        await this.events.publish('task', { type: 'task.progress', taskId, progress, message });
        await this.prisma.generationTask.update({ where: { id: taskId }, data: { progress, statusMessage: message } }).catch(() => undefined);
      },
      setProviderAttempt: async (providerId: string, modelId: string) => {
        await this.prisma.generationTask.update({ where: { id: taskId }, data: { providerId, modelId } }).catch(() => undefined);
      },
      setRemoteTaskId: async (remoteTaskId: string) => {
        await this.prisma.generationTask.update({ where: { id: taskId }, data: { remoteTaskId } }).catch(() => undefined);
      },
    };

    try {
      await ctx.publishProgress(10, task.type === 'image' ? '正在生成图片…' : '正在生成视频…');
      const result = await executor.execute(ctx);
      await ctx.publishProgress(80, '正在保存结果…');

      const files = await this.storeFiles(task, result);
      // 条件完成：若已被清扫 job 标 failed（慢 Worker 竞态），放弃写入并回收附件
      const done = await this.prisma.generationTask.updateMany({
        where: { id: taskId, status: 'processing' },
        data: {
          status: 'completed', statusMessage: '完成', progress: 100, completedAt: new Date(),
          providerId: result.providerId, modelId: result.modelId,
          output: { attachments: files.map((a) => a.id) },
        },
      });
      if (done.count === 0) {
        await this.prisma.attachment.deleteMany({ where: { id: { in: files.map((a) => a.id) } } }).catch(() => undefined);
        this.logger.warn({ taskId }, '任务已被清扫为失败，放弃完成写入并回收附件');
        return;
      }
      await this.usage.recordMediaUsage({
        userId: task.userId, conversationId: task.conversationId ?? undefined, messageId: task.messageId ?? undefined, taskId,
        kind: task.type, providerId: result.providerId, modelId: result.modelId,
        imageCount: result.imageCount, videoSeconds: result.videoSeconds,
        latencyMs: Date.now() - startedAt, status: 'success', runId: task.runId ?? undefined,
      });
      await this.events.publish('task', { type: 'task.completed', taskId, progress: 100 });
      // M6-P4：任务终态单点 hook → 唤醒 waiting 的 AgentRun（waiting→queued→resume）
      await this.resume.onTaskTerminal(taskId).catch(() => undefined);
      // Pre-M9 D1：媒体账本行由 UsageService.recordMediaUsage 派生镜像（ur:{recordId} 幂等键）——本处不再直写
      // Pre-M9 C1：终态释放配额预留
      await this.quota.release(taskId, task.type === 'image' ? 'image_generation' : 'video_seconds').catch(() => undefined);
      this.logger.log({ taskId, userId: task.userId, type: task.type, provider: result.providerId, latencyMs: Date.now() - startedAt }, '媒体任务完成');
    } catch (err) {
      const appErr = err instanceof AppError ? err : mapProviderError(err as ProviderLikeError);
      await this.failTask(taskId, appErr.code, appErr.message, startedAt);
    }
  }

  /** 失败终态（条件更新，不覆盖已终态的任务）；usage 失败归因取自 attempt 时写入的 provider/model */
  private async failTask(taskId: string, code: string, message: string, startedAt: number) {
    const current = await this.prisma.generationTask.findUnique({ where: { id: taskId } });
    const failed = await this.prisma.generationTask.updateMany({
      where: { id: taskId, status: 'processing' },
      data: { status: 'failed', statusMessage: message, errorCode: code, errorMessage: message, completedAt: new Date() },
    });
    if (failed.count === 0) return; // 已被清扫/其他路径终态
    await this.usage.recordMediaUsage({
      userId: current!.userId, conversationId: current!.conversationId ?? undefined, messageId: current!.messageId ?? undefined, taskId,
      kind: current!.type, providerId: current!.providerId ?? '', modelId: current!.modelId ?? '',
      imageCount: 0, videoSeconds: 0, latencyMs: Date.now() - startedAt, status: 'failed', errorCode: code,
      runId: current!.runId ?? undefined, // M6-A9：失败归因补齐 runId（与成功/清扫路径一致）
    }).catch(() => undefined);
    await this.events.publish('task', { type: 'task.progress', taskId, progress: 100, message: '失败' });
    // M6-P4：任务失败也是终态 → 唤醒 run（P4-9：失败回喂模型，由 LLM 决定重试/降级/终态）
    await this.resume.onTaskTerminal(taskId).catch(() => undefined);
    // Pre-M9 C1：失败终态释放配额预留（失败用量 attempt 记 1 次由 usage 镜像覆盖——本处不再直写账本）
    await this.quota.release(taskId, current!.type === 'image' ? 'image_generation' : 'video_seconds').catch(() => undefined);
    this.logger.warn({ taskId, code, provider: current!.providerId ?? 'unknown' }, `媒体任务失败: ${message}`);
  }

  /** 下载（data URL 或 http）→ 转存对象存储 → attachments（kind 按任务类型） */
  private async storeFiles(task: { id: string; userId: string; conversationId: string | null; messageId: string | null; type: string }, result: MediaExecResult) {
    const attachments = [];
    const defaultMime = task.type === 'video' ? 'video/mp4' : 'image/png';
    const ext = task.type === 'video' ? '.mp4' : '.png';
    for (const file of result.files) {
      const buffer = await this.download(file.url);
      const mimeType = file.mimeType ?? defaultMime;
      const now = new Date();
      const storageKey = `${task.userId}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${randomUUID()}${ext}`;
      const { Readable } = await import('node:stream');
      await this.storage.put(storageKey, Readable.from(buffer), { contentType: mimeType, sizeBytes: buffer.length });
      const att = await this.prisma.attachment.create({
        data: {
          userId: task.userId, conversationId: task.conversationId, messageId: task.messageId,
          kind: task.type === 'video' ? 'generated_video' : 'generated_image',
          type: task.type === 'video' ? 'video' : 'image',
          mimeType, storageKey,
          originalName: `generated-${task.id.slice(0, 8)}${ext}`,
          sizeBytes: buffer.length,
          metadata: (file.metadata ?? undefined) as never,
          status: 'ready', taskId: task.id,
        },
      });
      attachments.push(att);
    }
    return attachments;
  }

  private async download(url: string): Promise<Buffer> {
    if (url.startsWith('data:')) return Buffer.from(url.split(',')[1], 'base64');
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`下载失败: ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        if (attempt === MAX_DOWNLOAD_ATTEMPTS) throw new AppError(ErrorCode.PROVIDER_UNKNOWN, `结果下载失败: ${(err as Error).message}`);
      }
    }
    throw new AppError(ErrorCode.PROVIDER_UNKNOWN, '结果下载失败');
  }
}
