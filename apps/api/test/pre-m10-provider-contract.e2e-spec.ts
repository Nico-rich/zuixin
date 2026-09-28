import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { AppError, RETRYABLE_CODES } from '@ai-agent/shared';
import { startFakeOpenAIServer, FakeOpenAIServer } from '../scripts/fake-openai-server';
import { OpenAICompatibleAdapter } from '../src/providers/llm/adapters/openai-compatible.adapter';
import { ChatParams, LLMChunk } from '../src/providers/llm/llm.types';
import { assertProviderBaseUrlSafe, manualRedirectFetch } from '../src/modules/security/provider-base-url.guard';
import { DnsResolver } from '../src/modules/security/ssrf-guard';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { ObservabilityService } from '../src/core/tracing/observability.service';
import { LLMManagerService } from '../src/providers/llm/llm-manager.service';
import { ImageManagerService } from '../src/providers/image/image-manager.service';
import { VideoManagerService } from '../src/providers/video/video-manager.service';

// M10-P2：并行 worktree 铁律——e2e 使用**本 Agent 专属 Redis DB（22）**，绝不污染 DB0。
// （协调者已把共享 Redis 的 databases 从 16 扩到 64，DB22 现已有效；本文件不实际连 Redis，
//  该赋值只为满足"e2e 必须指定 DB22"的铁律，避免任何隐含连接落到 DB0。）
process.env.REDIS_URL = 'redis://localhost:6379/22';

/**
 * M10-P2 **Provider HTTP Contract 验证层**（e2e，真实 TCP/HTTP/SSE + 真实代码路径）。
 *
 * 与本仓库既有 provider 测试的区别（诚实口径）：
 * - mock adapter 测试（pre-m9-provider-fault 等）验证的是**平台自己的替身**；
 * - 本文件让 **openai-compatible adapter（生产代码路径：OpenAI SDK + manualRedirectFetch +
 *   StreamGuard）直连本地假服务器**走真实网络：流式分块/done/usage、四层超时、429/5xx/4xx 映射、
 *   3xx 不被跟随、SSRF 逐跳校验、以及 provider 启动配置校验（D12）。
 * - **真实厂商行为（DeepSeek/Kimi/百炼/方舟/智谱/OpenAI）仍为 NOT VERIFIED**：假服务器只证明
 *   平台客户端在"符合 OpenAI 形态 + 注入故障"的服务端下的行为，不证明任何厂商的真实响应细节。
 *
 * 假服务器零新依赖（node:http），场景由 model 前缀 `scenario:<name>` 控制（每次请求可不同）。
 */

const SK = 'sk-contract-test';
const TIMEOUT_ENVS = [
  'LLM_STREAM_CONNECT_TIMEOUT_MS', 'LLM_STREAM_FIRST_BYTE_TIMEOUT_MS',
  'LLM_STREAM_IDLE_TIMEOUT_MS', 'LLM_STREAM_TOTAL_TIMEOUT_MS',
] as const;

const REPLY = '你好，我是本地假服务器。'; // 12 个字（分块断言用）

/** 平台侧 DNS 解析替身：公网地址（不依赖真实 DNS；与 provider-base-url.guard.spec 同法） */
const publicResolver: DnsResolver = async () => ['93.184.216.34'];

let server: FakeOpenAIServer;
let internalTarget: FakeOpenAIServer;
let prisma: PrismaService;

function adapter(cfg: { timeoutMs?: number } = {}): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({ baseUrl: server.url, apiKey: SK, timeoutMs: cfg.timeoutMs ?? 5_000 });
}

