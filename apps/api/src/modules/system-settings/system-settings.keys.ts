/**
 * M12-P4 受控键白名单（**硬编码**——绝不从配置/DB/请求推导，绝无通用写口）。
 *
 * 审计事实（M12）：`SystemSetting` 全仓此前只有 seed 两条写入，**无任何运行时写入口**；
 * 运营者改一个阈值必须改代码重启。本文件定义唯一的受控写面：
 *
 * - 白名单 = `SYSTEM_SETTING_KEYS`（三个键，全部在此显式列出；其余键 **一律不可见、不可写**）；
 * - `patchSchema` = **可写面**（strict：未知键/未开放子键 → 400，绝不静默丢弃）；
 * - `readSchema` = **读取投影**（strip：白名单子键之外的存储内容绝不回显）；
 * - `blockedSubKeys` = 显式拒绝面（配额类子键只读——红线：**不开放 quota/RBAC 面**）。
 *
 * 红线（本文件即登记载体）：
 * 1. **LLM 不决定策略**：本白名单只由平台管理员 API 写入；Agent/工具链**没有任何注册入口**
 *    （ToolsModule 不注册任何 settings 工具——结构性无写路径）；
 * 2. quota/RBAC 面不开放：`limits` 中配额类子键（每日图片/视频/记忆候选、月 token 预算）
 *    只读（可查不可写），且不存在"改配额"的键；org 角色/权限表更不在本白名单内；
 * 3. 值校验：每个键一组 zod 校验（可写面 + 生效值跨字段一致性），非法值 400，绝不落库。
 */

import { z } from 'zod';
import {
  POLICY_THRESHOLDS_KEY,
  PolicyThresholdsPatchSchema,
  PolicyThresholdsSchema,
  resolvePolicyThresholds,
  resolvePolicyThresholdsStrict,
} from './policy-thresholds';
import { AppError, ErrorCode } from '../../common/errors/app-error';

const Ms = z.number().int().min(1).max(86_400_000);
const NonNegInt = z.number().int().min(0).max(1_000_000);
const PosInt = z.number().int().min(1).max(1_000_000);

/** 生效值校验所需的注入依赖（由服务层提供；单测可替身） */
export interface SettingValidationDeps {
  findModels(ids: string[]): Promise<Array<{ id: string; type: string; enabled: boolean }>>;
}

export interface SystemSettingKeySpec {
  key: string;
  /** 面向管理员的语义说明（GET 清单回显；绝不含敏感信息） */
  description: string;
  /** 可写面（strict：未知/未开放子键 → 400） */
  patchSchema: z.ZodTypeAny;
  /** 读取投影（strip：白名单之外的存储内容绝不回显） */
  readSchema: z.ZodTypeAny;
  /** 读路径生效值解析（缺省 = 原样返回投影后的存储值；可在此叠加编译期兜底） */
  resolveEffective?: (stored: unknown) => unknown;
  /** 写路径生效值校验（合并后严格校验：非法组合 → 抛 AppError(VALIDATION_ERROR)；可异步查库） */
  validateEffective?: (stored: unknown, deps: SettingValidationDeps) => void | Promise<void>;
  /** 显式拒绝面：命中即 400（附带精准原因，绝不靠"未知键"泛化报错） */
  blockedSubKeys?: { names: readonly string[]; reason: string };
}

// ===== routingPolicy：路由策略（既有键；读路径已存在：router/agent-registry/model-resolver/embedding/routing）=====
const RoutingPolicySchema = z.object({
  confidenceThreshold: z.number().min(0).max(1).optional(),
  routerModelId: z.string().min(1).max(200).nullable().optional(),
  defaults: z.record(z.string().min(1).max(64), z.string().min(1).max(200).nullable()).optional(),
  agentMapping: z.record(z.string().min(1).max(64), z.string().min(1).max(200)).optional(),
});

/** 能力键 → Model.type（默认模型只接受与能力同类型的模型） */
const CAPABILITY_MODEL_TYPES: Record<string, string> = { llm: 'llm', image: 'image', video: 'video', embedding: 'embedding' };
const CapabilityDefaultModelId = z.string().min(1).max(200).nullable();
/**
 * M13+（模型配置页）：defaults 的**写面**收紧为四个能力键（strict：未知能力键 400；null = 显式清除）。
 * 读面（RoutingPolicySchema.defaults）保持宽松 record——存量非能力键（如 seed 的 vision）
 * 绝不能被任何一次 PATCH 静默剔除（读投影是深合并基线）。
 */
const RoutingDefaultsPatchSchema = z
  .strictObject({
    llm: CapabilityDefaultModelId.optional(),
    image: CapabilityDefaultModelId.optional(),
    video: CapabilityDefaultModelId.optional(),
    embedding: CapabilityDefaultModelId.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'defaults 补丁不能为空' });

const RoutingPolicyPatchSchema = z
  .strictObject({
    confidenceThreshold: z.number().min(0).max(1).optional(),
    routerModelId: z.string().min(1).max(200).nullable().optional(),
    defaults: RoutingDefaultsPatchSchema.optional(),
    agentMapping: z.record(z.string().min(1).max(64), z.string().min(1).max(200)).optional(),
  });

// ===== limits：运行时限额/超时（既有键；读路径已存在：runtime/lease/context/memory/delegation/workflow）=====
/** 配额类子键：**只读**（红线 14：不开放 quota 面——可见是为运维排查，绝不可写） */
const LIMITS_QUOTA_KEYS = ['dailyImage', 'dailyVideo', 'dailyMemoryCandidates', 'monthlyTokenBudget'] as const;

