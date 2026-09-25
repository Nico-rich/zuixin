export const LIMITS = {
  IMAGE_MAX_MB: 20, VIDEO_MAX_MB: 200, FILE_MAX_MB: 50,
  IMAGE_TASK_TIMEOUT_MS: 5 * 60_000, VIDEO_TASK_TIMEOUT_MS: 30 * 60_000,
  DAILY_IMAGE_LIMIT_DEFAULT: 50, VIDEO_CONCURRENCY_DEFAULT: 1,
} as const;
export const ROUTER_DEFAULTS = { CONFIDENCE_THRESHOLD: 0.7 } as const;
/** 组织 id：uuid 或 personal-{uuid}（个人组织 id 非纯 UUID——z.string().uuid() 会拒绝合法的个人组织） */
export const ORG_ID_REGEX = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|personal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
