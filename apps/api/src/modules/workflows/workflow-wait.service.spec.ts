import { describe, it, expect } from 'vitest';
import { WorkflowWaitService, parseWaitingUntil } from './workflow-wait.service';
import { WorkflowContext } from './workflow-types';

const waits = new WorkflowWaitService();

const ctx: WorkflowContext = {
  input: { childRunId: 'child-run-1', minutes: 5 },
  steps: { prepare: { status: 'completed', output: { runId: 'child-run-2' } } },
};

/**
 * M9-P4 wait 条件（单测）：分支判定/期限换算/持久化期限恢复/到期判定。
 * 不变量：相对时长只在首次进入时换算；恢复一律取落库期限（绝不重新计时）。
 */
describe('WorkflowWaitService（M9-P4 wait 条件）', () => {
  it('resolve：untilMs 相对时长 → now + untilMs；untilIso → 绝对时间；childRunId → 模板渲染', () => {
    const now = 1_700_000_000_000;
    expect(waits.resolve({ untilMs: 1500 }, ctx, now)).toEqual({ kind: 'time', untilMs: now + 1500 });
    const iso = new Date(now + 60_000).toISOString();
    expect(waits.resolve({ untilIso: iso }, ctx, now)).toEqual({ kind: 'time', untilMs: Date.parse(iso) });
    expect(waits.resolve({ childRunId: '{{input.childRunId}}' }, ctx, now)).toEqual({ kind: 'agent_run', childRunId: 'child-run-1' });
    expect(waits.resolve({ childRunId: '{{steps.prepare.output.runId}}' }, ctx, now)).toEqual({ kind: 'agent_run', childRunId: 'child-run-2' });
  });

  it('resolve：非法/缺失条件一律 VALIDATION_ERROR（fail-closed，绝不静默降级为"立即通过"）', () => {
    expect(() => waits.resolve({}, ctx)).toThrowError(/缺少等待条件/);
    expect(() => waits.resolve({ untilMs: -1 }, ctx)).toThrowError(/untilMs 非法/);
    expect(() => waits.resolve({ untilMs: 8 * 86400_000 }, ctx)).toThrowError(/untilMs 非法/);
    expect(() => waits.resolve({ untilIso: 'not-a-date' }, ctx)).toThrowError(/untilIso 非法/);
    expect(() => waits.resolve({ childRunId: '{{input.missing}}' }, ctx)).toThrowError(/渲染结果为空/);
  });

  it('persistedDeadline/parseWaitingUntil：恢复落库期限；非法/缺失 → null（按首次进入处理）', () => {
    const iso = new Date(1_700_000_060_000).toISOString();
    expect(waits.persistedDeadline({ kind: 'time', waitingUntil: iso })).toBe(1_700_000_060_000);
    expect(parseWaitingUntil({ waitingUntil: iso })).toBe(1_700_000_060_000);
    expect(parseWaitingUntil({ waitingUntil: 'xxx' })).toBeNull();
    expect(parseWaitingUntil({})).toBeNull();
    expect(parseWaitingUntil(null)).toBeNull();
    expect(parseWaitingUntil('string')).toBeNull();
  });

  it('isDue/remaining：now >= untilMs 才放行（早到唤醒 → 继续等待，绝不提前前进）', () => {
    expect(waits.isDue(1000, 999)).toBe(false);
    expect(waits.isDue(1000, 1000)).toBe(true);
    expect(waits.isDue(1000, 1001)).toBe(true);
    expect(waits.remaining(1000, 400)).toBe(600);
    expect(waits.remaining(1000, 1200)).toBeLessThan(0);
  });
});
