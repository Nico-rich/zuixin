/**
 * M8-P7 智能 Provider 路由：能力/候选/决策 词汇表。
 *
 * 服务端 deterministic——能力需求可以由 LLM 表达（“我要一张图”），但**选谁**永远由本模块
 * 依据平台数据（能力声明/组织策略/健康/熔断/价格）裁决，LLM 不参与、也无权指定 provider。
 */
import { ModelType, ProviderType } from '@prisma/client';

/** 路由目标能力（schema ProviderCapability.capability 同一词汇表） */
export const ROUTING_CAPABILITIES = [
  'text_generation', 'image_generation', 'video_generation', 'embedding', 'function_calling', 'vision',
] as const;
export type RoutingCapability = (typeof ROUTING_CAPABILITIES)[number];

export const ROUTING_CAPABILITY_SET = new Set<string>(ROUTING_CAPABILITIES);

/** 候选被拒原因（写入 RoutingDecision.candidates，审计可回溯） */
export type CandidateReasonCode =
  | 'selected'      // 最终选中
  | 'fallback'      // 进入回退链（可用但非首选）
  | 'disabled'      // provider.enabled = false
  | 'policy_deny'   // 组织策略 deny（硬剔除，敏感数据绝不流向被禁 provider）
  | 'cost_ceiling'  // 估算成本超 policy.costCeilingPerRequest
  | 'unhealthy'     // provider.healthStatus = unhealthy
  | 'circuit_open'  // 熔断器 open
  | 'no_model';     // 声明支持该能力，但无合格的启用模型

/** 决策级 reasonCode（与 schema RoutingDecision.reasonCode 注释同一词汇表） */
export type DecisionReasonCode =
  | 'capability_match' | 'cost_optimal' | 'health_score' | 'policy_allow'
  | 'fallback' | 'circuit_open' | 'denied';

/** 能力 → 该能力的 provider 类型（Provider.type 只有 llm/image/video/embedding） */
export const CAPABILITY_PROVIDER_TYPES: Record<RoutingCapability, ProviderType[]> = {
  text_generation: [ProviderType.llm],
  function_calling: [ProviderType.llm],
  vision: [ProviderType.llm],
  image_generation: [ProviderType.image],
  video_generation: [ProviderType.video],
  embedding: [ProviderType.embedding],
};

/** 能力 → 模型类型（非显式能力时按类型兜底匹配） */
export const CAPABILITY_MODEL_TYPES: Record<RoutingCapability, ModelType[]> = {
  text_generation: [ModelType.llm],
  function_calling: [ModelType.llm],
  vision: [ModelType.llm],
  image_generation: [ModelType.image],
  video_generation: [ModelType.video],
  embedding: [ModelType.embedding],
};

/** 能力 → models.capabilities 中的声明键（后台/种子数据里的多种写法都认） */
export const CAPABILITY_MODEL_KEYS: Record<RoutingCapability, string[]> = {
  text_generation: ['textGeneration', 'text_generation', 'chat', 'text'],
  function_calling: ['functionCalling', 'function_calling', 'tools', 'toolCalling'],
  vision: ['vision', 'imageInput', 'multimodal'],
  image_generation: ['imageGeneration', 'image_generation', 'image'],
  video_generation: ['videoGeneration', 'video_generation', 'video'],
  embedding: ['embedding', 'embeddings'],
};

/**
 * 显式声明类能力：仅靠模型类型推断不足以证明支持（llm 类型不等于会调工具/能读图），
 * 必须由 Model.capabilities 显式声明 true，或由平台写入 ProviderCapability 行声明。
 */
export const EXPLICIT_ONLY_CAPABILITIES: RoutingCapability[] = ['function_calling', 'vision'];

/** 估算预算（未给则按默认 token/单位估算） */
export interface CostBudget {
  inputTokens?: number;
  outputTokens?: number;
  units?: number;
}

/** route() 入参（**全部是服务端事实**：调用方只提供需求与上下文，绝不指定 provider） */
export interface RouteInput {
  organizationId?: string | null;
  capability: RoutingCapability;
  requestId?: string;
  traceId?: string;
  runId?: string;
  taskId?: string;
  budget?: CostBudget;
  /**
   * 运营者偏好模型（有序；来源：systemSetting.routingPolicy.defaults.<类型>）。
   * **只做排序优先组，不做硬过滤**——被偏好的 provider 若被策略拒绝/不健康/熔断 open，仍按常规候选链回退。
   */
  preferredModelIds?: string[];
  /**
   * 软能力偏好（如 function_calling）：仅作为排序因子（命中多者优先），不是硬过滤。
   * 硬过滤会让「全平台无模型显式声明工具能力」的部署直接不可用；调用方（引擎）保留能力降级语义。
   */
  preferCapabilities?: RoutingCapability[];
  /**
   * 稳定哈希 tie-break 键（如 runId）：候选在前述所有维度完全同质时，
   * 按 hash(stickyKey + providerId) 排序——同键恒定同序（可复现），不同键稳定分摊。
   * 不提供 → 按 providerId 字典序（与 M8-P7 冻结语义一致）。
   */
  stickyKey?: string;
}

