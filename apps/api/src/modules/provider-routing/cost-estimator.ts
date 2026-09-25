/**
 * M8-P7 成本估算（纯函数，可单测）：
 * - token 类能力（text_generation / function_calling / vision）：与 usage 计量同一约定
 *   `(inputTokens × inputPrice + outputTokens × outputPrice) / 1_000_000`（单价为每百万 token）；
 * - 单位类能力（image / video / embedding）：`units × unitPrice`（每张/每秒/每次）；
 * - 未给 budget 时按默认估算（1000 tokens / 1 单位）——只为 cost ceiling 预检，非最终计费。
 */
import { RoutingCapability } from './provider-routing.types';

/** 默认估算 token 数（输入/输出各 1000，可被 budget 覆盖） */
export const DEFAULT_ESTIMATED_TOKENS = 1000;
/** 默认估算单位数（图片张数 / 视频秒数 / 向量条数） */
export const DEFAULT_ESTIMATED_UNITS = 1;

/** token 计价的能力 */
export const TOKEN_PRICED_CAPABILITIES: RoutingCapability[] = ['text_generation', 'function_calling', 'vision'];

export interface PricedModel {
  inputPrice: number;
  outputPrice: number;
  unitPrice: number;
}

export interface EstimateBudget {
  inputTokens?: number;
  outputTokens?: number;
  units?: number;
}

/** 成本保留 6 位小数（避免浮点噪声导致排序/断言不确定） */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function estimateCost(capability: RoutingCapability, model: PricedModel, budget: EstimateBudget = {}): number {
  if (TOKEN_PRICED_CAPABILITIES.includes(capability)) {
    const inputTokens = normalize(budget.inputTokens, DEFAULT_ESTIMATED_TOKENS);
    const outputTokens = normalize(budget.outputTokens, DEFAULT_ESTIMATED_TOKENS);
    return round6((inputTokens * model.inputPrice + outputTokens * model.outputPrice) / 1_000_000);
  }
  const units = normalize(budget.units, DEFAULT_ESTIMATED_UNITS);
  return round6(units * model.unitPrice);
}

/** 非法预算（负数/NaN）按默认值处理——路由绝不因脏输入崩溃 */
function normalize(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