function params(model: string, extra: Partial<ChatParams> = {}): ChatParams {
  return { model, messages: [{ role: 'user', content: '你好' }], ...extra };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 收集流式块（断言全部产出） */
async function collect(stream: AsyncIterable<LLMChunk>): Promise<LLMChunk[]> {
  const out: LLMChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

/** 断言"抛出 AppError"并返回错误对象（无错 / 非 AppError → 测试自身失败） */
async function caught(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return err;
  }
  throw new Error('期望抛错，但调用成功');
}

/**
 * **同 provider 重试**（平台口径复刻，真实 HTTP 驱动）。
 * 与 agent-runtime-engine.ts 的回合内 attempt 循环同源：
 *   ① 仅 `RETRYABLE_CODES`（shared，唯一事实源）可重试；
 *   ② 总尝试次数 = 1 + LLM_MAX_RETRIES(=2)；
 *   ③ 退避 = `LLM_RETRY_BACKOFF_MS` 序列（引擎同款 env）。
 * 诚实边界：重试**驱动者**是 Agent 引擎——本文件不复制引擎内部循环（避免"测测试自己"），
 * 只验证契约面：可重试性判定、服务端观察到的真实尝试次数、重试后的恢复路径。引擎内的真实循环
 * 由 pre-m9-provider-fault.e2e-spec（mock provider 注入故障）与 agent-runtime-engine.spec 覆盖。
 */
const LLM_MAX_RETRIES = 2;
async function streamWithRetryLikeEngine(model: string, backoffMs: number[]): Promise<{ attempts: number; error: AppError }> {
  let attempts = 0;
  for (let attempt = 0; ; attempt++) {
    attempts += 1;
    const err = await caught(async () => collect(adapter().stream(params(model))));
    if (!RETRYABLE_CODES.has(err.code) || attempt >= LLM_MAX_RETRIES) return { attempts, error: err };
    await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)]);
  }
}

