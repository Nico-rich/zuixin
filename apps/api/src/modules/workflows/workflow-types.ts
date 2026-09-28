/**
 * M7-P6 Workflow 定义与求值原语（确定性编排；绝无 eval/动态代码执行）。
 * 定义存放在 WorkflowVersion.definition（Json，不可变快照）。
 * M9-P4 增量：wait 步骤 + 步骤级 timeoutMs/retryPolicy + compensate（补偿链）；
 * 版本锁定语义见 `lockedDefinition`（WorkflowVersion.definition 只读，run 锁定 versionId）。
 */

import { AppError, ErrorCode, RETRYABLE_CODES } from '../../common/errors/app-error';

export type WorkflowStepType = 'condition' | 'tool' | 'agent' | 'approval' | 'external_action' | 'output' | 'wait';

export interface WorkflowTriggerDef {
  type: 'manual' | 'webhook' | 'schedule' | 'event';
  cron?: string;   // schedule
  event?: string;  // event：EventBus channel 名
}

/** M9-P4：审批步骤（reason 支持 {{...}} 模板；formFields 为展示字段路径，仅供人读） */
export interface WorkflowApprovalDef {
  reason: string;
  riskLevel?: string;
  expiresMs?: number;
  /**
   * 展示字段路径（input.x / steps.<id>.output.y）：解析后写入 Approval.payload.form。
   * **绝不参与 binding 摘要**——binding 只绑定"将被执行的具体动作"（见 approvals/approval-binding.ts）。
   */
  formFields?: string[];
}

/**
 * M9-P4：wait 步骤——等待条件三选一（DTO/validateDefinition 保证互斥）：
 * - untilMs：相对时长（步骤首次进入时换算为绝对期限并落库，崩溃恢复绝不重新计时）；
 * - untilIso：绝对时间；
 * - childRunId：等待既有子 AgentRun 终态（模板可渲染；复用 waiting + waitingOnAgentRunId 唤醒链）。
 */
export interface WorkflowWaitDef {
  untilMs?: number;
  untilIso?: string;
  childRunId?: string;
}

/** M9-P4：步骤级重试策略（与既有 maxAttempts 取并集——绝不改变 maxAttempts 的既有语义） */
export interface WorkflowRetryPolicy {
  maxRetries: number;
  /** 允许重试的错误码子集；缺省 = 平台瞬态码全集（RETRYABLE_CODES） */
  retryableCodes?: string[];
}

/** 可被 compensate 引用的步骤类型（补偿必须是"可单独执行的单一动作"） */
export const COMPENSATABLE_TYPES: readonly WorkflowStepType[] = ['tool', 'external_action'];

/** 步骤级重试允许声明的错误码（= 平台瞬态码全集；DTO 与运行时同一来源） */
export const RETRYABLE_STEP_CODES: readonly string[] = [...RETRYABLE_CODES];

/** wait 时间窗上限（7 天） */
export const WAIT_MAX_MS = 7 * 86400_000;

/** workflow run 总时限默认值（唯一事实源：Worker 侧 WorkflowLeaseService 与执行器共用） */
export const WORKFLOW_DEADLINE_DEFAULT_MS = 60 * 60_000;

/** SystemSetting('limits').workflowDeadlineMs 解析（非法/缺失 → 默认 1h） */
export function workflowDeadlineMsFromSetting(value: unknown): number {
  const n = Number((value as { workflowDeadlineMs?: number } | null | undefined)?.workflowDeadlineMs);
  return Number.isFinite(n) && n > 0 ? n : WORKFLOW_DEADLINE_DEFAULT_MS;
}

export interface WorkflowStepDef {
  id: string;
  type: WorkflowStepType;
  /** condition：安全路径取值 + 比较运算（绝无表达式执行） */
  condition?: {
    field: string;            // 形如 input.x / steps.<stepId>.output.y
    op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists';
    value?: unknown;
    then: string;             // 命中 → 跳转 step id
    else?: string;            // 未命中 → 跳转 step id（缺省 = 顺序下一步）
  };
  tool?: { name: string; arguments: Record<string, unknown> };
  agent?: { agentId?: string; message: string }; // message 支持 {{input.x}} / {{steps.<id>.output.y}} 模板
  approval?: WorkflowApprovalDef;
  externalAction?: { provider?: string; actionType: string; payload?: Record<string, unknown>; connectionId?: string };
  /** M9-P4：wait 步骤（等待条件三选一；到期/子 run 终态 → 前进） */
  wait?: WorkflowWaitDef;
  output?: Record<string, unknown>;
  /** 步骤级重试：仅瞬态错误码（PROVIDER_*）重试 */
  maxAttempts?: number;
  /** M9-P4：步骤级超时（ms；受 run 总时限约束）——超时按瞬态码 PROVIDER_TIMEOUT 归因，可被重试策略接住 */
  timeoutMs?: number;
  /** M9-P4：步骤级重试策略（与 maxAttempts 取并集、错误码可收窄） */
  retryPolicy?: WorkflowRetryPolicy;
  /**
   * M9-P4：补偿步骤 id（该步骤**仅**在失败回滚链中执行；正常流程遇到即跳过）。
   * 失败（非瞬态）时按已成功步骤的逆序执行其补偿；补偿复用同一 UNIQUE(runId,stepIndex) 锚点行 + 同一幂等键。
   */
  compensate?: string;
  onError?: 'fail' | 'skip';
}

