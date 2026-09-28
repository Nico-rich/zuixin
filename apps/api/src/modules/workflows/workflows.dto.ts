import { z } from 'zod';
import { ORG_ID_REGEX } from '@ai-agent/shared';
import { RETRYABLE_STEP_CODES, WAIT_MAX_MS, WorkflowDefinition } from './workflow-types';

const StepSchema = z.strictObject({
  id: z.string().min(1).max(100),
  // M9-P4：新增 wait 步骤（durable wait；到期/子 run 终态 → 前进）
  type: z.enum(['condition', 'tool', 'agent', 'approval', 'external_action', 'output', 'wait']),
  condition: z.strictObject({
    field: z.string().min(1).max(200),
    op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']),
    value: z.unknown().optional(),
    then: z.string().min(1).max(100),
    else: z.string().min(1).max(100).optional(),
  }).optional(),
  tool: z.strictObject({
    name: z.string().min(1).max(100),
    arguments: z.record(z.string(), z.unknown()),
  }).optional(),
  agent: z.strictObject({
    agentId: z.string().uuid().optional(),
    message: z.string().min(1).max(4000),
  }).optional(),
  approval: z.strictObject({
    reason: z.string().min(1).max(500), // M9-P4：支持 {{input.x}} / {{steps.<id>.output.y}} 模板
    riskLevel: z.enum(['low', 'medium', 'high']).optional(),
    expiresMs: z.number().int().min(1000).max(7 * 86400_000).optional(),
    // M9-P4：人工审批表单——展示字段路径（仅供人读，绝不参与 approval binding 摘要）
    formFields: z.array(z.string().min(1).max(200)).max(20).optional(),
  }).optional(),
  // M9-P4：wait 条件三选一（untilMs 相对 / untilIso 绝对 / childRunId 子 run 终态）
  wait: z.strictObject({
    untilMs: z.number().int().min(0).max(WAIT_MAX_MS).optional(),
    untilIso: z.string().min(1).max(40).optional(),
    childRunId: z.string().min(1).max(200).optional(),
  }).refine(
    (w) => [w.untilMs != null, w.untilIso != null, w.childRunId != null].filter(Boolean).length === 1,
    { message: 'wait 等待条件必须三选一（untilMs / untilIso / childRunId）' },
  ).optional(),
  externalAction: z.strictObject({
    provider: z.string().min(1).max(40).optional(),
    actionType: z.string().min(1).max(100),
    payload: z.record(z.string(), z.unknown()).optional(),
    connectionId: z.string().uuid().optional(),
  }).optional(),
  output: z.record(z.string(), z.unknown()).optional(),
  maxAttempts: z.number().int().min(0).max(5).optional(),
  // M9-P4：步骤级超时（受 run 总时限约束；超时归因 PROVIDER_TIMEOUT = 瞬态，可被重试策略接住）
  timeoutMs: z.number().int().min(100).max(3600_000).optional(),
  // M9-P4：步骤级重试策略（与 maxAttempts 取并集；retryableCodes 只能收窄到平台瞬态码）
  retryPolicy: z.strictObject({
    maxRetries: z.number().int().min(0).max(5),
    retryableCodes: z.array(
      z.string().min(1).max(60).refine(
        (c) => RETRYABLE_STEP_CODES.includes(c),
        { message: `仅允许瞬态错误码（${RETRYABLE_STEP_CODES.join('/')}）` },
      ),
    ).min(1).max(RETRYABLE_STEP_CODES.length).optional(),
  }).optional(),
  // M9-P4：补偿步骤 id（该步骤仅在失败回滚链中执行；目标须为 tool/external_action）
  compensate: z.string().min(1).max(100).optional(),
  onError: z.enum(['fail', 'skip']).optional(),
});

export const WorkflowDefinitionSchema = z.strictObject({
  triggers: z.array(z.strictObject({
    type: z.enum(['manual', 'webhook', 'schedule', 'event']),
    cron: z.string().min(5).max(100).optional(),
    event: z.string().min(1).max(100).optional(),
  })).max(8).optional(),
  steps: z.array(StepSchema).min(1).max(50),
});

export const CreateWorkflowSchema = z.strictObject({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  projectId: z.string().uuid().optional().nullable(),
  // Pre-M9 A2：uuid 或 personal-{uuid}（个人组织 id 非纯 UUID）
  organizationId: z.string().regex(ORG_ID_REGEX, '组织 id 格式非法').optional().nullable(),
  definition: WorkflowDefinitionSchema,
});

export const UpdateWorkflowSchema = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional().nullable(),
  definition: WorkflowDefinitionSchema.optional(),
});

export const CreateWorkflowRunSchema = z.strictObject({
  payload: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export type CreateWorkflowDto = z.infer<typeof CreateWorkflowSchema>;
export type UpdateWorkflowDto = z.infer<typeof UpdateWorkflowSchema>;
export type { WorkflowDefinition };
