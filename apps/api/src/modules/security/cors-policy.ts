/**
 * M8-P8 CORS 策略（审计结论的落地实现；main.ts 唯一来源，避免"策略在 main.ts 里不可测"）。
 *
 * 审计事实：
 * - CORS 来源一直是显式白名单（`CORS_ORIGINS` 逗号分隔 + 精确匹配），从未使用 `origin: true` / `*`；
 * - 但 `CORS_ORIGINS` 的原解析 `.split(',')` 不 trim：`"http://a.com, http://b.com"`（带空格）会整体不匹配 → 沉默失效（fail-closed 但不透明）；
 * - 且没有任何护栏阻止运维把 `CORS_ORIGINS=*` 写进环境变量（credentials=true 时 `ACAO: *` 是错误配置；浏览器会拒收，但语义上等于"放开任意源"的意图被写进了配置）。
 *
 * 本函数把这条边界显式化（fail-closed）：
 * 1. 逐项 trim + 丢弃空项（修掉沉默失效）；
 * 2. 丢弃任何含 `*` 的项（通配/子域通配一律不支持：cors 包在数组模式下本就不支持通配，保留它只会给人"已放开"的错觉）；
 * 3. 结果为空（未配置/全是通配）→ 回落到本地开发默认白名单，**绝不**回落到 `*`。
 */
export const DEFAULT_CORS_ORIGINS = ['http://localhost:3000'] as const;

export function corsOriginsFromEnv(raw: string | undefined = process.env.CORS_ORIGINS): string[] {
  const parsed = (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const exact = parsed.filter((origin) => !origin.includes('*'));
  return exact.length ? exact : [...DEFAULT_CORS_ORIGINS];
}