describe('M10-P2 Provider HTTP Contract（真实 HTTP/SSE：假服务器 × openai-compatible adapter）', () => {
  beforeAll(async () => {
    server = await startFakeOpenAIServer({ scenario: 'ok', replyText: REPLY, chunkIntervalMs: 40 });
    internalTarget = await startFakeOpenAIServer({ scenario: 'ok' });
    prisma = new PrismaService();
  });

  afterAll(async () => {
    // 只清本文件构造的行（labels.providerId 精确匹配）——共享开发库里不误删其他套件/Agent 的样本
    await prisma.metricSample.deleteMany({
      where: { name: 'provider_degraded', labels: { path: ['providerId'], equals: 'p-llm-bad' } } as never,
    }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await server.close();
    await internalTarget.close();
  });

  afterEach(() => {
    for (const name of TIMEOUT_ENVS) delete process.env[name];
  });

  // ─────────────────────────── A. 非流式（真实 HTTP 往返） ───────────────────────────

  describe('A. 非流式 chat：请求/响应契约', () => {
    it('200 → content + usage 映射（prompt/completion_tokens → input/outputTokens）', async () => {
      const r = await adapter().chat(params('scenario:ok'));
      expect(r.content).toBe(REPLY);
      expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 9 });
      expect(r.toolCalls).toBeUndefined();
    });

    it('请求契约：POST /v1/chat/completions、stream=false、Bearer apiKey、messages 原样', async () => {
      await adapter().chat(params('scenario:ok'));
      const last = server.requests.at(-1)!;
      expect(last.method).toBe('POST');
      expect(last.url).toBe('/v1/chat/completions');
      expect(last.hasAuthorization).toBe(true);
      expect(last.body).toMatchObject({ model: 'scenario:ok', stream: false, messages: [{ role: 'user', content: '你好' }] });
    });

    it.each([
      ['429', 'PROVIDER_RATE_LIMITED', true],
      ['500', 'PROVIDER_OVERLOADED', true],
      ['503', 'PROVIDER_OVERLOADED', true],
      ['401', 'PROVIDER_AUTH', false],
      ['400', 'PROVIDER_BAD_REQUEST', false],
    ] as const)('%s → %s（retryable=%s）', async (status, code, retryable) => {
      const err = await caught(() => adapter().chat(params(`scenario:${status}`)));
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(retryable);
    });

    it('连接后 stall（不响应头）→ SDK 超时 → PROVIDER_TIMEOUT 可重试（M10-P2 修复：原为不可重试的 PROVIDER_UNKNOWN）', async () => {
      const started = Date.now();
      const err = await caught(() => adapter({ timeoutMs: 700 }).chat(params('scenario:stall')));
      expect(err.code).toBe('PROVIDER_TIMEOUT');
      expect(err.retryable).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000); // 绝不无限期挂着
    });

    it('非法 JSON 响应体 → PROVIDER_UNKNOWN（明确归类：不崩溃、不伪造成功）', async () => {
      const err = await caught(() => adapter().chat(params('scenario:bad-json')));
      expect(err.code).toBe('PROVIDER_UNKNOWN');
    });
  });

  // ─────────────────────────── B. 流式（SSE 分块 / done / usage） ───────────────────────────

  describe('B. 流式 SSE：分块、done、usage 块', () => {
    it('文本块逐块产出（拼接 = 服务端回复）并以 [DONE] 正常结束；请求体带 stream=true + include_usage', async () => {
      const chunks = await collect(adapter().stream(params('scenario:ok')));
      const text = chunks.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('');
      expect(text).toBe(REPLY);
      expect(chunks.filter((c) => c.type === 'text')).toHaveLength(REPLY.length); // 逐字符分块（真实 SSE 帧）
      expect(server.requests.at(-1)!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    });

    it('usage 块（流末 chunk 携带 usage）→ 归一为内部 usage（provider 权威数字）', async () => {
      const chunks = await collect(adapter().stream(params('scenario:ok')));
      expect(chunks.at(-1)).toEqual({ type: 'usage', usage: { inputTokens: 5, outputTokens: 9 } });
    });

    it('服务端不发 usage 块 → 平台绝不伪造用量（无 usage 产出）', async () => {
      const chunks = await collect(adapter().stream(params('scenario:no-usage')));
      expect(chunks.some((c) => c.type === 'usage')).toBe(false);
      expect(chunks.filter((c) => c.type === 'text').length).toBeGreaterThan(0);
    });

    it('tool_calls delta 跨块聚合（id/name/arguments 分片）→ 一次产出完整 tool_calls 块', async () => {
      const chunks = await collect(adapter().stream(params('scenario:tool-calls')));
      const tool = chunks.find((c) => c.type === 'tool_calls') as { toolCalls: Array<{ id: string; name: string; arguments: string }> } | undefined;
      expect(tool?.toolCalls).toEqual([{ id: 'call_fake_1', name: 'image.generate', arguments: '{"prompt":"海报"}' }]);
      expect(chunks.at(-1)).toEqual({ type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } });
    });

    // M10-P2 取证（e2e 实测 + SDK 源码）：openai@4 的 Stream 收到 `data: [DONE]` 只是 `continue`，
    // **不会**结束迭代——真正的终止条件是「响应体结束（FIN）」。因此 provider 若在 [DONE] 后保持连接
    // （keep-alive 不回 FIN），平台不会自行收敛，只能由 **idle 层**兜底判超时：绝不永久挂住，代价是该次
    // 生成被判 PROVIDER_TIMEOUT（可重试）且**丢失本次已收到的 usage**（usage 在流末 yield）。
    // 真实厂商是否在 [DONE] 后关闭连接 = NOT VERIFIED（六家均未在本地验证）；本用例锁定的平台行为是
    // "不挂死 + 明确报错"，不是"厂商一定关连接"。
    it('[DONE] 后不回 FIN（keep-alive）→ SDK 不收敛，idle 层兜底判 PROVIDER_TIMEOUT：绝不挂死（文本块已可见，usage 丢失）', async () => {
      process.env.LLM_STREAM_IDLE_TIMEOUT_MS = '600';
      const started = Date.now();
      const chunks: LLMChunk[] = [];
      const err = await caught(async () => {
        for await (const c of adapter({ timeoutMs: 30_000 }).stream(params('scenario:hang-after-done'))) chunks.push(c);
      });
      const elapsed = Date.now() - started;
      expect(chunks.filter((c) => c.type === 'text')).toHaveLength(REPLY.length); // 文本已逐块可见
      expect(chunks.some((c) => c.type === 'usage')).toBe(false);                 // 诚实记录：超时路径丢掉 usage
      expect(err.code).toBe('PROVIDER_TIMEOUT');
      expect(elapsed).toBeGreaterThanOrEqual(560);
      expect(elapsed).toBeLessThan(5_000);
    });

    it('流式 429（错误在响应头阶段）→ PROVIDER_RATE_LIMITED 可重试', async () => {
      const err = await caught(async () => collect(adapter().stream(params('scenario:429'))));
      expect(err.code).toBe('PROVIDER_RATE_LIMITED');
      expect(err.retryable).toBe(true);
    });

    it('损坏的 SSE 帧（非法 JSON 行）→ 明确归类（PROVIDER_UNKNOWN），不静默丢块', async () => {
      const err = await caught(async () => collect(adapter().stream(params('scenario:bad-sse'))));
      expect(err.code).toBe('PROVIDER_UNKNOWN');
    });
  });

  // ─────────────────────────── C. 四层超时（与 StreamGuard 对齐） ───────────────────────────

  describe('C. 流式四层超时（connect / firstByte / idle / total）', () => {
    it('connect：服务端不发响应头 → 连接层超时 → PROVIDER_TIMEOUT（真实计时下界生效，远早于 provider.timeoutMs）', async () => {
      process.env.LLM_STREAM_CONNECT_TIMEOUT_MS = '300';
      const started = Date.now();
      const err = await caught(async () => collect(adapter({ timeoutMs: 10_000 }).stream(params('scenario:stall'))));
      const elapsed = Date.now() - started;
      expect(err.code).toBe('PROVIDER_TIMEOUT');
      expect(err.retryable).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(280);
      expect(elapsed).toBeLessThan(3_000);
    });

    it('firstByte：已发响应头但无数据块 → 首包层/连接层兜底 → PROVIDER_TIMEOUT（绝不挂到无限期）', async () => {
      // M10-P2 取证（e2e 实测 + SDK 源码）：openai@4 在**首个数据块到达前不 resolve 流对象**
      // （defaultParseResponse 在拿到 fetch response 后建流，但 create() 承诺实测 3s 仍未 resolve ⇒
      //  本场景由 **connect 层**拦下）。firstByte 层对"先 resolve 再静默"的流仍有效（单测覆盖该层）。
      process.env.LLM_STREAM_CONNECT_TIMEOUT_MS = '300';
      process.env.LLM_STREAM_FIRST_BYTE_TIMEOUT_MS = '300';
      const before = server.openResponses();
      const started = Date.now();
      const err = await caught(async () => collect(adapter({ timeoutMs: 30_000 }).stream(params('scenario:first-byte-stall'))));
      const elapsed = Date.now() - started;
      expect(err.code).toBe('PROVIDER_TIMEOUT');
      expect(err.retryable).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(280);
      expect(elapsed).toBeLessThan(5_000);
      // 在途请求被中断（服务端观察到断连）
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && server.openResponses() > before) await sleep(50);
      expect(server.openResponses()).toBe(before);
    });

    it('idle：发块后静默 → 空闲层超时 → PROVIDER_TIMEOUT，且底层请求被中断（服务端在途响应释放）', async () => {
      process.env.LLM_STREAM_IDLE_TIMEOUT_MS = '300';
      const before = server.openResponses();
      const err = await caught(async () => collect(adapter({ timeoutMs: 30_000 }).stream(params('scenario:stall-mid-stream'))));
      expect(err.code).toBe('PROVIDER_TIMEOUT');
      expect(err.retryable).toBe(true);
      // 中断语义：guard.abort() 真中断在途请求（服务端观察到断连）——绝不把连接挂在服务端
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && server.openResponses() > before) await sleep(50);
      expect(server.openResponses()).toBe(before);
      // 注：层超时与 SDK abort 在同一 tick 竞争 Promise.race，层特定文案可能被覆盖；
      // **契约保证是错误码与可重试性**（见 adapter 注释），故此处不断言文案。
    });

    it('total：慢流超过绝对总时长上限 → PROVIDER_TIMEOUT（AbortSignal.timeout 中止 ⇒ SDK 静默结束 ⇒ 适配器显式归一）', async () => {
      process.env.LLM_STREAM_TOTAL_TIMEOUT_MS = '400';
      const started = Date.now();
      const err = await caught(async () => collect(adapter({ timeoutMs: 30_000 }).stream(params('scenario:slow-stream'))));
      expect(err.code).toBe('PROVIDER_TIMEOUT');
      expect(err.retryable).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it('外部 deadline 信号（回合取消/超时）→ 立即中断并归一 PROVIDER_TIMEOUT（信号直达 SDK；SDK 静默结束也必须报错）', async () => {
      const external = new AbortController();
      const started = Date.now();
      const pending = caught(async () => collect(adapter({ timeoutMs: 30_000 }).stream(params('scenario:slow-stream', { signal: external.signal }))));
      await sleep(120);
      external.abort();
      const err = await pending;
      expect(err.code).toBe('PROVIDER_TIMEOUT');
      expect(err.retryable).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000); // 取消立即生效，不等层超时
    });
  });

  // ─────────────────────────── D. 重试（可重试 vs 不可重试） ───────────────────────────

  describe('D. 重试语义：429/5xx 可重试、400/401 不重试、尝试次数有上界', () => {
    it('429 后重试 → 服务端恰好观察到 2 次真实请求且第 2 次成功（恢复路径）', async () => {
      const before = server.chatCompletions;
      const first = await caught(() => adapter().chat(params('scenario:429')));
      expect(first.code).toBe('PROVIDER_RATE_LIMITED');
      expect(RETRYABLE_CODES.has(first.code)).toBe(true); // 引擎据此进入重试
      const ok = await adapter().chat(params('scenario:ok')); // 重试（引擎驱动；此处验证第 2 次真实请求成功）
      expect(ok.content).toBe(REPLY);
      expect(server.chatCompletions - before).toBe(2);
    });

    it('流式 429 连续失败 → 尝试次数 = 1 + LLM_MAX_RETRIES(2) 后放弃（绝不无限重试），退避真实发生', async () => {
      const before = server.chatCompletions;
      const started = Date.now();
      const outcome = await streamWithRetryLikeEngine('scenario:429', [150, 250]);
      expect(outcome.attempts).toBe(3);
      expect(outcome.error.code).toBe('PROVIDER_RATE_LIMITED');
      expect(server.chatCompletions - before).toBe(3); // 服务端计数 = 客户端尝试数（无隐藏重试）
      expect(Date.now() - started).toBeGreaterThanOrEqual(350); // 150 + 250 退避真实等待
    }, 20_000);

    it('不可重试（400 / 401）→ 只尝试 1 次，绝不重试', async () => {
      const before400 = server.chatCompletions;
      const e400 = await streamWithRetryLikeEngine('scenario:400', [1, 2]);
      expect(e400.attempts).toBe(1);
      expect(e400.error.code).toBe('PROVIDER_BAD_REQUEST');
      expect(RETRYABLE_CODES.has(e400.error.code)).toBe(false);
      expect(server.chatCompletions - before400).toBe(1);

      const before401 = server.chatCompletions;
      const e401 = await streamWithRetryLikeEngine('scenario:401', [1, 2]);
      expect(e401.attempts).toBe(1);
      expect(e401.error.code).toBe('PROVIDER_AUTH');
      expect(server.chatCompletions - before401).toBe(1);
    });

    it('5xx（过载）→ 可重试 → 重试成功（服务端只多一次真实请求）', async () => {
      const before = server.chatCompletions;
      const err = await caught(() => adapter().chat(params('scenario:500')));
      expect(err.code).toBe('PROVIDER_OVERLOADED');
      expect(RETRYABLE_CODES.has(err.code)).toBe(true);
      const ok = await adapter().chat(params('scenario:ok'));
      expect(ok.content).toBe(REPLY);
      expect(server.chatCompletions - before).toBe(2);
    });
  });

  // ─────────────────────────── E. 3xx 与 SSRF 逐跳校验（manualRedirectFetch） ───────────────────────────

  describe('E. manualRedirectFetch：3xx 不被跟随 + 逐跳校验（SSRF 判定）', () => {
    it('302 → 内网目标：适配器不自动跟随（目标零请求），逐跳校验对 Location 判定 SSRF_BLOCKED', async () => {
      const internalLocation = `http://127.0.0.1:${internalTarget.port}/v1/redirect-target`;
      server.setScenario('redirect');
      try {
        // 注：3xx 无对应 provider 语义 → 归 PROVIDER_UNKNOWN（**绝不是**裸 500/INTERNAL，也不跟随）
        const err = await caught(() => adapter().chat(params('plain-model')));
        expect(err.code).toBe('PROVIDER_UNKNOWN');
        // ① 3xx 绝不被跟随（manualRedirectFetch 强制 redirect: 'manual'）
        expect(internalTarget.redirectHits()).toBe(0);
        expect(internalTarget.chatCompletions).toBe(0);
        // ② 若有人拿 Location 继续请求，必须被 provider baseUrl 校验拦下（fail-closed）
        await expect(assertProviderBaseUrlSafe({
          providerId: 'p-redirect', adapter: 'openai-compatible', baseUrl: internalLocation, allowHttp: true,
        })).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
      } finally {
        server.setScenario('ok');
      }
    });

    it('302 → 白名单 http 目标：按既有策略放行（显式 allowHttp + 解析地址非私网），但适配器仍不跟随', async () => {
      const publicHttpTarget = 'http://inference.corp.example.com/v1';
      await expect(assertProviderBaseUrlSafe({
        providerId: 'p-http-ok', adapter: 'openai-compatible', baseUrl: publicHttpTarget,
        allowHttp: true, resolver: publicResolver,
      })).resolves.toBeTruthy();
      // 未显式放行 http → 协议层拒绝
      await expect(assertProviderBaseUrlSafe({
        providerId: 'p-http-no', adapter: 'openai-compatible', baseUrl: publicHttpTarget,
        allowHttp: false, resolver: publicResolver,
      })).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
      // 公网域名解析到私网 → 拒绝（每次调用前重解析，压缩 TOCTOU 窗口）
      await expect(assertProviderBaseUrlSafe({
        providerId: 'p-http-private', adapter: 'openai-compatible', baseUrl: publicHttpTarget,
        allowHttp: true, resolver: async () => ['10.0.0.5'],
      })).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });

      const hitsBefore = server.redirectHits();
      const before = server.chatCompletions;
      server.setScenario('redirect');
      try {
        await caught(() => adapter().chat(params('plain-model')));
        expect(server.chatCompletions - before).toBe(1); // 只打了 provider 一次：没有第二跳
        expect(server.redirectHits()).toBe(hitsBefore);  // 重定向目标零命中
        expect(internalTarget.chatCompletions).toBe(0);
      } finally {
        server.setScenario('ok');
      }
    });

    it('manualRedirectFetch 可用（真实 fetch：POST 到假服务器正常往返）', async () => {
      const res = await manualRedirectFetch(`${server.url}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'scenario:ok' }),
      });
      expect(res.status).toBe(200);
      expect((await res.json() as { object?: string }).object).toBe('chat.completion');
    });
  });

  // ─────────────────────────── F. D12：启动配置校验 → degraded（不阻断启动） ───────────────────────────

  describe('F. D12 provider 启动配置校验（buildAdapter 失败 = degraded，不阻断启动）', () => {
    const ADAPTERS: Record<string, string> = { llm: 'mock', image: 'mock-image', video: 'mock-video' };
    const BAD_ADAPTER = 'not-a-real-adapter';
    const okRow = (type: string) => ({
      id: `p-${type}-ok`, name: `OK-${type}`, type, adapter: ADAPTERS[type], baseUrl: '',
      apiKeyEncrypted: '', timeoutMs: 1000, enabled: true,
    });
    const badRow = (type: string) => ({
      id: `p-${type}-bad`, name: `BAD-${type}`, type, adapter: BAD_ADAPTER, baseUrl: 'https://api.example.com/v1',
      apiKeyEncrypted: '', timeoutMs: 1000, enabled: true,
    });

    function prismaStub(type: string) {
      return {
        provider: { findMany: async () => [okRow(type), badRow(type)] },
        model: {
          findUnique: async () => ({
            id: `m-${type}-bad`, providerId: `p-${type}-bad`, apiModelId: 'x', enabled: true, capabilities: {},
            provider: {
              id: `p-${type}-bad`, name: `BAD-${type}`, enabled: true, adapter: BAD_ADAPTER,
              baseUrl: 'https://api.example.com/v1', timeoutMs: 1000,
            },
          }),
        },
      };
    }
    const cryptoStub = { decrypt: () => 'k' } as never;

    let metrics: ObservabilityService;
    beforeAll(() => { metrics = new ObservabilityService(prisma); });

    it('LLM manager：坏配置只让该 provider degraded（健康 provider 照常加载），调用期 PROVIDER_CONFIG_INVALID + 真实原因', async () => {
      const svc = new LLMManagerService(prismaStub('llm') as never, cryptoStub, publicResolver, metrics);
      await expect(svc.refresh()).resolves.toBeUndefined(); // 不阻断启动：绝不 throw
      expect(svc.getProvider('p-llm-ok')).toBeTruthy();

      const err = await caught(() => svc.resolve('m-llm-bad'));
      expect(err.code).toBe('PROVIDER_CONFIG_INVALID');
      expect(err.retryable).toBe(false);          // 配置问题重试无意义（绝不进重试/回退链）
      expect(err.message).toContain(BAD_ADAPTER); // 真实原因对外可见（可运维定位）
    });

    it('provider_degraded 计数落到观测面（MetricSample：labels 带 type/providerId/reason，organizationId=null）', async () => {
      const before = await prisma.metricSample.count({ where: { name: 'provider_degraded' } });
      const svc = new LLMManagerService(prismaStub('llm') as never, cryptoStub, publicResolver, metrics);
      await svc.refresh();
      // M10-P15（跨 Phase 测试加固）：计数比较必须用 **count**，不能用 `take:5` 的 rows.length ——
      // 观测面是**累积**事实（历史运行留下的采样行永不清理），一旦累计 ≥5 行，
      // `rows.length(=5) > before(≥5)` 恒假，用例会随运行次数永久变红。
      const after = await prisma.metricSample.count({ where: { name: 'provider_degraded' } });
      const rows = await prisma.metricSample.findMany({ where: { name: 'provider_degraded' }, orderBy: { sampledAt: 'desc' }, take: 5 });
      expect(after).toBeGreaterThan(before);
      const labels = rows[0].labels as Record<string, unknown>;
      expect(labels).toMatchObject({ type: 'llm', providerId: 'p-llm-bad', providerName: 'BAD-llm', adapter: BAD_ADAPTER });
      expect(String(labels.reason)).toContain(BAD_ADAPTER);
      expect(rows[0].organizationId).toBeNull(); // 平台级配置，绝不借用租户/调用上下文归属
      expect(Number(rows[0].value)).toBe(1);
    }, 20_000);

    it('观测面缺失（@Optional 未注入）→ 加载与调用语义完全不受影响（best-effort）', async () => {
      const svc = new LLMManagerService(prismaStub('llm') as never, cryptoStub, publicResolver);
      await expect(svc.refresh()).resolves.toBeUndefined();
      expect(svc.getProvider('p-llm-ok')).toBeTruthy();
      expect((await caught(() => svc.resolve('m-llm-bad'))).code).toBe('PROVIDER_CONFIG_INVALID');
    });

    it('Image / Video manager：同一 degraded 语义（配置错误不外溢，调用期明确错误码）', async () => {
      const video = new VideoManagerService(prismaStub('video') as never, cryptoStub, publicResolver, metrics);
      await expect(video.refresh()).resolves.toBeUndefined();
      expect((await caught(() => video.resolve('m-video-bad'))).code).toBe('PROVIDER_CONFIG_INVALID');

      const image = new ImageManagerService(prismaStub('image') as never, cryptoStub, publicResolver, metrics);
      await expect(image.refresh()).resolves.toBeUndefined();
      expect((await caught(() => image.resolve('m-image-bad'))).code).toBe('PROVIDER_CONFIG_INVALID');
    });
  });
});
