/**
 * 站外跳转（M13-W5）——唯一允许离开本站的出口（OAuth 授权页 authorizeUrl）。
 *
 * 为什么单独成模块：
 *  - OAuth 授权必须由浏览器离开 SPA 去 provider 域（Next 的 router.push 不支持站外 URL，也不能用）；
 *  - `window.location` 在 jsdom 中是 [LegacyUnforgeable] 属性，**不可** stub/defineProperty/delete，
 *    页面单测若直接调它只会得到 "Not implemented: navigation" 噪声且无法断言目标地址；
 *  - 因此把这一格副作用隔离在此文件，页面单测用 `vi.mock('@/lib/redirect')` 观察跳转目标。
 *
 * 安全口径：调用方只允许传**服务端下发**的 authorizeUrl（不得由用户输入拼装）。
 */
export function redirectTo(url: string): void {
  window.location.assign(url);
}
