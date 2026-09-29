/**
 * M10-P1 生产安全守卫（D2/D8/D23/PR-8）：**启动期 fail-fast**，不是运行期兜底。
 *
 * 威胁模型：本地开发为了"零配置可跑"引入了一批占位密钥与开发替身开关
 * （`JWT_SECRET=change_me_...`、`ENCRYPTION_KEY=change_me_...`、`SEED_ADMIN_PASSWORD=admin123456`、
 * `MOCK_DELAY_MS`/`MOCK_LLM_FAILURE`/`MOCK_LLM_STALL_MS`/`MOCK_EMBEDDING_DIMS`/`LLM_RETRY_BACKOFF_MS`）。
 * 这些值一旦随镜像/部署清单进入生产：
 * - 占位 JWT_SECRET = 任何人都能伪造任意用户的 access token（含 admin）；
 * - 占位 ENCRYPTION_KEY = 落库凭证（provider API Key / OAuth token / webhook secret）等于明文；
 * - 开发替身开关 = 故障注入/延迟注入被外部输入触发（如 `MOCK_LLM_FAILURE` 让全站 LLM 直接失败）。
 *
 * 口径（诚实边界）：
 * - **生产**（`NODE_ENV === 'production'`）→ 收集**全部**违规项，一次性抛出并列出（不让运维"修一个报一个"）；
 * - **非生产** → 只 `warn`（开发/测试必须能零配置跑通；不静默：每条替身开关都会出现在启动日志里）；
 * - 本守卫是**配置面**判定，不做任何网络/DB 访问（必须在 NestFactory.create 之前可执行）；
 * - 覆盖范围：API 进程（`main.ts`）、Worker 进程（`worker.ts`，M11-P10 E-08 已接线）与种子脚本（`prisma/seed.ts`）
 *   （`worker.ts` 不在本 Phase 所有权内）——见 M10-P1 报告"依赖/未覆盖"。
 */
import { Logger } from '@nestjs/common';

/** 开发替身开关（生产启用即违规）：这些 env 只服务于本地零配置/故障注入，生产必须完全不存在 */
export const DEV_SUBSTITUTE_ENV_KEYS = [
  'MOCK_DELAY_MS',
  'MOCK_LLM_FAILURE',
  'MOCK_LLM_STALL_MS',
  'MOCK_EMBEDDING_DIMS',
  'LLM_RETRY_BACKOFF_MS',
] as const;

/**
 * 占位密钥识别（宁可误报也不放过：生产被拦下的运维成本 << 占位密钥泄漏的代价）。
 * 命中任一子串或等于任一保留值即视为占位。
 */
const PLACEHOLDER_SUBSTRINGS = [
  'change_me', 'change-me', 'changeme',
  'dev-secret', 'dev_secret', 'devsecret',
  'placeholder', 'replace_me', 'replace-me',
  'your-secret', 'your_secret', 'your-key', 'your_key', 'your_password', 'your-password',
  'insecure', 'not-a-secret', 'todo', 'example.com/secret',
];

const PLACEHOLDER_EXACT = new Set([
  'secret', 'password', 'passwd', 'jwt', 'jwtsecret', 'jwt-secret', 'jwt_secret',
  'test', 'testing', 'dev', 'development', 'admin', 'admin123', 'admin123456',
  'xxx', 'xxxx', 'xxxxxx', '123456', '12345678', 'changeme',
]);

export function isPlaceholderSecret(value: string | undefined | null): boolean {
  const v = (value ?? '').trim();
  if (v === '') return true; // 缺失 = 占位（生产绝不允许"空密钥"）
  const lower = v.toLowerCase();
  if (PLACEHOLDER_EXACT.has(lower)) return true;
  if (PLACEHOLDER_SUBSTRINGS.some((s) => lower.includes(s))) return true;
  // `<YOUR_KEY>` / `{{secret}}` 这类模板占位
  if (/^[<{].{0,40}[>}]$/.test(v)) return true;
  return false;
}

/** 是否合法的 base64 32 字节密钥（ENCRYPTION_KEY 的硬性要求） */
export function isValidEncryptionKey(value: string | undefined | null): boolean {
  const v = (value ?? '').trim();
  if (v === '') return false;
  try {
    return Buffer.from(v, 'base64').length === 32;
  } catch {
    return false;
  }
}

/** 开发默认口令（seed 在生产的拒绝名单；同时覆盖 `.env.example` 的历史默认值） */
export const DEV_DEFAULT_SEED_PASSWORDS = new Set(['admin123456', 'admin123', 'changeme', 'password', '123456']);

export interface ProductionSafetyReport {
  /** 判定模式（production = 违规即抛错；其余 = 仅告警） */
  mode: 'production' | 'non-production';
  /**
   * 生产下会导致启动失败的违规项（人类可读，已脱敏——绝不回显密钥值本身）。
   * **与 mode 无关地计算**：非生产下也照样列出，便于部署前用同一份配置 dry-run
   * （"若这是生产，会被哪几条拦下"）；是否真的阻断由 `assertProductionSafety` 按 mode 裁决。
   */
  violations: string[];
  /** 非生产下的提示项（哪些开发替身/占位被启用了） */
  warnings: string[];
}

type EnvLike = Record<string, string | undefined>;

/**
 * 纯函数审计（不抛错、不访问外部资源）——单测直接对着它断言，部署脚本也可 dry-run。
 * @param env 默认 process.env；测试显式传入避免污染全局
 */
