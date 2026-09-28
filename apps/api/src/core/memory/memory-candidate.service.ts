import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MemoryCategory, MessageRole, MessageStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { ModelResolverService } from '../../providers/llm/model-resolver.service';
import { ExtractedCandidatesSchema, MEMORY_CATEGORIES } from './memory-extractor';
import { SummaryRefinerService } from './summary-refiner.service';

/**
 * M9-P2 记忆候选提炼（MemoryCandidate 三态表：candidate | active | rejected）。
 *
 * 流程：摘要版本段 → 取该段**区间对应的真实对话消息行** → LLM 提炼 → 三态落库：
 * - rejected：低于可提炼下限（confidence < 0.4 或 importance < 20）——**显式记录**，避免同一区间反复提炼；
 * - candidate：可用但未达自动提升阈值（留人工确认，与既有 M2 语义一致）；
 * - active：confidence ≥ 0.8 且 importance ≥ 70 → 同时写入既有 Memory 表（status=active，进入上下文组装），
 *   候选行置 active + promotedAt，并用 sourceSummaryId/Memory.metadata 双向追溯。
 *
 * **防循环污染（硬约束）**：
 * 1. 提炼输入只来自 Message 表（真实对话行），**摘要文本绝不进 prompt**——摘要只提供"覆盖区间/追溯 id"；
 * 2. 本服务绝不写对话消息，因此不会出现"摘要 → 记忆 → 再摘要"的自我强化环；
 * 3. 提升走既有 Memory 表（active 语义 = Memory.status=active，ContextAssembler 既有 sources 只读该表）；
 *    MemoryCandidate 表**不直接进上下文**。
 *
 * 上限闸门与既有提取器同源：每日候选上限复用 limits.dailyMemoryCandidates（不计入则只留 candidate 不提升）。
 */
export const DEFAULT_PROMOTE_CONFIDENCE = 0.8;
export const DEFAULT_PROMOTE_IMPORTANCE = 70;
/** 低于此下限 → rejected（显式记录，不再反复提炼） */
export const REJECT_CONFIDENCE_BELOW = 0.4;
export const REJECT_IMPORTANCE_BELOW = 20;
const DEFAULT_DAILY_LIMIT = 20;
/** 单次提炼的候选上限（防 LLM 一次吐一百条） */
const MAX_ITEMS_PER_SUMMARY = 20;
/** 区间消息读取上限 */
const MAX_MESSAGES = 200;
/** 单条消息进 prompt 的截断长度 */
const MAX_MESSAGE_CHARS = 500;

/** M10 W0：候选内容指纹（DB UNIQUE(userId, contentHash) 去重锚点；与迁移 SQL 的 sha256 口径一致） */
export function memoryContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface ExtractResult {
  summaryId: string | null;
  /** 未产出候选的原因（null = 正常执行） */
  skipped: 'no_summary' | 'already_extracted' | 'no_messages' | 'anchor_missing' | null;
  /** 新建候选行数（含 rejected） */
  extracted: number;
  promoted: number;
  rejected: number;
  /** 与既有记忆/候选重复而跳过的条数 */
  duplicated: number;
}

const EMPTY: Omit<ExtractResult, 'summaryId' | 'skipped'> = { extracted: 0, promoted: 0, rejected: 0, duplicated: 0 };

export const CANDIDATE_SYSTEM_PROMPT = `你是记忆提炼器。从下面给出的**真实对话消息**中提炼值得长期记住的、用户明确表达的稳定事实/偏好/指令/项目背景。
只输出 JSON：{"memories":[{"content":"...","category":"preference|profile|instruction|project_context|workflow|other","importance":0~100,"confidence":0~1}]}
规则：
1. 只依据给出的消息原文，不臆测、不补充消息之外的信息；
2. 只提炼用户明确表达的稳定内容（如"以后都按 2000×2000 做"），不提炼一般问答内容；
3. confidence 表示"这值得长期保存"的置信度，importance 表示对未来任务的重要程度——两者独立；
4. 拿不准时 confidence 低于 0.4；没有可提炼内容时输出 {"memories":[]}。`;

