import { z } from 'zod';
import { EVALUATOR_TYPES } from './evaluators/evaluator-registry';

/**
 * M9-P1 Evaluation DTO（zod；全部 strictObject——多余字段直接拒绝，绝不静默丢弃）。
 * 归属字段（organizationId/agentId/agentVersionId 的解析）一律服务端裁决：
 * 客户端只能提交 id，**不能**提交 organizationId 之外的任何身份声明（userId 永不来自请求体）。
 */
const Id = z.string().min(8).max(100); // 组织 id 含 personal-{uuid} 前缀，非纯 UUID
const ModelId = z.string().min(1).max(100);

/** case 输入：消息串（或 {message} 包装）；expected 为任意可序列化期望值 */
const CaseInputSchema = z.strictObject({
  input: z.union([
    z.string().min(1).max(20_000),
    z.strictObject({ message: z.string().min(1).max(20_000) }),
  ]),
  expected: z.union([z.string().max(20_000), z.record(z.unknown()), z.array(z.unknown()), z.number(), z.boolean(), z.null()]).optional(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
});

export const MAX_CASES_PER_DATASET = 500;

export const CreateDatasetSchema = z.strictObject({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  cases: z.array(CaseInputSchema).max(MAX_CASES_PER_DATASET).optional(),
  organizationId: Id.optional(),
});

export const UpdateDatasetSchema = z.strictObject({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2_000).nullable().optional(),
});

/** 替换全部 case：copy-on-write——dataset.version +1，新版本行写入，旧版本行保留 */
export const ReplaceCasesSchema = z.strictObject({
  cases: z.array(CaseInputSchema).min(1).max(MAX_CASES_PER_DATASET),
});

export const ListQuerySchema = z.strictObject({
  organizationId: Id.optional(),
  datasetId: Id.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const CreateEvaluatorSchema = z.strictObject({
  name: z.string().min(1).max(120),
  type: z.enum(EVALUATOR_TYPES),
  config: z.record(z.unknown()),
  organizationId: Id.optional(),
});

export const UpdateEvaluatorSchema = z.strictObject({
  name: z.string().min(1).max(120).optional(),
  config: z.record(z.unknown()).optional(),
});

export const CreateRunSchema = z.strictObject({
  datasetId: Id,
  /** 锁定的 Agent 版本（AgentVersion 不可变）；agentId 由服务端从该行解析，绝不采信客户端 */
  agentVersionId: Id,
  evaluatorIds: z.array(Id).max(20).optional(),
  /** 对比基线：同组织可见的历史 run */
  baselineRunId: Id.optional(),
  /** 运行参数覆写（缺省取 AgentVersion 值）；全部写入 configSnapshot 后即锁定 */
  modelId: ModelId.optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(128_000).optional(),
  organizationId: Id.optional(),
});

export const CreateExperimentSchema = z.strictObject({
  name: z.string().min(1).max(120),
  hypothesis: z.record(z.unknown()).optional(),
  organizationId: Id.optional(),
});

export const UpdateExperimentSchema = z.strictObject({
  name: z.string().min(1).max(120).optional(),
  hypothesis: z.record(z.unknown()).nullable().optional(),
});

export const ExperimentStatusSchema = z.strictObject({
  /** draft → running → completed → archived（允许 draft → archived 直接放弃） */
  status: z.enum(['running', 'completed', 'archived']),
});

export const CreateVariantSchema = z.strictObject({
  name: z.string().min(1).max(120),
  agentId: Id.optional(),
  agentVersionId: Id.optional(),
  configSnapshot: z.record(z.unknown()).optional(),
  isBaseline: z.boolean().optional(),
  trafficPercent: z.number().int().min(0).max(100).optional(),
});

export type CaseInputDto = z.infer<typeof CaseInputSchema>;
export type CreateDatasetDto = z.infer<typeof CreateDatasetSchema>;
export type CreateRunDto = z.infer<typeof CreateRunSchema>;
export type CreateEvaluatorDto = z.infer<typeof CreateEvaluatorSchema>;
export type CreateExperimentDto = z.infer<typeof CreateExperimentSchema>;
export type CreateVariantDto = z.infer<typeof CreateVariantSchema>;
