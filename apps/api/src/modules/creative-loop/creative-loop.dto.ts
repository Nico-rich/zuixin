import { z } from 'zod';
import { HypothesisStatus } from './hypothesis-status';
import { SuccessCriteria } from './insight-rules';
import { WAIT_MAX_MS } from '../workflows/workflow-types';

/**
 * M9-P5 DTO（zod；全部 strictObject——多余字段直接拒绝，绝不静默丢弃）。
 * 归属字段（organizationId/projectId）一律服务端解析：客户端只能提交 id，**userId 永不来自请求体**。
 */
const Id = z.string().min(8).max(100); // 组织 id 含 personal-{uuid} 前缀，非纯 UUID
const Uuid = z.string().uuid();

/** 假设陈述上限 300：渲染进审批理由（≤500）与生成提示，避免超长模板渲染值 */
export const HypothesisStatement = z.string().min(4).max(300);

/** 状态与判据指标的枚举字面量在本文件内声明为元组（zod 需要非空元组），并用 satisfies 与领域类型对齐 */
const STATUS_VALUES = ['draft', 'ready', 'running', 'validated', 'rejected'] as const satisfies readonly HypothesisStatus[];
const CRITERIA_METRIC_VALUES = ['avg_score', 'pass_rate', 'roas', 'ctr'] as const satisfies readonly SuccessCriteria['metric'][];

const SuccessCriteriaSchema = z.strictObject({
  metric: z.enum(CRITERIA_METRIC_VALUES),
  op: z.enum(['gte', 'lte']),
  value: z.number().finite(),
});

export const CreateHypothesisSchema = z.strictObject({
  statement: HypothesisStatement,
  rationale: z.string().max(2_000).nullable().optional(),
  target: z.string().max(200).nullable().optional(),
  platform: z.string().max(40).nullable().optional(),
  insightId: Id.nullable().optional(),
  successCriteria: SuccessCriteriaSchema.optional(),
  organizationId: Id.optional(),
  projectId: Id.optional(),
});

export const UpdateHypothesisSchema = z.strictObject({
  statement: HypothesisStatement.optional(),
  rationale: z.string().max(2_000).nullable().optional(),
  target: z.string().max(200).nullable().optional(),
  platform: z.string().max(40).nullable().optional(),
  insightId: Id.nullable().optional(),
  successCriteria: SuccessCriteriaSchema.nullable().optional(),
});

/**
 * 人工状态推进（**只开放人工可达边**：draft→ready 提交、draft/ready→rejected 放弃）。
 * running 只能由 loop 启动产出（/start），validated/rejected 只能由判定产出（/conclude 或判据收敛）——
 * 客户端**绝不可直设**执行中/终态（否则可绕过 loop 事实与判定依据）。
 */
export const SetStatusSchema = z.strictObject({
  status: z.enum(['ready', 'rejected'] as const satisfies readonly HypothesisStatus[]),
  reason: z.string().min(1).max(500).optional(),
});

export const ListHypothesesSchema = z.strictObject({
  organizationId: Id.optional(),
  projectId: Id.optional(),
  status: z.enum(STATUS_VALUES).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** loop 启动参数（仅首次启动生效——定义一经固化即版本锁定，M9-P4 语义） */
export const StartLoopSchema = z.strictObject({
  waitMs: z.number().int().min(500).max(WAIT_MAX_MS).optional(),
  platform: z.string().min(1).max(40).optional(),
  actionType: z.string().min(1).max(100).optional(),
  connectionId: Uuid.optional(),
  agentId: Uuid.optional(),
  riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  approvalReason: z.string().min(1).max(500).optional(),
  target: z.string().min(1).max(200).optional(),
});

export const ConcludeSchema = z.strictObject({
  decision: z.enum(['validated', 'rejected']).optional(),
  reason: z.string().min(1).max(500).optional(),
});

export const AttachEvaluationSchema = z.strictObject({ evaluationRunId: Id });
export const AttachExperimentSchema = z.strictObject({ experimentId: Id });

/** 洞察构建（事实层窗口；解读不经此端点——见 InterpretationSchema） */
export const BuildInsightSchema = z.strictObject({
  organizationId: Id.optional(),
  projectId: Id.optional(),
  days: z.number().int().min(1).max(365).optional(),
  artifactId: Uuid.optional(),
  campaignId: Uuid.optional(),
  includeEvaluation: z.boolean().optional(),
});

export const ListInsightsSchema = z.strictObject({
  organizationId: Id.optional(),
  projectId: Id.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** LLM 解读写入（独立层；服务端以 factsHash 条件更新，事实层绝不被改写） */
export const InterpretationSchema = z.strictObject({
  items: z.array(z.string().min(1).max(500)).min(1).max(10),
  model: z.string().min(1).max(100).nullable().optional(),
});

export type CreateHypothesisDto = z.infer<typeof CreateHypothesisSchema>;
export type SetStatusDto = z.infer<typeof SetStatusSchema>;
export type UpdateHypothesisDto = z.infer<typeof UpdateHypothesisSchema>;
export type ListHypothesesDto = z.infer<typeof ListHypothesesSchema>;
export type StartLoopDto = z.infer<typeof StartLoopSchema>;
export type ConcludeDto = z.infer<typeof ConcludeSchema>;
export type BuildInsightDto = z.infer<typeof BuildInsightSchema>;
export type InterpretationDto = z.infer<typeof InterpretationSchema>;