export function auditProductionSafety(env: EnvLike = process.env): ProductionSafetyReport {
  const mode: ProductionSafetyReport['mode'] = env.NODE_ENV === 'production' ? 'production' : 'non-production';
  const violations: string[] = [];
  const warnings: string[] = [];

  // ① JWT_SECRET：占位/过短 → 可被暴力/直接伪造 sign
  const jwt = env.JWT_SECRET;
  if (isPlaceholderSecret(jwt)) {
    violations.push('JWT_SECRET 为默认占位或缺失（生产必须使用 openssl rand -base64 32 生成的随机密钥）');
  } else if ((jwt ?? '').length < 32) {
    violations.push(`JWT_SECRET 长度不足（${(jwt ?? '').length} < 32）`);
  }

  // ② ENCRYPTION_KEY：占位/非 32 字节 → 落库凭证等效明文
  const enc = env.ENCRYPTION_KEY;
  const encConfigured = env.ENCRYPTION_KEYS != null && env.ENCRYPTION_KEYS.trim() !== '';
  if (!encConfigured) {
    if (isPlaceholderSecret(enc)) {
      violations.push('ENCRYPTION_KEY 为默认占位或缺失（生产必须使用 openssl rand -base64 32 生成的随机密钥）');
    } else if (!isValidEncryptionKey(enc)) {
      violations.push('ENCRYPTION_KEY 不是 base64 编码的 32 字节密钥');
    }
  } else {
    // M10 Final Audit：ENCRYPTION_KEYS 非空时也必须逐条校验——一个"长得像随机"的占位
    // 多密钥配置曾可整体绕过 ② 的 fail-fast
    for (const pair of env.ENCRYPTION_KEYS!.split(',')) {
      const [ver, key] = pair.split(':');
      if (!ver || !key || isPlaceholderSecret(key) || !isValidEncryptionKey(key)) {
        violations.push(`ENCRYPTION_KEYS 含非法条目（版本 ${ver ?? '?'}：占位/非 base64-32 字节密钥）`);
      }
    }
  }

  // ③ 开发替身开关：生产启用 = 可被外部触发的故障注入面
  for (const key of DEV_SUBSTITUTE_ENV_KEYS) {
    const value = env[key];
    if (value === undefined || value === '') continue;
    const line = `${key}=${value}（开发替身/故障注入开关，生产禁止启用）`;
    if (mode === 'production') violations.push(line);
    else warnings.push(line);
  }

  // ④ seed 默认口令（seed 在生产的拒绝口径；此处保留在报告里以便部署前 dry-run 发现）
  if (isPlaceholderSecret(env.SEED_ADMIN_PASSWORD) || DEV_DEFAULT_SEED_PASSWORDS.has((env.SEED_ADMIN_PASSWORD ?? '').trim())) {
    const line = 'SEED_ADMIN_PASSWORD 为默认/占位口令（生产 seed 将拒绝执行）';
    if (mode === 'production') violations.push(line);
    else warnings.push(line);
  }

  // ⑤ 非生产下的弱密钥提示（不拦，但让开发知道"这不是生产可用的东西"）
  if (mode !== 'production') {
    if (isPlaceholderSecret(jwt)) warnings.push('JWT_SECRET 为默认占位（仅限本地开发/测试）');
    if (isPlaceholderSecret(enc) && !encConfigured) warnings.push('ENCRYPTION_KEY 为默认占位（仅限本地开发/测试）');
  }

  return { mode, violations, warnings };
}

/**
 * 启动守卫：生产下有任何违规即抛错（fail-fast，绝不"带病启动"）；非生产只告警。
 * @throws Error 生产 + 存在违规（错误消息只列配置项名与原因，**绝不回显密钥值**）
 */
export function assertProductionSafety(env: EnvLike = process.env, logger?: Logger): void {
  const report = auditProductionSafety(env);
  const log = logger ?? new Logger('ProductionGuard');
  if (report.mode === 'production') {
    if (report.violations.length > 0) {
      throw new Error(
        `生产环境安全守卫失败（NODE_ENV=production），拒绝启动：\n  - ${report.violations.join('\n  - ')}\n` +
        '请修正 .env / 部署清单后重启（本地开发请勿设置 NODE_ENV=production）。',
      );
    }
    return;
  }
  for (const w of report.warnings) log.warn(`[非生产] ${w}`);
}

/**
 * seed 守卫：生产环境拒绝用默认/占位管理员口令初始化（避免生产出现一个已知口令的 admin）。
 * @throws Error 生产 + 口令是默认/占位/过短
 */
export function assertSeedPasswordSafe(env: EnvLike = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const password = env.SEED_ADMIN_PASSWORD;
  if (isPlaceholderSecret(password)) {
    throw new Error('生产环境拒绝执行 seed：SEED_ADMIN_PASSWORD 缺失或为占位口令（请显式提供强口令）');
  }
  if (DEV_DEFAULT_SEED_PASSWORDS.has((password ?? '').trim())) {
    throw new Error('生产环境拒绝执行 seed：SEED_ADMIN_PASSWORD 为开发默认口令（admin123456 等）');
  }
  if ((password ?? '').length < 12) {
    throw new Error(`生产环境拒绝执行 seed：SEED_ADMIN_PASSWORD 长度不足（${(password ?? '').length} < 12）`);
  }
}
