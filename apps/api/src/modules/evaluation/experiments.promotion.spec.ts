import { describe, it, expect } from 'vitest';
import {
  PromotionVariantInput, buildPromotionProposal, proposalHashOf, readPromotionTarget,
} from './experiments.promotion';
import { RunScoreSummary } from './evaluation.types';

/**
 * M12-P4 晋级结论单测（纯函数）。
 * 红线断言：胜出判定是**服务端确定性规则**（无 LLM、无随机、无时间依赖），同分保持输入顺序；
 * 无事实 → 绝不臆造结论；未声明目标 → 绝不猜一个键；指纹把"看到的结论"与"确认时的事实"钉在一起。
 */
function scores(overall: Partial<RunScoreSummary['overall']> & { evaluated: number }): RunScoreSummary {
  return {
    overall: { passed: overall.passed ?? 0, failed: overall.evaluated - (overall.passed ?? 0), avgScore: overall.avgScore ?? 0, passRate: overall.passRate ?? 0, evaluated: overall.evaluated },
    perEvaluator: [], perCase: [], evaluatorIds: [], caseCount: overall.evaluated,
  } as unknown as RunScoreSummary;
}

function variant(over: Partial<PromotionVariantInput> & { id: string }): PromotionVariantInput {
  return {
    name: over.id,
    isBaseline: false,
    agentVersionId: `av-${over.id}`,
    configSnapshot: { promotion: { key: 'policyThresholds', value: { commerce: { anomalyPct: 12 } } } },
    evaluation: { runCount: 1, scores: scores({ evaluated: 1, avgScore: 0.5, passRate: 0.5, passed: 0 }) },
    ...over,
  };
}

describe('readPromotionTarget（形状不符 → null，绝不猜测）', () => {
  it('合法声明 → {key, value}', () => {
    expect(readPromotionTarget({ promotion: { key: 'routingPolicy', value: { confidenceThreshold: 0.4 } } }))
      .toEqual({ key: 'routingPolicy', value: { confidenceThreshold: 0.4 } });
  });

  it('缺 promotion / key 非字符串 / 空 key / value 非对象 / 非对象快照 → null', () => {
    for (const bad of [
      undefined, null, 'x', 1, [], {},
      { note: '无声明' },
      { promotion: null },
      { promotion: {} },
      { promotion: { key: 1, value: {} } },
      { promotion: { key: '', value: {} } },
      { promotion: { key: 'routingPolicy' } },
      { promotion: { key: 'routingPolicy', value: [] } },
      { promotion: { key: 'routingPolicy', value: 'x' } },
    ]) {
      expect(readPromotionTarget(bad)).toBeNull();
    }
  });
});

