import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConversationSummary, MessageRole, MessageStatus } from '@prisma/client';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { ModelResolverService } from '../../providers/llm/model-resolver.service';
import { UsageService } from '../../modules/usage/usage.service';
import { SimpleTokenEstimator } from '../context/token-estimator';

/**
 * M9-P2 增量摘要（ConversationSummary 版本链）。
 *
 * 语义（与 schema 预整合列一一对应）：
 * - 每会话**多行**摘要：一行 = 一个版本段，覆盖 sourceStartMessageId..sourceEndMessageId 的消息区间；
 *   `conversationId` 唯一约束已移除 —— 因此**任何"取当前摘要"的读路径必须 orderBy createdAt desc + take 1**
 *   （本服务的 current()/latestUsable() 是唯一读入口，其它模块不得自行 findUnique({ conversationId })）。
 * - 增量：新消息达到阈值 → 新建一行；`summary` 文本 = 前版全文 + 新消息段的增量提炼（追加不变式，见 segmentsOf）；
 *   `parentSummaryId` 链上前版；`tokenCount` 记录全文 token 估算（供上下文预算）。
 * - 回滚：删除最新版 → 前版自动恢复为 current（rollback）。
 * - 降级（D29）：LLM 不可用 → 确定性兜底段（段首 DEGRADED_SUMMARY_MARKER）标记为降级；
 *   `SummaryChain.degraded` 随链下行 → 上下文侧降权 + 置尾（绝不与正常摘要同权）。
 * - 陈旧：区间内消息被编辑/删除 → stale=true（markStale/detectStale）→ 重算（recomputeStale 删旧链后重建）；
 * - 隐私删除传播：会话删除 → purgeConversation（软删除不触发 FK 级联，必须显式清除）。
 *
 * **防循环污染（硬约束）**：本服务只把**真实 Message 行**当对话事实；前版摘要仅作"衔接上下文"传给 LLM
 * （prompt 明确声明其不含新事实）。摘要文本绝不回流成对话输入，也绝不作为记忆候选的提炼来源
 * （记忆候选走 MemoryCandidateService，只读真实 Message 行）。
 */
export const DEFAULT_SUMMARY_REFINE_THRESHOLD = 6;
/**
 * D29 降级兜底段的**显式标记**：LLM 不可用时按消息原文压缩的段以此开头。
 *
 * 标记即事实来源（无 schema 变更）：`isDegradedSummarySegment()` 是唯一判定入口，
 * 上下文侧（ConversationSummarySource / ContextBudgetService）据此把含降级段的摘要**降权 + 置尾**，
 * 绝不与正常摘要同权进入上下文排序。
 */
export const DEGRADED_SUMMARY_MARKER = '【摘要降级：模型不可用，按消息原文压缩】';
/** 单次建段的输入消息上限（超长会话按段推进，避免一次灌爆 prompt） */
const MAX_MESSAGES_PER_SEGMENT = 40;
/** 单条消息进入 prompt 的截断长度 */
const MAX_MESSAGE_CHARS = 500;
/** 版本段文本上限（兜底防 LLM 长篇撑爆上下文预算） */
const MAX_SEGMENT_CHARS = 1200;
/** 兜底摘要里单条消息的截断长度 */
const FALLBACK_LINE_CHARS = 120;
/** 版本链回溯上限（防环/防超长链） */
const MAX_CHAIN_DEPTH = 50;
/** 单会话版本行读取上限 */
const MAX_VERSIONS = 200;

/**
 * 段是否为降级兜底产物（D29）。
 * 容错：段的截断（MAX_SEGMENT_CHARS，标记在段首）与外部拼装造成的空白都不影响判定。
 */
export function isDegradedSummarySegment(segment: string): boolean {
  return typeof segment === 'string' && segment.trimStart().startsWith(DEGRADED_SUMMARY_MARKER);
}

