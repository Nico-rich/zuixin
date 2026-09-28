import { describe, it, expect } from 'vitest';
import {
  HYPOTHESIS_STATUSES, TERMINAL_HYPOTHESIS_STATUSES, assertTransition, canTransition, isHypothesisStatus,
  isLoopActive, isTerminal,
} from './hypothesis-status';

/**
 * M9-P5 假设状态机（单测）：允许边/终态只读/非法推进一律 VALIDATION_ERROR（deny-by-default）。
 * 状态机与 Experiment（P1）/WorkflowRun（M7-P6）互不冒充——本文件只锁"创意假设"这一业务实体。
 */
describe('hypothesis-status（M9-P5 假设状态机）', () => {
  it('状态全集与终态集合固定', () => {
    expect([...HYPOTHESIS_STATUSES]).toEqual(['draft', 'ready', 'running', 'validated', 'rejected']);
    expect([...TERMINAL_HYPOTHESIS_STATUSES]).toEqual(['validated', 'rejected']);
    expect(isTerminal('validated')).toBe(true);
    expect(isTerminal('rejected')).toBe(true);
    expect(isTerminal('running')).toBe(false);
  });

  it('isHypothesisStatus：仅接受已知状态（未知值/非字符串一律 false）', () => {
    for (const s of HYPOTHESIS_STATUSES) expect(isHypothesisStatus(s)).toBe(true);
    expect(isHypothesisStatus('completed')).toBe(false);
    expect(isHypothesisStatus('')).toBe(false);
    expect(isHypothesisStatus(null)).toBe(false);
    expect(isHypothesisStatus(7)).toBe(false);
  });

  it('允许边：draft→ready|rejected；ready→running|rejected；running→validated|rejected；终态无出边', () => {
    expect(canTransition('draft', 'ready')).toBe(true);
    expect(canTransition('draft', 'rejected')).toBe(true);
    expect(canTransition('ready', 'running')).toBe(true);
    expect(canTransition('ready', 'rejected')).toBe(true);
    expect(canTransition('running', 'validated')).toBe(true);
    expect(canTransition('running', 'rejected')).toBe(true);
    // 未列出的边一律拒绝（含"跳跃推进"与"终态复活"）
    expect(canTransition('draft', 'running')).toBe(false);
    expect(canTransition('draft', 'validated')).toBe(false);
    expect(canTransition('ready', 'validated')).toBe(false);
    expect(canTransition('validated', 'running')).toBe(false);
    expect(canTransition('validated', 'rejected')).toBe(false);
    expect(canTransition('rejected', 'validated')).toBe(false);
    expect(canTransition('running', 'ready')).toBe(false);
  });

  it('assertTransition：非法推进抛 VALIDATION_ERROR，消息含 from → to（可诊断）', () => {
    expect(() => assertTransition('draft', 'ready')).not.toThrow();
    expect(() => assertTransition('draft', 'running')).toThrowError(/draft → running/);
    expect(() => assertTransition('validated', 'running')).toThrowError(/假设状态不允许该推进/);
    try {
      assertTransition('validated', 'running');
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('VALIDATION_ERROR');
    }
  });

  it('isLoopActive：仅 running 视为执行中（启动/评测触发的前置条件）', () => {
    expect(isLoopActive('running')).toBe(true);
    expect(isLoopActive('ready')).toBe(false);
    expect(isLoopActive('draft')).toBe(false);
    expect(isLoopActive('validated')).toBe(false);
    expect(isLoopActive('rejected')).toBe(false);
  });
});
