/**
 * M12-P4 实验受控晋级（**纯函数：无 IO、无 DI、无 LLM**）。
 *
 * 审计事实：`ExperimentVariant.trafficPercent` / `configSnapshot` 此前**零运行时读者**——
 * 实验跑完、结论有了，却没有任何受控通道把结论变成生效策略；而"自动把胜出变体写成线上策略"
 * 恰恰是治理红线（LLM/实验**不得自行决定**策略阈值）。
 *
 * 本文件定义"实验结论 → 人工确认 → 策略生效"链条里**可判定、可复现**的那一半：
 * - 胜出判定是**服务端规则**（评测聚合事实的确定性排序，无 LLM、无随机、无时间依赖）；
 * - 晋级目标来自胜出变体创建时声明的 `configSnapshot.promotion`（写面由 SystemSettings 白名单裁决）；
 * - `proposalHash` 把"管理员看到的结论"与"确认时的事实"钉在一起（事实变了 → 哈希不匹配 → 拒绝确认）；
 * - **绝不触碰 trafficPercent**：晋级只写受控策略键，流量分配绝不因晋级而改变（谁都不自动切流）。
 */

import { createHash } from 'node:crypto';
import { RunScoreSummary } from './evaluation.types';

export type PromotionStatus = 'candidate' | 'baseline_holds' | 'insufficient_evidence' | 'no_target';

export interface PromotionVariantInput {
  id: string;
  name: string;
  isBaseline: boolean;
  agentVersionId: string | null;
  /** 变体配置快照（`promotion` 子对象声明晋级目标：{ key, value }） */
  configSnapshot: unknown;
  /** 读路径派生的评测对照事实（无已完成 run → null） */
  evaluation: { runCount: number; scores: RunScoreSummary | null } | null;
}

export interface PromotionEvidence {
  variantId: string;
  name: string;
  isBaseline: boolean;
  runCount: number;
  evaluated: number;
  passed: number;
  avgScore: number;
  passRate: number;
}

export interface PromotionTarget {
  key: string;
  value: Record<string, unknown>;
}

export interface PromotionProposal {
  experimentId: string;
  status: PromotionStatus;
  /** 人读结论（服务端生成；绝不含 LLM 文本） */
  reason: string;
  winner: { variantId: string; name: string; agentVersionId: string | null } | null;
  baseline: { variantId: string; name: string } | null;
  target: PromotionTarget | null;
  /** 全部变体的对照事实（审计/前端呈现；与判定同源） */
  evidence: PromotionEvidence[];
  /** 结论指纹（事实 + 目标）；null = 无可确认的结论 */
  proposalHash: string | null;
}

