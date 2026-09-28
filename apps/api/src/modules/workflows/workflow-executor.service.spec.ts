import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { boundActionOf, buildApprovalRequest, stepExternalActionKey, stepIdempotencyKey } from './workflow-executor.service';
import { assertApprovalBinding, bindPayload, hashPayload } from '../approvals/approval-binding';
import { WorkflowContext, WorkflowStepDef } from './workflow-types';

const APPROVAL_STEP: WorkflowStepDef = {
  id: 'approve',
  type: 'approval',
  approval: { reason: '发布 {{input.title}}（预算 {{steps.plan.output.budget}}）', formFields: ['input.title', 'steps.plan.output.budget', 'input.missing'] },
};
const PUBLISH_STEP: WorkflowStepDef = {
  id: 'publish', type: 'external_action',
  externalAction: { actionType: 'success', payload: { title: '{{input.title}}', nested: { budget: '{{steps.plan.output.budget}}' } } },
};
const ctx: WorkflowContext = {
  input: { title: '主图 v2' },
  steps: { plan: { status: 'completed', output: { budget: 500 } } },
};

/**
 * M9-P4 ①/④：审批请求构造（reason 模板 + 展示字段 + **绑定具体动作**）。
 * 关键不变量：form 展示字段**绝不参与** payloadHash（binding 只覆盖将被执行的动作）。
 */
describe('WorkflowExecutor 审批请求构造（M9-P4 ①/④）', () => {
  it('buildApprovalRequest：reason 模板渲染 + formFields 解析（缺值 → null，绝不抛错/绝不执行代码）', () => {
    const req = buildApprovalRequest(APPROVAL_STEP, [APPROVAL_STEP, PUBLISH_STEP], 0, ctx);
    expect(req.reason).toBe('发布 主图 v2（预算 500）');
    expect(req.actionType).toBe('success');
    expect(req.action).toEqual({ title: '主图 v2', nested: { budget: '500' } }); // 嵌套模板值经 renderTemplate 字符串化（既有语义）
    expect(req.form).toEqual({ 'input.title': '主图 v2', 'steps.plan.output.budget': 500, 'input.missing': null });
  });

  it('绑定口径 = 下游 external_action 的 (actionType, 渲染载荷)；无下游外部动作 → 绑定审批步骤自身', () => {
    const self = boundActionOf([APPROVAL_STEP], 0, APPROVAL_STEP, ctx);
    expect(self).toEqual({ actionType: 'workflow.approval:approve', action: { stepId: 'approve' } });
    const downstream = boundActionOf([APPROVAL_STEP, PUBLISH_STEP], 0, APPROVAL_STEP, ctx);
    expect(downstream.actionType).toBe('success');
  });

  it('binding 摘要只覆盖动作：渲染载荷一致 → assertApprovalBinding 通过（三处校验同一 helper）', () => {
    const req = buildApprovalRequest(APPROVAL_STEP, [APPROVAL_STEP, PUBLISH_STEP], 0, ctx);
    const payload = bindPayload(
      { stepId: 'approve', boundActionType: req.actionType, boundAction: req.action, ...(req.form ? { form: req.form } : {}) },
      req.actionType, req.action,
    );
    // form 只进 payload，不进摘要：hash 等于纯动作摘要
    expect(hashPayload(req.action)).toBe((payload.__binding as { payloadHash: string }).payloadHash);
    expect(() => assertApprovalBinding({ payload, actionType: 'success', action: req.action })).not.toThrow();
    // 动作被替换（金额/收件人/目标漂移）→ 拒绝执行
    expect(() => assertApprovalBinding({
      payload, actionType: 'success', action: { ...(req.action as object), title: '被换掉的标题' },
    })).toThrowError(/载荷摘要不一致/);
    // 动作类型漂移 → 拒绝
    expect(() => assertApprovalBinding({ payload, actionType: 'forbidden', action: req.action })).toThrowError(/动作类型不一致/);
  });

  it('无 formFields 声明 → 不写 form 键（payload 形状与 Pre-M9 完全一致）', () => {
    const bare: WorkflowStepDef = { id: 'approve', type: 'approval', approval: { reason: '静态理由' } };
    const req = buildApprovalRequest(bare, [bare, PUBLISH_STEP], 0, ctx);
    expect(req.reason).toBe('静态理由');
    expect(req.form).toBeUndefined();
  });

  it('stepIdempotencyKey：锚点 (runId, stepIndex) 决定副作用幂等键（补偿路径复用同一把键）', () => {
    const key = stepIdempotencyKey('run-1', 4);
    expect(key).toBe(createHash('sha256').update('wf:run-1:4').digest('hex'));
    expect(stepIdempotencyKey('run-1', 4)).toBe(key);       // 幂等：同锚点同键
    expect(stepIdempotencyKey('run-1', 3)).not.toBe(key);   // 不同锚点不同键
    expect(stepIdempotencyKey('run-2', 4)).not.toBe(key);
    // 外部动作键保持 M7-P6 既有口径（ExternalAction UNIQUE 是跨版本共享事实源）
    expect(stepExternalActionKey('run-1', 4)).toBe('wf:run-1:4');
    expect(stepExternalActionKey('run-1', 3)).not.toBe(stepExternalActionKey('run-1', 4));
  });
});
