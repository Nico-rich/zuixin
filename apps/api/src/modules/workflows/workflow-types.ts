/**
 * M7-P6 Workflow 定义与求值原语（确定性编排；绝无 eval/动态代码执行）。
 * 定义存放在 WorkflowVersion.definition（Json，不可变快照）。
 */

export type WorkflowStepType = 'condition' | 'tool' | 'agent' | 'approval' | 'external_action' | 'output';

export interface WorkflowTriggerDef {
  type: 'manual' | 'webhook' | 'schedule' | 'event';
  cron?: string;   // schedule
  event?: string;  // event：EventBus channel 名
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
  approval?: { reason: string; riskLevel?: string; expiresMs?: number };
  externalAction?: { provider?: string; actionType: string; payload?: Record<string, unknown>; connectionId?: string };
  output?: Record<string, unknown>;
  /** 步骤级重试：仅瞬态错误码（PROVIDER_*）重试 */
  maxAttempts?: number;
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
  }
  return null;
}