export interface WorkflowDefinition {
  triggers: WorkflowTriggerDef[];
  steps: WorkflowStepDef[];
}

/** 步骤输出上下文（模板/条件求值输入；只含结构化输出，绝不含内部推理） */
export interface WorkflowContext {
  input: Record<string, unknown>;
  steps: Record<string, { output?: unknown; status: string }>;
}

/** 安全取值：a.b.c 路径访问（数组仅支持整型下标；非法路径返回 undefined） */
export function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** 条件求值：steps.<id>.output.x / input.x 路径 + 比较运算（返回 then/else 跳转目标 + 命中事实） */
export function evaluateCondition(
  def: NonNullable<WorkflowStepDef['condition']>,
  ctx: WorkflowContext,
  nextStepId: string | null,
): { target: string | null; hit: boolean; actual: unknown } {
  const raw = def.field.startsWith('steps.') || def.field.startsWith('input.')
    ? getPath(ctx, def.field)
    : undefined;
  const value = def.value;
  let hit = false;
  switch (def.op) {
    case 'exists': hit = raw !== undefined && raw !== null; break;
    case 'eq': hit = raw === value; break;
    case 'neq': hit = raw !== value; break;
    case 'gt': hit = Number(raw) > Number(value); break;
    case 'gte': hit = Number(raw) >= Number(value); break;
    case 'lt': hit = Number(raw) < Number(value); break;
    case 'lte': hit = Number(raw) <= Number(value); break;
    case 'contains': hit = typeof raw === 'string' && String(value).length > 0 && raw.includes(String(value)); break;
    default: hit = false;
  }
  const target = hit ? def.then : (def.else ?? nextStepId);
  return { target, hit, actual: raw };
}

/** 模板渲染：{{input.x}} / {{steps.<id>.output.y}} → 字符串替换（缺值 → 空串；绝不执行任何代码） */
export function renderTemplate(template: string, ctx: WorkflowContext): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const v = getPath(ctx, path);
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/**
 * M9-P4 Version Locking（**无新列的最小实现——缺口如实记录**）：
 * 设计文档原计划 `WorkflowRun.definitionSnapshot Json?`；实际 schema（apps/api/prisma/schema.prisma）中
 * WorkflowRun **既无 definitionSnapshot 也无 metadata 列**，仅 input/output 两个 JSON 列，而 input 是业务入参
 * （写入快照会污染业务语义、且模板 {{input.x}} 会取到快照键）。M9-P4 硬约束禁止改 schema/migration，故降级为：
 * ① run 创建即锁定 versionId（既有；FK `onDelete: Restrict` → 被引用的版本行不可删）；
 * ② `WorkflowVersion.definition` 对已发布版本只读：编辑只改 draft 行或新建版本行（workflows.service.update），
 *    publish 只做 draft→published 的状态迁移，**published 行内容永不被改写**；
 * ③ 执行期一律 `run.version.definition`（本函数），**绝不读 workflow 的最新版本**。
 * ①②③ 共同保证"版本后续发布不影响已运行 run"；`definitionSnapshot` 列仍是已知缺口（见 M9-P4 交付说明）。
 */
export function lockedDefinition(version: { definition: unknown } | null | undefined): WorkflowDefinition {
  if (!version || version.definition == null) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, '工作流版本缺失或定义为空，拒绝执行（版本锁定不变量被破坏）');
  }
  return version.definition as WorkflowDefinition;
}

/** M9-P4：被其他步骤 compensate 引用的步骤集合（正常流程遇到即跳过——绝不当作普通步骤执行） */
export function compensationTargetIds(steps: readonly WorkflowStepDef[]): Set<string> {
  const ids = new Set<string>();
  for (const s of steps) if (s.compensate) ids.add(s.compensate);
  return ids;
}

