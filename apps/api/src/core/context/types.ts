import { ChatMessage } from '../../providers/llm/llm.types';

/**
 * 上下文块来源。
 * 已落地（本枚举描述现状，不再是"未来扩展"清单）：
 * - 'conversation'：最近会话消息（M1 内置源，ContextAssembler 内建）；
 * - 'project' / 'user'：项目级/用户级 active 记忆（ProjectMemorySource / UserMemorySource）；
 * - 'summary'：对话摘要版本段（M9-P2 ConversationSummarySource——超预算时裁掉最早版本段）；
 * - 'knowledge'：KB/RAG 检索块（KnowledgeSource，需 Agent 配置 knowledge.enabled 才检索）。
 * 未落地：'system'（Agent System Prompt 由运行链路单独注入，不经本源注册）。
 */
export type MemoryScope = 'system' | 'conversation' | 'user' | 'project' | 'knowledge' | 'summary';

export interface MemoryBlock {
  scope: MemoryScope;
  role: ChatMessage['role'];
  content: string;
  /** 组装排序权重，越小越靠前（默认 100；scope 优先级映射随未来源注册时定义） */
  order?: number;
  /** 截断优先级（ContextBudgetService 分配预算顺序，越小越优先保留；默认按 scope 映射） */
  priority?: number;
  /** required=true 的块（如 System Prompt）不可被预算截断删除 */
  required?: boolean;
  /** token 估算（BudgetApplier 截断用） */
  tokenCount?: number;
  /**
   * D29 降级块标记：内容为降级产物（如【摘要降级】兜底段——LLM 不可用时按消息原文压缩）。
   * 语义：置尾（order = CONTEXT_ORDER.degraded_summary）+ 最低预算优先级（DEGRADED_SUMMARY_PRIORITY）+
   * 预算不足直接丢弃——绝不与正常来源同权进入上下文排序。非降级块不设此字段。
   */
  degraded?: boolean;
  /** 来源元数据（引用/citation 预留，不注入模型） */
  source?: Record<string, unknown>;
}

export interface AssembleContext {
  userId: string;
  conversationId: string;
  /** 会话所属项目（ProjectMemorySource 使用；M1 无项目时行为不变） */
  projectId?: string;
  /** 当前用户消息（KnowledgeSource 检索 query；无则跳过检索） */
  userMessage?: string;
  /** 组装历史时排除的消息 id（通常是本次用户消息） */
  excludeMessageId?: string;
  /** 最近消息条数上限（默认 8，与 M1 行为一致） */
  recentMessagesLimit?: number;
  /** Knowledge 自动检索开关（Agent 配置 knowledge.enabled；默认关闭——不因普通聊天触发 embedding） */
  knowledge?: { enabled: boolean };
  /** 上下文 token 预算（AgentVersion 配置覆盖；默认 limits.contextBudgetTokens=8000，服务端配置，Tool/用户不可改） */
  budgetTokens?: number;
}

/**
 * 上下文块组装顺序锁定（架构审查报告 §4）。
 * system → project memory → user memory → summary → knowledge → recent messages →（降级摘要，置尾）。
 * 'system' 位由运行链路的 System Prompt 单独注入，不产生本表数据；其余位均已落地实现。
 */
export const CONTEXT_ORDER = {
  system: 0,
  project_memory: 10,
  user_memory: 20,
  summary: 30,
  knowledge: 40,
  recent_messages: 100,
  /** D29：降级摘要（含【摘要降级】兜底段的版本链）排到全部常规源之后——置尾，绝不与正常摘要同权 */
  degraded_summary: 110,
} as const;

/**
 * D29 降级块的预算优先级：6 = 低于全部常规源（summary=3 / knowledge=4 / recent_messages=5）。
 * 预算不足时最先被丢弃，绝不挤占正常摘要、记忆与最近消息的预算。
 */
export const DEGRADED_SUMMARY_PRIORITY = 6;

/**
 * 上下文数据源接口：ProjectMemory / UserMemory / ConversationSummary / Knowledge 均实现本接口，
 * 注册进 ContextAssembler 即生效（注册点在 ContextModule 的 useFactory）。
 */
export interface MemorySource {
  readonly scope: MemoryScope;
  collect(ctx: AssembleContext): Promise<MemoryBlock[]>;
}

export const DEFAULT_RECENT_MESSAGES_LIMIT = 8;
