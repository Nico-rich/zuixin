export const COOKIE_ACCESS = 'agent_access';
export const COOKIE_REFRESH = 'agent_refresh';
export const ACCESS_TTL_SEC = Number(process.env.JWT_ACCESS_TTL_SEC ?? 900);
export const REFRESH_TTL_SEC = Number(process.env.JWT_REFRESH_TTL_SEC ?? 30 * 24 * 3600);
export const LOGIN_MAX_FAILS = 5;
export const LOGIN_FAIL_WINDOW_SEC = 300;
