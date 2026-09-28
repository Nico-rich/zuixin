import { AppError, ErrorCode } from '../../../common/errors/app-error';
import { CaseFacts, EvaluatorImpl, Verdict } from './types';
import { stringify, truncate, tryParseJson } from './util';

export interface JsonSchemaConfig {
  /** 期望输出符合的 JSON Schema 子集（type/required/properties/items/enum/数值与长度边界/pattern） */
  schema: Record<string, unknown>;
}

const MAX_FAILURES = 50;
const ALLOWED_KEYWORDS = new Set([
  'type', 'required', 'properties', 'items', 'enum', 'minimum', 'maximum',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'description', 'title',
]);
const JSON_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

interface Failure { path: string; rule: string; message: string }

/**
 * json_schema：确定性 JSON Schema 校验（无第三方依赖；只实现评测所需的稳定子集）。
 * - 事实来源：caseRun.output 文本 → JSON.parse（解析失败 = 不通过，绝不"尽力修复"输出）；
 * - 未知关键字 → 配置校验期拒绝（避免"看似校验实则忽略"的假通过）；
 * - passed = 零违规；score 二值（1/0）——schema 符合性是布尔事实，部分分会产生误导。
 */
export class JsonSchemaEvaluator implements EvaluatorImpl {
  readonly type = 'json_schema' as const;

  validate(config: Record<string, unknown>): void {
    const schema = (config as unknown as JsonSchemaConfig).schema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'json_schema.schema 必须是 JSON Schema 对象');
    }
    assertSchema(schema as Record<string, unknown>, '$');
  }

  async evaluate(facts: CaseFacts, config: Record<string, unknown>): Promise<Verdict> {
    const schema = (config as unknown as JsonSchemaConfig).schema;
    if (facts.outputJson === null || facts.outputJson === undefined) {
      return {
        score: 0,
        passed: false,
        evidence: {
          reason: '输出不是合法 JSON（不通过；绝不尝试修复输出）',
          failures: [{ path: '$', rule: 'json.parse', message: '输出无法解析为 JSON' }],
          output: truncate(facts.outputText),
        },
      };
    }
    const failures: Failure[] = [];
    validateNode(facts.outputJson, schema, '$', failures);
    const passed = failures.length === 0;
    return {
      score: passed ? 1 : 0,
      passed,
      evidence: {
        failureCount: failures.length,
        failures: failures.slice(0, MAX_FAILURES),
        ...(failures.length > MAX_FAILURES ? { truncated: failures.length - MAX_FAILURES } : {}),
        output: truncate(facts.outputText),
      },
    };
  }
}

function assertSchema(schema: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `json_schema 不支持的关键字：${key}（${path}）——绝不静默忽略`);
    }
  }
  const type = schema.type;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    for (const t of types) {
      if (typeof t !== 'string' || !JSON_TYPES.includes(t)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, `json_schema.type 非法：${String(t)}（${path}）`);
      }
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== 'string')) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `json_schema.required 必须是字符串数组（${path}）`);
    }
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `json_schema.properties 必须是对象（${path}）`);
    }
    for (const [name, sub] of Object.entries(schema.properties as Record<string, unknown>)) {
      if (!sub || typeof sub !== 'object' || Array.isArray(sub)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, `json_schema.properties.${name} 必须是对象（${path}）`);
      }
      assertSchema(sub as Record<string, unknown>, `${path}.${name}`);
    }
  }
  if (schema.items !== undefined) {
    if (!schema.items || typeof schema.items !== 'object' || Array.isArray(schema.items)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `json_schema.items 必须是对象（${path}）`);
    }
    assertSchema(schema.items as Record<string, unknown>, `${path}[]`);
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `json_schema.enum 必须是数组（${path}）`);
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    const v = schema[key];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `json_schema.${key} 必须是有限数字（${path}）`);
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `json_schema.pattern 必须是字符串（${path}）`);
    }
    try {
      new RegExp(schema.pattern);
    } catch {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `json_schema.pattern 不是合法正则（${path}）`);
    }
  }
}

function validateNode(value: unknown, schema: Record<string, unknown>, path: string, failures: Failure[]): void {
  if (failures.length >= MAX_FAILURES) return;

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    failures.push({ path, rule: 'type', message: `期望 ${types.join('|')}，实际 ${actualType(value)}` });
    return; // 类型不符时不再下钻（避免噪声级联）
  }

  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).some((e) => deepEqual(e, value))) {
    failures.push({ path, rule: 'enum', message: `取值不在 enum 白名单内：${truncate(stringify(value), 200)}` });
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      failures.push({ path, rule: 'minimum', message: `${value} < minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      failures.push({ path, rule: 'maximum', message: `${value} > maximum ${schema.maximum}` });
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      failures.push({ path, rule: 'minLength', message: `长度 ${value.length} < ${schema.minLength}` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      failures.push({ path, rule: 'maxLength', message: `长度 ${value.length} > ${schema.maxLength}` });
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      failures.push({ path, rule: 'pattern', message: `不匹配 /${schema.pattern}/` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      failures.push({ path, rule: 'minItems', message: `元素数 ${value.length} < ${schema.minItems}` });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      failures.push({ path, rule: 'maxItems', message: `元素数 ${value.length} > ${schema.maxItems}` });
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      value.forEach((item, i) => validateNode(item, schema.items as Record<string, unknown>, `${path}[${i}]`, failures));
    }
  }

  if (isPlainObject(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) failures.push({ path, rule: 'required', message: `缺少必需字段 ${key}` });
      }
    }
    if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
      for (const [name, sub] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) {
        if (name in obj) validateNode(obj[name], sub, `${path}.${name}`, failures);
      }
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function actualType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  return stringify(a) === stringify(b);
}

/** 供 runner/服务层复用的 JSON 解析入口（导出以保持单一解析语义） */
export function parseOutputJson(text: string): unknown {
  return tryParseJson(text) ?? null;
}
