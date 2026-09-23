import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError, ErrorCode, TaskIntent } from '@ai-agent/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKVService } from '../../core/circuit-breaker/redis-kv.service';
import { RouterService } from '../../core/router/router.service';
import { ContextAssembler } from '../../core/context/context-assembler';
import { ModelResolverService } from '../../providers/llm/model-resolver.service';
import { ResolvedLLM } from '../../providers/llm/llm-manager.service';
import { ChatMessage } from '../../providers/llm/llm.types';
import { Agent } from '../../agents/agent.types';
import { UsageService } from '../usage/usage.service';
import { ChatDto } from './chat.dto';
import { SSEWriter } from './sse-writer';

export interface ChatRunContext {
  conversationId: string; userMessageId: string; assistantMessageId: string;
  userMessage: string; history: ChatMessage[]; intent: TaskIntent;
  resolved: ResolvedLLM; lockKey: string; startedAt: number; userId: string;
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
    @Inject(ModelResolverService) private readonly modelResolver: ModelResolverService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject('CHAT_AGENT_FACTORY') private readonly agentFactory: AgentFactory,
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
      // 上下文组装统一走 ContextAssembler（M1 仅最近消息源；未来 Memory/RAG 在此扩展）
      const { messages: history } = await this.context.assemble({
        userId, conversationId: conversation.id, excludeMessageId: userMessage.id,
      });
      const intent = await this.router.classify({ userMessage: dto.message, attachments: [], history: history.slice(-2) });
      const resolved = await this.modelResolver.resolveDefaultLLM();
      // 意图落库可观测（M4 后台看分类命中率）
      await this.prisma.message.update({ where: { id: userMessage.id }, data: { intentType: intent.type, intentConfidence: intent.confidence } });
      return {
        conversationId: conversation.id, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id,
        userMessage: dto.message, history, intent, resolved, lockKey, startedAt, userId,
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
      const agent = this.agentFactory.create({ resolved: ctx.resolved });
      const events = agent.execute({
        userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.assistantMessageId,
        userMessage: ctx.userMessage, attachments: [], history: ctx.history, intent: ctx.intent,
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
    await this.usage.recordChatUsage({
      userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.assistantMessageId,
      providerId: ctx.resolved.providerId, modelId: ctx.resolved.modelId,
      inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
      latencyMs, status: status === 'completed' ? 'success' : 'failed', errorCode,
    }).catch((err) => this.logger.error(`用量记录失败: ${(err as Error).message}`));
    // 结构化日志（M5 统计：成本/成功率/latency/provider 健康度）
    this.logger.log({
      requestId, userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.assistantMessageId,
      provider: ctx.resolved.providerName, model: ctx.resolved.apiModelId, intentType: ctx.intent.type,
      latencyMs, status, errorCode, tokens: usage,
    }, 'chat 完成');
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
