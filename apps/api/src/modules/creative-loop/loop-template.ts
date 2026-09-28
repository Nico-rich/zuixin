/**
 * M9-P5 Creative Performance Loop 编排模板（**纯函数生成器**）。
 *
 * 闭环落成一条 **workflow definition**（供 M9-P4 引擎执行——绝不新增编排器）：
 *   ① insight_snapshot（tool / 只读）→ 复用 M7-P8 `performance.insights`（绩效记忆候选 + 近期绩效事实，分层标注）
 *   ② generate_creative（agent）→ 复用 M5 生成链路（Agent 经既有工具链调用 image.generate/video.generate，
 *      走既有 GenerationTask/Artifact 事实，**不新增生成路径**）
 *   ③ human_review（approval）→ **人工审批门**（reason 模板 + 展示字段；绑定下游真实写动作）
 *   ④ publish_creative（external_action）→ 真实平台写操作，**只经由 ExternalActionsService**（Approval + 审计 + 幂等全链）
 *   ⑤ rollback_publish（external_action / 补偿专用）→ 失败回滚链（M9-P4 compensate）
 *   ⑥ observe_performance（wait）→ 绩效观察窗（时间窗落库、崩溃不重新计时——M9-P4 wait）
 *   ⑦ loop_outcome（output）→ run 终态输出（引用前序步骤事实，供 loop 明细对照）
 *
 * 边界（**M8 冻结边界延续**）：本模板只编排**单条**人工审批过的写动作——绝不做"无人工审批的批量外部操作"，
 * 绝不批量投放；`publish_creative` 前必有 approval 步骤（引擎在无审批步骤时直接拒绝执行 external_action）。
 * 定义一经发布即版本锁定（M9-P4 ⑤）——loop 重跑复用同一版本，绝不半路换定义。
 */

import { WorkflowDefinition } from '../workflows/workflow-types';

/** 步骤 id（固定命名：loop 明细与测试按 id 寻址，绝不依赖下标） */
export const LOOP_STEP_IDS = {
  insightSnapshot: 'insight_snapshot',
  generateCreative: 'generate_creative',
  humanReview: 'human_review',
  publishCreative: 'publish_creative',
  rollbackPublish: 'rollback_publish',
  observePerformance: 'observe_performance',
  loopOutcome: 'loop_outcome',
} as const;

/** 只读事实工具（M7-P8 注册的 read-only 工具） */
export const INSIGHT_SNAPSHOT_TOOL = 'performance.insights';

/** wait 观察窗默认时长（1 小时；e2e 传短窗） */
export const DEFAULT_WAIT_MS = 3600_000;

/** 平台写动作默认 actionType（mock provider 的确定性成功向量；真实平台接线下由调用方传入） */
export const DEFAULT_ACTION_TYPE = 'success';

export interface LoopTemplateInput {
  /** 假设 id（写入 run payload 与步骤输出，便于反查） */
  hypothesisId: string;
  /** 假设陈述（渲染进生成提示与审批理由） */
  statement: string;
  /** 创意生成的目标受众/场景（来自洞察，可选） */
  target?: string;
  /** 目标平台（可选） */
  platform?: string;
  /** 来源洞察 id（可选；仅作追溯引用，绝不改写洞察事实） */
  insightId?: string | null;
  /** 写动作类型（默认 mock 成功向量） */
  actionType?: string;
  /** 连接 id（真实平台连接；缺省 = mock provider） */
  connectionId?: string;
  /** 绩效观察窗（ms；受 DTO/validateDefinition 上限约束） */
  waitMs?: number;
  /** 创意生成 Agent（缺省 = 平台 general-assistant） */
  agentId?: string;
  /** 审批理由模板覆盖（缺省由本生成器构造） */
  approvalReason?: string;
  /** 审批风险级（默认 medium） */
  riskLevel?: 'low' | 'medium' | 'high';
  /** 回滚动作类型（补偿链；默认与写动作同向量） */
  rollbackActionType?: string;
}

