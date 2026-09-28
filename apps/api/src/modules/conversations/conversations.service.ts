import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { SummaryRefinerService } from '../../core/memory/summary-refiner.service';
import { PageMeta, buildPage, cursorFilter, resolveWindow } from './cursor';
import { ListConversationsQuery, ListMessagesQuery } from './conversations.dto';

/** 会话列表分页默认条数（= M0~M9 的固定 take 值，既有调用方行为不变） */
export const CONVERSATIONS_PAGE_DEFAULT_LIMIT = 50;
/** 消息列表分页默认条数（= M0~M9 的固定 take 值，既有调用方行为不变） */
export const MESSAGES_PAGE_DEFAULT_LIMIT = 200;
const PAGE_MAX_LIMIT = 200;

/** 消息列表对外投影（与 M0~M9 一致；仅新增 M10-P3 已落库的 editedAt） */
const MESSAGE_SELECT = {
  id: true, conversationId: true, role: true, content: true, status: true, errorCode: true,
  intentType: true, intentConfidence: true, createdAt: true, editedAt: true,
  attachments: { select: { id: true, kind: true, type: true, mimeType: true, originalName: true } },
} satisfies Prisma.MessageSelect;

/** 会话列表对外投影 */
const CONVERSATION_SELECT = {
  id: true, title: true, projectId: true, createdAt: true, updatedAt: true,
} satisfies Prisma.ConversationSelect;

export type ConversationRow = Prisma.ConversationGetPayload<{ select: typeof CONVERSATION_SELECT }>;
export type MessageRow = Prisma.MessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

export interface Paged<T> {
  items: T[];
  /** 分页元数据（由控制器写入响应头，不改变既有 `{ data: [...] }` 信封形状） */
  meta: PageMeta;
}

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger('Conversations');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    // M9-P2 隐私删除传播：会话删除 → 摘要版本链/未提升候选清除（摘要生命周期只归记忆域管理）
    @Inject(SummaryRefinerService) private readonly summaries: SummaryRefinerService,
  ) {}

  /**
   * 会话列表。M10-P3（ARCH-11）：固定 `take: 50` → 游标分页（`limit` / `before` / `after`）。
   * 不传分页参数 = 首页 50 条（与旧版一致）；排序仍是用户可见性主序 `updatedAt desc`。
   * 注意：`updatedAt` 是**可变**排序键（会话被更新即前移），故列表分页在并发更新下是"尽力而为"；
   * 严格"无重复无遗漏"的保证落在消息列表（不可变的 `createdAt`）。
   */
  async list(userId: string, query: ListConversationsQuery = {}): Promise<Paged<ConversationRow>> {
    const { direction, cursor, limit } = resolveWindow(query, CONVERSATIONS_PAGE_DEFAULT_LIMIT, PAGE_MAX_LIMIT);
    // 端点惯用方向 = updatedAt desc；`before` 回溯 → 反向取数（asc），最后由 buildPage 统一按 desc 返回
    const fetchAsc = direction === 'before';
    const rows = await this.prisma.conversation.findMany({
      where: {
        userId, deletedAt: null,
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(cursor ? { OR: cursorFilter('updatedAt', cursor, fetchAsc) } : {}),
      },
      orderBy: fetchAsc ? [{ updatedAt: 'asc' }, { id: 'asc' }] : [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1, // 多取一条判定 hasMore（不额外 count）
      select: CONVERSATION_SELECT,
    });
    return buildPage(rows, limit, fetchAsc, (c) => c.updatedAt, 'desc');
  }

  async create(userId: string, dto: { title?: string; projectId?: string | null }) {
    if (dto.projectId) await this.requireProject(userId, dto.projectId);
    return this.prisma.conversation.create({
      data: { userId, title: dto.title ?? '新对话', projectId: dto.projectId ?? null },
      select: CONVERSATION_SELECT,
    });
  }

  get(userId: string, id: string) {
    return this.requireOwned(userId, id);
  }

  /** 更新标题 / 移动项目（null = 移出项目） */
  async update(userId: string, id: string, dto: { title?: string; projectId?: string | null }) {
    await this.requireOwned(userId, id);
    if (dto.projectId) await this.requireProject(userId, dto.projectId);
    const data: { title?: string; projectId?: string | null } = {};
    if (dto.title) data.title = dto.title;
    if (dto.projectId !== undefined) data.projectId = dto.projectId;
    return this.prisma.conversation.update({ where: { id }, data });
  }

  /**
   * 软删除会话 + **隐私删除传播**：摘要版本链与未提升候选一并清除。
   * 软删除不触发 DB 的 onDelete 级联（FK 只对硬删除生效），摘要源自本会话对话内容——
   * 用户删除会话后不得残留。清理失败只记日志（会话删除本身已生效，绝不因清理回滚删除）。
   */
  async softDelete(userId: string, id: string) {
    await this.requireOwned(userId, id);
    await this.prisma.conversation.update({ where: { id }, data: { deletedAt: new Date() } });
    try {
      await this.summaries.purgeConversation(id);
    } catch (err) {
      this.logger.warn(`会话摘要清理失败（会话已删除）: ${(err as Error).message}`);
    }
  }

  /**
   * 会话消息列表。M10-P3（ARCH-11）：固定 `take: 200` → **(createdAt, id) 复合游标分页**。
   *
   * - 排序键不可变（消息生成后 createdAt/id 恒定）→ 严格无重复无遗漏（同毫秒由 id 全序兜底）；
   * - 返回数组**恒为时间正序**（与旧行为一致，既有调用方直接遍历/取首尾不受影响）；
   * - 不传分页参数 = 首页（与旧版 `take: 200` 同起点、同量级）——向后兼容。
   *
   * 归属硬条件 `conversationId` 恒由服务端以调用方 scope 解析（见 requireOwned）；
   * 游标只表达页内位置，跨会话/伪造游标只会落在"本会话内的错误位置"，不构成越权读取面。
   */
  async getMessages(userId: string, conversationId: string, query: ListMessagesQuery = {}): Promise<Paged<MessageRow>> {
    await this.requireOwned(userId, conversationId);
    const { direction, cursor, limit } = resolveWindow(query, MESSAGES_PAGE_DEFAULT_LIMIT, PAGE_MAX_LIMIT);
    const fetchAsc = direction !== 'before';
    const rows = await this.prisma.message.findMany({
      where: { conversationId, ...(cursor ? { OR: cursorFilter('createdAt', cursor, fetchAsc) } : {}) },
      orderBy: fetchAsc ? [{ createdAt: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1, // 多取一条判定 hasMore
      select: MESSAGE_SELECT,
    });
    return buildPage(rows, limit, !fetchAsc, (m) => m.createdAt, 'asc');
  }

  /** 归属校验：非本人 → 404（防枚举） */
  private async requireOwned(userId: string, id: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id, userId, deletedAt: null } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '对话不存在');
    return c;
  }

  /** 目标项目归属校验：非本人项目 → 404 */
  private async requireProject(userId: string, projectId: string) {
    const p = await this.prisma.project.findFirst({ where: { id: projectId, userId, deletedAt: null } });
    if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
  }
}
