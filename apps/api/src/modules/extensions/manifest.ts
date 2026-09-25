import { z } from 'zod';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/**
 * M8-P6 Extension SDK —— 声明式 manifest（严格 zod 校验；**绝无任何可执行代码路径**）。
 *
 * 安全边界（本文件是唯一入口，全部非法/越权声明一律 VALIDATION_ERROR）：
 * - manifest 只描述"做什么"（包装哪个平台已有工具、哪个 prompt 模板、哪个 provider 模型），
 *   绝不携带可执行代码（无 eval/Function/vm/child_process）、密钥、文件路径、数据库连接；
 * - 权限必须落在平台白名单内，且不得超出所属 kind 的能力域（越权声明拒绝）；
 * - provider.baseUrl 必须是公网 https（禁 localhost/私网/回环——SSRF 边界）；
 * - apiKey 等凭证只能由"安装时组织 config"提供（服务端加密落库），manifest 携带即拒绝。
 */

export const EXTENSION_KINDS = ['tool', 'agent', 'provider', 'workflow_step'] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

/** 扩展版本状态机（绝不逆向；见 ExtensionsService） */
export const EXTENSION_STATUSES = ['draft', 'published', 'deprecated', 'archived'] as const;
export type ExtensionStatus = (typeof EXTENSION_STATUSES)[number];

/** 平台权限白名单（manifest 只能声明这些名字；绝不自定义权限） */
export const PLATFORM_PERMISSION_WHITELIST = [
  'tool.execute', 'agent.run', 'provider.call', 'workflow.step', 'config.read', 'config.write',
] as const;
export type ExtensionPermissionName = (typeof PLATFORM_PERMISSION_WHITELIST)[number];

/** 每个 kind 允许声明的权限域（最小权限：tool 类不能声明 provider.call 等） */
const KIND_PERMISSION_SCOPE: Record<ExtensionKind, ExtensionPermissionName[]> = {
  tool: ['tool.execute', 'config.read', 'config.write'],
  agent: ['agent.run', 'config.read', 'config.write'],
  provider: ['provider.call', 'config.read', 'config.write'],
  workflow_step: ['workflow.step', 'config.read', 'config.write'],
};

/** 每个 kind 必须声明的核心权限（声明缺失 → 拒绝） */
const KIND_REQUIRED_PERMISSION: Record<ExtensionKind, ExtensionPermissionName> = {
  tool: 'tool.execute',
  agent: 'agent.run',
  provider: 'provider.call',
  workflow_step: 'workflow.step',
};

/** 可被扩展包装的平台工具权限（只读/写入/生成；破坏性/财务/外部副作用一律不可包装） */
export const WRAPPABLE_TOOL_PERMISSIONS = ['read', 'write', 'generate'] as const;

/** 工具名命名空间：ext.<slug>.<name>（必须前缀 ext.） */
export const EXT_TOOL_NAME_PATTERN = /^ext\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$/;

const PermissionNameSchema = z.enum(PLATFORM_PERMISSION_WHITELIST);
/** 权限声明的兼容位（规范位置在顶层 permissions；块内写法等价且必须一致） */
const BlockPermissionsSchema = z.array(PermissionNameSchema).min(1).max(6).optional();

/** 每参数约束（执行前校验；不修改平台工具自身 schema） */
export const ParamConstraintSchema = z.strictObject({
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1).max(50).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  pattern: z.string().min(1).max(200).optional(),
  required: z.boolean().optional(),
  description: z.string().min(1).max(200).optional(),
}).superRefine((v, ctx) => {
  const hasRule = v.enum !== undefined || v.min !== undefined || v.max !== undefined || v.pattern !== undefined || v.required !== undefined;
  if (!hasRule) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '参数约束必须至少声明 enum/min/max/pattern/required 之一' });
  if (v.min !== undefined && v.max !== undefined && v.min > v.max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '参数约束 min 不得大于 max' });
  }
  if (v.enum !== undefined && (v.min !== undefined || v.max !== undefined || v.pattern !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '参数约束 enum 不能与 min/max/pattern 同时声明' });
  }
});
export type ParamConstraint = z.infer<typeof ParamConstraintSchema>;

