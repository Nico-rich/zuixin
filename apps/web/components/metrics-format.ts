/**
 * 指标展示格式化（M13-W6：/analytics · /feedback · /usage 三个页面共用）
 *
 * 纪律（红线：facts / derived / meta 必须如实分层呈现）：
 *  - 本模块**只做展示格式化**：千分位、金额、百分比、时长的字符串化；
 *  - 绝不做业务计算——成本/成功率/均值等派生值一律由服务端给出，前端不得自行推导、换算或改写；
 *  - `flattenFacts` 只把后端 facts 的嵌套对象展开成「点分键 → 原值」列表：不改数值、不算差值、不做单位换算。
 *  - 刻意不依赖 `Intl`/`toLocaleString`（ICU 差异会让 jsdom 与浏览器输出不一致），格式化结果可被测试逐字断言。
 */

/** 整数千分位（负数保留符号；非有限数 → —） */
export function fmtInt(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const negative = value < 0;
  const grouped = String(Math.abs(Math.trunc(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

/** 小数展示：最多 `maxFrac` 位、去掉尾部 0，整数不带小数点（展示层舍入，不改语义） */
export function fmtDecimal(value: number, maxFrac = 2): string {
  if (!Number.isFinite(value)) return '—';
  const fixed = value.toFixed(maxFrac);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

/**
 * 金额（计费事实源为 UsageRecord，计价单位为美元）。
 * 有效小数位随量级放大：小额成本（LLM 单次调用常见 1e-5 级）绝不显示成 `$0.00`。
 */
export function fmtCost(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return `$${fmtDecimal(value, digits)}`;
}

/** 比率 → 百分比。输入是**服务端算好的 0..1 比率**（页面只乘 100 做展示，不改变语义） */
export function fmtPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${fmtDecimal(ratio * 100, digits)}%`;
}

/** 时长（毫秒 → 人类可读；仅展示换算，不参与任何判定） */
export function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${fmtDecimal(seconds, 1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes - hours * 60}m`;
}

/** 日期时刻（本地时区，`YYYY-MM-DD HH:mm`；非法/空值 → —，绝不渲染 `Invalid Date`） */
export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 日期（本地时区，`YYYY-MM-DD`；用于 period 这类日粒度字段） */
export function fmtDate(value: string | null | undefined): string {
  const full = fmtDateTime(value);
  return full.includes(' ') ? full.split(' ')[0] : full;
}

export interface FactEntry {
  /** 点分路径（嵌套对象被展开，如 `byProvider.mock.calls`）；键按字典序稳定输出 */
  key: string;
  value: unknown;
}

/**
 * 把后端 `facts`（`Record<string, unknown>`，值可能是嵌套对象）展开为稳定的「键 → 原值」列表。
 * 纯结构展开：数组与空对象保留为单个条目（不猜测其内部结构），不会丢字段。
 */
export function flattenFacts(value: unknown, prefix = ''): FactEntry[] {
  // 空值：仅在带前缀时保留一个占位条目（供单值渲染复用）；无前缀的空输入 = 无字段可展示
  if (value === null || value === undefined) return prefix ? [{ key: prefix, value: null }] : [];
  if (typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length === 0) return prefix ? [{ key: prefix, value: {} }] : [];
    return entries.flatMap(([key, child]) => flattenFacts(child, prefix ? `${prefix}.${key}` : key));
  }
  return [{ key: prefix, value }];
}

/** 事实值的展示字符串：数字用千分位/小数，布尔转是/否，对象走 JSON（截断），空值 → — */
export function formatFactValue(value: unknown, maxLength = 120): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? fmtInt(value) : fmtDecimal(value, 6);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
  const json = JSON.stringify(value) ?? String(value);
  return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
}
