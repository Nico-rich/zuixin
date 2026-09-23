import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError, ErrorCode, TaskIntent } from '@ai-agent/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { RedisKVService } from '../../core/circuit-breaker/redis-kv.service';
import { RouterService } from '../../core/router/router.service';
import { ContextAssembler } from '../../core/context/context-assembler';
import { MemoryExtractor, MEMORY_EXTRACTOR } from '../../core/memory/memory-extractor';
import { ModelResolverService } from '../../providers/llm/model-resolver.service';
import { ResolvedLLM } from '../../providers/llm/llm-manager.service';
import { ChatMessage } from '../../providers/llm/llm.types';
import { Agent, AttachmentMeta } from '../../agents/agent.types';
import { UsageService } from '../usage/usage.service';
import { ChatDto } from './chat.dto';
import { SSEWriter } from './sse-writer';

export interface ChatRunContext {
  conversationId: string; userMessageId: string; assistantMessageId: string;
  userMessage: string; history: ChatMessage[]; intent: TaskIntent;
  /** chat 意图必有；生图等非 LLM 意图为 null（按需解析，省一次模型调用） */
  resolved: ResolvedLLM | null;
  lockKey: string; startedAt: number; userId: string;
  projectId?: string | null;
  attachments: AttachmentMeta[];
}

export interface AgentFactory {
  create(input: { resolved: ResolvedLLM }): Agent;
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
    @Inject(ModelResolverService) private readonly modelResolver: ModelResolverService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject('CHAT_AGENT_FACTORY') private readonly agentFactory: AgentFactory,
    @Inject('IMAGE_AGENT_FACTORY') private readonly imageAgentFactory: { create: () => Agent },
    @Inject('VIDEO_AGENT_FACTORY') private readonly videoAgentFactory: { create: () => Agent },
  ) {}

  /** 第一步（HTTP 阶段，出错走统一 JSON envelope）：会话/锁/消息/路由/模型 */
  async prepareChat(userId: string, dto: ChatDto, requestId: string): Promise<ChatRunContext> {
    const startedAt = Date.now();
    const conversation = dto.conversationId
      ? await this.requireConversation(userId, dto.conversationId)
      : await this.createConversation(userId, dto.projectId);

    const lockKey = `chat:lock:${conversation.id}`;
    const locked = await this.kv.setNX(lockKey, requestId, 120);
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
      // 仅 LLM 类意图解析 LLM（生图等直接走各自 Agent，不浪费一次模型解析）
      const resolved = intent.type === 'chat' ? await this.modelResolver.resolveDefaultLLM() : null;
      // 意图落库可观测（M4 后台看分类命中率）
      await this.prisma.message.update({ where: { id: userMessage.id }, data: { intentType: intent.type, intentConfidence: intent.confidence } });
      return {
        conversationId: conversation.id, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id,
        userMessage: dto.message, history, intent, resolved, lockKey, startedAt, userId,
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
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let finalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
    let errorCode: string | undefined;

    try {
      writer.event('message_start', { type: 'message_start', messageId: ctx.assistantMessageId, conversationId: ctx.conversationId, role: 'assistant', createdAt: new Date().toISOString() });
      // 按意图选择 Agent（M2：chat / image；M3：+video；M4 起走 DB 配置的 Agent 注册表）
      const agent = ctx.intent.type === 'image_generation'
        ? this.imageAgentFactory.create()
        : ctx.intent.type === 'video_generation'
          ? this.videoAgentFactory.create()
          : this.agentFactory.create({ resolved: ctx.resolved! });
      const events = agent.execute({
        userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.assistantMessageId,
        userMessage: ctx.userMessage, attachments: ctx.attachments, history: ctx.history, intent: ctx.intent,
        mode: 'normal', signal,
      });
      for await (const ev of events) {
        switch (ev.type) {
          case 'status': writer.event('status', ev); break;
          case 'text.delta': buffer += ev.text; writer.event('message_delta', { type: 'message_delta', delta: ev.text }); break;
          case 'task.created': writer.event('task.created', ev); break;
          case 'done':
            usage = (ev as { usage?: { inputTokens: number; outputTokens: number } }).usage;
            writer.event('message_end', { type: 'message_end', messageId: ctx.assistantMessageId, status: 'completed' });
            break;
          case 'error':
            errorCode = ev.code; finalStatus = 'failed';
            writer.event('error', { type: 'error', code: ev.code, message: ev.message, requestId });
            writer.event('message_end', { type: 'message_end', messageId: ctx.assistantMessageId, status: 'failed' });
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
      await this.finalize(ctx, buffer, finalStatus, errorCode, usage, requestId);
      await this.kv.del(ctx.lockKey).catch(() => undefined);
    }
  }

  private async finalize(
    ctx: ChatRunContext, content: string, status: 'completed' | 'failed' | 'cancelled',
    errorCode: string | undefined, usage: { inputTokens: number; outputTokens: number } | undefined, requestId: string,
  ) {
    const latencyMs = Date.now() - ctx.startedAt;
    await this.prisma.message.update({
      where: { id: ctx.assistantMessageId },
      data: { content, status, errorCode, tokenUsage: usage ?? undefined },
    }).catch((err) => this.logger.error(`消息落库失败: ${(err as Error).message}`));
    if (ctx.resolved) {
      await this.usage.recordChatUsage({
        userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.assistantMessageId,
        providerId: ctx.resolved.providerId, modelId: ctx.resolved.modelId,
        inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
        latencyMs, status: status === 'completed' ? 'success' : 'failed', errorCode,
      }).catch((err) => this.logger.error(`用量记录失败: ${(err as Error).message}`));
    }
    // 记忆提取：fire-and-forget，不阻塞 SSE 收尾；失败/无候选静默（提取器内部兜底）
    if (status === 'completed' && content) {
      void this.memoryExtractor.extractCandidates({
        userId: ctx.userId, conversationId: ctx.conversationId, projectId: ctx.projectId ?? undefined,
        userMessage: ctx.userMessage, assistantReply: content, sourceMessageId: ctx.assistantMessageId,
      }).catch(() => undefined);
    }
    // 结构化日志（M5 统计：成本/成功率/latency/provider 健康度）
    this.logger.log({
      requestId, userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.assistantMessageId,
      provider: ctx.resolved?.providerName ?? 'none', model: ctx.resolved?.apiModelId ?? 'none', intentType: ctx.intent.type,
      latencyMs, status, errorCode, tokens: usage,
    }, 'chat 完成');
  }

  private async requireConversation(userId: string, id: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id, userId, deletedAt: null } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '对话不存在');
    return c;
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

  /** 新建会话：可挂载到用户自己的项目 */
  private async createConversation(userId: string, projectId?: string | null) {
    if (projectId) {
      const p = await this.prisma.project.findFirst({ where: { id: projectId, userId, deletedAt: null } });
      if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
    }
    return this.prisma.conversation.create({ data: { userId, projectId: projectId ?? null } });
  }
}
