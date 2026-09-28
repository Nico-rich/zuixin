import { AppError, ErrorCode } from '../../../common/errors/app-error';
import { CaseFacts, EvaluatorImpl, JudgeFn, Verdict } from './types';
import { clampScore, stringify, truncate } from './util';

export interface LlmJudgeConfig {
  /** 评审 prompt 模板（支持 {{input}} / {{output}} / {{expected}} / {{toolCalls}} 占位符） */
  prompt: string;
  /** judge 模型（Model.id）；缺省 = 系统默认 LLM（model-resolver）——provider-independent */
  judgeModelId?: string;
  /** 通过阈值（score ≥ 阈值 = passed；默认 0.5） */
  passThreshold?: number;
}

export const JUDGE_PLACEHOLDERS = ['{{input}}', '{{output}}', '{{expected}}', '{{toolCalls}}'] as const;

/**
 * llm_judge：LLM-as-judge（provider-independent；judge 模型由 config.judgeModelId 指定或走系统默认）。
 *
 * 硬约束（M9-P1 规格）：
 * - judge 输出**只**进 EvaluationResult.score / .passed / .evidence；
 *   绝不参与任何权限/quota/RBAC/provider/approval 判定（本类不注入任何系统服务，结构上不可能越权）；
 * - **输出解析失败绝不重试**（重试 = 用多次采样制造幻觉分数）：passed=false + score=0 + evidence 记录原文；
 * - judge 调用失败（provider 错误等）同理不重试：evidence 记录错误，passed=false——绝不用"默认通过"掩盖失败；
 * - score 归一到 [0,1]（支持 {score,maxScore} 形态归一）。
 */
export class LlmJudgeEvaluator implements EvaluatorImpl {
  readonly type = 'llm_judge' as const;

  validate(config: Record<string, unknown>): void {
    const cfg = config as unknown as LlmJudgeConfig;
    if (typeof cfg.prompt !== 'string' || cfg.prompt.trim().length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'llm_judge.prompt 必须是非空字符串模板');
    }
    if (cfg.prompt.length > 20_000) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'llm_judge.prompt 过长（≤20000 字符）');
    }
    if (!JUDGE_PLACEHOLDERS.some((p) => cfg.prompt.includes(p))) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `llm_judge.prompt 至少包含一个占位符：${JUDGE_PLACEHOLDERS.join(' / ')}`);
    }
    if (cfg.judgeModelId !== undefined && (typeof cfg.judgeModelId !== 'string' || cfg.judgeModelId.length === 0)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'llm_judge.judgeModelId 必须是非空字符串');
    }
    if (cfg.passThreshold !== undefined) {
      if (typeof cfg.passThreshold !== 'number' || !Number.isFinite(cfg.passThreshold) || cfg.passThreshold < 0 || cfg.passThreshold > 1) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'llm_judge.passThreshold 必须是 [0,1] 内的数字');
      }
    }
  }

  async evaluate(facts: CaseFacts, config: Record<string, unknown>, judge?: JudgeFn): Promise<Verdict> {
    const cfg = config as unknown as LlmJudgeConfig;
    const threshold = cfg.passThreshold ?? 0.5;
    const prompt = renderTemplate(cfg.prompt, facts);

    if (!judge) {
      return {
        score: 0,
        passed: false,
        evidence: { reason: 'judge 调用面未注入（评测环境未提供 LLM 抽象）——绝不默认通过', prompt: truncate(prompt) },
      };
    }

    let raw: string;
    try {
      raw = await judge(prompt);
    } catch (err) {
      // 调用失败不重试、不猜测：明确记为未通过并把错误写入证据
      return {
        score: 0,
        passed: false,
        evidence: {
          judgeError: truncate((err as Error).message ?? String(err)),
          judgeModelId: cfg.judgeModelId ?? null,
          prompt: truncate(prompt),
        },
      };
    }

    const parsed = parseJudgeOutput(raw);
    if (!parsed.ok) {
      // 解析失败：绝不重试（重试会制造幻觉分数）
      return {
        score: 0,
        passed: false,
        evidence: {
          parseError: parsed.error,
          judgeModelId: cfg.judgeModelId ?? null,
          raw: truncate(raw),
          prompt: truncate(prompt),
        },
      };
    }

    const score = clampScore(parsed.score);
    return {
      score,
      passed: typeof parsed.passed === 'boolean' ? parsed.passed && score >= threshold : score >= threshold,
      evidence: {
        passThreshold: threshold,
        judgeModelId: cfg.judgeModelId ?? null,
        ...(parsed.reason !== undefined ? { reason: truncate(parsed.reason) } : {}),
        raw: truncate(raw),
      },
    };
  }
}

/** 模板渲染（确定性纯字符串替换；未提供的占位符替换为空串） */
export function renderTemplate(template: string, facts: Pick<CaseFacts, 'input' | 'expected' | 'outputText' | 'toolCalls'>): string {
  return template
    .split('{{input}}').join(stringify(facts.input ?? ''))
    .split('{{output}}').join(facts.outputText ?? '')
    .split('{{expected}}').join(stringify(facts.expected ?? ''))
    .split('{{toolCalls}}').join(stringify(facts.toolCalls ?? []));
}

type ParsedJudge =
  | { ok: true; score: number; passed?: boolean; reason?: string }
  | { ok: false; error: string };

/**
 * 解析 judge 输出（绝不"尽力猜"）：
 * 接受单层 JSON 对象（允许前后包裹自然语言——取首个平衡花括号段）：
 *   { "score": 0.8 }                        → 0.8
 *   { "score": 8, "maxScore": 10 }          → 0.8
 *   { "passed": true, "score": 1 }          → passed
 * 其余（无 JSON / 无 score / 非数字 / 越界 NaN）→ 解析失败。
 */
export function parseJudgeOutput(raw: string): ParsedJudge {
  const json = extractFirstJsonObject(raw);
  if (!json) return { ok: false, error: '未在 judge 输出中找到 JSON 对象' };
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'judge 输出的 JSON 不是对象' };
    }
    obj = parsed as Record<string, unknown>;
  } catch (err) {
    return { ok: false, error: `judge 输出 JSON 解析失败：${(err as Error).message}` };
  }
  const score = obj.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return { ok: false, error: 'judge 输出缺少有限数字 score 字段' };
  }
  let normalized = score;
  if (typeof obj.maxScore === 'number' && Number.isFinite(obj.maxScore) && obj.maxScore > 0) {
    normalized = score / obj.maxScore;
  }
  return {
    ok: true,
    score: normalized,
    ...(typeof obj.passed === 'boolean' ? { passed: obj.passed } : {}),
    ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}),
  };
}

/** 取首个平衡花括号段（字符串内的花括号按字面量处理；不做容错修复） */
function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}
