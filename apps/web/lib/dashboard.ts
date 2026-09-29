import { conversationKeys } from '@/lib/services/conversations';

/**
 * Dashboard 首页（M13-W8）的取数口径与展示格式化。
 *
 * 为什么单独放 `lib/` 而不是 `app/page.tsx`：Next 的路由文件**只允许**导出页面约定符号
 * （default / metadata / config / generateStaticParams …），在 page.tsx 里多导出一个常量或函数，
 * `next build` 的类型校验会直接失败（`OmitWithTag<…> does not satisfy { [x: string]: never }`，本 wave 实测）。
 * 放这里后页面与测试共用同一份事实源，且路由文件保持「只有渲染」。
 */

/** 概览口径固定为「今日」（day = 1 天，UTC 日粒度；历史区间在 /analytics 页看） */
export const OVERVIEW_RANGE = 'day' as const;
/** 组织归属省略 = 服务端解析（个人组织优先）；前端绝不自己拼组织 id */
export const OVERVIEW_PATH = `/api/v1/analytics/overview?range=${OVERVIEW_RANGE}`;
/** 最近会话条数（产品口径：首屏 5 条；完整列表在 /chat 侧栏） */
export const RECENT_LIMIT = 5;
export const RECENT_PATH = `/api/v1/conversations?limit=${RECENT_LIMIT}`;

/**
 * 最近会话的查询键：**必须与聊天侧栏的 `['conversations', projectId]` 区分开**。
 *
 * 侧栏取的是「全量首屏」（默认 50 条），本页取的是 limit=5。React Query 的键哈希把 `undefined`
 * 归一为 `null`，若本页直接用 `conversationKeys.list(null)`，就会命中侧栏 `['conversations', undefined]`
 * 的**同一条缓存**——先挂载的一方把结果写进去，另一方在 staleTime（30s）内直接复用，于是侧栏只剩
 * 5 条（或本页显示 50 条），且没有任何报错。
 *
 * 用 `conversationKeys.all` 作前缀：既避开缓存条目冲突，又保留「删除会话 →
 * invalidateQueries(['conversations']) 能一并刷新本页」的前缀失效语义。
 */
export const RECENT_CONVERSATIONS_KEY = [...conversationKeys.all, 'recent', RECENT_LIMIT] as const;

/** 相对时间（会话列表按 updatedAt 倒序；超过一天直接给 UTC 日期，避免时区漂移） */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '—';
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toISOString().slice(0, 10);
}

/** 绝对时间（聚合行 refreshedAt：本地时区，分钟精度；解析失败给「—」而不是 Invalid Date） */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