export function isCompensationTarget(steps: readonly WorkflowStepDef[], stepId: string): boolean {
  return steps.some((s) => s.compensate === stepId);
}

/** M9-P4：有效重试次数 = max(既有 maxAttempts, retryPolicy.maxRetries)（并集，绝不收窄既有语义） */
export function effectiveMaxRetries(step: WorkflowStepDef): number {
  return Math.max(step.maxAttempts ?? 0, step.retryPolicy?.maxRetries ?? 0);
}

/**
 * M9-P4：步骤错误是否可重试——声明了 retryableCodes 则按声明收窄，否则沿用平台瞬态码全集。
 * （非瞬态码绝不重试：步骤立即失败 → 触发补偿链/finalize。）
 */
export function isRetryableStepError(step: WorkflowStepDef, code: string): boolean {
  const declared = step.retryPolicy?.retryableCodes;
  if (declared && declared.length > 0) return declared.includes(code);
  return RETRYABLE_CODES.has(code as never);
}

/** 定义校验：步骤 id 唯一、跳转目标存在、类型合法（非法 → VALIDATION_ERROR 消息） */
export function validateDefinition(def: WorkflowDefinition): string | null {
  if (!Array.isArray(def.steps) || def.steps.length === 0) return '工作流必须包含至少一个步骤';
  const ids = new Set<string>();
  for (const s of def.steps) {
    if (!s.id || ids.has(s.id)) return `步骤 id 重复或缺失: ${s.id}`;
    ids.add(s.id);
    if (s.type === 'condition') {
      const cond = s.condition;
      if (!cond || !cond.field || !cond.then) return `步骤 ${s.id} 条件定义不完整`;
      if (!def.steps.some((x) => x.id === cond.then)) return `步骤 ${s.id} 跳转目标不存在: ${cond.then}`;
      if (cond.else && !def.steps.some((x) => x.id === cond.else)) return `步骤 ${s.id} else 目标不存在: ${cond.else}`;
    }
    if (s.type === 'agent' && (!s.agent?.message)) return `步骤 ${s.id} 缺少 agent.message`;
    if (s.type === 'external_action' && (!s.externalAction?.actionType)) return `步骤 ${s.id} 缺少 actionType`;
    if (s.type === 'wait') {
      const w = s.wait;
      if (!w) return `步骤 ${s.id} 缺少 wait 条件定义`;
      const kinds = [w.untilMs != null, !!w.untilIso, !!w.childRunId].filter(Boolean).length;
      if (kinds === 0) return `步骤 ${s.id} wait 缺少等待条件（untilMs/untilIso/childRunId 三选一）`;
      if (kinds > 1) return `步骤 ${s.id} wait 等待条件必须三选一（untilMs/untilIso/childRunId）`;
      if (w.untilMs != null && (!Number.isFinite(w.untilMs) || w.untilMs < 0 || w.untilMs > WAIT_MAX_MS)) {
        return `步骤 ${s.id} wait.untilMs 非法（0 ~ ${WAIT_MAX_MS}）`;
      }
      if (w.untilIso && !Number.isFinite(Date.parse(w.untilIso))) return `步骤 ${s.id} wait.untilIso 非法: ${w.untilIso}`;
    }
    if (s.timeoutMs != null && (!Number.isFinite(s.timeoutMs) || s.timeoutMs < 100)) {
      return `步骤 ${s.id} timeoutMs 非法（>= 100ms）`;
    }
    if (s.retryPolicy) {
      if (!Number.isFinite(s.retryPolicy.maxRetries) || s.retryPolicy.maxRetries < 0) return `步骤 ${s.id} retryPolicy.maxRetries 非法`;
      for (const code of s.retryPolicy.retryableCodes ?? []) {
        if (!RETRYABLE_STEP_CODES.includes(code)) return `步骤 ${s.id} retryPolicy.retryableCodes 含非瞬态码: ${code}`;
      }
    }
    if (s.compensate) {
      if (s.compensate === s.id) return `步骤 ${s.id} 不可补偿自身`;
      const target = def.steps.find((x) => x.id === s.compensate);
      if (!target) return `步骤 ${s.id} 补偿目标不存在: ${s.compensate}`;
      if (!COMPENSATABLE_TYPES.includes(target.type)) {
        return `步骤 ${s.id} 补偿目标 ${target.id} 类型不支持（仅 ${COMPENSATABLE_TYPES.join('/')}）`;
      }
    }
  }
  return null;
}
