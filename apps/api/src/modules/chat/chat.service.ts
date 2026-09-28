import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
import { ChatDto, EditMessageDto } from './chat.dto';
import { MessageMutationOp, messageMutationForbidden } from './message-forbidden';
import { SSEWriter } from './sse-writer';

export interface ChatRunContext {
  conversationId: string; userMessageId: string; assistantMessageId: string;
  userMessage: string; history: ChatMessage[]; intent: TaskIntent;
  lockKey: string; startedAt: number; userId: string;
  projectId?: string | null;
  attachments: AttachmentMeta[];
}

/** M10-P3 消息编辑/删除的响应投影（只暴露客户端渲染所需字段，不外泄内部列） */
const MESSAGE_MUTATION_SELECT = {
  id: true, conversationId: true, role: true, content: true, status: true, editedAt: true, createdAt: true,
} satisfies Prisma.MessageSelect;

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

  // ===== M10-P3 消息编辑 / 删除（仅本人 + role=user；摘要陈旧传播接线）=====

  /**
   * 编辑本人 user 消息：content 覆盖 + `editedAt=now`（M10 W0 预置列，null = 未编辑）。
   *
   * 权限面（IDOR 防线，M0~M9 冻结原则）：
   * - 查询条件**同时**约束 `userId` 与 `conversation.userId`（可靠归属链：Message → Conversation → User），
   *   非本人消息 / 跨租户会话 / 不存在的 id **一律 404**（同一分支、同一文案 → 不构成存在性预言机）；
   * - 命中但 `role !== 'user'`（助手/系统/工具消息）→ 403 `MESSAGE_EDIT_FORBIDDEN`（本人的资源，无枚举风险）。
   *
   * 语义副作用：编辑后该消息所在摘要区间失真 → 触发 M9-P2 陈旧传播（markStale + 自愈重算），
   * 摘要文本不得继续以旧内容进入后续上下文。钩子失败只记日志（编辑本身已生效）。
   */
  async editMessage(userId: string, messageId: string, dto: EditMessageDto) {
    const target = await this.requireOwnUserMessage(userId, messageId, 'edit');
    const updated = await this.prisma.message.update({
      where: { id: target.id },
      data: { content: dto.content, editedAt: new Date() },
      select: MESSAGE_MUTATION_SELECT,
    });
    await this.markSummariesStale(target.conversationId, [target.id]);
    this.healSummaries(target.conversationId, { userId, projectId: target.projectId });
    return updated;
  }

  /**
   * 删除本人 user 消息。schema 无 `deletedAt`（M10 §7 不新增列）→ **硬删除**，但顺序是关键：
   * 1) **先** markStale（markStale 需消息行仍存在才能取出 createdAt 判定"区间覆盖"；
   *    先删后标会因行已消失而漏标）→ 2) 硬删除 → 3) detectStale 兜底（锚点已缺失的版本一并标 stale）
   *    + recomputeStale 自愈重建。
   *
   * 已引用的消息：`Attachment.messageId` 为可空引用（schema 无 onDelete → 仅置空引用，附件本身保留，
   * 不随消息消失——附件是用户资产，删除消息不等于删除文件）；AgentRun/GenerationTask 不持有
   * messageId 外键，任务产物按会话维度独立存在。摘要对已删消息的引用由 `intervalMessages`
   * 的"锚点不存在 → 标陈旧"兜底（见 core/memory/memory-candidate.service.ts 的 anchor_missing 分支，
   * 该文件属 A11 记忆域，本 Phase 只调用其既有公开方法，绝不修改）。
   */
  async deleteMessage(userId: string, messageId: string) {
    const target = await this.requireOwnUserMessage(userId, messageId, 'delete');
    await this.markSummariesStale(target.conversationId, [target.id]);
    await this.prisma.message.delete({ where: { id: target.id } });
    this.healSummaries(target.conversationId, { userId, projectId: target.projectId });
    return { id: target.id, conversationId: target.conversationId, deleted: true as const };
  }

  /**
   * 可变更消息的**统一取数 + 授权判定**：非本人 / 跨租户 / 不存在 → 404（防枚举，单一分支）；
   * 本人但非 user 角色 → 403（对应 M10 错误码）。
   */
  private async requireOwnUserMessage(userId: string, messageId: string, op: MessageMutationOp) {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, userId, conversation: { userId, deletedAt: null } },
      select: {
        id: true, conversationId: true, role: true,
        conversation: { select: { projectId: true } },
      },
    });
    if (!message) throw new AppError(ErrorCode.NOT_FOUND, '消息不存在');
    if (message.role !== 'user') {
      throw messageMutationForbidden(op, op === 'edit' ? '仅本人发送的消息可编辑' : '仅本人发送的消息可删除');
    }
    return { id: message.id, conversationId: message.conversationId, projectId: message.conversation.projectId };
  }

  /**
   * 摘要陈旧标记（M9-P2 自愈链的生产调用方之一）。**删除路径必须在消息行仍存在时调用**。
   * 失败只记日志：消息变更本身已生效，记忆域自愈是副作用，绝不因副作用回滚用户操作。
   */
  private async markSummariesStale(conversationId: string, messageIds: string[]): Promise<number> {
    try {
      return await this.summaryRefiner.markStale(conversationId, messageIds);
    } catch (err) {
      this.logger.warn(`摘要陈旧标记失败（消息变更已生效，留给下次检测兜底）: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * 摘要自愈（markStale 之后）：detectStale 兜底"锚点消息已消失"的版本（删除路径的漏网保护），
   * recomputeStale 删旧链 + 强制重建（覆盖区间以**当前真实消息**重新生成，绝不残留旧内容）。
   * recompute 内含 LLM 调用 → fire-and-forget，不阻塞编辑/删除的 HTTP 响应；失败静默记日志。
   */
  private healSummaries(conversationId: string, ctx: { userId: string; projectId: string | null }): void {
    void (async () => {
      try {
        await this.summaryRefiner.detectStale(conversationId);
        await this.summaryRefiner.recomputeStale(conversationId, { userId: ctx.userId, projectId: ctx.projectId });
      } catch (err) {
        this.logger.warn(`摘要自愈重算失败（下次对话推进时兜底）: ${(err as Error).message}`);
      }
    })();
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
