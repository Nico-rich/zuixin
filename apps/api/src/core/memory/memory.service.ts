import { Inject, Injectable } from '@nestjs/common';
import { MemoryCategory, MemoryScope, MemoryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

export interface MemoryListFilter {
  scope?: MemoryScope;
  projectId?: string;
  status?: MemoryStatus;
  q?: string;
}

export interface CreateMemoryInput {
  scope: MemoryScope;
  projectId?: string | null;
  content: string;
  category: MemoryCategory;
  importance?: number;
  confidence?: number;
  status?: MemoryStatus;
  source?: string;
  sourceMessageId?: string;
  /** M7-P8：结构化元数据（如绩效记忆 kind/subjectId 幂等判定） */
  metadata?: Record<string, unknown> | null;
}

export interface UpdateMemoryInput {
  content?: string;
  category?: MemoryCategory;
  importance?: number;
  confidence?: number | null;
  status?: MemoryStatus;
}

/**
 * 记忆服务（core 层，ContextAssembler 与 HTTP 模块共用）。
 *
 * 两个概念明确分离，不合并：
 * - confidence：AI 判断"这是否值得保存"的置信度（0~1，提取阶段，仅 candidate 有意义）
 * - importance：该记忆对未来任务的重要程度（0~100，ContextAssembler 读取排序用）
 *
 * 状态机：candidate → active（人工确认）| rejected；只有 active 参与上下文组装。
 */
@Injectable()
export class MemoryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 列表 + PG 普通文本搜索（ILIKE，M2 不做 embedding）。
   *
   * 排序（D15）：importance 主序 → lastUsedAt 次序（**最近被上下文用过者优先**，从未用过者最后，
   * 即 lastUsedAt IS NULL 恒排在非 NULL 之后——绝不因 PG 默认 NULLS FIRST 让"没用过的"盖过"用过的"）
   * → createdAt 兜底（同分同用量时新记忆优先，排序确定可复现）。
   * 上下文组装读的正是本方法 → 近期真正被用到的记忆更可能进入下一轮上下文。
   */
  list(userId: string, filter: MemoryListFilter = {}) {
    const where: Prisma.MemoryWhereInput = { userId };
    if (filter.scope) where.scope = filter.scope;
    if (filter.projectId) where.projectId = filter.projectId; // 与 userId 双条件天然防越权
    if (filter.status) where.status = filter.status;
    if (filter.q) where.content = { contains: filter.q, mode: 'insensitive' };
    return this.prisma.memory.findMany({
      where,
      orderBy: [
        { importance: 'desc' },
        { lastUsedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      take: 100,
    });
  }

  async create(userId: string, input: CreateMemoryInput) {
    if (input.scope === 'user' && input.projectId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '用户级记忆不能挂载项目');
    }
    if (input.scope === 'project') {
      if (!input.projectId) throw new AppError(ErrorCode.VALIDATION_ERROR, '项目级记忆必须指定项目');
      const p = await this.prisma.project.findFirst({ where: { id: input.projectId, userId, deletedAt: null } });
      if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
    }
    return this.prisma.memory.create({
      data: {
        userId,
        scope: input.scope,
        projectId: input.scope === 'project' ? input.projectId : null,
        content: input.content,
        category: input.category,
        importance: input.importance ?? 50,
        confidence: input.confidence,
        status: input.status ?? MemoryStatus.candidate,
        source: input.source,
        sourceMessageId: input.sourceMessageId,
        metadata: (input.metadata as never) ?? undefined,
      },
    });
  }

  /** M6-P4 副作用收敛：同一 (用户, 内容, 来源消息) 的 candidate 已存在 → 复用（resume 重放不重复创建） */
  async findCandidate(userId: string, content: string, sourceMessageId?: string) {
    return this.prisma.memory.findFirst({
      where: { userId, content, status: 'candidate', sourceMessageId: sourceMessageId ?? null },
    });
  }

  /** 更新（scope/projectId 不可变）；candidate→active/rejected 即"确认/拒绝" */
  async update(userId: string, id: string, input: UpdateMemoryInput) {
    await this.requireOwned(userId, id);
    const data: Prisma.MemoryUpdateInput = {};
    if (input.content !== undefined) data.content = input.content;
    if (input.category !== undefined) data.category = input.category;
    if (input.importance !== undefined) data.importance = input.importance;
    if (input.confidence !== undefined) data.confidence = input.confidence;
    if (input.status !== undefined) data.status = input.status;
    return this.prisma.memory.update({ where: { id }, data });
  }

  async remove(userId: string, id: string) {
    await this.requireOwned(userId, id);
    await this.prisma.memory.delete({ where: { id } });
  }

  /** 上下文组装使用后刷新 lastUsedAt（D15：已参与 list 排序——importance 相同时最近使用者优先） */
  async markUsed(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.prisma.memory.updateMany({
      where: { id: { in: ids } },
      data: { lastUsedAt: new Date() },
    });
  }

  private async requireOwned(userId: string, id: string) {
    const m = await this.prisma.memory.findFirst({ where: { id, userId } });
    if (!m) throw new AppError(ErrorCode.NOT_FOUND, '记忆不存在');
    return m;
  }
}
