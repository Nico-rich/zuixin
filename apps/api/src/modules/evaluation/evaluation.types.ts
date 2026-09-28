/** M9-P1 评测共享类型（纯数据；无 DI） */

/** EvaluationRun.configSnapshot 的形状（版本化：schema 字段演进时旧 run 仍可解释） */
export interface EvaluationConfigSnapshot {
  schema: 1;
  lockedAt: string;
  // ===== 锁定的 Agent 身份（AgentVersion 不可变）=====
  agentId: string;
  agentVersionId: string;
  agentVersion: number;
  agentSlug: string;
  // ===== 锁定的 LLM 参数（执行时以此为准，绝不读"当前"配置）=====
  modelId: string | null;
  providerId: string | null;
  providerName: string | null;
  temperature: number;
  maxTokens: number | null;
  systemPrompt: string;
  tools: string[];
  // ===== 锁定的评测绑定与数据版本 =====
  evaluatorIds: string[];
  datasetId: string;
  datasetVersion: number;
  /** 创建期覆写记录（缺省字段 = 继承 AgentVersion 值） */
  overrides?: {
    modelId?: string;
    temperature?: number;
    maxTokens?: number;
  };
}

export interface EvaluatorScoreRow {
  evaluatorId: string;
  name: string;
  type: string;
  /** 已出结果的 caseRun 数（分母；失败/未跑的 caseRun 不计入） */
  evaluated: number;
  passed: number;
  failed: number;
  avgScore: number;
  passRate: number;
}

export interface RunScoreSummary {
  evaluators: EvaluatorScoreRow[];
  /** 全部评测器的加权总览（evaluated = Σ；avgScore = 全部结果均分） */
  overall: { evaluated: number; passed: number; failed: number; avgScore: number; passRate: number };
  caseRuns: { total: number; completed: number; failed: number; pending: number; skipped: number };
}

export interface CaseComparisonRow {
  caseId: string;
  baseline: { score: number; passed: boolean } | null;
  candidate: { score: number; passed: boolean } | null;
  outcome: 'unchanged_pass' | 'unchanged_fail' | 'improved' | 'regressed' | 'added' | 'removed';
}

export interface RunComparison {
  candidateRunId: string;
  baselineRunId: string;
  evaluators: Array<{
    evaluatorId: string;
    name: string;
    type: string;
    baseline: { evaluated: number; passed: number; avgScore: number; passRate: number };
    candidate: { evaluated: number; passed: number; avgScore: number; passRate: number };
    delta: { avgScore: number; passRate: number };
  }>;
  summary: { improved: number; regressed: number; unchangedPass: number; unchangedFail: number; added: number; removed: number };
  cases: CaseComparisonRow[];
  /** 两侧数据集版本不同 → caseId 集合无交集，对照仅供人工核对（绝不伪造可比性） */
  comparable: boolean;
}