export const SUMMARY_SYSTEM_PROMPT = `你是对话摘要器。把"新增对话"压缩为一段增量摘要，追加到已有摘要之后。
只输出新增部分的摘要文本（纯文本，不要 JSON、不要标题、不要重复已有摘要内容）。
规则：
1. 只记录对话中真实出现的事实（用户偏好/要求/已确认的结论/未完成事项），不臆测、不补充对话之外的信息；
2. "已有摘要"仅用于衔接上下文，它不是新事实来源，不要复述它；
3. 简洁：200 字以内，保留对未来对话有用的信息（称谓、尺寸、约束、待办）。`;

export interface SummaryChain {
  /** 当前版本行 id */
  summaryId: string;
  /** 版本号（链深度，从 1 开始） */
  version: number;
  /** 全文（= segments.join('\n')，与库中 summary 文本一致） */
  text: string;
  /**
   * 版本段（最早 → 最新）：segments[i] = 第 i+1 版相对第 i 版的新增文本。
   * 上下文预算是"超预算裁掉最早版本段"的依据（ContextBudgetService 读 block.source.segments）。
   */
  segments: string[];
  tokenCount: number;
  /**
   * D29：链上**存在**降级兜底段（LLM 不可用 → 按消息原文压缩）→ 该摘要整体按降级处理。
   * 上下文侧据此降权/置尾（ContextBudgetService：最低优先级、预算不足直接丢弃），绝不与正常摘要同权。
   */
  degraded: boolean;
}

export interface RefineOptions {
  userId?: string;
  projectId?: string | null;
  /** 覆盖触发阈值（默认 limits.summaryRefineThreshold ?? 6） */
  threshold?: number;
  /** force=true 时忽略阈值（重算路径：只要有未覆盖消息就建段） */
  force?: boolean;
}

export interface RefineResult {
  created: Array<{ id: string; sourceStartMessageId: string; sourceEndMessageId: string }>;
  /** 本次未纳入摘要的剩余消息数（未达阈值时为待摘要消息数） */
  pendingMessages: number;
}

export interface RollbackResult {
  removedId: string | null;
  current: { id: string; summary: string } | null;
  /** 被一并清理的未提升候选数（来源指向被删版本） */
  removedCandidates: number;
}

type MessageRow = { id: string; role: string; content: string; createdAt: Date };