/** 工作流名（含假设 id：启动幂等复用同一 workflow，绝不为同一假设建第二个） */
export function loopWorkflowName(hypothesisId: string): string {
  return `creative-loop:${hypothesisId}`;
}

/** run 幂等键（同一假设 + 同一 attempt 绝不产生第二个 run——并发双击收敛为同一 run） */
export function loopRunIdempotencyKey(hypothesisId: string, attempt: number): string {
  return `creative-loop:${hypothesisId}:${attempt}`;
}

/** 生成提示（渲染进 agent 步骤 message；含 {{input.statement}} 模板变量） */
export function buildCreativePrompt(input: Pick<LoopTemplateInput, 'target' | 'platform'>): string {
  const target = input.target ? `目标受众：${input.target}。` : '';
  const platform = input.platform ? `投放平台：${input.platform}。` : '';
  return `创意假设：{{input.statement}}。${target}${platform}请基于该假设产出候选创意主图素材，并说明设计要点。`;
}

/**
 * 生成 loop 定义（确定性：同一输入 → 逐字节同一 definition）。
 * 生成的 definition 必须通过 `validateDefinition` 与 `WorkflowDefinitionSchema`（单测双向锁死）。
 */
export function buildLoopDefinition(input: LoopTemplateInput): WorkflowDefinition {
  const ids = LOOP_STEP_IDS;
  const actionType = input.actionType ?? DEFAULT_ACTION_TYPE;
  const rollbackActionType = input.rollbackActionType ?? actionType;
  const waitMs = input.waitMs ?? DEFAULT_WAIT_MS;

  return {
    triggers: [{ type: 'manual' }],
    steps: [
      {
        id: ids.insightSnapshot,
        type: 'tool',
        tool: { name: INSIGHT_SNAPSHOT_TOOL, arguments: { limit: 10 } },
      },
      {
        id: ids.generateCreative,
        type: 'agent',
        agent: {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          message: buildCreativePrompt(input),
        },
      },
      {
        id: ids.humanReview,
        type: 'approval',
        approval: {
          reason: input.approvalReason
            ? input.approvalReason
            : `创意假设 {{input.statement}}：审批后将向「${input.platform ?? 'mock'}」提交一次平台写操作（${actionType}）`,
          riskLevel: input.riskLevel ?? 'medium',
          // 展示字段（仅供人读，绝不参与绑定摘要）：假设陈述 + 生成结果
          formFields: ['input.statement', `steps.${ids.generateCreative}.output.content`],
        },
      },
      {
        id: ids.publishCreative,
        type: 'external_action',
        externalAction: {
          provider: 'mock',
          actionType,
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
          payload: {
            hypothesisId: '{{input.hypothesisId}}',
            platform: input.platform ?? 'mock',
            actionType,
            creative: `{{steps.${ids.generateCreative}.output.content}}`,
          },
        },
        // 失败/部分成功 → 逆序补偿（M9-P4 ③）：正常流程中该步骤被跳过
        compensate: ids.rollbackPublish,
      },
      {
        id: ids.rollbackPublish,
        type: 'external_action',
        externalAction: {
          provider: 'mock',
          actionType: rollbackActionType,
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
          payload: {
            hypothesisId: '{{input.hypothesisId}}',
            rollbackOf: `{{steps.${ids.publishCreative}.output.externalActionId}}`,
            actionType: rollbackActionType,
          },
        },
      },
      {
        id: ids.observePerformance,
        type: 'wait',
        wait: { untilMs: waitMs },
      },
      {
        id: ids.loopOutcome,
        type: 'output',
        output: {
          hypothesisId: '{{input.hypothesisId}}',
          insightId: input.insightId ?? null,
          generated: `{{steps.${ids.generateCreative}.output.content}}`,
          published: `{{steps.${ids.publishCreative}.output.externalActionId}}`,
          observedMs: waitMs,
        },
      },
    ],
  };
}
