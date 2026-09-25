/**
 * M8-P8 载荷复杂度防线（webhook / 事件等"外部可控 JSON"入口）。
 *
 * 体积上限（express.raw limit）只挡字节数；深嵌套/超宽对象仍可造成
 * 解析后遍历/序列化/审计落库的 CPU 与内存放大（JSON bomb 的"轻量"变体）。
 * 本模块在 JSON.parse 之后做结构性拒绝（**只拒绝，不改写/不裁剪**）。
 */

export interface ComplexityLimits {
  /** 最大嵌套深度（根对象 = 1） */
  maxDepth: number;
  /** 最大键总数（递归累计） */
  maxKeys: number;
  /** 单数组最大长度 */
  maxArrayLength: number;
  /** 单字符串最大长度（UTF-16 code unit） */
  maxStringLength: number;
}

/** webhook 载荷限值（体积上限由 express.raw limit 兜底 = 1MB） */
export const WEBHOOK_LIMITS: ComplexityLimits = {
  maxDepth: 10,
  maxKeys: 500,
  maxArrayLength: 200,
  maxStringLength: 100_000,
};

export interface ComplexityVerdict {
  ok: boolean;
  /** 违规原因（中文，可进 4xx 响应） */
  reason?: string;
}

/**
 * 结构复杂度检查（递归；命中即返回，绝不遍历完整棵再判断）。
 * 非普通对象/函数/符号等"非 JSON 值"一并拒绝（JSON.parse 不会产生，但调用方可能传入）。
 */
export function checkJsonComplexity(value: unknown, limits: ComplexityLimits = WEBHOOK_LIMITS): ComplexityVerdict {
  const state = { keys: 0 };
  const walk = (node: unknown, depth: number): ComplexityVerdict => {
    if (depth > limits.maxDepth) return { ok: false, reason: `载荷嵌套层级超过上限（${limits.maxDepth}）` };
    if (node === null || node === undefined) return { ok: true };
    const t = typeof node;
    if (t === 'string') {
      return (node as string).length > limits.maxStringLength
        ? { ok: false, reason: `载荷字符串超过长度上限（${limits.maxStringLength}）` } : { ok: true };
    }
    if (t === 'number' || t === 'boolean') return { ok: true };
    if (t !== 'object') return { ok: false, reason: `载荷含非 JSON 值（${t}）` };
    if (Array.isArray(node)) {
      if (node.length > limits.maxArrayLength) return { ok: false, reason: `载荷数组长度超过上限（${limits.maxArrayLength}）` };
      for (const item of node) {
        const r = walk(item, depth + 1);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    const proto = Object.getPrototypeOf(node as object);
    if (proto !== Object.prototype && proto !== null) return { ok: false, reason: '载荷含非普通对象' };
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      state.keys += 1;
      if (state.keys > limits.maxKeys) return { ok: false, reason: `载荷键数量超过上限（${limits.maxKeys}）` };
      if (k.length > 200) return { ok: false, reason: '载荷键名超长' };
      const r = walk(v, depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  };
  return walk(value, 1);
}

/** webhook 载荷必须是 JSON 对象（数组/标量一律拒绝——工作流载荷语义上就是对象） */
export function isPlainPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