/** kind=tool：包装一个平台已有工具 + 每参数约束（paramConstraints 只做拒绝，绝不注入/改写输入） */
const ToolBlockSchema = z.strictObject({
  name: z.string().min(7).max(120).regex(EXT_TOOL_NAME_PATTERN, '工具名必须是 ext.<slug>.<name> 命名空间（前缀 ext.）'),
  description: z.string().min(1).max(500),
  baseTool: z.string().min(3).max(80).regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'baseTool 必须是平台工具名（如 knowledge.search）'),
  paramConstraints: z.record(z.string().min(1).max(64), ParamConstraintSchema).optional(),
  permissions: BlockPermissionsSchema,
});

/** kind=agent：systemPrompt 模板 + 平台工具子集（模板变量白名单，绝不执行任何模板代码） */
const AgentBlockSchema = z.strictObject({
  name: z.string().min(2).max(50).regex(/^[a-z0-9][a-z0-9_-]*$/, 'Agent 名只能是小写字母/数字/中划线/下划线'),
  description: z.string().min(1).max(500),
  systemPrompt: z.string().min(1).max(8000),
  tools: z.array(z.string().min(3).max(80)).max(50).default([]),
  permissions: BlockPermissionsSchema,
});

/** kind=provider：仅 openai-compatible 适配器；baseUrl 必须公网 https（禁 SSRF） */
const ProviderBlockSchema = z.strictObject({
  name: z.string().min(1).max(100),
  adapter: z.literal('openai-compatible'),
  baseUrl: z.string().min(8).max(300).url(),
  models: z.array(z.strictObject({
    name: z.string().min(1).max(100),
    apiModelId: z.string().min(1).max(200),
    type: z.enum(['llm', 'image', 'video', 'embedding']),
    enabled: z.boolean().optional(),
  })).min(1).max(20),
  permissions: BlockPermissionsSchema,
});

/** kind=workflow_step：可查询步骤模板（只声明；执行器改动不在本 Phase） */
const WorkflowStepBlockSchema = z.strictObject({
  name: z.string().min(2).max(50).regex(/^[a-z0-9][a-z0-9_-]*$/, '步骤名只能是小写字母/数字/中划线/下划线'),
  stepType: z.enum(['tool', 'agent', 'output']),
  description: z.string().min(1).max(500).optional(),
  params: z.record(z.string().min(1).max(64), z.unknown()).default({}),
  permissions: BlockPermissionsSchema,
});

const ManifestBase = z.strictObject({
  manifestVersion: z.literal(1),
  kind: z.enum(EXTENSION_KINDS),
  /** 规范位置（版本级权限）；兼容各 kind 块内写法，两者必须一致 */
  permissions: z.array(PermissionNameSchema).min(1).max(6).optional(),
  tool: ToolBlockSchema.optional(),
  agent: AgentBlockSchema.optional(),
  provider: ProviderBlockSchema.optional(),
  workflow_step: WorkflowStepBlockSchema.optional(),
});

export type ToolBlock = z.infer<typeof ToolBlockSchema>;
export type AgentBlock = z.infer<typeof AgentBlockSchema>;
export type ProviderBlock = z.infer<typeof ProviderBlockSchema>;
export type WorkflowStepBlock = z.infer<typeof WorkflowStepBlockSchema>;
export interface ExtensionManifest {
  manifestVersion: 1;
  kind: ExtensionKind;
  permissions: ExtensionPermissionName[];
  tool?: ToolBlock;
  agent?: AgentBlock;
  provider?: ProviderBlock;
  workflow_step?: WorkflowStepBlock;
}

