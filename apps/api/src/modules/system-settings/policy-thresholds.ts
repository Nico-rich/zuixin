/**
 * M12-P4 策略阈值层（**纯函数：无 IO、无 DI、无 LLM**）。
 *
 * 背景（M12 审计）：策略阈值此前全部是编译期常量，散落在四处消费方
 * （feedback.service / insight-rules / commerce-analysis.service / health-score），
 * 运营者无法在不改代码的前提下调整——本文件把它们收敛为**一份可校验、可外部化的定义**：
 *
 * - `DEFAULT_POLICY_THRESHOLDS`：编译期兜底值（与既有常量**逐字节一致**——缺省行为绝不改变；
 *   由 `policy-thresholds.spec.ts` 逐项断言"缺省快照 == 既有编译期常量"，防止两处口径漂移）；
 * - `PolicyThresholdsSchema`：**读取投影**（zod strip：白名单之外的子键一律丢弃，绝不回显）；
 * - `PolicyThresholdsPatchSchema`：**可写面**（strict：未知/未开放子键 → 400，绝不静默丢弃）；
 * - `resolvePolicyThresholds`：SystemSetting 优先、常量兜底（脏值/缺字段逐项回退，绝不整体失效）。
 *
 * 边界（红线）：本层只描述"规则参数"，**不承载任何判定**——没有 LLM 参与，
 * 也不表达 quota/RBAC/provider/审批任何一面的开关；跨字段一致性（如 badCtr ≤ goodCtr）
 * 由服务端 refinement 校验（非法组合 → 400，绝不静默接受）。
 */

import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import type { PrismaService } from '../prisma/prisma.service';

const logger = new Logger('PolicyThresholds');

export const POLICY_THRESHOLDS_KEY = 'policyThresholds';

/** 反馈绩效阈值（与 feedback.service 的编译期常量同口径） */
export interface FeedbackThresholds {
  /** CTR 达标线（表现好） */
  goodCtr: number;
  /** ROAS 达标线（表现好） */
  goodRoas: number;
  /** CTR 不达标线（表现差） */
  badCtr: number;
  /** ROAS 不达标线（表现差） */
  badRoas: number;
}

/** 洞察/评分阈值（与 insight-rules 的编译期常量同口径） */
export interface InsightThresholds {
  /** 好评下限（>= 视为好评） */
  ratingGood: number;
  /** 差评上限（<= 视为差评） */
  ratingBad: number;
  /** 环比变化标注阈值（%，双向） */
  comparisonPct: number;
}

/** 电商异常检测阈值（与 commerce-analysis.service 的编译期常量同口径） */
export interface CommerceThresholds {
  /** 指标较前一期下降 ≥ 该值（%）→ anomaly */
  anomalyPct: number;
}

/** provider 健康/延迟评分参数（与 health-score 的编译期常量同口径） */
export interface ProviderHealthThresholds {
  /** 健康状态基分（unhealthy 在准入阶段已被剔除，此处兜底） */
  baseScores: { healthy: number; untested: number; unhealthy: number };
  /** 失败率罚分上限 */
  failurePenaltyMax: number;
  /** 失败率罚分最小样本量（观测数低于该值 → 证据不足，罚分 0） */
  failureRateMinSamples: number;
  /** 延迟罚分上限 */
  latencyPenaltyMax: number;
  /** 平均延迟达到该值（ms）→ 延迟罚分拉满 */
  latencyPenaltyFullMs: number;
  /** 无延迟样本时的中性罚分 */
  latencyNeutralPenalty: number;
}

export interface PolicyThresholds {
  feedback: FeedbackThresholds;
  insight: InsightThresholds;
  commerce: CommerceThresholds;
  providerHealth: ProviderHealthThresholds;
}

/**
 * 编译期兜底值（= 既有常量快照）。
 * 单一事实源约定：消费方仍保留自己的编译期常量作为**最后一跳兜底**（纯函数默认参数场景），
 * 本表必须与之一致——由单测逐项断言（漂移即测试失败，绝不静默分叉）。
 */
