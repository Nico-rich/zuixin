import { z } from 'zod';
import { WorkflowDefinition } from './workflow-types';

const StepSchema = z.strictObject({
  id: z.string().min(1).max(100),
  type: z.enum(['condition', 'tool', 'agent', 'approval', 'external_action', 'output']),
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
    reason: z.string().min(1).max(500),
    riskLevel: z.enum(['low', 'medium', 'high']).optional(),
    expiresMs: z.number().int().min(1000).max(7 * 86400_000).optional(),
  }).optional(),
  externalAction: z.strictObject({
    provider: z.string().min(1).max(40).optional(),
    actionType: z.string().min(1).max(100),
    payload: z.record(z.string(), z.unknown()).optional(),
    connectionId: z.string().uuid().optional(),
  }).optional(),
  output: z.record(z.string(), z.unknown()).optional(),
  maxAttempts: z.number().int().min(0).max(5).optional(),
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
