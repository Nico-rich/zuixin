import { ChatMessage } from '../../providers/llm/llm.types';

/**
 * 上下文块来源。
 * M1 仅使用 'conversation'（最近会话消息）；
 * 未来按审查报告 §4 扩展：'system'（Agent System Prompt）、
 * 'user'（User Memory）、'project'（Project Memory）、'knowledge'（KB/RAG 检索）。
 */
export type MemoryScope = 'system' | 'conversation' | 'user' | 'project' | 'knowledge';

export interface MemoryBlock {
  scope: MemoryScope;
  role: ChatMessage['role'];
  content: string;
  /** 组装排序权重，越小越靠前（默认 100；scope 优先级映射随未来源注册时定义） */
  order?: number;
}

export interface AssembleContext {
  userId: string;
  conversationId: string;
  /** 会话所属项目（ProjectMemorySource 使用；M1 无项目时行为不变） */
  projectId?: string;
  /** 组装历史时排除的消息 id（通常是本次用户消息） */
  excludeMessageId?: string;
  /** 最近消息条数上限（默认 8，与 M1 行为一致） */
  recentMessagesLimit?: number;
}

/**
 * 上下文块组装顺序锁定（架构审查报告 §4）。
 * system → project memory → user memory → summary → knowledge → recent messages。
 * 未实现的源（summary/knowledge/system）不产生任何数据。
 */
export const CONTEXT_ORDER = {
  system: 0,
  project_memory: 10,
  user_memory: 20,
  summary: 30,
  knowledge: 40,
  recent_messages: 100,
} as const;

/**
 * 未来上下文数据源接口（M6+ 实现）：
 * Conversation Summary / User Memory / Project Memory / KB 检索
 * 均实现此接口并注册进 ContextAssembler 即生效。
 * 注意：M1 不实现任何未来源。
 */
export interface MemorySource {
  readonly scope: MemoryScope;
  collect(ctx: AssembleContext): Promise<MemoryBlock[]>;
}

export const DEFAULT_RECENT_MESSAGES_LIMIT = 8;