const LimitsSchema = z.object({
  // 配额面（只读：GET 可见，PATCH 显式拒绝）
  dailyImage: NonNegInt.optional(),
  dailyVideo: NonNegInt.optional(),
  dailyMemoryCandidates: NonNegInt.optional(),
  monthlyTokenBudget: NonNegInt.optional(),
  videoConcurrency: PosInt.optional(),
  // 运行时/超时面（可写）
  agentRunTimeoutMs: Ms.optional(),
  contextBudgetTokens: PosInt.optional(),
  agentRunDeadlineMs: Ms.optional(),
  agentRunLeaseTtlMs: Ms.optional(),
  agentRunHeartbeatMs: Ms.optional(),
  agentRunLlmTurnMs: Ms.optional(),
  approvalExpiresMs: NonNegInt.optional(),
  workflowDeadlineMs: Ms.optional(),
  summaryRefineThreshold: PosInt.optional(),
  delegationMaxDepth: PosInt.optional(),
  delegationMaxChildren: PosInt.optional(),
});

const LimitsPatchSchema = z
  .strictObject({
    videoConcurrency: PosInt.optional(),
    agentRunTimeoutMs: Ms.optional(),
    contextBudgetTokens: PosInt.optional(),
    agentRunDeadlineMs: Ms.optional(),
    agentRunLeaseTtlMs: Ms.optional(),
    agentRunHeartbeatMs: Ms.optional(),
    agentRunLlmTurnMs: Ms.optional(),
    approvalExpiresMs: NonNegInt.optional(),
    workflowDeadlineMs: Ms.optional(),
    summaryRefineThreshold: PosInt.optional(),
    delegationMaxDepth: PosInt.optional(),
    delegationMaxChildren: PosInt.optional(),
  });

export const SYSTEM_SETTING_KEYS: readonly SystemSettingKeySpec[] = [
  {
    key: 'routingPolicy',
    description: '路由策略（置信阈值 / 路由模型 / 各能力默认模型 / 意图→Agent 映射）——只影响排序与兜底，不做硬过滤',
    patchSchema: RoutingPolicyPatchSchema,
    readSchema: RoutingPolicySchema,
    /**
     * M13+（模型配置页）生效值校验：defaults 里的每个能力默认模型必须是**存在、已启用、类型匹配**的模型
     * （一次 findMany，绝不循环查库；无能力键时零额外查询——既有 confidenceThreshold/实验晋级路径不受影响）。
     * 不要求 provider.enabled：运营者可先配默认模型再开通厂商（defaults 只影响排序，已证不构成硬门禁）。
     */
    validateEffective: async (stored, deps) => {
      const defaults = (stored as { defaults?: unknown }).defaults;
      if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return;
      const entries = Object.entries(defaults as Record<string, unknown>)
        .filter(([cap]) => cap in CAPABILITY_MODEL_TYPES)
        .filter(([, id]) => typeof id === 'string' && id.length > 0);
      if (entries.length === 0) return;
      const models = await deps.findModels(entries.map(([, id]) => id as string));
      const byId = new Map(models.map((m) => [m.id, m]));
      for (const [cap, id] of entries) {
        const model = byId.get(id as string);
        if (!model) throw new AppError(ErrorCode.VALIDATION_ERROR, `默认模型不存在: ${id}`);
        if (model.type !== CAPABILITY_MODEL_TYPES[cap]) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, `defaults.${cap} 必须是 ${cap} 类型模型（收到 ${model.type}）`);
        }
        if (!model.enabled) throw new AppError(ErrorCode.VALIDATION_ERROR, `默认模型已停用: ${id}`);
      }
    },
  },
  {
    key: 'limits',
    description: '运行时限额与超时（run deadline / lease / 心跳 / 上下文预算 / 委派上限 / 工作流时限）；配额类子键只读',
    patchSchema: LimitsPatchSchema,
    readSchema: LimitsSchema,
    blockedSubKeys: {
      names: LIMITS_QUOTA_KEYS,
      reason: '属于配额面（计划权益/租户配额），本 API 不开放写入口',
    },
  },
  {
    key: POLICY_THRESHOLDS_KEY,
    description: '策略阈值（反馈绩效好/差档、洞察评分与环比阈值、异常检测阈值、provider 健康评分参数）',
    patchSchema: PolicyThresholdsPatchSchema,
    readSchema: PolicyThresholdsSchema,
    // 读：SystemSetting 优先、编译期常量兜底（缺字段逐项回退，坏配置绝不整体失效）
    resolveEffective: (stored) => resolvePolicyThresholds(stored),
    // 写：合并后跨字段一致性严格校验（非法组合 → 400，绝不落库）
    validateEffective: (stored) => void resolvePolicyThresholdsStrict(stored),
  },
];

export const SYSTEM_SETTING_KEY_BY_NAME: ReadonlyMap<string, SystemSettingKeySpec> = new Map(
  SYSTEM_SETTING_KEYS.map((spec) => [spec.key, spec]),
);

/** 白名单键名（审计/文档用；顺序稳定） */
export const SYSTEM_SETTING_KEY_NAMES: readonly string[] = SYSTEM_SETTING_KEYS.map((s) => s.key);

export function findSystemSettingKey(key: string): SystemSettingKeySpec | undefined {
  return SYSTEM_SETTING_KEY_BY_NAME.get(key);
}
