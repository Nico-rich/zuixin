import { describe, it, expect } from 'vitest';
import { compareRuns, caseVerdict, summarizeScores, ResultFact } from './score-aggregation';

const EV = [
  { id: 'ev1', name: '严格相等', type: 'exact_match' },
  { id: 'ev2', name: '裁判', type: 'llm_judge' },
];

function r(caseRunId: string, evaluatorId: string, score: number, passed: boolean): ResultFact {
  return { caseRunId, evaluatorId, score, passed };
}

describe('summarizeScores（读路径聚合，无新表）', () => {
  it('总体/分评测器通过率与均分；分母 = 已出结果的 caseRun', () => {
    const results = [r('cr1', 'ev1', 1, true), r('cr2', 'ev1', 0, false), r('cr1', 'ev2', 0.5, true)];
    const caseRuns = [
      { id: 'cr1', caseId: 'c1', status: 'completed' },
      { id: 'cr2', caseId: 'c2', status: 'completed' },
      { id: 'cr3', caseId: 'c3', status: 'failed' },
    ];
    const s = summarizeScores(results, caseRuns, EV);
    expect(s.overall).toMatchObject({ evaluated: 3, passed: 2, failed: 1, passRate: 0.666667 });
    const ev1 = s.evaluators.find((e) => e.evaluatorId === 'ev1')!;
    expect(ev1).toMatchObject({ name: '严格相等', evaluated: 2, passed: 1, failed: 1, avgScore: 0.5, passRate: 0.5 });
    expect(s.caseRuns).toEqual({ total: 3, completed: 2, failed: 1, pending: 0, skipped: 0 });
  });

  it('failed/pending 的 caseRun 不进分母（未评测绝不用 0 分冒充）', () => {
    const results = [r('cr1', 'ev1', 1, true)];
    const caseRuns = [
      { id: 'cr1', caseId: 'c1', status: 'completed' },
      { id: 'cr2', caseId: 'c2', status: 'failed' },
      { id: 'cr3', caseId: 'c3', status: 'running' },
      { id: 'cr4', caseId: 'c4', status: 'pending' },
    ];
    const s = summarizeScores(results, caseRuns, EV);
    expect(s.overall).toMatchObject({ evaluated: 1, passed: 1, failed: 0, avgScore: 1, passRate: 1 });
    expect(s.caseRuns).toEqual({ total: 4, completed: 1, failed: 1, pending: 2, skipped: 0 });
  });

  it('零结果 → 全 0，绝不产生 NaN', () => {
    const s = summarizeScores([], [{ id: 'cr1', caseId: 'c1', status: 'failed' }], EV);
    expect(s.overall).toEqual({ evaluated: 0, passed: 0, failed: 0, avgScore: 0, passRate: 0 });
    expect(s.evaluators).toEqual([]);
  });

  it('评测器已删除时结果仍可读（名称降级为占位，绝不丢行）', () => {
    const s = summarizeScores([r('cr1', 'gone', 1, true)], [{ id: 'cr1', caseId: 'c1', status: 'completed' }], EV);
    expect(s.evaluators[0]).toMatchObject({ evaluatorId: 'gone', name: '(已删除评测器)', type: 'unknown' });
  });
});

describe('caseVerdict', () => {
  it('同 case 多评测器：均分为 score，全通过才 passed', () => {
    expect(caseVerdict([])).toBeNull();
    expect(caseVerdict([r('cr1', 'ev1', 1, true), r('cr1', 'ev2', 0.5, true)])).toEqual({ score: 0.75, passed: true });
    expect(caseVerdict([r('cr1', 'ev1', 1, true), r('cr1', 'ev2', 0, false)])).toEqual({ score: 0.5, passed: false });
  });
});

