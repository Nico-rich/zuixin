/**
 * 时间展示（M13-W3）：`YYYY-MM-DD HH:mm`（本地时区）。
 * 刻意不用 `toLocaleString`——其输出随 ICU/时区变化，页面单测无法稳定断言。
 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
