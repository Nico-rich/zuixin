import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ACTION_TYPE, DEFAULT_WAIT_MS, INSIGHT_SNAPSHOT_TOOL, LOOP_STEP_IDS,
  buildCreativePrompt, buildLoopDefinition, loopRunIdempotencyKey, loopWorkflowName,
} from './loop-template';
import { COMPENSATABLE_TYPES, WorkflowStepDef, validateDefinition } from '../workflows/workflow-types';
import { WorkflowDefinitionSchema } from '../workflows/workflows.dto';

const base = { hypothesisId: 'h-1', statement: '换用高对比主图可提升点击率' };

/**
 * M9-P5 编排模板（单测）：定义确定性 + 通过 M9-P4 双重校验（validateDefinition + Zod）。
 * 安全不变量：写操作步骤（external_action）**必有前置 approval 步骤**；补偿步骤只在回滚链执行。
 */
describe('loop-template（M9-P5 编排模板生成）', () => {
  it('buildLoopDefinition：7 步固定序列（id 稳定，绝不依赖下标）且通过 validateDefinition', () => {
    const def = buildLoopDefinition(base);
    expect(def.triggers).toEqual([{ type: 'manual' }]);
    expect(def.steps.map((s) => s.id)).toEqual([
      'insight_snapshot', 'generate_creative', 'human_review', 'publish_creative',
      'rollback_publish', 'observe_performance', 'loop_outcome',
    ]);
    expect(def.steps.map((s) => s.type)).toEqual([
      'tool', 'agent', 'approval', 'external_action', 'external_action', 'wait', 'output',
    ]);
    expect(validateDefinition(def)).toBeNull();
    expect(LOOP_STEP_IDS.publishCreative).toBe('publish_creative');
    expect(LOOP_STEP_IDS.loopOutcome).toBe('loop_outcome');
  });

  it('定义通过 DTO Zod 校验（HTTP 面与引擎同一套约束）', () => {
    for (const input of [base, { ...base, platform: 'mock-ads', target: '一线城市 25-34 女性', waitMs: 2000 }]) {
      const parsed = WorkflowDefinitionSchema.safeParse(buildLoopDefinition(input));
      expect(parsed.success).toBe(true);
    }
  });

  it('写安全：external_action 之前必有 approval 步骤；且审批理由含假设模板（人工可见）', () => {
    const def = buildLoopDefinition({ ...base, platform: 'meta' });
    const approvalIndex = def.steps.findIndex((s) => s.type === 'approval');
    const publishIndex = def.steps.findIndex((s) => s.id === LOOP_STEP_IDS.publishCreative);
    expect(approvalIndex).toBeGreaterThanOrEqual(0);
    expect(approvalIndex).toBeLessThan(publishIndex);
    const approval = def.steps[approvalIndex];
    expect(approval.approval?.reason).toContain('{{input.statement}}');
    expect(approval.approval?.reason).toContain('meta');
    expect(approval.approval?.formFields).toEqual(['input.statement', `steps.${LOOP_STEP_IDS.generateCreative}.output.content`]);
  });

  it('补偿链：publish 声明 compensate=rollback_publish；补偿步骤为合法补偿目标且仅此一处', () => {
    const def = buildLoopDefinition(base);
    const publish = def.steps.find((s) => s.id === LOOP_STEP_IDS.publishCreative)!;
    const rollback = def.steps.find((s) => s.id === LOOP_STEP_IDS.rollbackPublish)!;
    expect(publish.compensate).toBe(LOOP_STEP_IDS.rollbackPublish);
    expect(rollback.compensate).toBeUndefined();
    expect(COMPENSATABLE_TYPES).toContain(rollback.type);
    expect(rollback.externalAction?.payload).toMatchObject({ rollbackOf: `{{steps.${LOOP_STEP_IDS.publishCreative}.output.externalActionId}}` });
    // 正常流程中补偿步骤不执行：仅被引用（M9-P4 compensationTargetIds 语义）
    const referenced = def.steps.filter((s) => s.compensate).map((s) => s.compensate);
    expect(referenced).toEqual([LOOP_STEP_IDS.rollbackPublish]);
  });

  it('工具步骤为只读事实工具；agent 步骤提示含假设与主图关键词（复用 M5 生成链）', () => {
    const def = buildLoopDefinition(base);
    const tool = def.steps.find((s) => s.type === 'tool') as WorkflowStepDef;
    expect(tool.tool?.name).toBe(INSIGHT_SNAPSHOT_TOOL);
    const prompt = buildCreativePrompt({ target: '女性用户', platform: 'meta' });
    expect(prompt).toContain('{{input.statement}}');
    expect(prompt).toContain('女性用户');
    expect(prompt).toContain('主图'); // 触发 M5 生成链（mock 适配器的 image.generate 启发式关键词）
    const agent = def.steps.find((s) => s.type === 'agent') as WorkflowStepDef;
    expect(agent.agent?.message).toContain('主图');
  });

  it('wait 步骤带观察窗；waitMs 可覆盖（缺省 1 小时）', () => {
    expect(DEFAULT_WAIT_MS).toBe(3600_000);
    const def = buildLoopDefinition({ ...base, waitMs: 2000 });
    const wait = def.steps.find((s) => s.type === 'wait') as WorkflowStepDef;
    expect(wait.wait).toEqual({ untilMs: 2000 });
    const output = def.steps.find((s) => s.id === LOOP_STEP_IDS.loopOutcome) as WorkflowStepDef;
    expect(output.output).toMatchObject({ hypothesisId: '{{input.hypothesisId}}', observedMs: 2000 });
  });

  it('确定性：同输入 → 逐字节同一定义（版本锁定/幂等键的前提）', () => {
    expect(JSON.stringify(buildLoopDefinition(base))).toBe(JSON.stringify(buildLoopDefinition(base)));
    expect(buildLoopDefinition(base)).toEqual(buildLoopDefinition({ ...base }));
    expect(JSON.stringify(buildLoopDefinition({ ...base, target: 'x' })))
      .not.toBe(JSON.stringify(buildLoopDefinition(base)));
  });

  it('幂等键/工作流名含假设 id：同一假设的同一 attempt 绝不产生第二个 run', () => {
    expect(loopWorkflowName('h-1')).toBe('creative-loop:h-1');
    expect(loopRunIdempotencyKey('h-1', 1)).toBe('creative-loop:h-1:1');
    expect(loopRunIdempotencyKey('h-1', 1)).not.toBe(loopRunIdempotencyKey('h-1', 2));
    expect(loopRunIdempotencyKey('h-1', 1)).not.toBe(loopRunIdempotencyKey('h-2', 1));
    expect(loopRunIdempotencyKey('h-1', 1).startsWith(loopWorkflowName('h-1'))).toBe(true);
  });

  it('mock 写动作向量：默认 actionType=success（真实平台由调用方传入 connectionId/actionType）', () => {
    expect(DEFAULT_ACTION_TYPE).toBe('success');
    const def = buildLoopDefinition({ ...base, actionType: 'create_ad', connectionId: undefined });
    const publish = def.steps.find((s) => s.id === LOOP_STEP_IDS.publishCreative)!;
    expect(publish.externalAction?.actionType).toBe('create_ad');
    expect(publish.externalAction?.provider).toBe('mock');
    expect(publish.externalAction?.payload).toMatchObject({ platform: 'mock', actionType: 'create_ad' });
  });
});
