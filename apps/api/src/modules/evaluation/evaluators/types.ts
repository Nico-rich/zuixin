/**
 * M9-P1 评测器契约（纯函数层；无 IO、无 DI——registry 之外的全部实现可单测）。
 *
 * 硬不变量：
 * - 评测器的产物**只**进 EvaluationResult.score / .passed / .evidence（只读事实）；
 *   绝不决定任何权限/quota/RBAC/provider/approval（LLM judge 输出尤其如此）。
 * - llm_judge 解析失败绝不重试、绝不猜测分数：passed=false + evidence 记录原文。
 */

/** 评测器类型（与 Evaluator.type 列的取值一一对应；未知类型 = 拒绝） */
export const EVALUATOR_TYPES = ['exact_match', 'json_schema', 'rule', 'llm_judge'] as const;
export type EvaluatorType = (typeof EVALUATOR_TYPES)[number];

/** 工具调用事实（评测 runner 不执行工具——只记录模型发出的调用，output 恒为 null） */
export interface ToolCallFact {
  name: string;
  arguments: string;
  output: string | null;
}

/** 单个 case 的**事实**（评测输入面；全部来自 DB 已落库的行，绝不含推断值） */
export interface CaseFacts {
  input: unknown;
  expected: unknown;
  outputText: string;
  /** outputText 可解析为 JSON 时的解析结果，否则 null（exact_match / rule 的字段比对用） */
  outputJson: unknown;
  latencyMs: number | null;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  toolCalls: ToolCallFact[];
}

/** 评测结论（唯一出口） */
export interface Verdict {
  /** 0~1 */
  score: number;
  passed: boolean;
  /** 只读事实：规则命中/差异明细/judge 原文——绝不作为系统判定依据 */
  evidence: Record<string, unknown>;
}

/**
 * judge 调用面（provider-independent）：输入渲染后的 prompt 文本，返回模型原始文本。
 * 由 runner 注入（走既有 LLM 抽象）；单测注入假实现即可完全离线。
 */
export type JudgeFn = (prompt: string) => Promise<string>;

export interface EvaluatorImpl {
  readonly type: EvaluatorType;
  /** 配置校验（CRUD 时调用；非法配置绝不允许入库） */
  validate(config: Record<string, unknown>): void;
  /** 执行（纯逻辑 + 可选 judge 回调；除 judge 外无 IO） */
  evaluate(facts: CaseFacts, config: Record<string, unknown>, judge?: JudgeFn): Promise<Verdict>;
}