/** 一个可调用目标（provider + 模型 + 价格 + 事实评分 + 句柄所需字段） */
export interface RouteTarget {
  providerId: string;
  providerName: string;
  adapter: string;
  modelId: string;
  modelName: string;
  apiModelId: string;
  estimatedCost: number;
  policyId: string | null;
  allowListed: boolean;
  policyPriority: number;
  providerPriority: number;
  healthStatus: string;
  breakerState: string;
  /** models.capabilities 原样透传（引擎 MUST-3 工具能力降级判断用；路由只转发事实，不做能力裁决） */
  modelCapabilities: Record<string, unknown>;
  /** 软能力命中数（preferCapabilities 命中数，排序用） */
  capabilityFit: number;
  /** 健康分（health-score.ts；排序用，越高越优） */
  healthScore: number;
  /** 最近平均延迟（usage_records 只读聚合）；null = 无样本 */
  latencyMs: number | null;
}

/** 候选审计记录（RoutingDecision.candidates 的每一行） */
export interface RoutingCandidateRecord {
  providerId: string;
  providerName: string;
  modelId: string | null;
  modelName: string | null;
  estimatedCost: number | null;
  allowListed: boolean;
  policyId: string | null;
  policyPriority: number;
  providerPriority: number;
  healthStatus: string;
  breakerState: string;
  /** 健康分（审计可复现：为什么是它而不是同价同优先级的另一个） */
  healthScore: number;
  /** 最近平均延迟（只读事实；null = 无样本） */
  latencyMs: number | null;
  /** 熔断窗口内失败/成功计数（只读事实，决策可回溯） */
  windowFailures: number;
  windowSuccesses: number;
  /** 软能力命中数 */
  capabilityFit: number;
  accepted: boolean;
  reasonCode: CandidateReasonCode;
}

/** route() 返回值：选中结果 + 审计 + 回退调用句柄 */
export interface RouteResult {
  decisionId: string;
  capability: RoutingCapability;
  providerId: string;
  providerName: string;
  modelId: string;
  apiModelId: string;
  adapter: string;
  reasonCode: DecisionReasonCode;
  estimatedCost: number;
  policyId: string | null;
  /** [首选, 回退1, 回退2]（最多 1 + maxFallbacks） */
  chain: RouteTarget[];
  candidates: RoutingCandidateRecord[];
  /**
   * adapter 调用句柄：首选失败自动重试链上下一个（最多 2 次 fallback），
   * 同时把成功/失败喂给熔断器；回退成功 → 决策行改写为实际使用的 provider（reasonCode=fallback）。
   *
   * `opts.retryableOnly=true`：不可重试错误（参数/鉴权类）立即停止回退链——换 provider 也救不回来，
   * 继续打只会污染熔断计数并放大延迟（媒体执行器沿用 ModelRouter 的既有语义）。
   */
  invoke<T>(
    fn: (target: RouteTarget, attempt: number) => Promise<T>,
    opts?: { maxFallbacks?: number; retryableOnly?: boolean },
  ): Promise<T>;
}

export const DEFAULT_POLICY_PRIORITY = 100;
export const DEFAULT_MAX_FALLBACKS = 2;

/** 熔断配置（Provider.retryConfig 可覆盖默认阈值/冷却） */
export const DEFAULT_BREAKER_FAILURE_THRESHOLD = 5;
export const DEFAULT_BREAKER_COOLDOWN_SEC = 60;

/** 被过滤候选 → 决策级 reasonCode（说明“本可胜出但被过滤”的决定因素） */
export const FILTER_TO_DECISION_REASON: Record<CandidateReasonCode, DecisionReasonCode> = {
  selected: 'capability_match',
  fallback: 'capability_match',
  disabled: 'capability_match',
  no_model: 'capability_match',
  policy_deny: 'policy_allow',
  cost_ceiling: 'cost_optimal',
  unhealthy: 'health_score',
  circuit_open: 'circuit_open',
};
