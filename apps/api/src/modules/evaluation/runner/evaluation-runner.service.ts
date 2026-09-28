import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AppError } from '../../../common/errors/app-error';
import { LLMManagerService, ResolvedLLM } from '../../../providers/llm/llm-manager.service';
import { ModelResolverService } from '../../../providers/llm/model-resolver.service';
import { ChatMessage, LLMChunk } from '../../../providers/llm/llm.types';
import { UsageService, computeCost } from '../../usage/usage.service';
import { evaluateFacts } from '../evaluators/evaluator-registry';
import { CaseFacts, JudgeFn, ToolCallFact } from '../evaluators/types';
import { tryParseJson } from '../evaluators/util';
import { EvaluationConfigSnapshot } from '../evaluation.types';

export interface RunnerOutcome {
  runId: string;
  claimed: boolean;
  status: string;
  completedCases: number;
  failedCases: number;
  results: number;
}

interface ResolvedTarget {
  llm: ResolvedLLM;
  inputPrice: number;
  outputPrice: number;
}

/** 单条评测用例的默认超时（毫秒；由 EVALUATION_CASE_TIMEOUT_MS 覆盖） */
const CASE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.EVALUATION_CASE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 120_000;
})();

/**
 * M9-P1 评测 runner（Worker 侧执行面）：
 *
 * 逐 case 执行：以 run.configSnapshot **锁定的参数**经既有 LLM 抽象（llm-manager / model-resolver
 * resolve + adapter.stream）跑输入 → 采集 output/latency/tokens/cost/toolCalls → 写 EvaluationCaseRun
 * （条件更新 + UNIQUE(runId,caseId) 幂等）→ 每个 case 跑完立刻跑绑定的 evaluators → 写 EvaluationResult
 * （UNIQUE(caseRunId,evaluatorId) 幂等）。
 *
 * 边界与不变量：
 * - **不执行任何工具**（评测绝不产生副作用：发布/外发/审批一律不触发）——只记录模型发出的调用（output=null）；
 * - 绝不写任何权限/quota/RBAC/provider/approval 状态（本类无此类依赖，结构上不可能越权）；
 * - judge 输出只进 EvaluationResult.score/.passed/.evidence；
 * - 中断即停：run 状态非 running（取消）或 signal.aborted → 停止后续 case（已完成的事实保留）。
 */
