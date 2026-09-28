import { AppError, ErrorCode } from '../../../common/errors/app-error';
import { CaseFacts, EvaluatorImpl, Verdict } from './types';
import { canonicalJson, getPath, round6, stringify, truncate } from './util';

export type RuleType =
  | 'contains' | 'not_contains' | 'equals' | 'regex' | 'min_length' | 'max_length'
  | 'max_latency_ms' | 'max_cost' | 'max_tokens' | 'json_path_equals' | 'tool_called';

export interface RuleDef {
  type: RuleType;
  /** 文本/正则/工具名/比对值（数值类规则为阈值） */
  value?: string | number | boolean | null;
  /** json_path_equals 的点分路径 */
  path?: string;
  /** 人类可读标签（仅观测） */
  label?: string;
}

export interface RuleConfig { rules: RuleDef[] }

const TEXT_RULES: RuleType[] = ['contains', 'not_contains', 'equals', 'regex', 'min_length', 'max_length'];
const NUMERIC_RULES: RuleType[] = ['max_latency_ms', 'max_cost', 'max_tokens'];

/**
 * rule：确定性规则集（无 LLM 依赖）。
 * - 逐条判定，score = 通过条数 / 总条数（部分分＝覆盖率事实），passed = 全部通过；
 * - 任一规则配置非法 → CRUD 期拒绝（绝不入库后静默跳过）；
 * - 数值类规则在事实缺失（如 latencyMs 为空）时判定为不通过并在证据中标注 missing——绝不视为通过。
 */
export class RuleEvaluator implements EvaluatorImpl {
  readonly type = 'rule' as const;

  validate(config: Record<string, unknown>): void {
    const rules = (config as unknown as RuleConfig).rules;
    if (!Array.isArray(rules) || rules.length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'rule.rules 必须是非空数组');
    }
    if (rules.length > 100) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'rule.rules 最多 100 条');
    }
    rules.forEach((rule, i) => assertRule(rule, i));
  }

  async evaluate(facts: CaseFacts, config: Record<string, unknown>): Promise<Verdict> {
    const rules = (config as unknown as RuleConfig).rules;
    const details = rules.map((rule, index) => ({ index, type: rule.type, ...(rule.label ? { label: rule.label } : {}), ...judge(rule, facts) }));
    const passedCount = details.filter((d) => d.ok).length;
    const score = rules.length === 0 ? 0 : round6(passedCount / rules.length);
    return {
      score,
      passed: passedCount === rules.length,
      evidence: { total: rules.length, passed: passedCount, rules: details },
    };
  }
}

function assertRule(rule: RuleDef, index: number): void {
  const where = `rule.rules[${index}]`;
  if (!rule || typeof rule !== 'object') throw new AppError(ErrorCode.VALIDATION_ERROR, `${where} 必须是对象`);
  if (typeof rule.type !== 'string' || !isRuleType(rule.type)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `${where}.type 非法：${String(rule.type)}`);
  }
  if (rule.label !== undefined && (typeof rule.label !== 'string' || rule.label.length > 200)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `${where}.label 必须是 ≤200 字符的字符串`);
  }
  if (TEXT_RULES.includes(rule.type)) {
    if (rule.type === 'min_length' || rule.type === 'max_length') {
      if (typeof rule.value !== 'number' || !Number.isInteger(rule.value) || rule.value < 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, `${where}.value 必须是非负整数长度`);
      }
      return;
    }
    if (typeof rule.value !== 'string' || rule.value.length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `${where}.value 必须是非空字符串`);
    }
    if (rule.type === 'regex') {
      try {
        new RegExp(rule.value);
      } catch {
        throw new AppError(ErrorCode.VALIDATION_ERROR, `${where}.value 不是合法正则`);
      }
    }
    return;
  }
  if (NUMERIC_RULES.includes(rule.type)) {
    if (typeof rule.value !== 'number' || !Number.isFinite(rule.value) || rule.value < 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `${where}.value 必须是非负有限数字`);
    }
    return;
  }
  if (rule.type === 'json_path_equals') {
    if (typeof rule.path !== 'string' || rule.path.length === 0 || rule.path.length > 200) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `${where}.path 必须是 1~200 字符的点分路径`);
    }
    if (rule.value === undefined) throw new AppError(ErrorCode.VALIDATION_ERROR, `${where}.value 必填`);
    return;
  }
  // tool_called
  if (typeof rule.value !== 'string' || rule.value.length === 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `${where}.value 必须是工具名（非空字符串）`);
  }
}

function judge(rule: RuleDef, facts: CaseFacts): { ok: boolean; detail: string } {
  const text = facts.outputText ?? '';
  switch (rule.type) {
    case 'contains': return { ok: text.includes(String(rule.value)), detail: `contains(${truncate(String(rule.value), 120)})` };
    case 'not_contains': return { ok: !text.includes(String(rule.value)), detail: `not_contains(${truncate(String(rule.value), 120)})` };
    case 'equals': return { ok: text === String(rule.value), detail: `equals(${truncate(String(rule.value), 120)})` };
    case 'regex': return { ok: new RegExp(String(rule.value)).test(text), detail: `regex(/${truncate(String(rule.value), 120)}/)` };
    case 'min_length': return { ok: text.length >= Number(rule.value), detail: `min_length(${rule.value})，实际 ${text.length}` };
    case 'max_length': return { ok: text.length <= Number(rule.value), detail: `max_length(${rule.value})，实际 ${text.length}` };
    case 'max_latency_ms':
      return facts.latencyMs === null
        ? { ok: false, detail: `max_latency_ms(${rule.value})：事实缺失（latencyMs 为空）` }
        : { ok: facts.latencyMs <= Number(rule.value), detail: `max_latency_ms(${rule.value})，实际 ${facts.latencyMs}` };
    case 'max_cost':
      return { ok: facts.cost <= Number(rule.value), detail: `max_cost(${rule.value})，实际 ${facts.cost}` };
    case 'max_tokens': {
      const total = facts.promptTokens + facts.completionTokens;
      return { ok: total <= Number(rule.value), detail: `max_tokens(${rule.value})，实际 ${total}` };
    }
    case 'json_path_equals': {
      const actual = getPath(facts.outputJson, String(rule.path));
      if (actual === undefined) return { ok: false, detail: `json_path_equals(${rule.path})：路径不存在` };
      // 规范化 JSON 比对：键序无关、类型严格（1 vs "1" 判为不等）
      const ok = canonicalJson(actual) === canonicalJson(rule.value);
      return { ok, detail: `json_path_equals(${rule.path})=${truncate(stringify(rule.value), 120)}，实际 ${truncate(stringify(actual), 120)}` };
    }
    case 'tool_called':
      return { ok: facts.toolCalls.some((t) => t.name === String(rule.value)), detail: `tool_called(${rule.value})` };
    default:
      return { ok: false, detail: `未知规则类型：${String(rule.type)}` };
  }
}

function isRuleType(value: string): value is RuleType {
  return (TEXT_RULES as string[]).includes(value)
    || (NUMERIC_RULES as string[]).includes(value)
    || value === 'json_path_equals' || value === 'tool_called';
}
