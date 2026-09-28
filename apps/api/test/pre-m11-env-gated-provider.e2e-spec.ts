import { describe, it, expect } from 'vitest';
import { AppError } from '@ai-agent/shared';
import { OpenAICompatibleAdapter } from '../src/providers/llm/adapters/openai-compatible.adapter';
import { ChatParams, LLMChunk } from '../src/providers/llm/llm.types';

// M11-P4 并行 worktree 铁律：e2e 必须显式指定独立 Redis DB。本文件不连 Redis/DB
// （直连真实厂商的 openai-compatible 适配器 —— 生产代码路径：OpenAI SDK + manualRedirectFetch + StreamGuard），
// 该赋值只为杜绝任何隐含连接落到共享 DB0。
process.env.REDIS_URL = 'redis://localhost:6379/24';

/**
 * M11-P4 / NV-01：**可选凭据门控**的真实厂商端到端骨架。
 *
 * 诚实边界（绝不伪造）：
 * - 本文件**只在**配置了真实凭据时执行；未配置 → 整个套件 `describe.skip`（套件报告为 skipped，
 *   绝不是"通过"）——真实厂商端到端= **NOT VERIFIED**，不写任何"已验证真实厂商"的结论；
 * - 有凭据时打的是**真实网络**：真实 baseUrl + 真实 key + 真实模型（默认取 REAL_LLM_MODEL），
 *   断言的是平台客户端在真实厂商下的行为（HTTP 2xx 语义 / 流式形状 / 4xx 错误归一），
 *   不做任何替身注入（假服务器契约由 test/pre-m10-provider-contract.e2e-spec.ts 覆盖）；
 * - 凭据只从 env 读，**绝不入库/不落日志**；未配置时本文件不发起任何请求。
 *
 * 启用方式（本机有 key 时）：
 *   REAL_LLM_API_KEY=sk-xxx REAL_LLM_BASE_URL=https://api.deepseek.com/v1 REAL_LLM_MODEL=deepseek-chat \
 *     REDIS_URL=redis://localhost:6379/24 pnpm --filter api test pre-m11-env-gated-provider
 * 可选：REAL_LLM_TIMEOUT_MS（默认 30s）、REAL_LLM_MAX_TOKENS（默认 32）。
 */

const REAL_API_KEY = (process.env.REAL_LLM_API_KEY ?? '').trim();
const REAL_BASE_URL = (process.env.REAL_LLM_BASE_URL ?? '').trim();
const REAL_MODEL = (process.env.REAL_LLM_MODEL ?? '').trim();
const REAL_TIMEOUT_MS = Number(process.env.REAL_LLM_TIMEOUT_MS) > 0 ? Math.trunc(Number(process.env.REAL_LLM_TIMEOUT_MS)) : 30_000;
const REAL_MAX_TOKENS = Number(process.env.REAL_LLM_MAX_TOKENS) > 0 ? Math.trunc(Number(process.env.REAL_LLM_MAX_TOKENS)) : 32;

/** 门控判定：key 与 baseUrl 同时存在才算"有凭据"（缺一不可，绝不拿半个凭据去猜） */
const REAL_LLM_ENABLED = REAL_API_KEY.length > 0 && REAL_BASE_URL.length > 0;
/** 有凭据但未给模型名 → 明确的占位模型（让厂商侧的真实 4xx 说话，绝不静默换模型） */
const REAL_MODEL_OR_FALLBACK = REAL_MODEL || 'gpt-4o-mini';

if (!REAL_LLM_ENABLED) {
  // 显式可见的跳过原因（不是静默通过）：真实厂商端到端 = NOT VERIFIED
  console.warn(
    '[pre-m11-env-gated-provider] REAL_LLM_API_KEY / REAL_LLM_BASE_URL 未配置 → 真实厂商端到端（NV-01）显式 skip；'
    + '真实厂商行为仍为 NOT VERIFIED（绝不伪造 provider 响应）。',
  );
}

/** 有凭据 → describe；无凭据 → describe.skip（同一套用例，绝无"门控内空跑"） */
const suite = REAL_LLM_ENABLED ? describe : describe.skip;

function adapter(): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({ baseUrl: REAL_BASE_URL, apiKey: REAL_API_KEY, timeoutMs: REAL_TIMEOUT_MS });
}

function params(model: string, signal?: AbortSignal): ChatParams {
  return {
    model,
    messages: [
      { role: 'system', content: '你是测试助手，回答必须简短。' },
      { role: 'user', content: '请只回复两个字：你好' },
    ],
    temperature: 0,
    maxTokens: REAL_MAX_TOKENS,
    signal,
  };
}

suite('M11-P4/NV-01 真实厂商端到端（env 门控：无凭据则整套 skip，绝不伪造）', () => {
  it('非流式 chat()：真实厂商 2xx 语义（内容非空；provider 报告 usage 时 token > 0）', async () => {
    const res = await adapter().chat(params(REAL_MODEL_OR_FALLBACK));
    expect(typeof res.content).toBe('string');
    expect(res.content.trim().length).toBeGreaterThan(0); // 2xx 且有真实回答（非 2xx 会被 mapSdkError 归一为 AppError 抛出）
    if (res.usage) {
      // provider 权威用量：报告了就必须是正数（平台绝不本地估算——usage 缺失时是 undefined，不是 0）
      expect(res.usage.inputTokens).toBeGreaterThan(0);
      expect(res.usage.outputTokens).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);

  it('流式 stream()：真实增量形状（>=1 个 text 块、内容与拼接一致、流自然结束）', async () => {
    const chunks: LLMChunk[] = [];
    for await (const c of adapter().stream(params(REAL_MODEL_OR_FALLBACK))) chunks.push(c);
    const text = chunks.filter((c): c is { type: 'text'; text: string } => c.type === 'text');
    expect(text.length).toBeGreaterThan(0); // 真实流式：至少一个增量块
    expect(text.map((c) => c.text).join('').trim().length).toBeGreaterThan(0);
    // usage 块（stream_options.include_usage）可能在流末出现；出现即必须是正数（绝不伪造 0）
    const usage = chunks.find((c): c is { type: 'usage'; usage: { inputTokens: number; outputTokens: number } } => c.type === 'usage');
    if (usage) expect(usage.usage.inputTokens).toBeGreaterThan(0);
    // 流必须自然结束（能走到这里即已结束；StreamGuard 的截断保护会把"静默截断"归一为 PROVIDER_TIMEOUT 抛出，
    // 即：真实厂商若在 [DONE] 前断流，本用例会以 AppError 失败而不是悄悄"通过"）
  }, 60_000);

  it('真实厂商拒答（未知模型 → 4xx）→ 归一为平台 AppError，绝不吞成"空回答成功"', async () => {
    const notFoundModel = '__m11-nonexistent-model__';
    let caught: unknown = null;
    try {
      await adapter().chat(params(notFoundModel));
    } catch (err) {
      caught = err;
    }
    // 真实厂商对未知模型一律报错；平台客户端必须把它变成 AppError（可归因/可重试判定），
    // 而不是返回 { content: '' } 让上层误以为生成成功。
    expect(caught).toBeInstanceOf(AppError);
  }, 60_000);
});