/** 稳定序列化（键排序；哈希可复现的前提——不受对象键插入顺序影响） */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** 结论指纹：实验 + 胜出变体 + 目标 + 事实快照（任一项变化 → 指纹变化 → 确认被拒） */
export function proposalHashOf(input: {
  experimentId: string; winnerVariantId: string; target: PromotionTarget; evidence: readonly PromotionEvidence[];
}): string {
  return createHash('sha256')
    .update(stableStringify({
      experimentId: input.experimentId,
      winnerVariantId: input.winnerVariantId,
      key: input.target.key,
      value: input.target.value,
      evidence: input.evidence,
    }))
    .digest('hex');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 变体的晋级目标声明（`configSnapshot.promotion`）；形状不符 → null（绝不猜测） */
export function readPromotionTarget(configSnapshot: unknown): PromotionTarget | null {
  if (!isPlainObject(configSnapshot)) return null;
  const raw = configSnapshot['promotion'];
  if (!isPlainObject(raw)) return null;
  const key = raw['key'];
  const value = raw['value'];
  if (typeof key !== 'string' || key.length === 0 || !isPlainObject(value)) return null;
  return { key, value: value as Record<string, unknown> };
}

function evidenceOf(v: PromotionVariantInput): PromotionEvidence {
  const overall = v.evaluation?.scores?.overall;
  return {
    variantId: v.id,
    name: v.name,
    isBaseline: v.isBaseline,
    runCount: v.evaluation?.runCount ?? 0,
    evaluated: overall?.evaluated ?? 0,
    passed: overall?.passed ?? 0,
    avgScore: overall?.avgScore ?? 0,
    passRate: overall?.passRate ?? 0,
  };
}

/** 胜出比较键：均分 → 通过率 → 样本量（越大越优）；全等 → 保持输入顺序（确定性，绝不随机） */
function better(a: PromotionEvidence, b: PromotionEvidence): boolean {
  if (a.avgScore !== b.avgScore) return a.avgScore > b.avgScore;
  if (a.passRate !== b.passRate) return a.passRate > b.passRate;
  return a.evaluated > b.evaluated;
}

/**
 * 晋级结论（确定性服务端规则）：
 * 1. 无任何评测事实 → insufficient_evidence（**绝不拿零样本比较当结论**）；
 * 2. 胜出变体 = 有事实的变体中按 (avgScore, passRate, evaluated) 最优者（基线参与比较）；
 * 3. 胜出即基线，或基线事实不劣于胜出 → baseline_holds（保守：没有严格改进就不晋级）；
 * 4. 胜出变体未声明晋级目标 → no_target；
 * 5. 否则 → candidate（附目标 + 指纹），等待**平台管理员人工确认**。
 */
export function buildPromotionProposal(input: {
  experimentId: string;
  variants: readonly PromotionVariantInput[];
}): PromotionProposal {
  const evidence = input.variants.map(evidenceOf);
  const withFacts = evidence.filter((e) => e.evaluated > 0);
  const baselineVariant = input.variants.find((v) => v.isBaseline) ?? null;
  const base: Omit<PromotionProposal, 'status' | 'reason' | 'winner' | 'target' | 'proposalHash'> = {
    experimentId: input.experimentId,
    baseline: baselineVariant ? { variantId: baselineVariant.id, name: baselineVariant.name } : null,
    evidence,
  };

  if (withFacts.length === 0) {
    return { ...base, status: 'insufficient_evidence', reason: '尚无已完成的评测事实，无法形成晋级结论', winner: null, target: null, proposalHash: null };
  }

  // 确定性排序：稳定比较（不用 Array.sort 的隐式顺序，显式 reduce 保证同分保持输入顺序）
  const winner = withFacts.reduce((best, cur) => (better(cur, best) ? cur : best));
  const winnerVariant = input.variants.find((v) => v.id === winner.variantId)!;

  if (winner.isBaseline) {
    return { ...base, status: 'baseline_holds', reason: '基线变体事实最优，无候选可晋级', winner: { variantId: winner.variantId, name: winner.name, agentVersionId: winnerVariant.agentVersionId }, target: null, proposalHash: null };
  }
  const baselineEvidence = baselineVariant ? evidence.find((e) => e.variantId === baselineVariant.id) : undefined;
  if (baselineEvidence && baselineEvidence.evaluated > 0 && !better(winner, baselineEvidence)) {
    return { ...base, status: 'baseline_holds', reason: '候选未严格优于基线（均分/通过率/样本量），基线保持', winner: { variantId: winner.variantId, name: winner.name, agentVersionId: winnerVariant.agentVersionId }, target: null, proposalHash: null };
  }

  const target = readPromotionTarget(winnerVariant.configSnapshot);
  if (!target) {
    return { ...base, status: 'no_target', reason: '胜出变体未声明受控晋级目标（configSnapshot.promotion），无可写入的策略键', winner: { variantId: winner.variantId, name: winner.name, agentVersionId: winnerVariant.agentVersionId }, target: null, proposalHash: null };
  }

  return {
    ...base,
    status: 'candidate',
    reason: `候选「${winner.name}」在评测事实（均分 ${winner.avgScore} / 通过率 ${winner.passRate} / 样本 ${winner.evaluated}）上胜出，待平台管理员确认后写入受控策略键 ${target.key}`,
    winner: { variantId: winner.variantId, name: winner.name, agentVersionId: winnerVariant.agentVersionId },
    target,
    proposalHash: proposalHashOf({ experimentId: input.experimentId, winnerVariantId: winner.variantId, target, evidence }),
  };
}