describe('compareRuns（baseline vs candidate 逐 case 对照）', () => {
  const base = {
    caseRuns: [{ id: 'b1', caseId: 'c1', status: 'completed' }, { id: 'b2', caseId: 'c2', status: 'completed' }, { id: 'b3', caseId: 'c3', status: 'completed' }],
    results: [r('b1', 'ev1', 1, true), r('b2', 'ev1', 0, false), r('b3', 'ev1', 1, true)],
  };
  const cand = {
    caseRuns: [{ id: 'k1', caseId: 'c1', status: 'completed' }, { id: 'k2', caseId: 'c2', status: 'completed' }, { id: 'k4', caseId: 'c4', status: 'completed' }],
    results: [r('k1', 'ev1', 1, true), r('k2', 'ev1', 1, true), r('k4', 'ev1', 0, false)],
  };

  it('按 caseId 对齐（无 FK 时由 caseRun 行内建映射）：improved/regressed/added/removed 分类正确', () => {
    const cmp = compareRuns({
      candidateRunId: 'cand', baselineRunId: 'base', comparable: true,
      baseline: base, candidate: cand, caseIds: ['c1', 'c2', 'c3', 'c4'], evaluators: EV,
    });
    expect(cmp.summary).toEqual({ improved: 1, regressed: 0, unchangedPass: 1, unchangedFail: 0, added: 1, removed: 1 });
    expect(cmp.cases.find((c) => c.caseId === 'c2')!.outcome).toBe('improved');
    expect(cmp.cases.find((c) => c.caseId === 'c3')!.outcome).toBe('removed');
    expect(cmp.cases.find((c) => c.caseId === 'c4')!.outcome).toBe('added');
    expect(cmp.cases.find((c) => c.caseId === 'c1')!.baseline).toEqual({ score: 1, passed: true });
  });

  it('regressed：baseline 通过而 candidate 不通过', () => {
    const cmp = compareRuns({
      candidateRunId: 'cand', baselineRunId: 'base', comparable: true,
      baseline: { caseRuns: [{ id: 'b1', caseId: 'c1', status: 'completed' }], results: [r('b1', 'ev1', 1, true)] },
      candidate: { caseRuns: [{ id: 'k1', caseId: 'c1', status: 'completed' }], results: [r('k1', 'ev1', 0, false)] },
      caseIds: ['c1'], evaluators: EV,
    });
    expect(cmp.summary.regressed).toBe(1);
    expect(cmp.cases[0].outcome).toBe('regressed');
  });

  it('分评测器 delta = candidate 均分/通过率 - baseline（同分母口径）', () => {
    const cmp = compareRuns({
      candidateRunId: 'cand', baselineRunId: 'base', comparable: false,
      baseline: base, candidate: cand, caseIds: ['c1', 'c2', 'c3', 'c4'], evaluators: EV,
    });
    const ev1 = cmp.evaluators.find((e) => e.evaluatorId === 'ev1')!;
    expect(ev1.baseline).toEqual({ evaluated: 3, passed: 2, avgScore: 0.666667, passRate: 0.666667 });
    expect(ev1.candidate).toEqual({ evaluated: 3, passed: 2, avgScore: 0.666667, passRate: 0.666667 });
    expect(ev1.delta).toEqual({ avgScore: 0, passRate: 0 });
    expect(cmp.comparable).toBe(false);
  });

  it('孤儿结果（caseRun 已删除）被跳过，绝不抛错或错配到别的 case', () => {
    const cmp = compareRuns({
      candidateRunId: 'cand', baselineRunId: 'base', comparable: true,
      baseline: { caseRuns: [{ id: 'b1', caseId: 'c1', status: 'completed' }], results: [r('b1', 'ev1', 1, true), r('orphan', 'ev1', 0, false)] },
      candidate: { caseRuns: [], results: [] },
      caseIds: ['c1'], evaluators: EV,
    });
    expect(cmp.cases[0].baseline).toEqual({ score: 1, passed: true });
    expect(cmp.summary.removed).toBe(1);
  });
});