@Injectable()
export class SummaryRefinerService {
  private readonly logger = new Logger('SummaryRefiner');
  private readonly estimator = new SimpleTokenEstimator();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ModelResolverService) private readonly modelResolver: ModelResolverService,
    // M10 Final Audit H4：摘要重建 LLM 计量（UsageService 由 MemoryModule 引入）
    @Inject(UsageService) private readonly usage: UsageService,
  ) {}

  /**
   * 当前摘要 = 最新版（orderBy createdAt desc + take 1）。
   * 唯一约束已移除 → 绝不能用 findUnique({ conversationId })（会抛错/取错行）。
   */
  async current(conversationId: string): Promise<ConversationSummary | null> {
    return this.prisma.conversationSummary.findFirst({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** 供上下文注入：最新**非 stale** 版本 + 版本段（无摘要/全部陈旧 → null） */
  async latestUsable(conversationId: string): Promise<SummaryChain | null> {
    const versions = await this.versions(conversationId);
    const usable = [...versions].reverse().find((v) => !v.stale);
    if (!usable) return null;
    const chain = this.chainOf(versions, usable);
    const segments = this.segmentsOf(chain);
    const text = segments.join('\n');
    return {
      summaryId: usable.id, version: chain.length, text, segments,
      tokenCount: usable.tokenCount || this.estimator.estimate(text),
      // D29：链上任一段为降级兜底 → 整体降级（保守：含原文压缩段的摘要整体降权，绝不与正常摘要同权）
      degraded: segments.some(isDegradedSummarySegment),
    };
  }

  /**
   * 增量推进：有新消息达到阈值 → 新建一个版本段。
   * 自愈：链上存在 stale 版本时先清理（删 stale 版及其后代 + 其未提升候选），再从存活链头继续。
   * 绝不抛错（fire-and-forget 调用方；失败只记日志）。
   */
  async maybeRefine(conversationId: string, opts: RefineOptions = {}): Promise<RefineResult> {
    try {
      const threshold = opts.force ? 1 : (opts.threshold ?? (await this.refineThreshold()));
      const all = await this.versions(conversationId);
      const staleIdx = all.findIndex((v) => v.stale);
      const versions = staleIdx >= 0 ? all.slice(0, staleIdx) : all;
      if (staleIdx >= 0) await this.purgeFrom(all.slice(staleIdx));

      const head = versions.at(-1) ?? null;
      const pending = await this.messagesAfter(conversationId, head?.sourceEndMessageId ?? null, MAX_MESSAGES_PER_SEGMENT + 1);
      if (pending === null) {
        // 锚点消息已不存在（被删除）→ 整链标陈旧，等下一次自愈清理重算
        await this.markStaleVersions(conversationId, versions.map((v) => v.id));
        return { created: [], pendingMessages: 0 };
      }
      if (pending.length < threshold) return { created: [], pendingMessages: pending.length };

      const segmentMessages = pending.slice(0, MAX_MESSAGES_PER_SEGMENT);
      const prevText = head?.summary ?? '';
      // M10 Final Audit H4：计量上下文（归属随真实会话行解析——绝不信任调用方传入）
      const conv = await this.prisma.conversation.findUnique({
        where: { id: conversationId }, select: { userId: true, projectId: true },
      }).catch(() => null);
      const meter = { userId: conv?.userId ?? '', conversationId, projectId: conv?.projectId ?? null };
      const delta = await this.buildDelta(prevText, segmentMessages, meter);
      // 并发保护（乐观 CAS）：LLM 调用期间链头若已变化（另一次 refine 已建段）→ 放弃本次。
      // 否则两次 refine 会对同一区间重复建段（追加不变式被破坏、候选重复提炼）。
      const freshHead = (await this.versions(conversationId)).at(-1) ?? null;
      if ((freshHead?.id ?? null) !== (head?.id ?? null)) {
        this.logger.warn('增量摘要并发推进：链头已变化，放弃本次建段（下次按新链头继续）');
        return { created: [], pendingMessages: 0 };
      }
      const text = prevText ? `${prevText}\n${delta}` : delta;
      const startMessageId = segmentMessages[0].id;
      const endMessageId = segmentMessages[segmentMessages.length - 1].id;
      const row = await this.prisma.conversationSummary.create({
        data: {
          conversationId,
          summary: text,
          sourceStartMessageId: startMessageId,
          sourceEndMessageId: endMessageId,
          summarizedThroughMessageId: endMessageId,
          parentSummaryId: head?.id ?? null,
          tokenCount: this.estimator.estimate(text),
          stale: false,
        },
      });
      return {
        created: [{ id: row.id, sourceStartMessageId: startMessageId, sourceEndMessageId: endMessageId }],
        pendingMessages: pending.length - segmentMessages.length,
      };
    } catch (err) {
      this.logger.warn(`增量摘要失败（不影响聊天）：${(err as Error).message}`);
      return { created: [], pendingMessages: 0 };
    }
  }

  /** 回滚：删除最新版 → 前版恢复为 current（同时清理来源指向被删版本的未提升候选） */
  async rollback(conversationId: string): Promise<RollbackResult> {
    const versions = await this.versions(conversationId);
    const head = versions.at(-1) ?? null;
    if (!head) return { removedId: null, current: null, removedCandidates: 0 };
    const removed = await this.prisma.memoryCandidate.deleteMany({
      where: { sourceSummaryId: head.id, status: 'candidate' },
    });
    await this.prisma.conversationSummary.delete({ where: { id: head.id } });
    const prev = versions.at(-2) ?? null;
    return {
      removedId: head.id,
      current: prev ? { id: prev.id, summary: prev.summary } : null,
      removedCandidates: removed.count,
    };
  }

  /**
   * 陈旧标记：给定消息被编辑/删除时，覆盖它们的版本（及其全部后代，因为后代建立在其之上）标 stale。
   * 调用方：消息编辑/删除路径（当前无编辑端点，钩子已就绪）；detectStale 覆盖"锚点被删"的自动检测。
   */
  async markStale(conversationId: string, messageIds: string[]): Promise<number> {
    if (!messageIds.length) return 0;
    const versions = await this.versions(conversationId);
    if (!versions.length) return 0;
    const anchors = await this.anchorTimes(versions);
    const rows = await this.prisma.message.findMany({
      where: { id: { in: messageIds }, conversationId },
      select: { id: true, createdAt: true },
    });
    if (!rows.length) return 0;
    const doomed: string[] = [];
    versions.forEach((v, idx) => {
      if (v.stale) return;
      const start = v.sourceStartMessageId ? anchors.get(v.sourceStartMessageId) : undefined;
      const end = v.sourceEndMessageId ? anchors.get(v.sourceEndMessageId) : undefined;
      const missingAnchor = Boolean((v.sourceStartMessageId && !start) || (v.sourceEndMessageId && !end));
      const covered = Boolean(rows.some((m) => this.within(m.createdAt, start, end)));
      if (missingAnchor || covered) doomed.push(...versions.slice(idx).map((x) => x.id));
    });
    return this.markStaleVersions(conversationId, [...new Set(doomed)]);
  }

  /** 陈旧检测：版本覆盖区间的锚点消息已不存在（消息被删除）→ 标 stale（含后代） */
  async detectStale(conversationId: string): Promise<number> {
    const versions = await this.versions(conversationId);
    if (!versions.length) return 0;
    const anchors = await this.anchorTimes(versions);
    const doomed: string[] = [];
    versions.forEach((v, idx) => {
      if (v.stale) return;
      const startMissing = Boolean(v.sourceStartMessageId && !anchors.has(v.sourceStartMessageId));
      const endMissing = Boolean(v.sourceEndMessageId && !anchors.has(v.sourceEndMessageId));
      if (startMissing || endMissing) doomed.push(...versions.slice(idx).map((x) => x.id));
    });
    return this.markStaleVersions(conversationId, [...new Set(doomed)]);
  }

  /** 重算：删除最早 stale 版本及其全部后代（含未提升候选）→ 强制重建覆盖段 */
  async recomputeStale(conversationId: string, opts: RefineOptions = {}): Promise<{ removed: number; created: RefineResult['created'] }> {
    const versions = await this.versions(conversationId);
    const idx = versions.findIndex((v) => v.stale);
    if (idx < 0) return { removed: 0, created: [] };
    const removed = await this.purgeFrom(versions.slice(idx));
    const res = await this.maybeRefine(conversationId, { ...opts, force: true });
    return { removed, created: res.created };
  }

  /**
   * 会话删除传播（M9-P2 隐私）：会话删除 → 本会话摘要版本链 + 其**未提升**候选一并清除。
   *
   * DB 层 `onDelete: Cascade` 只覆盖**硬删除**（用户删除 → 会话级联）；产品默认的会话删除是**软删除**
   * （deletedAt），不会触发 FK 级联——必须显式清除，否则源自对话内容的摘要文本在用户删除会话后仍残留。
   * 已提升的 Memory 是用户级长期事实（用户在记忆管理中处置），与本服务 rollback 的清理范围一致。
   */
  async purgeConversation(conversationId: string): Promise<{ summaries: number; candidates: number }> {
    const ids = (await this.prisma.conversationSummary.findMany({
      where: { conversationId }, select: { id: true },
    })).map((s) => s.id);
    if (!ids.length) return { summaries: 0, candidates: 0 };
    const candidates = await this.prisma.memoryCandidate.deleteMany({
      where: { sourceSummaryId: { in: ids }, status: 'candidate' },
    });
    const summaries = await this.prisma.conversationSummary.deleteMany({ where: { conversationId } });
    return { summaries: summaries.count, candidates: candidates.count };
  }

  /** 触发阈值：limits.summaryRefineThreshold（服务端配置）→ 默认 6 */
  async refineThreshold(): Promise<number> {
    const limits = await this.prisma.systemSetting.findUnique({ where: { key: 'limits' } });
    const raw = (limits?.value as { summaryRefineThreshold?: number } | null)?.summaryRefineThreshold;
    if (raw != null && Number.isInteger(raw) && raw >= 1 && raw <= 100) return raw;
    return DEFAULT_SUMMARY_REFINE_THRESHOLD;
  }

  // ===== 内部实现 =====

  private versions(conversationId: string): Promise<ConversationSummary[]> {
    return this.prisma.conversationSummary.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_VERSIONS,
    });
  }

  /** 从 current 沿 parentSummaryId 回溯出**时间正序**的链（上限 MAX_CHAIN_DEPTH，防环） */
  private chainOf(versions: ConversationSummary[], head: ConversationSummary): ConversationSummary[] {
    const byId = new Map(versions.map((v) => [v.id, v]));
    const chain: ConversationSummary[] = [];
    const seen = new Set<string>();
    let cur: ConversationSummary | undefined = head;
    while (cur && chain.length < MAX_CHAIN_DEPTH && !seen.has(cur.id)) {
      chain.unshift(cur);
      seen.add(cur.id);
      cur = cur.parentSummaryId ? byId.get(cur.parentSummaryId) : undefined;
    }
    return chain;
  }

  /**
   * 版本段还原：第 i 段 = 第 i 版 summary 去掉前版全文后的新增部分（追加不变式：text_i = text_{i-1} + '\n' + delta_i）。
   * 不变式被破坏（如外部直写库）→ 丢弃更早段，只保留本版全文（绝不产出错位文本）。
   */
  private segmentsOf(chain: ConversationSummary[]): string[] {
    const segments: string[] = [];
    let prevText = '';
    for (const v of chain) {
      const appended = Boolean(prevText) && v.summary.startsWith(prevText);
      if (prevText && !appended) segments.length = 0;
      const delta = appended ? v.summary.slice(prevText.length).replace(/^\n+/, '') : v.summary;
      segments.push(delta);
      prevText = v.summary;
    }
    return segments;
  }

  /** 版本区间锚点的 createdAt 映射（一次性批量查询；缺失 = 锚点消息已被删除） */
  private async anchorTimes(versions: ConversationSummary[]): Promise<Map<string, Date>> {
    const ids = [...new Set(versions.flatMap((v) => [v.sourceStartMessageId, v.sourceEndMessageId]).filter((x): x is string => Boolean(x)))];
    if (!ids.length) return new Map();
    const rows = await this.prisma.message.findMany({ where: { id: { in: ids } }, select: { id: true, createdAt: true } });
    return new Map(rows.map((r) => [r.id, r.createdAt]));
  }

  private within(at: Date, start: Date | undefined, end: Date | undefined): boolean {
    if (start && at < start) return false;
    if (end && at > end) return false;
    return true;
  }

  private async markStaleVersions(conversationId: string, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const res = await this.prisma.conversationSummary.updateMany({
      where: { conversationId, id: { in: ids }, stale: false },
      data: { stale: true },
    });
    return res.count;
  }

  /** 逆序删除（先删后代，避免 parentSummaryId onDelete: SetNull 把链改乱）+ 清理其未提升候选 */
  private async purgeFrom(doomed: ConversationSummary[]): Promise<number> {
    if (!doomed.length) return 0;
    const ids = doomed.map((v) => v.id);
    await this.prisma.memoryCandidate.deleteMany({ where: { sourceSummaryId: { in: ids }, status: 'candidate' } });
    for (const v of [...doomed].reverse()) {
      await this.prisma.conversationSummary.delete({ where: { id: v.id } });
    }
    return doomed.length;
  }

  /**
   * 锚点之后的新消息（时间正序，含同毫秒的 id 次序；返回 null = 锚点消息已丢失）。
   * 只取 user/assistant 且 completed 的真实对话行——摘要绝不从其它来源（如工具消息/摘要文本）生成。
   */
  private async messagesAfter(conversationId: string, anchorId: string | null, take: number): Promise<MessageRow[] | null> {
    const base = { conversationId, role: { in: [MessageRole.user, MessageRole.assistant] }, status: MessageStatus.completed };
    if (!anchorId) {
      return this.prisma.message.findMany({
        where: base, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take,
        select: { id: true, role: true, content: true, createdAt: true },
      });
    }
    const anchor = await this.prisma.message.findUnique({
      where: { id: anchorId }, select: { id: true, conversationId: true, createdAt: true },
    });
    if (!anchor || anchor.conversationId !== conversationId) return null;
    return this.prisma.message.findMany({
      where: {
        ...base,
        OR: [{ createdAt: { gt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { gt: anchor.id } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take,
      select: { id: true, role: true, content: true, createdAt: true },
    });
  }

  /** 生成一个版本段的增量文本：LLM 提炼 → 失败/空 → 确定性兜底（只由真实消息行压缩） */
  private async buildDelta(prevText: string, messages: MessageRow[], meter: { userId: string; conversationId: string; projectId: string | null }): Promise<string> {
    const transcript = messages
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, MAX_MESSAGE_CHARS)}`)
      .join('\n');
    const userContent = `${prevText ? `已有摘要（仅供衔接，不是新事实来源）：\n${prevText}\n\n` : ''}新增对话：\n${transcript}`;
    const started = Date.now();
    try {
      const { adapter, apiModelId, providerId, modelId } = await this.modelResolver.resolveDefaultLLM();
      const r = await adapter.chat({
        model: apiModelId,
        temperature: 0,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      });
      const delta = this.sanitizeDelta(r.content ?? '', prevText);
      if (delta) {
        // M10 Final Audit H4：摘要重建的 LLM 调用必须计量（此前完全未计量，且 M10-P3 让用户
        // 可通过消息编辑/删除反复触发）。token 用本地估算（provider 响应无 usage 时）；
        // 是否纳入 llm_tokens 配额裁决属产品决策（已登记 Deferred）——至少先计量。
        await this.usage.recordChatUsage({
          userId: meter.userId, conversationId: meter.conversationId, projectId: meter.projectId,
          providerId, modelId,
          inputTokens: this.estimator.estimate(`${SUMMARY_SYSTEM_PROMPT}\n${userContent}`),
          outputTokens: this.estimator.estimate(r.content ?? ''),
          latencyMs: Date.now() - started, status: 'success',
        }).catch((err) => this.logger.warn(`摘要用量计量失败（不影响聊天）：${(err as Error).message}`));
        return delta;
      }
      await this.usage.recordChatUsage({
        userId: meter.userId, conversationId: meter.conversationId, projectId: meter.projectId,
        providerId, modelId, inputTokens: 0, outputTokens: 0,
        latencyMs: Date.now() - started, status: 'failed', errorCode: 'SUMMARY_EMPTY_DELTA',
      }).catch(() => undefined);
    } catch (err) {
      this.logger.warn(`摘要 LLM 提炼失败，改用确定性兜底：${(err as Error).message}`);
      await this.usage.recordChatUsage({
        userId: meter.userId, conversationId: meter.conversationId, projectId: meter.projectId,
        providerId: 'unknown', modelId: 'unknown', inputTokens: 0, outputTokens: 0,
        latencyMs: Date.now() - started, status: 'failed', errorCode: 'SUMMARY_LLM_FAILED',
      }).catch(() => undefined);
    }
    return this.fallbackDelta(messages);
  }

  private sanitizeDelta(raw: string, prevText: string): string {
    let delta = raw.trim();
    if (prevText && delta.startsWith(prevText)) delta = delta.slice(prevText.length).trim();
    return delta.slice(0, MAX_SEGMENT_CHARS);
  }

  /**
   * 确定性兜底段：真实消息行逐条压缩（无 LLM 也可用；绝不引入摘要文本自身）。
   * D29：段首固定为 DEGRADED_SUMMARY_MARKER——上下文侧据此识别并降权/置尾（标记不被截断丢失：标记在段首）。
   */
  private fallbackDelta(messages: MessageRow[]): string {
    const lines = messages.map((m) => {
      const oneLine = m.content.replace(/\s+/g, ' ').trim().slice(0, FALLBACK_LINE_CHARS);
      return `${m.role === 'user' ? '用户' : '助手'}：${oneLine}`;
    });
    return `${DEGRADED_SUMMARY_MARKER}\n${lines.join('\n')}`.slice(0, MAX_SEGMENT_CHARS);
  }
}
