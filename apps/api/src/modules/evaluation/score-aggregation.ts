import { round6 } from './evaluators/util';
import { CaseComparisonRow, EvaluatorScoreRow, RunComparison, RunScoreSummary } from './evaluation.types';

/** 聚合输入（仅 EvaluationResult 的只读事实列） */
export interface ResultFact { caseRunId: string; evaluatorId: string; score: number; passed: boolean }
export interface CaseRunFact { id: string; caseId: string; status: string }
export interface EvaluatorMeta { id: string; name: string; type: string }

/**
 * 评测分数聚合（纯函数；读路径派生，绝不落新表）。
 * 分母只计**已出结果的 caseRun**（failed/pending 的 caseRun 不产生结果，也不进分母——
 * 用 0 分冒充"未评测"会系统性低估质量）。
 */
export function summarizeScores(
  results: ResultFact[],
  caseRuns: CaseRunFact[],
  evaluators: EvaluatorMeta[],
): RunScoreSummary {
  const meta = new Map(evaluators.map((e) => [e.id, e]));
  const byEvaluator = new Map<string, ResultFact[]>();
  for (const r of results) {
    const list = byEvaluator.get(r.evaluatorId) ?? [];
    list.push(r);
    byEvaluator.set(r.evaluatorId, list);
  }
  const rows: EvaluatorScoreRow[] = [...byEvaluator.entries()].map(([evaluatorId, rs]) => {
    const passed = rs.filter((r) => r.passed).length;
    const avg = rs.length === 0 ? 0 : rs.reduce((s, r) => s + r.score, 0) / rs.length;
    return {
      evaluatorId,
      name: meta.get(evaluatorId)?.name ?? '(已删除评测器)',
      type: meta.get(evaluatorId)?.type ?? 'unknown',
      evaluated: rs.length,
      passed,
      failed: rs.length - passed,
      avgScore: round6(avg),
      passRate: round6(rs.length === 0 ? 0 : passed / rs.length),
    };
  }).sort((a, b) => a.evaluatorId.localeCompare(b.evaluatorId));

  const totalPassed = results.filter((r) => r.passed).length;
  const overallAvg = results.length === 0 ? 0 : results.reduce((s, r) => s + r.score, 0) / results.length;
  const count = (status: string) => caseRuns.filter((c) => c.status === status).length;

  return {
    evaluators: rows,
    overall: {
      evaluated: results.length,
      passed: totalPassed,
      failed: results.length - totalPassed,
      avgScore: round6(overallAvg),
      passRate: round6(results.length === 0 ? 0 : totalPassed / results.length),
    },
    caseRuns: {
      total: caseRuns.length,
      completed: count('completed'),
      failed: count('failed'),
      pending: count('pending') + count('running'),
      skipped: count('skipped'),
    },
  };
}

/** 单个 case 的对照取值（同 caseId 的多条结果取均分；无结果 = null） */
export function caseVerdict(results: ResultFact[]): { score: number; passed: boolean } | null {
  if (results.length === 0) return null;
  const passed = results.every((r) => r.passed);
  return { score: round6(results.reduce((s, r) => s + r.score, 0) / results.length), passed };
}

/**
 * baseline vs candidate 逐 case 对照（读路径聚合，无新表）：
 * - 仅按 caseId 对齐（两侧数据集版本不同 → caseId 集合可能无交集 → comparable=false，绝不伪造可比性）；
 * - improved/regressed 由"整体通过态"翻转定义（pass→fail = regressed）。
 */
export function compareRuns(input: {
  candidateRunId: string;
  baselineRunId: string;
  comparable: boolean;
  baseline: { results: ResultFact[]; caseRuns: CaseRunFact[] };
  candidate: { results: ResultFact[]; caseRuns: CaseRunFact[] };
  caseIds: string[];
  evaluators: EvaluatorMeta[];
}): RunComparison {
  const meta = new Map(input.evaluators.map((e) => [e.id, e]));
  // caseRunId → caseId（EvaluationCaseRun 与 EvaluationCase 无 FK，映射由本函数按 run 行内建）
  const group = (side: { results: ResultFact[]; caseRuns: CaseRunFact[] }) => {
    const caseOf = new Map(side.caseRuns.map((c) => [c.id, c.caseId]));
    const byCase = new Map<string, ResultFact[]>();
    for (const r of side.results) {
      const caseId = caseOf.get(r.caseRunId);
      if (!caseId) continue; // 孤儿结果（caseRun 已随 run 级联删除）——跳过
      const list = byCase.get(caseId) ?? [];
      list.push(r);
      byCase.set(caseId, list);
    }
    return byCase;
  };
  const baseByCase = group(input.baseline);
  const candByCase = group(input.candidate);
  const baselineResults = input.baseline.results;
  const candidateResults = input.candidate.results;

  const evaluatorIds = [...new Set([...baselineResults, ...candidateResults].map((r) => r.evaluatorId))]
    .filter((id) => meta.has(id))
    .sort();
  const evaluatorRows = evaluatorIds.map((evaluatorId) => {
    const pick = (rs: ResultFact[]) => rs.filter((r) => r.evaluatorId === evaluatorId);
    const base = pick(baselineResults);
    const cand = pick(candidateResults);
    const stat = (rs: ResultFact[]) => {
      const passed = rs.filter((r) => r.passed).length;
      const avg = rs.length === 0 ? 0 : rs.reduce((s, r) => s + r.score, 0) / rs.length;
      return { evaluated: rs.length, passed, avgScore: round6(avg), passRate: round6(rs.length === 0 ? 0 : passed / rs.length) };
    };
    const b = stat(base);
    const c = stat(cand);
    return {
      evaluatorId,
      name: meta.get(evaluatorId)?.name ?? '(已删除评测器)',
      type: meta.get(evaluatorId)?.type ?? 'unknown',
      baseline: b,
      candidate: c,
      delta: { avgScore: round6(c.avgScore - b.avgScore), passRate: round6(c.passRate - b.passRate) },
    };
  });

  const cases: CaseComparisonRow[] = input.caseIds.map((caseId) => {
    const b = caseVerdict(baseByCase.get(caseId) ?? []);
    const c = caseVerdict(candByCase.get(caseId) ?? []);
    let outcome: CaseComparisonRow['outcome'];
    if (!b && c) outcome = 'added';
    else if (b && !c) outcome = 'removed';
    else if (b && c) outcome = !b.passed && c.passed ? 'improved' : b.passed && !c.passed ? 'regressed' : b.passed ? 'unchanged_pass' : 'unchanged_fail';
    else outcome = 'removed';
    return { caseId, baseline: b, candidate: c, outcome };
  });

  const tally = (o: CaseComparisonRow['outcome']) => cases.filter((c) => c.outcome === o).length;
  return {
    candidateRunId: input.candidateRunId,
    baselineRunId: input.baselineRunId,
    evaluators: evaluatorRows,
    summary: {
      improved: tally('improved'),
      regressed: tally('regressed'),
      unchangedPass: tally('unchanged_pass'),
      unchangedFail: tally('unchanged_fail'),
      added: tally('added'),
      removed: tally('removed'),
    },
    cases,
    comparable: input.comparable,
  };
}