@Injectable()
export class MemoryCandidateService {
  private readonly logger = new Logger('MemoryCandidate');
  private readonly categories = MEMORY_CATEGORIES;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ModelResolverService) private readonly modelResolver: ModelResolverService,
    @Inject(SummaryRefinerService) private readonly summaries: SummaryRefinerService,
  ) {}

  /** 对会话**当前版本**摘要做一次提炼（fire-and-forget 入口；绝不抛错） */
  async extractForConversation(conversationId: string): Promise<ExtractResult> {
    try {
      const current = await this.summaries.current(conversationId);
      if (!current || current.stale) return { summaryId: current?.id ?? null, skipped: 'no_summary', ...EMPTY };
      return await this.extractFromSummary(current.id);
    } catch (err) {
      this.logger.warn(`记忆候选提炼失败（不影响聊天）：${(err as Error).message}`);
      return { summaryId: null, skipped: null, ...EMPTY };
    }
  }

  /** 从指定摘要版本段提炼（幂等：同一摘要行已有候选 → 跳过） */
  async extractFromSummary(summaryId: string): Promise<ExtractResult> {
    try {
      const summary = await this.prisma.conversationSummary.findUnique({ where: { id: summaryId } });
      if (!summary || summary.stale) return { summaryId, skipped: 'no_summary', ...EMPTY };
      const already = await this.prisma.memoryCandidate.count({ where: { sourceSummaryId: summaryId } });
      if (already > 0) return { summaryId, skipped: 'already_extracted', ...EMPTY };

      const conversation = await this.prisma.conversation.findUnique({
        where: { id: summary.conversationId }, select: { userId: true, projectId: true },
      });
      if (!conversation) return { summaryId, skipped: 'no_messages', ...EMPTY };

      const messages = await this.intervalMessages(summary, conversation.userId);
      if (messages === null) {
        // 区间锚点消息已不存在（被删除）→ 标陈旧待重算；不提炼（绝不从摘要文本兜底取事实）
        await this.summaries.markStale(summary.conversationId, [summary.sourceStartMessageId, summary.sourceEndMessageId].filter((x): x is string => Boolean(x)));
        return { summaryId, skipped: 'anchor_missing', ...EMPTY };
      }
      if (!messages.length) return { summaryId, skipped: 'no_messages', ...EMPTY };

      const parsed = await this.invokeExtractor(messages);
      if (!parsed) return { summaryId, skipped: null, ...EMPTY };

      const promoteLimits = await this.promoteLimits();
      let remaining = await this.dailyRemaining(conversation.userId);
      const result: ExtractResult = { summaryId, skipped: null, ...EMPTY };

      for (const item of parsed.memories.slice(0, MAX_ITEMS_PER_SUMMARY)) {
        // 去重：同用户同内容（Memory 任意状态 / MemoryCandidate 任意状态）→ 不重复落库
        const dup = await this.isDuplicate(conversation.userId, item.content);
        if (dup) { result.duplicated++; continue; }

        const rejected = item.confidence < REJECT_CONFIDENCE_BELOW || item.importance < REJECT_IMPORTANCE_BELOW;
        const eligible = !rejected
          && item.confidence >= promoteLimits.confidence
          && item.importance >= promoteLimits.importance
          && remaining > 0;

        const row = await this.prisma.memoryCandidate.create({
          data: {
            userId: conversation.userId,
            projectId: conversation.projectId,
            sourceSummaryId: summary.id,
            content: item.content,
            contentHash: memoryContentHash(item.content), // M10 W0：去重锚点（A11 语义补强）
            category: item.category as MemoryCategory,
            importance: item.importance,
            confidence: item.confidence,
            status: rejected ? 'rejected' : 'candidate',
          },
        });
        result.extracted++;

        if (eligible && row) {
          const promoted = await this.promote(conversation.userId, conversation.projectId, row.id, summary.id, item, summary.sourceEndMessageId);
          if (promoted) {
            result.promoted++;
            remaining--;
          }
        } else if (rejected) {
          result.rejected++;
        }
      }
      return result;
    } catch (err) {
      this.logger.warn(`记忆候选提炼失败（不影响聊天）：${(err as Error).message}`);
      return { summaryId, skipped: null, ...EMPTY };
    }
  }

  /** 人工确认/拒绝（候选表三态的显式流转；提升同样写入 Memory 表） */
  async decide(candidateId: string, decision: 'active' | 'rejected'): Promise<boolean> {
    const row = await this.prisma.memoryCandidate.findUnique({ where: { id: candidateId } });
    if (!row || row.status !== 'candidate') return false;
    if (decision === 'rejected') {
      await this.prisma.memoryCandidate.update({ where: { id: candidateId }, data: { status: 'rejected' } });
      return true;
    }
    return this.promote(row.userId, row.projectId, row.id, row.sourceSummaryId, {
      content: row.content, category: row.category, importance: row.importance, confidence: row.confidence,
    }, null);
  }

  // ===== 内部实现 =====

  /** 摘要区间对应的**真实对话消息行**（升序；null = 锚点丢失） */
  private async intervalMessages(
    summary: { conversationId: string; sourceStartMessageId: string | null; sourceEndMessageId: string | null },
    userId: string,
  ) {
    const anchorIds = [summary.sourceStartMessageId, summary.sourceEndMessageId].filter((x): x is string => Boolean(x));
    const anchors = anchorIds.length
      ? await this.prisma.message.findMany({ where: { id: { in: anchorIds }, conversationId: summary.conversationId }, select: { id: true, createdAt: true } })
      : [];
    if (anchorIds.length && anchors.length !== anchorIds.length) return null;
    const start = anchors.find((a) => a.id === summary.sourceStartMessageId)?.createdAt;
    const end = anchors.find((a) => a.id === summary.sourceEndMessageId)?.createdAt;
    return this.prisma.message.findMany({
      where: {
        conversationId: summary.conversationId,
        userId,
        role: { in: [MessageRole.user, MessageRole.assistant] },
        status: MessageStatus.completed,
        ...(start ? { createdAt: { gte: start } } : {}),
        ...(end ? { createdAt: { lte: end } } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_MESSAGES,
      select: { id: true, role: true, content: true },
    });
  }

  /**
   * LLM 提炼：prompt 只包含真实消息行（**绝不含摘要文本**——防循环污染）。
   * 返回 null = LLM 不可用/输出非法（安全降级，不落任何候选）。
   */
  private async invokeExtractor(messages: Array<{ role: string; content: string }>) {
    const transcript = messages
      .map((m) => `${m.role === MessageRole.user ? '用户' : '助手'}：${m.content.slice(0, MAX_MESSAGE_CHARS)}`)
      .join('\n');
    const { adapter, apiModelId } = await this.modelResolver.resolveDefaultLLM();
    const r = await adapter.chat({
      model: apiModelId,
      temperature: 0,
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: CANDIDATE_SYSTEM_PROMPT },
        { role: 'user', content: `真实对话消息：\n${transcript}` },
      ],
    });
    const parsed = ExtractedCandidatesSchema.safeParse(JSON.parse(r.content));
    if (!parsed.success) return null;
    return { memories: parsed.data.memories.filter((m) => this.categories.includes(m.category)) };
  }

  private async isDuplicate(userId: string, content: string): Promise<boolean> {
    const [memory, candidate] = await Promise.all([
      this.prisma.memory.count({ where: { userId, content } }),
      this.prisma.memoryCandidate.count({ where: { userId, content } }),
    ]);
    return memory > 0 || candidate > 0;
  }

  /** 提升：写既有 Memory 表（active）→ 候选行置 active + promotedAt（追溯双向） */
  private async promote(
    userId: string, projectId: string | null, candidateId: string, sourceSummaryId: string | null,
    item: { content: string; category: string; importance: number; confidence: number },
    sourceMessageId: string | null,
  ): Promise<boolean> {
    const memory = await this.prisma.memory.create({
      data: {
        userId,
        scope: projectId ? 'project' : 'user',
        projectId: projectId ?? null,
        content: item.content,
        category: item.category as MemoryCategory,
        importance: item.importance,
        confidence: item.confidence,
        status: 'active',
        source: 'extractor',
        sourceMessageId: sourceMessageId ?? null,
        metadata: { memoryCandidateId: candidateId, sourceSummaryId } as Prisma.InputJsonValue,
      },
    });
    if (!memory) return false;
    await this.prisma.memoryCandidate.update({ where: { id: candidateId }, data: { status: 'active', promotedAt: new Date() } });
    return true;
  }

  private async promoteLimits(): Promise<{ confidence: number; importance: number }> {
    const limits = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
    const value = (limits?.value ?? null) as { memoryPromoteConfidence?: number; memoryPromoteImportance?: number } | null;
    const confidence = value?.memoryPromoteConfidence;
    const importance = value?.memoryPromoteImportance;
    return {
      confidence: confidence != null && confidence >= 0 && confidence <= 1 ? confidence : DEFAULT_PROMOTE_CONFIDENCE,
      importance: importance != null && Number.isInteger(importance) && importance >= 0 && importance <= 100 ? importance : DEFAULT_PROMOTE_IMPORTANCE,
    };
  }

  /** 每日提升余量：与既有提取器同源（limits.dailyMemoryCandidates），防无限保存 */
  private async dailyRemaining(userId: string): Promise<number> {
    const limits = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
    const dailyLimit = (limits?.value as { dailyMemoryCandidates?: number } | null)?.dailyMemoryCandidates ?? DEFAULT_DAILY_LIMIT;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const used = await this.prisma.memory.count({ where: { userId, source: 'extractor', createdAt: { gte: todayStart } } });
    return Math.max(0, dailyLimit - used);
  }
}
