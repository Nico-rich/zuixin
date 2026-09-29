import { describe, it, expect } from 'vitest';
import {
  CreateWorkflowSchema, EVENT_TRIGGER_RETIRED_MESSAGE, UpdateWorkflowSchema, WorkflowDefinitionSchema,
} from './workflows.dto';
import { validateDefinition, WorkflowDefinition } from './workflow-types';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

/**
 * M12-P5：event 触发器**下线**的契约锁（裁决：docs/operations/m12-workflow-event-trigger-retirement.md）。
 *
 * 本文件只锁三件事：
 * 1. 写入面（HTTP DTO）拒绝 `type:'event'`，且错误是**可读的明确文案**（不是泛泛的 enum 报错）；
 * 2. 错误定位到具体触发器下标（多触发器时不靠猜）；
 * 3. **存量不受影响**：既有含 event 触发器的定义仍能通过运行时校验（读/运行/发布链路未动）。
 */

const steps = [{ id: 's1', type: 'tool', tool: { name: 'noop', arguments: {} } }] as const;

function createDef(triggers: unknown) {
  return { name: 'wf', definition: { triggers, steps } };
}

describe('M12-P5：event 触发器下线（写入面拒绝，存量不动）', () => {
  it('存量口径：definition 里带 event 触发器仍通过 validateDefinition（读/运行/发布链路未动）', () => {
    const legacy = {
      triggers: [
        { type: 'manual' },
        { type: 'event', event: 'ch-legacy' },
      ],
      steps: [{ id: 's1', type: 'tool', tool: { name: 'noop', arguments: {} } }],
    } as unknown as WorkflowDefinition;
    // 运行时校验（发布链路 validateDefinition）**不拒绝** event —— 既有工作流绝不因下线变砖
    expect(validateDefinition(legacy)).toBeNull();
  });

  it('三条真实链路（manual/webhook/schedule）照常通过', () => {
    const ok = CreateWorkflowSchema.safeParse(createDef([
      { type: 'manual' },
      { type: 'webhook' },
      { type: 'schedule', cron: '0 9 * * 1' },
    ]));
    expect(ok.success).toBe(true);
  });

  it('triggers 可缺省（既有契约不变）', () => {
    expect(CreateWorkflowSchema.safeParse({ name: 'wf', definition: { steps } }).success).toBe(true);
    expect(WorkflowDefinitionSchema.safeParse({ steps }).success).toBe(true);
  });

  it('新建：单个 event 触发器被拒，报错文案明确（含下线原因与替代方案）', () => {
    const res = CreateWorkflowSchema.safeParse(createDef([{ type: 'event', event: 'ch-1' }]));
    expect(res.success).toBe(false);
    const issues = res.success ? [] : res.error.issues;
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe(EVENT_TRIGGER_RETIRED_MESSAGE);
    // 文案可读性硬要求：说明"已下线"、给出替代（manual / webhook / schedule）、声明存量不受影响
    expect(issues[0].message).toContain('已下线');
    expect(issues[0].message).toContain('manual');
    expect(issues[0].message).toContain('webhook');
    expect(issues[0].message).toContain('schedule');
  });

  it('错误定位到具体触发器下标：definition.triggers.<i>.type（多触发器时不必靠猜）', () => {
    // 走 CreateWorkflowSchema（= 真实 HTTP 写入路径）：zod 会自动补上前缀，报错里能直接看出是第几个
    const viaCreate = CreateWorkflowSchema.safeParse(createDef([
      { type: 'manual' },
      { type: 'event', event: 'ch-1' },
    ]));
    expect(viaCreate.success).toBe(false);
    const createIssues = viaCreate.success ? [] : viaCreate.error.issues;
    expect(createIssues).toHaveLength(1);
    expect(createIssues[0].path.join('.')).toBe('definition.triggers.1.type');

    // 直接校验 definition 本身：路径不带外层前缀（同一实现，两种入口都定位到触发器下标）
    const direct = WorkflowDefinitionSchema.safeParse({ triggers: [{ type: 'event', event: 'ch-1' }], steps });
    expect(direct.success).toBe(false);
    expect((direct.success ? [] : direct.error.issues)[0].path.join('.')).toBe('triggers.0.type');
  });

  it('多个 event 触发器 → 逐个报错（不因第一个就提前退出）', () => {
    const res = WorkflowDefinitionSchema.safeParse({
      triggers: [
        { type: 'event', event: 'a' },
        { type: 'schedule', cron: '0 9 * * 1' },
        { type: 'event', event: 'b' },
      ],
      steps,
    });
    expect(res.success).toBe(false);
    const paths = (res.success ? [] : res.error.issues).map((i) => i.path.join('.'));
    expect(paths).toEqual(['triggers.0.type', 'triggers.2.type']);
  });

  it('更新（UpdateWorkflowSchema）同样是写入口：event 触发器一律拒绝', () => {
    const res = UpdateWorkflowSchema.safeParse({ definition: { triggers: [{ type: 'event', event: 'ch-x' }], steps } });
    expect(res.success).toBe(false);
    expect((res.success ? [] : res.error.issues)[0].message).toBe(EVENT_TRIGGER_RETIRED_MESSAGE);
  });

  it('经 ZodValidationPipe 冒泡为 400 + VALIDATION_ERROR（HTTP 可判别、可断言）', () => {
    const pipe = new ZodValidationPipe(CreateWorkflowSchema);
    expect(() => pipe.transform(createDef([{ type: 'event', event: 'ch-1' }]))).toThrowError(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'VALIDATION_ERROR',
          message: expect.stringContaining(EVENT_TRIGGER_RETIRED_MESSAGE),
        }),
      }),
    );
  });

  it('非 event 的触发器字段校验不受影响（strictObject 仍拒绝未知字段）', () => {
    expect(WorkflowDefinitionSchema.safeParse({ triggers: [{ type: 'manual', typo: 1 }], steps }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({ triggers: [{ type: 'manual' }], steps }).success).toBe(true);
    // event 字段本身仍是合法字段（存量定义的结构不被破坏），只是 type='event' 不再被接受
    expect(WorkflowDefinitionSchema.safeParse({ triggers: [{ type: 'webhook', event: 'ch-1' }], steps }).success).toBe(true);
  });
});
