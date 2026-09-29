import { describe, expect, it } from 'vitest';
import {
  flattenFacts, fmtCost, fmtDate, fmtDateTime, fmtDecimal, fmtDurationMs, fmtInt, fmtPercent, formatFactValue,
} from '@/components/metrics-format';

/**
 * 展示格式化契约（M13-W6）：三个页面共用的数字/时间口径。
 *
 * 这些断言钉的是**展示层**行为，其中两条是红线：
 *  - 只格式化不计算：fmtPercent 只做 ×100 的展示换算（输入必须是服务端算好的比率）；
 *  - 小额成本绝不显示成 $0.00（金额精度随量级放大）——否则等于把事实抹平。
 */

describe('fmtInt：整数千分位', () => {
  it('千分位分组、负数保留符号、小数截断、非有限数给占位', () => {
    expect(fmtInt(0)).toBe('0');
    expect(fmtInt(999)).toBe('999');
    expect(fmtInt(1000)).toBe('1,000');
    expect(fmtInt(1234567)).toBe('1,234,567');
    expect(fmtInt(-1234)).toBe('-1,234');
    expect(fmtInt(1234.9)).toBe('1,234');
    expect(fmtInt(Number.NaN)).toBe('—');
  });
});

describe('fmtDecimal：小数（去尾零）', () => {
  it('按最大位数舍入并去掉尾部 0；-0 归一为 0', () => {
    expect(fmtDecimal(2)).toBe('2');
    expect(fmtDecimal(1.5, 2)).toBe('1.5');
    expect(fmtDecimal(1.25, 2)).toBe('1.25');
    expect(fmtDecimal(12.5, 4)).toBe('12.5');
    expect(fmtDecimal(-0.0000001, 6)).toBe('0');
    expect(fmtDecimal(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('fmtCost：金额（精度随量级放大）', () => {
  it('≥1 用 2 位、≥0.01 用 4 位、更小用 6 位——小额成本不被抹成 $0.00', () => {
    expect(fmtCost(1.234)).toBe('$1.23');
    expect(fmtCost(1.2)).toBe('$1.2');
    expect(fmtCost(0.05)).toBe('$0.05');
    expect(fmtCost(0.4)).toBe('$0.4');
    expect(fmtCost(0.0000123)).toBe('$0.000012');
    expect(fmtCost(0)).toBe('$0');
  });
});

describe('fmtPercent：比率 → 百分比（仅展示换算，服务端口径不变）', () => {
  it('0..1 比率乘 100 展示；非法值占位', () => {
    expect(fmtPercent(0.5)).toBe('50%');
    expect(fmtPercent(0)).toBe('0%');
    expect(fmtPercent(1)).toBe('100%');
    expect(fmtPercent(0.3333)).toBe('33.3%');
    expect(fmtPercent(Number.NaN)).toBe('—');
  });
});

describe('fmtDurationMs：时长', () => {
  it('ms/s/m/h 分档（含进位取整）', () => {
    expect(fmtDurationMs(500)).toBe('500ms');
    expect(fmtDurationMs(1500)).toBe('1.5s');
    expect(fmtDurationMs(125000)).toBe('2m 5s');
    expect(fmtDurationMs(3600000)).toBe('1h 0m');
    expect(fmtDurationMs(-1)).toBe('—');
  });
});

describe('fmtDateTime / fmtDate：本地时区展示', () => {
  it('按本地时区渲染 YYYY-MM-DD HH:mm，非法值不产生 Invalid Date', () => {
    const iso = new Date(2026, 8, 28, 13, 5).toISOString(); // 本地 2026-09-28 13:05
    expect(fmtDateTime(iso)).toBe('2026-09-28 13:05');
    expect(fmtDate(iso)).toBe('2026-09-28');
    expect(fmtDateTime(null)).toBe('—');
    expect(fmtDateTime(undefined)).toBe('—');
    expect(fmtDateTime('not-a-date')).toBe('not-a-date');
  });
});

describe('flattenFacts：facts 结构展开（不猜结构、不丢字段）', () => {
  it('嵌套对象展开为点分键并按字典序稳定输出', () => {
    expect(flattenFacts({ b: 1, a: { d: 2, c: 3 } })).toEqual([
      { key: 'a.c', value: 3 },
      { key: 'a.d', value: 2 },
      { key: 'b', value: 1 },
    ]);
  });

  it('数组与空对象保留为单条目（不猜测内部结构）；空输入产出空列表', () => {
    expect(flattenFacts({ byTrigger: { cron: 2 }, list: [1, 2] })).toEqual([
      { key: 'byTrigger.cron', value: 2 },
      { key: 'list', value: [1, 2] },
    ]);
    expect(flattenFacts({ nested: {} })).toEqual([{ key: 'nested', value: {} }]);
    expect(flattenFacts({})).toEqual([]);
    expect(flattenFacts(null)).toEqual([]);
  });

  it('顶层标量按给定前缀返回（供单值渲染复用）', () => {
    expect(flattenFacts(42, 'derived.ctr')).toEqual([{ key: 'derived.ctr', value: 42 }]);
  });
});

describe('formatFactValue：事实原值展示', () => {
  it('整数千分位、小数最多 6 位、布尔转是/否、空值占位', () => {
    expect(formatFactValue(1234567)).toBe('1,234,567');
    expect(formatFactValue(0.1234567)).toBe('0.123457');
    expect(formatFactValue(true)).toBe('是');
    expect(formatFactValue(false)).toBe('否');
    expect(formatFactValue(null)).toBe('—');
    expect(formatFactValue(undefined)).toBe('—');
  });

  it('长字符串与对象 JSON 截断（避免撑破表格）', () => {
    const long = 'x'.repeat(200);
    expect(formatFactValue(long).endsWith('…')).toBe(true);
    expect(formatFactValue(long).length).toBe(121);
    expect(formatFactValue({ a: 1 })).toBe('{"a":1}');
  });
});
