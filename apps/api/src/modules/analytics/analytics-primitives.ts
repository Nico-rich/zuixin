import { AppError, ErrorCode } from '../../common/errors/app-error';

/**
 * Analytics 叶子原语（日粒度工具 + 数值取整）。
 * M12-P2：从 analytics.service 原样抽出为独立叶子模块——聚合刷新与表现排序（agent-performance）
 * 依赖同一份 period 数学/取整口径，抽到叶子避免 analytics.service ⇄ agent-performance 循环依赖。
 * 语义逐字不变；analytics.service 仍 re-export（既有导入路径 `./analytics.service` 不受影响）。
 */

const DAY_MS = 86_400_000;

/** 统一 UTC 边界：period 与窗口同源，绝无本地时区漂移 */
export function periodOf(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function dayRange(period: string): { start: Date; end: Date } {
  const start = new Date(`${period}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new AppError(ErrorCode.VALIDATION_ERROR, `日期格式非法：${period}（期望 YYYY-MM-DD）`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export function addDays(period: string, delta: number): string {
  const { start } = dayRange(period);
  return periodOf(new Date(start.getTime() + delta * DAY_MS));
}

export function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