describe('buildPromotionProposal（确定性结论）', () => {
  it('变体为空 / 全部无评测事实 → insufficient_evidence（零样本绝不比较）', () => {
    expect(buildPromotionProposal({ experimentId: 'e1', variants: [] }))
      .toMatchObject({ status: 'insufficient_evidence', proposalHash: null, winner: null, target: null, evidence: [] });

    const noFacts = buildPromotionProposal({
      experimentId: 'e1',
      variants: [
        variant({ id: 'v1', isBaseline: true, evaluation: { runCount: 0, scores: null } }),
        variant({ id: 'v2', evaluation: { runCount: 0, scores: null } }),
      ],
    });
    expect(noFacts.status).toBe('insufficient_evidence');
    expect(noFacts.proposalHash).toBeNull();
  });

  it('候选严格优于基线 + 声明目标 → candidate（附目标 + 指纹 + 服务端人读结论）', () => {
    const p = buildPromotionProposal({
      experimentId: 'e1',
      variants: [
        variant({ id: 'base', isBaseline: true, evaluation: { runCount: 1, scores: scores({ evaluated: 4, avgScore: 0.5, passRate: 0.5, passed: 2 }) } }),
        variant({ id: 'cand', evaluation: { runCount: 1, scores: scores({ evaluated: 4, avgScore: 0.9, passRate: 1, passed: 4 }) } }),
      ],
    });
    expect(p).toMatchObject({
      experimentId: 'e1',
      status: 'candidate',
      winner: { variantId: 'cand', name: 'cand', agentVersionId: 'av-cand' },
      baseline: { variantId: 'base', name: 'base' },
      target: { key: 'policyThresholds', value: { commerce: { anomalyPct: 12 } } },
    });
    expect(p.proposalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.evidence).toHaveLength(2);
    expect(p.evidence.find((e) => e.variantId === 'cand')).toMatchObject({ avgScore: 0.9, passRate: 1, evaluated: 4, isBaseline: false });
    expect(p.reason).toContain('待平台管理员确认');
    expect(p.reason).toContain('policyThresholds');
  });

  it('胜出即基线 → baseline_holds（没有严格改进就不晋级），且目标/指纹为 null', () => {
    const p = buildPromotionProposal({
      experimentId: 'e1',
      variants: [
        variant({ id: 'base', isBaseline: true, evaluation: { runCount: 1, scores: scores({ evaluated: 4, avgScore: 0.9, passRate: 1, passed: 4 }) } }),
        variant({ id: 'cand', evaluation: { runCount: 1, scores: scores({ evaluated: 4, avgScore: 0.5, passRate: 0.5, passed: 2 }) } }),
      ],
    });
    expect(p).toMatchObject({ status: 'baseline_holds', target: null, proposalHash: null, winner: { variantId: 'base' } });
    expect(p.reason).toContain('基线变体事实最优');
  });

  it('候选未严格优于基线（均分同、通过率同、样本量同）→ baseline_holds（保守，绝不"平局即晋级"）', () => {
    const tie = scores({ evaluated: 4, avgScore: 0.5, passRate: 0.5, passed: 2 });
    const p = buildPromotionProposal({
      experimentId: 'e1',
      variants: [
        variant({ id: 'base', isBaseline: true, evaluation: { runCount: 1, scores: tie } }),
        variant({ id: 'cand', evaluation: { runCount: 1, scores: tie } }),
      ],
    });
    expect(p.status).toBe('baseline_holds');
    expect(p.proposalHash).toBeNull();
  });

  it('候选均分胜出但样本量更小 → 仍晋级（排序键：均分 → 通过率 → 样本量）', () => {
    const p = buildPromotionProposal({
      experimentId: 'e1',
      variants: [
        variant({ id: 'base', isBaseline: true, evaluation: { runCount: 1, scores: scores({ evaluated: 20, avgScore: 0.5, passRate: 0.5, passed: 10 }) } }),
        variant({ id: 'cand', evaluation: { runCount: 1, scores: scores({ evaluated: 2, avgScore: 0.7, passRate: 0.5, passed: 1 }) } }),
      ],
    });
    expect(p.status).toBe('candidate');
    expect(p.winner).toMatchObject({ variantId: 'cand' });
  });

  it('同分保持输入顺序（确定性：绝不随机、绝不依赖 sort 的隐式行为）', () => {
    const same = scores({ evaluated: 3, avgScore: 0.6, passRate: 0.6, passed: 2 });
    const forward = buildPromotionProposal({
      experimentId: 'e1',
      variants: [variant({ id: 'a', isBaseline: true, evaluation: { runCount: 1, scores: same } }), variant({ id: 'b', evaluation: { runCount: 1, scores: same } })],
    });
    const reversed = buildPromotionProposal({
      experimentId: 'e1',
      variants: [variant({ id: 'b', evaluation: { runCount: 1, scores: same } }), variant({ id: 'a', isBaseline: true, evaluation: { runCount: 1, scores: same } })],
    });
    expect(forward.winner).toMatchObject({ variantId: 'a' });
    expect(reversed.winner).toMatchObject({ variantId: 'b' });
  });

  it('候选胜出但未声明目标 → no_target（绝不臆造写键）', () => {
    const p = buildPromotionProposal({
      experimentId: 'e1',
      variants: [
        variant({ id: 'base', isBaseline: true, evaluation: { runCount: 1, scores: scores({ evaluated: 4, avgScore: 0.2, passRate: 0.25, passed: 1 }) } }),
        variant({ id: 'cand', configSnapshot: { note: '无目标' }, evaluation: { runCount: 1, scores: scores({ evaluated: 4, avgScore: 0.9, passRate: 1, passed: 4 }) } }),
      ],
    });
    expect(p).toMatchObject({ status: 'no_target', target: null, proposalHash: null, winner: { variantId: 'cand' } });
  });

  it('无基线变体（实验未标基线）→ 有事实候选即可成为 candidate（基线字段 null，绝不虚构一个基线）', () => {
    const p = buildPromotionProposal({
      experimentId: 'e1',
      variants: [variant({ id: 'cand', evaluation: { runCount: 1, scores: scores({ evaluated: 4, avgScore: 0.8, passRate: 0.75, passed: 3 }) } })],
    });
    expect(p).toMatchObject({ status: 'candidate', baseline: null });
  });

  it('基线无事实、候选有事实 → 晋级候选（证据不足绝不当作"基线更优"）', () => {
    const p = buildPromotionProposal({
      experimentId: 'e1',
      variants: [
        variant({ id: 'base', isBaseline: true, evaluation: { runCount: 0, scores: null } }),
        variant({ id: 'cand', evaluation: { runCount: 1, scores: scores({ evaluated: 1, avgScore: 0.1, passRate: 0, passed: 0 }) } }),
      ],
    });
    expect(p.status).toBe('candidate');
    expect(p.evidence.find((e) => e.variantId === 'base')).toMatchObject({ runCount: 0, evaluated: 0, avgScore: 0, passRate: 0 });
  });
});

describe('proposalHashOf（指纹可复现且对任一事实变化敏感）', () => {
  const evidence = [{ variantId: 'v1', name: 'v1', isBaseline: false, runCount: 1, evaluated: 4, passed: 4, avgScore: 1, passRate: 1 }];
  const target = { key: 'policyThresholds', value: { commerce: { anomalyPct: 12 } } };
  const base = { experimentId: 'e1', winnerVariantId: 'v1', target, evidence };

  it('同输入 → 同指纹（六十四位十六进制；不受对象键插入顺序影响）', () => {
    const a = proposalHashOf(base);
    const b = proposalHashOf({
      ...base,
      target: { value: { commerce: { anomalyPct: 12 } }, key: 'policyThresholds' },
      evidence: [{ ...evidence[0] }],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('事实/目标/胜出者/实验任一变化 → 指纹变化（确认时 CAS 才有意义）', () => {
    const a = proposalHashOf(base);
    expect(proposalHashOf({ ...base, evidence: [{ ...evidence[0], avgScore: 0.9 }] })).not.toBe(a);
    expect(proposalHashOf({ ...base, target: { key: 'policyThresholds', value: { commerce: { anomalyPct: 13 } } } })).not.toBe(a);
    expect(proposalHashOf({ ...base, winnerVariantId: 'v2' })).not.toBe(a);
    expect(proposalHashOf({ ...base, experimentId: 'e2' })).not.toBe(a);
  });
});