/** Agent systemPrompt 模板变量白名单（未知占位符一律拒绝；绝不执行模板代码） */
export const AGENT_PROMPT_VARS = ['extension.name', 'extension.slug', 'extension.description', 'organization.id'] as const;
const PLACEHOLDER_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** 禁止出现的密钥字段名（manifest 绝不携带凭证——凭证只能来自安装时组织 config） */
const SECRET_KEY_PATTERN = /(api[-_]?key|apikey|secret|token|password|passwd|credential|private[-_]?key|bearer|authorization|session[-_]?key)/i;
/** 禁止出现的密钥形态字面量 */
const SECRET_VALUE_PATTERN = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9\-._~+/]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(ql)?:\/\/|redis:\/\/|mysql:\/\/)/;

/** 稳定序列化（键排序；确保 checksum 与键序无关、可复算） */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** manifest 内容摘要（sha256 hex）——版本不可变标识 */
export function checksumOf(manifest: unknown): string {
  return createHash('sha256').update(stableStringify(manifest), 'utf8').digest('hex');
}

/** 发布签名 = HMAC-SHA256(checksum, 平台密钥)。平台密钥来自 ENCRYPTION_KEY（与 at-rest 加密同源） */
export function signChecksum(checksum: string, platformKey: string): string {
  if (!platformKey) throw new AppError(ErrorCode.INTERNAL, '平台签名密钥缺失');
  return createHmac('sha256', platformKey).update(checksum, 'utf8').digest('hex');
}

