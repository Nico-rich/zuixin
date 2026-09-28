import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError, ErrorCode, TaskIntent } from '@ai-agent/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { RedisKVService } from '../../core/circuit-breaker/redis-kv.service';
import { RouterService } from '../../core/router/router.service';
import { ContextAssembler } from '../../core/context/context-assembler';
import { MemoryExtractor, MEMORY_EXTRACTOR } from '../../core/memory/memory-extractor';
import { SummaryRefinerService } from '../../core/memory/summary-refiner.service';
import { MemoryCandidateService } from '../../core/memory/memory-candidate.service';
import { AgentRegistryService } from '../../agents/agent-registry.service';
import { AttachmentMeta } from '../../agents/agent.types';
import { ChatMessage } from '../../providers/llm/llm.types';
import { QuotaService } from '../billing/quota.service';
import { ChatDto } from './chat.dto';
import { SSEWriter } from './sse-writer';

export interface ChatRunContext {
  conversationId: string; userMessageId: string; assistantMessageId: string;
  userMessage: string; history: ChatMessage[]; intent: TaskIntent;
  lockKey: string; startedAt: number; userId: string;
  projectId?: string | null;
  attachments: AttachmentMeta[];
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger('Chat');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisKVService) private readonly kv: RedisKVService,
    @Inject(RouterService) private readonly router: RouterService,
    @Inject(ContextAssembler) private readonly context: ContextAssembler,
    @Inject(AttachmentsService) private readonly attachmentsService: AttachmentsService,
    @Inject(MEMORY_EXTRACTOR) private readonly memoryExtractor: MemoryExtractor,
    @Inject(AgentRegistryService) private readonly agentRegistry: AgentRegistryService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(SummaryRefinerService) private readonly summaryRefiner: SummaryRefinerService,
    @Inject(MemoryCandidateService) private readonly memoryCandidates: MemoryCandidateService,
  ) {}

  /** 第一步（HTTP 阶段，出错走统一 JSON envelope）：会话/锁/消息/路由/上下文 */
  async prepareChat(userId: string, dto: ChatDto, requestId: string): Promise<ChatRunContext> {
    const startedAt = Date.now();
    const conversation = dto.conversationId
      ? await this.requireConversation(userId, dto.conversationId)
      : await this.createConversation(userId, dto.projectId);

    const lockKey = `chat:lock:${conversation.id}`;
    // Pre-M9 G4 降级（**fail-closed**）：会话锁是**正确性面**（同一会话单写者：并发生成会双写 assistant 消息、
    // 双扣配额、上下文错乱）。Redis 不可用/超时时无法证明互斥 → 显式拒绝（500 + 明确文案），
    // 绝不"以为拿到锁"放行。取舍：Redis 故障期间该会话不可用（优于静默数据错乱）。
    let locked: boolean;
    try {
      locked = await this.kv.setNX(lockKey, requestId, 120);
    } catch (err) {
      this.logger.error(`会话锁获取失败（Redis 不可用/超时 → 拒绝本次生成）: ${(err as Error).message}`);
      throw new AppError(ErrorCode.INTERNAL, '会话锁服务暂不可用，请稍后重试');
    }
    if (!locked) throw new AppError(ErrorCode.CONCURRENT_CHAT, '上一条消息仍在生成中，请稍候');

    try {
      const userMessage = await this.prisma.message.create({
        data: { conversationId: conversation.id, userId, role: 'user', content: dto.message },
      });
      if (conversation.title === '新对话') {
        await this.prisma.conversation.update({ where: { id: conversation.id }, data: { title: dto.message.slice(0, 30) } });
      }
      const assistantMessage = await this.prisma.message.create({
        data: { conversationId: conversation.id, userId, role: 'assistant', content: '', status: 'streaming' },
      });
      // Pre-M9 R3：sync /chat 进入统一配额体系（llm_tokens；超限 429 于生成前——
      // 账本镜像由 UsageService 在每条 usage_record 写入时派生，本路径无需另计）。
      // C1：assistantMessageId 作预留 refId（finalize 释放；TTL 兜底）。
      await this.quota.assertQuota(userId, conversation.projectId ?? null, 'llm_tokens', 1, assistantMessage.id);
      const attachments = await this.resolveAttachments(userId, dto.attachmentIds);
      // 上下文组装统一走 ContextAssembler（最近消息 + 项目/用户记忆；未来 Summary/RAG 在此扩展）
      const { messages: history, blocks } = await this.context.assemble({
        userId, conversationId: conversation.id, projectId: conversation.projectId ?? undefined, excludeMessageId: userMessage.id,
      });
      // 意图分类只看真实对话（记忆块不进 Router——"用户偏好主图尺寸"不应触发生图意图）
      const conversationOnly = blocks
        .map((b, i) => ({ scope: b.scope, message: history[i] }))
        .filter((x) => x.scope === 'conversation')
        .map((x) => x.message);
      const intent = await this.router.classify({ userMessage: dto.message, attachments: [], history: conversationOnly.slice(-2) });
      // 意图落库可观测（M4 后台看分类命中率）
      await this.prisma.message.update({ where: { id: userMessage.id }, data: { intentType: intent.type, intentConfidence: intent.confidence } });
      return {
        conversationId: conversation.id, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id,
        userMessage: dto.message, history, intent, lockKey, startedAt, userId,
        projectId: conversation.projectId, attachments,
      };
    } catch (err) {
      await this.kv.del(lockKey).catch(() => undefined);
      throw err;
    }
  }

  /** 第二步（SSE 阶段）：Agent 事件流 → 线上协议；无论成败终态必落库 */
  async streamChat(ctx: ChatRunContext, writer: SSEWriter, signal: AbortSignal, requestId: string): Promise<void> {
    let buffer = '';
    let finalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
    let errorCode: string | undefined;

    try {
      writer.event('message_start', { type: 'message_start', messageId: ctx.assistantMessageId, conversationId: ctx.conversationId, role: 'assistant', createdAt: new Date().toISOString() });
      // 意图 → Agent（DB 注册表；M1~M3 行为兼容：chat/image/video 映射与 seed agentMapping 一致）
      const agent = await this.agentRegistry.resolveForIntent(ctx.intent);
      const events = agent.execute({
        userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.assistantMessageId,
        projectId: ctx.projectId ?? undefined,
        userMessage: ctx.userMessage, attachments: ctx.attachments, history: ctx.history, intent: ctx.intent,
        mode: 'normal', signal,
      });
      for await (const ev of events) {
        switch (ev.type) {
          case 'status': writer.event('status', ev); break;
          case 'text.delta': buffer += ev.text; writer.event('message_delta', { type: 'message_delta', delta: ev.text }); break;
          case 'task.created': writer.event('task.created', ev); break;
          case 'done':
            writer.event('message_end', { type: 'message_end', messageId: ctx.assistantMessageId, status: 'completed' });
            break;
          case 'agent.start': case 'agent.end': case 'tool.start': case 'tool.end':
          case 'run.created': case 'run.progress': case 'run.completed':
            writer.event(ev.type, ev);
            if (ev.type === 'agent.end') {
              if (ev.status === 'completed') writer.event('message_end', { type: 'message_end', messageId: ctx.assistantMessageId, status: 'completed' });
              else if (ev.status === 'cancelled') {
                finalStatus = 'cancelled';
                writer.event('message_end', { type: 'message_end', messageId: ctx.assistantMessageId, status: 'stopped' });
              } else {
                finalStatus = 'failed';
                writer.event('message_end', { type: 'message_end', messageId: ctx.assistantMessageId, status: 'failed' });
              }
            }
            break;
          case 'error':
            errorCode = ev.code; finalStatus = 'failed';
            writer.event('error', { type: 'error', code: ev.code, message: ev.message, requestId });
            break;
        }
      }
    } catch (err) {
      if (signal.aborted || (err as { name?: string }).name === 'AbortError') {
        finalStatus = 'cancelled'; // 用户主动停止，保留部分内容
      } else {
        const appErr = err instanceof AppError ? err : new AppError(ErrorCode.PROVIDER_UNKNOWN, (err as Error).message);
        errorCode = appErr.code; finalStatus = 'failed';
        writer.event('error', { type: 'error', code: appErr.code, message: appErr.message, requestId });
        writer.event('message_end', { type: 'message_end', messageId: ctx.assistantMessageId, status: 'failed' });
      }
    } finally {
      await this.finalize(ctx, buffer, finalStatus, errorCode, requestId);
      // Pre-M9 C1：终态释放配额预留（释放丢失由 TTL 兜底）
      await this.quota.release(ctx.assistantMessageId, 'llm_tokens').catch(() => undefined);
      await this.kv.del(ctx.lockKey).catch(() => undefined);
    }
  }

  private async finalize(ctx: ChatRunContext, content: string, status: 'completed' | 'failed' | 'cancelled', errorCode: string | undefined, requestId: string) {
    const latencyMs = Date.now() - ctx.startedAt;
    await this.prisma.message.update({
      where: { id: ctx.assistantMessageId },
      data: { content, status, errorCode },
    }).catch((err) => this.logger.error(`消息落库失败: ${(err as Error).message}`));
    // 记忆提取：fire-and-forget，不阻塞 SSE 收尾；失败/无候选静默（提取器内部兜底）
    if (status === 'completed' && content) {
      void this.memoryExtractor.extractCandidates({
        userId: ctx.userId, conversationId: ctx.conversationId, projectId: ctx.projectId ?? undefined,
        userMessage: ctx.userMessage, assistantReply: content, sourceMessageId: ctx.assistantMessageId,
      }).catch(() => undefined);
      // M9-P2：增量摘要 + 候选提炼（同一 fire-and-forget 语义；两个服务内部各自兜底，绝不抛错）
      void this.advanceMemory(ctx).catch(() => undefined);
    }
    // 结构化日志（LLM 用量由 AgentLoop 记录并关联 runId；本行只记录会话维度）
    this.logger.log({
      requestId, userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.assistantMessageId,
      intentType: ctx.intent.type, latencyMs, status, errorCode,
    }, 'chat 完成');
  }

  /**
   * M9-P2 记忆推进（fire-and-forget）：增量摘要达到阈值 → 新建版本段 → 从**该段真实对话行**提炼候选。
   * 顺序固定：先摘要后提炼（候选需 sourceSummaryId 追溯）；任一步失败静默（不阻塞/不影响聊天）。
   */
  private async advanceMemory(ctx: ChatRunContext): Promise<void> {
    const refined = await this.summaryRefiner.maybeRefine(ctx.conversationId, {
      userId: ctx.userId, projectId: ctx.projectId ?? undefined,
    });
    for (const version of refined.created) {
      await this.memoryCandidates.extractFromSummary(version.id).catch(() => undefined);
    }
  }

  /** 解析消息附件：M2 仅图片进入 Agent 上下文（vision/参考图，base64 data URL）；其他文件仅可下载 */
  private async resolveAttachments(userId: string, ids?: string[]): Promise<AttachmentMeta[]> {
    if (!ids?.length) return [];
    const metas: AttachmentMeta[] = [];
    for (const id of ids) {
      const att = await this.attachmentsService.getById(userId, id);
      const url = await this.attachmentsService.imageDataUrl(att);
      if (att.type === 'image' && url) {
        metas.push({ id: att.id, type: 'image', mimeType: att.mimeType, url });
      }
    }
    return metas;
  }

  private async requireConversation(userId: string, id: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id, userId, deletedAt: null } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '对话不存在');
    return c;
  }

  /** 新建会话：可挂载到用户自己的项目 */
  private async createConversation(userId: string, projectId?: string | null) {
    if (projectId) {
      const p = await this.prisma.project.findFirst({ where: { id: projectId, userId, deletedAt: null } });
      if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
    }
    return this.prisma.conversation.create({ data: { userId, projectId: projectId ?? null } });
  }
}