export const DEFAULT_POLICY_THRESHOLDS: PolicyThresholds = {
  feedback: { goodCtr: 0.03, goodRoas: 2, badCtr: 0.01, badRoas: 1 },
  insight: { ratingGood: 4, ratingBad: 2, comparisonPct: 10 },
  commerce: { anomalyPct: 10 },
  providerHealth: {
    baseScores: { healthy: 100, untested: 80, unhealthy: 0 },
    failurePenaltyMax: 60,
    failureRateMinSamples: 3,
    latencyPenaltyMax: 30,
    latencyPenaltyFullMs: 30_000,
    latencyNeutralPenalty: 15,
  },
};

const Ratio = z.number().min(0).max(1);

/** 读取投影（strip：白名单之外的内容绝不回显）；跨字段一致性在下方服务端 refinement 中裁决 */
export const PolicyThresholdsSchema = z.object({
  feedback: z
    .object({
      goodCtr: Ratio.optional(),
      goodRoas: z.number().min(0).max(1_000).optional(),
      badCtr: Ratio.optional(),
      badRoas: z.number().min(0).max(1_000).optional(),
    })
    .optional(),
  insight: z
    .object({
      ratingGood: z.number().int().min(1).max(5).optional(),
      ratingBad: z.number().int().min(1).max(5).optional(),
      comparisonPct: z.number().min(0).max(1_000).optional(),
    })
    .optional(),
  commerce: z
    .object({ anomalyPct: z.number().min(0).max(1_000).optional() })
    .optional(),
  providerHealth: z
    .object({
      baseScores: z
        .object({
          healthy: z.number().min(0).max(100).optional(),
          untested: z.number().min(0).max(100).optional(),
          unhealthy: z.number().min(0).max(100).optional(),
        })
        .optional(),
      failurePenaltyMax: z.number().min(0).max(100).optional(),
      failureRateMinSamples: z.number().int().min(1).max(1_000).optional(),
      latencyPenaltyMax: z.number().min(0).max(100).optional(),
      latencyPenaltyFullMs: z.number().min(1).max(600_000).optional(),
      latencyNeutralPenalty: z.number().min(0).max(100).optional(),
    })
    .optional(),
});

/** 可写面（strict：未知子键 → 400；与读取投影同形，语义差异只在"是否拒绝多余键"） */
export const PolicyThresholdsPatchSchema = z
  .object({
    feedback: z
      .strictObject({
        goodCtr: Ratio.optional(),
        goodRoas: z.number().min(0).max(1_000).optional(),
        badCtr: Ratio.optional(),
        badRoas: z.number().min(0).max(1_000).optional(),
      })
      .optional(),
    insight: z
      .strictObject({
        ratingGood: z.number().int().min(1).max(5).optional(),
        ratingBad: z.number().int().min(1).max(5).optional(),
        comparisonPct: z.number().min(0).max(1_000).optional(),
      })
      .optional(),
    commerce: z.strictObject({ anomalyPct: z.number().min(0).max(1_000).optional() }).optional(),
    providerHealth: z
      .strictObject({
        baseScores: z
          .strictObject({
            healthy: z.number().min(0).max(100).optional(),
            untested: z.number().min(0).max(100).optional(),
            unhealthy: z.number().min(0).max(100).optional(),
          })
          .optional(),
        failurePenaltyMax: z.number().min(0).max(100).optional(),
        failureRateMinSamples: z.number().int().min(1).max(1_000).optional(),
        latencyPenaltyMax: z.number().min(0).max(100).optional(),
        latencyPenaltyFullMs: z.number().min(1).max(600_000).optional(),
        latencyNeutralPenalty: z.number().min(0).max(100).optional(),
      })
      .optional(),
  })
  .strict();

export type PolicyThresholdsPatch = z.infer<typeof PolicyThresholdsPatchSchema>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并（对象递归；数组/标量/null 一律替换——补丁语义绝不把"设为 null"误读为"保持原值"） */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

/**
 * 跨字段一致性（服务端规则；非法组合 → 抛错由调用方转 400）：
 * - badCtr ≤ goodCtr、badRoas ≤ goodRoas（否则"好/差"两档自相矛盾）；
 * - ratingBad < ratingGood（差评上限必须严格低于好评下限，否则中位评分同时落两档）；
 * - latencyNeutralPenalty ≤ latencyPenaltyMax、baseScores 单调（healthy ≥ untested ≥ unhealthy）。
 */