/** 签名校验（常量时间比较；长度不符直接 false） */
export function verifySignature(checksum: string, signature: string | null | undefined, platformKey: string): boolean {
  if (!signature || !platformKey) return false;
  const expected = Buffer.from(signChecksum(checksum, platformKey), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** 密钥扫描：返回第一个违规路径（null = 干净） */
export function findSecretPath(value: unknown, path = 'manifest', depth = 0): string | null {
  if (depth > 12) return `${path}（嵌套过深）`;
  if (typeof value === 'string') {
    return SECRET_VALUE_PATTERN.test(value) ? path : null;
  }
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecretPath(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(k)) return `${path}.${k}`;
    const hit = findSecretPath(v, `${path}.${k}`, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** JSON 安全（声明式数据只能是 JSON 标量/数组/普通对象；函数/DOM/类实例一律拒绝） */
export function findNonJsonPath(value: unknown, path = 'manifest', depth = 0): string | null {
  if (depth > 12) return `${path}（嵌套过深）`;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return null;
  if (t === 'function' || t === 'symbol' || t === 'bigint' || t === 'undefined') return `${path}（非 JSON 值：${t}）`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findNonJsonPath(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const proto = Object.getPrototypeOf(value as object);
  if (proto !== Object.prototype && proto !== null) return `${path}（非普通对象）`;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const hit = findNonJsonPath(v, `${path}.${k}`, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** 公网 https 校验（SSRF 边界：禁 localhost/私网/回环/内网域名） */
export function assertPublicHttpsUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'baseUrl 非法';
  }
  if (url.protocol !== 'https:') return 'baseUrl 必须是 https';
  if (url.username || url.password) return 'baseUrl 不得包含凭证';
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return 'baseUrl 不得指向本机/内网';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    const isPrivate = a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    if (isPrivate) return 'baseUrl 不得指向私网地址';
  }
  if (host === '[::1]' || host.startsWith('fd') || host.startsWith('fe80')) return 'baseUrl 不得指向私网地址';
  return null;
}

/** zod 对象的字段名清单（用于 paramConstraints 引用校验；非 object schema → null） */
export function zodObjectKeys(schema: unknown): string[] | null {
  const s = schema as { _def?: { typeName?: string; shape?: () => Record<string, unknown> } } | undefined;
  if (!s?._def || s._def.typeName !== 'ZodObject' || typeof s._def.shape !== 'function') return null;
  return Object.keys(s._def.shape());
}

/** Agent systemPrompt 模板渲染（仅白名单变量；未知占位符在 parse 阶段已拒绝） */
export function renderAgentPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER_PATTERN, (_m, name: string) => {
    const key = name.trim();
    if (!(AGENT_PROMPT_VARS as readonly string[]).includes(key)) return '';
    return vars[key] ?? '';
  });
}

function fail(message: string): never {
  throw new AppError(ErrorCode.VALIDATION_ERROR, `扩展 manifest 非法：${message}`);
}

/** 从（多来源）权限声明中归一化出权限清单（块内写法必须与顶层一致） */
function normalizedPermissions(parsed: z.infer<typeof ManifestBase>): ExtensionPermissionName[] {
  const blockPerms = (parsed[parsed.kind] as { permissions?: ExtensionPermissionName[] } | undefined)?.permissions;
  const top = parsed.permissions;
  if (top && blockPerms && JSON.stringify([...top].sort()) !== JSON.stringify([...blockPerms].sort())) {
    fail('permissions 顶层与 kind 块内声明不一致');
  }
  const perms = top ?? blockPerms ?? [];
  if (!perms.length) fail('必须声明 permissions');
  const allowed = KIND_PERMISSION_SCOPE[parsed.kind];
  for (const p of perms) {
    if (!allowed.includes(p)) fail(`kind=${parsed.kind} 不得声明权限 ${p}（越权声明）`);
  }
  if (!perms.includes(KIND_REQUIRED_PERMISSION[parsed.kind])) {
    fail(`kind=${parsed.kind} 必须声明权限 ${KIND_REQUIRED_PERMISSION[parsed.kind]}`);
  }
  return [...new Set(perms)];
}

export interface ParsedManifest {
  manifest: ExtensionManifest;
  permissions: ExtensionPermissionName[];
  checksum: string;
}

/**
 * manifest 严格校验（唯一入口）：
 * 1) 密钥/非 JSON 扫描（先于 zod——拒绝一切非声明式内容）；
 * 2) zod 分型结构校验（kind ↔ 定义块一一对应、strict 无未知字段）；
 * 3) kind 权限域 + 白名单 + 必需权限；
 * 4) kind 专有语义（ext. 命名空间与 slug 一致、provider SSRF、workflow_step 参数、prompt 模板变量）。
 */
export function parseManifest(raw: unknown, opts: { slug?: string } = {}): ParsedManifest {
  const secret = findSecretPath(raw);
  if (secret) fail(`不得携带密钥/凭证（${secret}）；凭证只能由安装时组织 config 提供`);
  const nonJson = findNonJsonPath(raw);
  if (nonJson) fail(`只能是声明式 JSON 数据（${nonJson}）`);

  const result = ManifestBase.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`).join('; ');
    fail(detail);
  }
  const parsed = result.data;

  const presentBlocks = EXTENSION_KINDS.filter((k) => parsed[k] !== undefined);
  if (presentBlocks.length !== 1 || presentBlocks[0] !== parsed.kind) {
    fail(`kind 与定义块必须一一对应（kind=${parsed.kind}，实际定义块=[${presentBlocks.join(',')}]）`);
  }
  const permissions = normalizedPermissions(parsed);

  if (parsed.kind === 'tool') {
    const tool = parsed.tool!;
    // 命名空间绑定：ext.<slug>.<name> 的 slug 段必须等于扩展 slug（防止冒用他人命名空间）
    if (opts.slug && tool.name.split('.')[1] !== opts.slug) {
      fail(`工具名命名空间必须与扩展 slug 一致（期望 ext.${opts.slug}.<name>）`);
    }
    if (tool.baseTool.startsWith('ext.')) fail('baseTool 不得引用其它扩展工具（禁止扩展链）');
    for (const [param, constraint] of Object.entries(tool.paramConstraints ?? {})) {
      if (constraint.pattern) {
        try {
          new RegExp(constraint.pattern); // 只编译校验合法性；执行期做长度上限保护
        } catch {
          fail(`参数约束 pattern 非法：${param}`);
        }
      }
    }
  }

  if (parsed.kind === 'agent') {
    const agent = parsed.agent!;
    if (agent.tools.some((t) => t.startsWith('ext.'))) fail('agent.tools 不得引用其它扩展工具（禁止扩展链）');
    const unknown = [...agent.systemPrompt.matchAll(PLACEHOLDER_PATTERN)].map((m) => m[1].trim())
      .filter((v) => !(AGENT_PROMPT_VARS as readonly string[]).includes(v));
    if (unknown.length) fail(`systemPrompt 模板变量不在白名单：${[...new Set(unknown)].join(', ')}`);
  }

  if (parsed.kind === 'provider') {
    const provider = parsed.provider!;
    const urlError = assertPublicHttpsUrl(provider.baseUrl);
    if (urlError) fail(urlError);
  }

  if (parsed.kind === 'workflow_step') {
    const step = parsed.workflow_step!;
    const params = step.params as Record<string, unknown>;
    if (step.stepType === 'tool' && typeof params.toolName !== 'string') fail('workflow_step(tool) 必须声明 params.toolName');
    if (step.stepType === 'agent' && typeof params.message !== 'string') fail('workflow_step(agent) 必须声明 params.message');
    if (step.stepType === 'tool' && typeof params.toolName === 'string' && params.toolName.startsWith('ext.')) {
      fail('workflow_step 不得引用扩展工具（禁止扩展链）');
    }
  }

  // 归一化：块内 permissions 折叠到顶层（存储/签名只依赖归一化后的内容）
  const manifest: ExtensionManifest = {
    manifestVersion: 1,
    kind: parsed.kind,
    permissions,
    ...(parsed.tool ? { tool: stripBlockPermissions(parsed.tool) } : {}),
    ...(parsed.agent ? { agent: stripBlockPermissions(parsed.agent) } : {}),
    ...(parsed.provider ? { provider: stripBlockPermissions(parsed.provider) } : {}),
    ...(parsed.workflow_step ? { workflow_step: stripBlockPermissions(parsed.workflow_step) } : {}),
  };
  return { manifest, permissions, checksum: checksumOf(manifest) };
}

function stripBlockPermissions<T extends { permissions?: unknown }>(block: T): Omit<T, 'permissions'> {
  const { permissions: _drop, ...rest } = block;
  return rest;
}

/** 单参数约束检查（返回违规描述；null = 通过）。只做"拒绝"，绝不改写输入 */
export function checkParamConstraints(
  constraints: Record<string, ParamConstraint> | undefined,
  input: unknown,
): string | null {
  if (!constraints) return null;
  const obj = (input ?? {}) as Record<string, unknown>;
  for (const [param, c] of Object.entries(constraints)) {
    const value = obj[param];
    if (value === undefined || value === null) {
      if (c.required) return `缺少必需参数 ${param}`;
      continue;
    }
    if (typeof value === 'string' && value.length > 5000) return `参数 ${param} 超长`;
    if (c.enum && !c.enum.some((allowed) => allowed === value)) return `参数 ${param} 不在允许取值范围内`;
    if (typeof c.min === 'number' || typeof c.max === 'number') {
      const num = Number(value);
      if (!Number.isFinite(num)) return `参数 ${param} 必须是有限数字`;
      if (typeof c.min === 'number' && num < c.min) return `参数 ${param} 小于下界 ${c.min}`;
      if (typeof c.max === 'number' && num > c.max) return `参数 ${param} 大于上界 ${c.max}`;
    }
    if (c.pattern !== undefined) {
      if (typeof value !== 'string') return `参数 ${param} 必须是字符串（pattern 约束）`;
      const re = new RegExp(c.pattern);
      if (!re.test(value)) return `参数 ${param} 不匹配约束 pattern`;
    }
  }
  return null;
}
