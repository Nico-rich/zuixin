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

/**
 * M12-P5：**event 触发器已下线**（裁决见 docs/operations/m12-workflow-event-trigger-retirement.md）。
 *
 * 裁决依据（审计）：`type: 'event'` 自 M7-P6 起就没有**生产发布端**——平台没有任何路径把真实事件
 * （EventEnvelope）投递给它，唯一能让它"跑起来"的方式是测试/脚本直接调触发服务；而"补上发布端"
 * 又会违反 G10（EventEnvelope 冻结：不得为触发器新增事件投递语义）。一个永远不会被真实触发的
 * 触发器类型留在契约里只会误导使用者（配了不生效，且看不出来）。
 *
 * 处置（**只收写入面，不动存量**）：
 * - 新建/更新（本 DTO = 唯一 HTTP 写入口）拒绝 `event`：400 + VALIDATION_ERROR + 明确文案；
 * - **既有**含 event 触发器的工作流原样保留：读、列表、运行（手工/API 触发）、发布（走
 *   `validateDefinition`，未改）全部照常——绝不因下线而让存量工作流变成不可用；
 * - `manual`（手工/API）、`webhook`（签名 + 重放防护）、`schedule`（cron）三条真实链路不受影响。
 */
export const EVENT_TRIGGER_RETIRED_MESSAGE =
  'event 触发器已下线（M12-P5）：平台无生产事件发布端，该类型从未被真实事件驱动过；请改用 manual / webhook / schedule（既有含 event 触发器的工作流仍可读取与运行）';

export const WorkflowDefinitionSchema = z.strictObject({
  triggers: z.array(z.strictObject({
    type: z.enum(['manual', 'webhook', 'schedule', 'event']),
    cron: z.string().min(5).max(100).optional(),
    event: z.string().min(1).max(100).optional(),
  })).max(8).superRefine((triggers, ctx) => {
    triggers.forEach((trigger, index) => {
      if (trigger.type === 'event') {
        // path 指到具体数组元素：错误信息里能看出是第几个触发器（多触发器时不必靠猜）
        ctx.addIssue({ code: 'custom', message: EVENT_TRIGGER_RETIRED_MESSAGE, path: [index, 'type'] });
      }
    });
  }).optional(),
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