export function assertPolicyThresholdsCoherent(t: PolicyThresholds): void {
  const bad: string[] = [];
  if (t.feedback.badCtr > t.feedback.goodCtr) bad.push('feedback.badCtr 必须 ≤ feedback.goodCtr');
  if (t.feedback.badRoas > t.feedback.goodRoas) bad.push('feedback.badRoas 必须 ≤ feedback.goodRoas');
  if (t.insight.ratingBad >= t.insight.ratingGood) bad.push('insight.ratingBad 必须 < insight.ratingGood');
  if (t.providerHealth.latencyNeutralPenalty > t.providerHealth.latencyPenaltyMax) {
    bad.push('providerHealth.latencyNeutralPenalty 必须 ≤ providerHealth.latencyPenaltyMax');
  }
  const b = t.providerHealth.baseScores;
  if (!(b.healthy >= b.untested && b.untested >= b.unhealthy)) {
    bad.push('providerHealth.baseScores 必须满足 healthy ≥ untested ≥ unhealthy');
  }
  if (bad.length > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `策略阈值组合非法：${bad.join('；')}`);
  }
}

/** 存储值 → 白名单投影（strip；脏行/非对象 → 空对象——坏行绝不污染合并基线） */
function projectStored(raw: unknown): Record<string, unknown> {
  const parsed = PolicyThresholdsSchema.safeParse(isPlainObject(raw) ? raw : {});
  return parsed.success ? (parsed.data as Record<string, unknown>) : {};
}

/**
 * SystemSetting 优先、常量兜底：把原始 JSON 逐项合并到缺省快照上。
 * 脏值（非对象/类型不符/缺字段）→ 该项回退缺省，**绝不整体失效**（一条坏配置不拖垮全部规则）。
 * 返回值恒为完整快照（调用方无需再做空值判断）。
 */
export function resolvePolicyThresholds(raw: unknown): PolicyThresholds {
  const merged = (deepMerge(
    DEFAULT_POLICY_THRESHOLDS as unknown as Record<string, unknown>,
    projectStored(raw),
  ) as unknown) as PolicyThresholds;
  try {
    assertPolicyThresholdsCoherent(merged);
    return merged;
  } catch {
    // 组合非法（外部直改 DB 等）→ 整体回退编译期常量（绝不把非法阈值投入判定面）
    return DEFAULT_POLICY_THRESHOLDS;
  }
}

/**
 * 写入路径专用（严格）：合并后的存储值 + 缺省基线 → 完整快照；组合非法 → **抛 400**。
 * 与 `resolvePolicyThresholds` 的差异只在"非法组合"的处置：读路径回退缺省，写路径绝不放行。
 */
export function resolvePolicyThresholdsStrict(stored: unknown): PolicyThresholds {
  const merged = (deepMerge(
    DEFAULT_POLICY_THRESHOLDS as unknown as Record<string, unknown>,
    projectStored(stored),
  ) as unknown) as PolicyThresholds;
  assertPolicyThresholdsCoherent(merged);
  return merged;
}

/**
 * 消费方入口（反馈/洞察/异常检测/provider 健康评分）：读 `policyThresholds` 一次，返回完整快照。
 *
 * 直读 Prisma 是仓库既有口径（11 处 SystemSetting 读路径皆如此）——本函数只把"读 + 兜底"收敛成一行，
 * 消费方**不新增 DI 依赖**（阈值是配置事实，不是服务能力）。缺行/脏行 → 编译期常量缺省。
 *
 * **读面故障绝不阻断主链**：查询抛错（存储不可用、单测替身未挂载该表等）→ 记 warning 并回落到编译期
 * 常量（缺省行为与 M12 之前逐字节一致）；与 M11「观测面故障绝不阻断路由决策」同口径。
 * 写面**不兜底**（`SystemSettingsService.patch` 非法值 → 400 且绝不落库）：读宽容、写严格。
 */
export async function readPolicyThresholds(prisma: Pick<PrismaService, 'systemSetting'>): Promise<PolicyThresholds> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: POLICY_THRESHOLDS_KEY }, select: { value: true } });
    return resolvePolicyThresholds(row?.value);
  } catch (err) {
    logger.warn(`策略阈值读取失败，回落编译期常量（业务主链不受影响）: ${(err as Error).message}`);
    return DEFAULT_POLICY_THRESHOLDS;
  }
}

