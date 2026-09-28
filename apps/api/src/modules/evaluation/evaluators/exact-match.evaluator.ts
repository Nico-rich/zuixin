import { AppError, ErrorCode } from '../../../common/errors/app-error';
import { CaseFacts, EvaluatorImpl, Verdict } from './types';
import { canonicalJson, getPath, stringify, truncate } from './util';

export interface ExactMatchConfig {
  /** 比对前是否 trim 两端空白（默认 true） */
  trim?: boolean;
  /** 是否区分大小写（默认 true） */
  caseSensitive?: boolean;
  /** equals = 完全相等；contains = expected 为 actual 的子串 */
  matchMode?: 'equals' | 'contains';
  /** 从 output JSON 中取值的点分路径（缺省比对整段输出文本） */
  path?: string;
}

/**
 * exact_match：确定性字符串比对（零 LLM 依赖）。
 * - 事实来源：case.expected vs caseRun.output（output 可解析为 JSON 时按 path 取值，否则整段文本）；
 * - expected 缺失（null/undefined）→ 不通过并在证据中说明（绝不猜测期望值）；
 * - contains 模式下 expected 为空串 = 恒真——配置校验已禁止空串。
 */
export class ExactMatchEvaluator implements EvaluatorImpl {
  readonly type = 'exact_match' as const;

  validate(config: Record<string, unknown>): void {
    const cfg = config as ExactMatchConfig;
    if (cfg.trim !== undefined && typeof cfg.trim !== 'boolean') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'exact_match.trim 必须是布尔值');
    }
    if (cfg.caseSensitive !== undefined && typeof cfg.caseSensitive !== 'boolean') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'exact_match.caseSensitive 必须是布尔值');
    }
    if (cfg.matchMode !== undefined && cfg.matchMode !== 'equals' && cfg.matchMode !== 'contains') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'exact_match.matchMode 只支持 equals/contains');
    }
    if (cfg.path !== undefined && (typeof cfg.path !== 'string' || cfg.path.length > 200)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'exact_match.path 必须是 ≤200 字符的字符串');
    }
  }

  async evaluate(facts: CaseFacts, config: Record<string, unknown>): Promise<Verdict> {
    const cfg = config as ExactMatchConfig;
    const trim = cfg.trim ?? true;
    const caseSensitive = cfg.caseSensitive ?? true;
    const matchMode = cfg.matchMode ?? 'equals';

    if (facts.expected === null || facts.expected === undefined) {
      return {
        score: 0,
        passed: false,
        evidence: { reason: 'case 未定义 expected，exact_match 无法比对', actual: truncate(stringify(facts.outputText)) },
      };
    }

    // 取值口径（三种，evidence.comparedAs 如实标注）：
    // - path：从输出 JSON 按点分路径取；
    // - expected 非字符串 且 输出可解析为 JSON：比**规范化 JSON**（消除空白/键序等无关差异——
    //   否则结构化 expected 只有在逐字节相同时才可能通过，等于形同虚设）；
    // - 其余：比整段输出文本。
    const comparedAs = cfg.path ? 'path' : (typeof facts.expected !== 'string' && facts.outputJson !== null && facts.outputJson !== undefined ? 'json' : 'text');
    const rawActual = cfg.path
      ? getPath(facts.outputJson, cfg.path)
      : comparedAs === 'json' ? facts.outputJson : facts.outputText;
    const encode = comparedAs === 'json' ? canonicalJson : stringify;
    const actualText = rawActual === undefined || rawActual === null ? '' : encode(rawActual);
    let expectedText = encode(facts.expected);
    let actual = actualText;
    if (trim) {
      expectedText = expectedText.trim();
      actual = actual.trim();
    }
    if (!caseSensitive) {
      expectedText = expectedText.toLowerCase();
      actual = actual.toLowerCase();
    }

    const passed = matchMode === 'equals' ? actual === expectedText : actual.includes(expectedText);
    return {
      score: passed ? 1 : 0,
      passed,
      evidence: {
        matchMode,
        caseSensitive,
        trim,
        comparedAs,
        ...(cfg.path ? { path: cfg.path } : {}),
        expected: truncate(stringify(facts.expected)),
        actual: truncate(rawActual === undefined || rawActual === null ? facts.outputText : stringify(rawActual)),
      },
    };
  }
}