@Injectable()
export class EvaluationRunnerService {
  private readonly logger = new Logger('EvaluationRunner');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LLMManagerService) private readonly llmManager: LLMManagerService,
    @Inject(ModelResolverService) private readonly modelResolver: ModelResolverService,
    @Inject(UsageService) private readonly usage: UsageService,
  ) {}

  /** 执行一个评测 run（幂等：已 claim/已终态 → claimed=false 且不改任何行） */
  async executeRun(runId: string, signal?: AbortSignal): Promise<RunnerOutcome> {
    const run = await this.prisma.evaluationRun.findUnique({
      where: { id: runId },
      include: { caseRuns: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!run) return { runId, claimed: false, status: 'missing', completedCases: 0, failedCases: 0, results: 0 };

    // 条件 claim（pending → running）：并发/重复投递只有一个执行者胜出
    const claimed = await this.prisma.evaluationRun.updateMany({
      where: { id: runId, status: 'pending' },
      data: { status: 'running' },
    });
    if (claimed.count === 0) {
      return { runId, claimed: false, status: run.status, completedCases: 0, failedCases: 0, results: 0 };
    }

    const snapshot = run.configSnapshot as unknown as EvaluationConfigSnapshot;
    const [evaluators, caseRows] = await Promise.all([
      this.prisma.evaluator.findMany({
        where: { id: { in: snapshot.evaluatorIds ?? [] }, organizationId: run.organizationId },
        select: { id: true, name: true, type: true, config: true },
      }),
      // 锁定版本的 case 行（EvaluationCaseRun.caseId 无 FK：由 (datasetId,datasetVersion) 显式读取）
      this.prisma.evaluationCase.findMany({ where: { datasetId: run.datasetId, version: run.datasetVersion } }),
    ]);
    const caseById = new Map(caseRows.map((c) => [c.id, c]));

    // 目标解析（锁定参数）；失败 → 全部未完成 case 标记失败 + run failed（绝不静默"完成零结果"）
    let target: ResolvedTarget;
    try {
      target = await this.resolveTarget(snapshot.modelId);
    } catch (err) {
      const code = (err as AppError).code ?? 'INTERNAL';
      this.logger.error(`run ${runId} 目标模型解析失败：${(err as Error).message}`);
      await this.prisma.evaluationCaseRun.updateMany({
        where: { runId, status: { in: ['pending', 'running'] } },
        data: { status: 'failed', errorCode: code, completedAt: new Date() },
      });
      await this.prisma.evaluationRun.updateMany({
        where: { id: runId, status: 'running' },
        data: { status: 'failed', completedAt: new Date() },
      });
      return { runId, claimed: true, status: 'failed', completedCases: 0, failedCases: run.caseRuns.length, results: 0 };
    }

    const judgeCache = new Map<string, ResolvedTarget>();
    let completedCases = 0;
    let failedCases = 0;
    let resultCount = 0;

    for (const caseRun of run.caseRuns) {
      if (signal?.aborted) break;
      const fresh = await this.prisma.evaluationRun.findUnique({ where: { id: runId }, select: { status: true } });
      if (fresh?.status !== 'running') break; // 已取消/已被接管 → 停止后续 case（不写新事实）

      // case 级 claim（pending → running）；count=0 = 已被处理过 → 跳过（幂等）
      const caseClaim = await this.prisma.evaluationCaseRun.updateMany({
        where: { id: caseRun.id, runId, status: 'pending' },
        data: { status: 'running' },
      });
      if (caseClaim.count === 0) continue;

      const evaluationCase = caseById.get(caseRun.caseId) ?? null;
      const inputPayload = evaluationCase?.input ?? caseRun.input;
      const expected = evaluationCase?.expected ?? null;
      const outcome = await this.executeCase({
        runId,
        caseRunId: caseRun.id,
        organizationId: run.organizationId,
        userId: run.userId,
        snapshot,
        target,
        input: inputPayload,
        expected,
        signal,
      });
      if (outcome.status === 'completed') completedCases++;
      else failedCases++;

      // 评测器（仅对已完成 case 执行——无输出则无可评之事，绝不拿失败当 0 分）
      if (outcome.status === 'completed') {
        resultCount += await this.runEvaluators({
          caseRunId: caseRun.id,
          evaluators,
          facts: outcome.facts,
          judgeCache,
          signal,
        });
      }
      await this.prisma.evaluationRun.update({
        where: { id: runId },
        data: { completedCases: { increment: 1 } },
      });
    }

    // 终态（条件更新：已 cancelled/已 failed 的 run 绝不被改写）
    const remaining = await this.prisma.evaluationCaseRun.count({
      where: { runId, status: { in: ['pending', 'running'] } },
    });
    const totalResults = await this.prisma.evaluationResult.count({ where: { caseRun: { runId } } });
    // 仍有剩余 case = 本轮未跑完（停机 abortsignal / 中断）：run 回到 **pending**（可被重投续跑，
    // case 级 claim 保证续跑不重复执行），**绝不**把"跑了一半"记成 completed；
    // 无剩余才判终态：零结果 = failed（绝不把"零评测"冒充成功）。
    const status = remaining === 0 ? (totalResults === 0 ? 'failed' : 'completed') : 'pending';
    const applied = await this.prisma.evaluationRun.updateMany({
      where: { id: runId, status: 'running' },
      data: { status, ...(remaining === 0 ? { completedAt: new Date() } : {}) },
    });
    let finalStatus: string = status;
    if (applied.count === 0) {
      // 未命中 = run 已被取消/接管（终态已由他处裁决）——如实返回当前状态，绝不改写
      const current = await this.prisma.evaluationRun.findUnique({ where: { id: runId }, select: { status: true } });
      finalStatus = current?.status ?? 'unknown';
    }
    if (remaining > 0) {
      this.logger.warn(`评测 run 中断（run=${runId}，剩余 ${remaining} 个 case 未执行）→ 状态回到 pending 等待重投`);
    }
    return {
      runId,
      claimed: true,
      status: finalStatus,
      completedCases,
      failedCases,
      results: resultCount,
    };
  }

  /** 单 case 执行（含失败隔离：单 case 失败绝不终止 run） */
  private async executeCase(input: {
    runId: string;
    caseRunId: string;
    organizationId: string;
    userId: string;
    snapshot: EvaluationConfigSnapshot;
    target: ResolvedTarget;
    input: unknown;
    expected: unknown;
    signal?: AbortSignal;
  }): Promise<{ status: 'completed'; facts: CaseFacts } | { status: 'failed'; facts: null }> {
    const started = Date.now();
    const upstream = new AbortController();
    const onAbort = () => upstream.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => upstream.abort(), CASE_TIMEOUT_MS);
    let text = '';
    let toolCalls: ToolCallFact[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let errorCode: string | null = null;
    try {
      const messages: ChatMessage[] = [];
      if (input.snapshot.systemPrompt) messages.push({ role: 'system', content: input.snapshot.systemPrompt });
      messages.push({ role: 'user', content: buildUserContent(input.input) });
      const stream = input.target.llm.adapter.stream({
        model: input.target.llm.apiModelId,
        messages,
        temperature: input.snapshot.temperature,
        maxTokens: input.snapshot.maxTokens ?? undefined,
        // 不传 tools：评测绝不执行工具，也不诱导模型发出会被静默丢弃的调用
        signal: upstream.signal,
      });
      for await (const chunk of stream as AsyncIterable<LLMChunk>) {
        if (chunk.type === 'text') text += chunk.text;
        else if (chunk.type === 'tool_calls') {
          toolCalls = chunk.toolCalls.map((t) => ({ name: t.name, arguments: t.arguments, output: null }));
        } else if (chunk.type === 'usage') {
          promptTokens = chunk.usage.inputTokens;
          completionTokens = chunk.usage.outputTokens;
        }
      }
    } catch (err) {
      errorCode = (err as AppError).code ?? 'INTERNAL';
      this.logger.warn(`case 执行失败（run=${input.runId} caseRun=${input.caseRunId}）：${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
    const latencyMs = Date.now() - started;
    const cost = computeCost({
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      inputPrice: input.target.inputPrice,
      outputPrice: input.target.outputPrice,
    });

    if (errorCode) {
      await this.prisma.evaluationCaseRun.updateMany({
        where: { id: input.caseRunId, status: 'running' },
        data: { status: 'failed', errorCode, latencyMs, promptTokens, completionTokens, cost, completedAt: new Date() },
      });
      await this.recordUsage(input, input.target, promptTokens, completionTokens, latencyMs, 'failed', errorCode);
      return { status: 'failed', facts: null };
    }

    await this.prisma.evaluationCaseRun.updateMany({
      where: { id: input.caseRunId, status: 'running' },
      data: {
        status: 'completed',
        output: { text } as never,
        latencyMs,
        promptTokens,
        completionTokens,
        cost,
        toolCalls: (toolCalls.length > 0 ? toolCalls : null) as never,
        completedAt: new Date(),
      },
    });
    await this.recordUsage(input, input.target, promptTokens, completionTokens, latencyMs, 'success', null);
    return {
      status: 'completed',
      facts: {
        input: input.input,
        expected: input.expected,
        outputText: text,
        outputJson: tryParseJson(text),
        latencyMs,
        promptTokens,
        completionTokens,
        cost,
        toolCalls,
      },
    };
  }

  /** 逐评测器执行并落 EvaluationResult（唯一键幂等：重复执行只更新，绝不多行） */
  private async runEvaluators(input: {
    caseRunId: string;
    evaluators: Array<{ id: string; name: string; type: string; config: unknown }>;
    facts: CaseFacts;
    judgeCache: Map<string, ResolvedTarget>;
    signal?: AbortSignal;
  }): Promise<number> {
    let written = 0;
    for (const evaluator of input.evaluators) {
      const config = (evaluator.config ?? {}) as Record<string, unknown>;
      let score = 0;
      let passed = false;
      let evidence: Record<string, unknown>;
      try {
        const judge = evaluator.type === 'llm_judge'
          ? await this.buildJudge(typeof config.judgeModelId === 'string' ? config.judgeModelId : undefined, input.judgeCache, input.signal)
          : undefined;
        const verdict = await evaluateFacts(evaluator.type, input.facts, config, judge);
        score = verdict.score;
        passed = verdict.passed;
        evidence = verdict.evidence;
      } catch (err) {
        // 单评测器异常绝不破坏 run：写成未通过 + 错误证据（绝不默认通过）
        score = 0;
        passed = false;
        evidence = { evaluatorError: (err as Error).message, evaluatorType: evaluator.type };
      }
      const data = { score, passed, evidence: evidence as never };
      await this.prisma.evaluationResult.upsert({
        where: { caseRunId_evaluatorId: { caseRunId: input.caseRunId, evaluatorId: evaluator.id } },
        create: { caseRunId: input.caseRunId, evaluatorId: evaluator.id, ...data },
        update: data,
      });
      written++;
    }
    return written;
  }

  /**
   * judge 调用面（provider-independent）：评测器 config.judgeModelId 指定则解析该模型，
   * 否则走系统默认 LLM（model-resolver）。解析结果按 modelId 缓存（同一 run 内复用）。
   * 抛错/乱答由 LlmJudgeEvaluator 负责落证据——本方法不做任何重试。
   */
  private async buildJudge(
    judgeModelId: string | undefined,
    cache: Map<string, ResolvedTarget>,
    signal?: AbortSignal,
  ): Promise<JudgeFn> {
    const key = judgeModelId ?? '__default__';
    let target = cache.get(key);
    if (!target) {
      target = await this.resolveTarget(judgeModelId ?? null);
      cache.set(key, target);
    }
    const resolved = target;
    return async (prompt: string) => {
      const res = await resolved.llm.adapter.chat({
        model: resolved.llm.apiModelId,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        maxTokens: 512,
        signal,
      });
      return res.content ?? '';
    };
  }

  /** 锁定参数下的目标解析（modelId 缺省 → 系统默认 LLM；价格取模型目录，与 usage 同源） */
  private async resolveTarget(modelId: string | null): Promise<ResolvedTarget> {
    const llm = modelId ? await this.llmManager.resolve(modelId) : await this.modelResolver.resolveDefaultLLM();
    const model = await this.prisma.model.findUnique({
      where: { id: llm.modelId },
      select: { inputPrice: true, outputPrice: true },
    });
    return { llm, inputPrice: model?.inputPrice ?? 0, outputPrice: model?.outputPrice ?? 0 };
  }

  /** 用量事实落库（既有唯一计价点；best-effort——账务抖动绝不使评测 run 失败） */
  private async recordUsage(
    input: { runId: string; organizationId: string; userId: string },
    target: ResolvedTarget,
    promptTokens: number,
    completionTokens: number,
    latencyMs: number,
    status: 'success' | 'failed',
    errorCode: string | null,
  ): Promise<void> {
    await this.usage.recordChatUsage({
      userId: input.userId,
      organizationId: input.organizationId,
      // 无会话消息归属（评测不是聊天）→ 不传 messageId；也绝不传 runId（那是 AgentRun 的归因列，
      // 传评测 run id 会被账务/归因链误读为 AgentRun 事实）
      providerId: target.llm.providerId,
      modelId: target.llm.modelId,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      latencyMs,
      status,
      ...(errorCode ? { errorCode } : {}),
    }).catch((err: Error) => {
      this.logger.warn(`评测用量记录失败（best-effort，run=${input.runId}）：${err.message}`);
    });
  }
}

/** case.input 归一为待评测的用户消息（string | {message} | 其它 → 稳定 JSON 文本） */
export function buildUserContent(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && typeof (input as { message?: unknown }).message === 'string') {
    return (input as { message: string }).message;
  }
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return String(input);
  }
}
