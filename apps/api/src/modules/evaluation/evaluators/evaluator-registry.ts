import { AppError, ErrorCode } from '../../../common/errors/app-error';
import { CaseFacts, EVALUATOR_TYPES, EvaluatorImpl, EvaluatorType, JudgeFn, Verdict } from './types';
import { ExactMatchEvaluator } from './exact-match.evaluator';
import { JsonSchemaEvaluator } from './json-schema.evaluator';
import { RuleEvaluator } from './rule.evaluator';
import { LlmJudgeEvaluator } from './llm-judge.evaluator';

/**
 * 评测器注册表（唯一分派点）：
 * - 未注册的类型 → VALIDATION_ERROR（绝不静默跳过：漏跑评测比跑错评测更危险）；
 * - 纯函数实现，无 DI 依赖——单测可直接调用，无需 Nest 容器。
 */
const IMPLS: Record<EvaluatorType, EvaluatorImpl> = {
  exact_match: new ExactMatchEvaluator(),
  json_schema: new JsonSchemaEvaluator(),
  rule: new RuleEvaluator(),
  llm_judge: new LlmJudgeEvaluator(),
};

export function isEvaluatorType(value: string): value is EvaluatorType {
  return (EVALUATOR_TYPES as readonly string[]).includes(value);
}

/** 按 type 取实现（未知类型 → 拒绝） */
export function getEvaluator(type: string): EvaluatorImpl {
  if (!isEvaluatorType(type)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `未知评测器类型：${type}（支持 ${EVALUATOR_TYPES.join('/')}）`);
  }
  return IMPLS[type];
}

/** 配置校验（Evaluator CRUD 的唯一入口；非法配置绝不入库） */
export function validateEvaluatorConfig(type: string, config: unknown): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, '评测器 config 必须是对象');
  }
  getEvaluator(type).validate(config as Record<string, unknown>);
}

/** 执行一次评测（judge 仅 llm_judge 需要；其它类型忽略） */
export function evaluateFacts(
  type: string,
  facts: CaseFacts,
  config: Record<string, unknown>,
  judge?: JudgeFn,
): Promise<Verdict> {
  return getEvaluator(type).evaluate(facts, config, judge);
}

export { EVALUATOR_TYPES };
