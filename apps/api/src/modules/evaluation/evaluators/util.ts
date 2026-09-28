/** 评测器共用小工具（纯函数；无 IO） */

/** 证据文本截断（防止 judge 原文把证据列撑爆；确定性、可复现） */
export const EVIDENCE_MAX_CHARS = 2_000;

export function truncate(value: string, max = EVIDENCE_MAX_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[截断 ${value.length - max} 字符]`;
}

/** 任意 JSON 值 → 稳定字符串（用于证据与比对） */
export function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 规范化 JSON 文本（**键序无关 + 严格类型**）——确定性比对专用，不用于证据展示：
 * - 对象键递归排序：{"b":1,"a":2} 与 {"a":2,"b":1} 判为相同（语义相同，绝不用书写顺序制造假差异）；
 * - 字符串**带引号**：数字 1 与字符串 "1" 判为**不同**（类型差异绝不被静默抹平）；
 * - 数组保持原序（JSON 数组的顺序是语义的一部分）；
 * - 循环/不可序列化值退化为 String()——绝不抛错。
 */
export function canonicalJson(value: unknown): string {
  try {
    const s = JSON.stringify(sortKeys(value));
    return s === undefined ? String(value) : s;
  } catch {
    return String(value);
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key]);
    return out;
  }
  return value;
}

/** score 归一到 [0,1] 并保留 6 位小数（与 usage 计价精度一致） */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 1_000_000) / 1_000_000;
}

export function round6(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0;
}

/** 点分路径取值（'a.b.0'）；缺省返回 undefined——绝不抛错 */
export function getPath(root: unknown, path: string): unknown {
  if (!path) return root;
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** 尝试把文本解析为 JSON（失败返回 null——绝不猜测/修复） */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
