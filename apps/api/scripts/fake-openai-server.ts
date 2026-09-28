/**
 * M10-P2：本地脚本化 **OpenAI-compatible 假服务器**（node:http 直写，零新依赖）。
 *
 * 定位（诚实口径）：本脚本是 **contract 层**——用来验证平台自己的 provider HTTP 客户端
 * （openai-compatible adapter / OpenAI SDK + manualRedirectFetch + StreamGuard）在**真实
 * TCP/HTTP/SSE** 下的行为：流式分块与 done 事件、usage 块、四层超时、429/5xx/4xx 错误映射、
 * 3xx 不被跟随。它**不是**任何真实厂商行为的证据：真实厂商（DeepSeek/Kimi/百炼/方舟/智谱/
 * OpenAI）的响应细节、限流口径、错误体结构仍为 **NOT VERIFIED**（见 M10-P2 报告）。
 *
 * 行为控制（优先级从高到低，便于一个实例覆盖多场景）：
 *   1. 请求头 `x-fake-scenario: <name>`
 *   2. URL query `?scenario=<name>`（仅影响该次请求；baseUrl 带 query 时也走这里）
 *   3. 请求体 `model` 前缀 `scenario:<name>`（或 `<name>@fake`；adapter 的 model 由测试控制）
 *   4. 实例默认（`opts.scenario` / env `FAKE_OPENAI_SCENARIO`），缺省 `ok`
 *
 * 场景：
 *   ok                 非流式 JSON（choices + usage）/ 流式 SSE（文本块 + usage 块 + [DONE]）
 *   tool-calls         流式 tool_calls delta 分片（跨块聚合）+ 文本块
 *   no-usage           流式但**不**发 usage 块（平台不得伪造用量）
 *   429 | 401 | 400 | 500 | 503   立即返回该状态码（错误体同 OpenAI 形态）
 *   stall              接受连接后**不响应**（不发响应头）——connect 层超时
 *   slow-headers       延迟 `FAKE_OPENAI_HEADER_DELAY_MS` 后才发响应头——connect 层超时
 *   first-byte-stall   发响应头后**不发任何数据块**——firstByte 层超时
 *   stall-mid-stream   先发 `FAKE_OPENAI_STALL_AFTER_CHUNKS`（默认 1）个块，随后静默——idle 层超时
 *   slow-stream        块间隔 `FAKE_OPENAI_CHUNK_INTERVAL_MS`（默认 200）——慢流/idle/total
 *   slow-total         慢流 + 长总时长——total 层超时
 *   redirect           302 + Location（`FAKE_OPENAI_REDIRECT_TO` / opts.redirectTo）——SSRF 逐跳校验
 *   bad-json           200 + 非法 JSON 体——解析失败的错误映射
 *   bad-sse            流式响应体格式损坏（非法 data 行）——SDK 解析行为
 *   hang-after-done    发完 [DONE] 后不结束连接（TCP 层不 FIN）——收尾不得挂住消费者
 *
 * 使用（测试内嵌）：`const srv = await startFakeOpenAIServer({ scenario: 'ok' }); srv.url`
 * 使用（手工/dev）：`pnpm --filter api exec tsx scripts/fake-openai-server.ts`（打印 baseUrl）
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export type FakeScenario =
  | 'ok'
  | 'tool-calls'
  | 'no-usage'
  | '429'
  | '401'
  | '400'
  | '500'
  | '503'
  | 'stall'
  | 'slow-headers'
  | 'first-byte-stall'
  | 'stall-mid-stream'
  | 'slow-stream'
  | 'slow-total'
  | 'redirect'
  | 'bad-json'
  | 'bad-sse'
  | 'hang-after-done';

export interface FakeRequestRecord {
  method: string;
  url: string;
  scenario: FakeScenario;
  /** 解析出的请求体（非 JSON/不可解析时为 undefined） */
  body?: Record<string, unknown>;
  /** 客户端请求头（不含凭证的断言用；apiKey 只记录是否存在） */
  hasAuthorization: boolean;
  at: number;
}

export interface FakeServerOptions {
  scenario?: FakeScenario;
  /** 监听端口（0 = 随机；默认 0） */
  port?: number;
  /** 绑定地址（默认 127.0.0.1——绝不对外监听） */
  host?: string;
  /** redirect 场景的 Location 目标（缺失时用 env FAKE_OPENAI_REDIRECT_TO；再缺失则 302 到自身 /v1/redirected） */
  redirectTo?: string;
  /** 流式块间隔（slow-stream/slow-total 场景；默认 env FAKE_OPENAI_CHUNK_INTERVAL_MS ?? 200） */
  chunkIntervalMs?: number;
  /** stall-mid-stream：先发几块再静默（默认 env FAKE_OPENAI_STALL_AFTER_CHUNKS ?? 1） */
  stallAfterChunks?: number;
  /** slow-headers：发响应头前的延迟（默认 env FAKE_OPENAI_HEADER_DELAY_MS ?? 2000） */
  headerDelayMs?: number;
  /** 回复文本（默认一段固定中文文本——断言块拼接结果用） */
  replyText?: string;
}

export interface FakeOpenAIServer {
  /** OpenAI 兼容 baseUrl（形如 http://127.0.0.1:PORT/v1） */
  url: string;
  port: number;
  /** 已收到的请求记录（顺序） */
  requests: FakeRequestRecord[];
  /** 收到 /v1/chat/completions 的次数（重试次数断言用） */
  chatCompletions: number;
  /** 打开中的响应连接数（收尾断言：平台必须中断在途请求） */
  openResponses(): number;
  setScenario(scenario: FakeScenario): void;
  /** 3xx 场景下被真正跟随的请求是否发生过（重定向目标命中数——manualRedirectFetch 必须保持 0） */
  redirectHits(): number;
  close(): Promise<void>;
}

const DEFAULT_REPLY = '你好，我是本地假服务器。';

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** `scenario:<name>` / `<name>@fake` 前缀解析（adapter 的 model 字段由测试控制） */
function scenarioFromModel(model: unknown): FakeScenario | null {
  if (typeof model !== 'string') return null;
  const prefixed = /^scenario:([a-z0-9-]+)$/.exec(model) ?? /^([a-z0-9-]+)@fake$/.exec(model);
  return (prefixed?.[1] as FakeScenario) ?? null;
}

function resolveScenario(req: IncomingMessage, url: URL, bodyModel: unknown, fallback: FakeScenario): FakeScenario {
  const header = req.headers['x-fake-scenario'];
  if (typeof header === 'string' && header) return header as FakeScenario;
  const query = url.searchParams.get('scenario');
  if (query) return query as FakeScenario;
  const fromModel = scenarioFromModel(bodyModel);
  if (fromModel) return fromModel;
  return fallback;
}

function sseData(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunkPayload(text: string, model: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 启动假服务器。真实 HTTP 监听 127.0.0.1（e2e 用 port 0 → 随机端口，避免并行套件端口冲突）。
 */
export async function startFakeOpenAIServer(opts: FakeServerOptions = {}): Promise<FakeOpenAIServer> {
  const requests: FakeRequestRecord[] = [];
  let defaultScenario: FakeScenario = opts.scenario ?? (process.env.FAKE_OPENAI_SCENARIO as FakeScenario | undefined) ?? 'ok';
  const replyText = opts.replyText ?? DEFAULT_REPLY;
  const chunkIntervalMs = opts.chunkIntervalMs ?? envInt('FAKE_OPENAI_CHUNK_INTERVAL_MS', 200);
  const stallAfterChunks = opts.stallAfterChunks ?? envInt('FAKE_OPENAI_STALL_AFTER_CHUNKS', 1);
  const headerDelayMs = opts.headerDelayMs ?? envInt('FAKE_OPENAI_HEADER_DELAY_MS', 2_000);
  const redirectHits = { count: 0 };
  const openResponses = new Set<ServerResponse>();

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const at = Date.now();
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> | undefined;
      try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined; } catch { body = undefined; }
      const scenario = url.pathname.endsWith('/chat/completions')
        ? resolveScenario(req, url, body?.model, defaultScenario)
        : (url.searchParams.get('scenario') as FakeScenario | null) ?? 'ok';
      requests.push({
        method: req.method ?? '', url: req.url ?? '', scenario, body,
        hasAuthorization: Boolean(req.headers.authorization), at,
      });
      if (url.pathname.includes('redirect-target')) redirectHits.count += 1;
      void handle(req, res, url, scenario, body, {
        replyText, chunkIntervalMs, stallAfterChunks, headerDelayMs,
        redirectTo: opts.redirectTo ?? process.env.FAKE_OPENAI_REDIRECT_TO ?? '',
        openResponses,
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/v1`;

  return {
    url,
    port,
    requests,
    get chatCompletions() { return requests.filter((r) => r.url.includes('/chat/completions')).length; },
    openResponses: () => openResponses.size,
    setScenario: (s) => { defaultScenario = s; },
    redirectHits: () => redirectHits.count,
    close: async () => {
      // 主动销毁在途连接（stall 场景下客户端可能仍握着连接）：close() 绝不等待它们自然结束
      for (const res of openResponses) res.destroy();
      openResponses.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
    },
  };
}

/** 单请求处理（场景分派） */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  scenario: FakeScenario,
  body: Record<string, unknown> | undefined,
  cfg: { replyText: string; chunkIntervalMs: number; stallAfterChunks: number; headerDelayMs: number; redirectTo: string; openResponses: Set<ServerResponse> },
): Promise<void> {
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
    return;
  }
  if (!url.pathname.endsWith('/chat/completions')) {
    // 重定向目标/探测端点：200 空体（命中数由 requests/redirectHits 记录）
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const model = typeof body?.model === 'string' ? body.model : 'fake-model';
  const wantStream = body?.stream === true;

  const statusScenario: Partial<Record<FakeScenario, number>> = { '429': 429, '401': 401, '400': 400, '500': 500, '503': 503 };
  const status = statusScenario[scenario];

  if (status) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `fake provider error ${status}`, type: 'fake_error', code: `fake_${status}` },
    }));
    return;
  }

  if (scenario === 'redirect') {
    const target = cfg.redirectTo || `http://127.0.0.1:${(res.socket?.localPort ?? 0)}/v1/redirect-target`;
    res.writeHead(302, { location: target, 'content-type': 'text/plain' });
    res.end('redirecting');
    return;
  }

  if (scenario === 'stall') return; // 接受连接、不响应（connect 层超时）

  if (scenario === 'slow-headers') {
    await sleep(cfg.headerDelayMs);
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': wantStream ? 'text/event-stream' : 'application/json' });
    res.end(wantStream ? 'data: [DONE]\n\n' : JSON.stringify(completionJson(cfg.replyText, model)));
    return;
  }

  if (!wantStream) {
    if (scenario === 'bad-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not-json');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completionJson(cfg.replyText, model)));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  cfg.openResponses.add(res);
  res.on('close', () => cfg.openResponses.delete(res));

  if (scenario === 'first-byte-stall') return; // 响应头已发、无数据块（firstByte 层超时）

  if (scenario === 'bad-sse') {
    res.write('data: {"broken"\n\n'); // 非法 JSON 行
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const includeUsage = (body?.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
  const pieces = [...cfg.replyText];

  if (scenario === 'tool-calls') {
    sseData(res, { id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: '先查一下' }, finish_reason: null }] });
    // tool_calls delta 分片（index 聚合：id/name 在首片，arguments 跨片）
    sseData(res, { id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_fake_1', type: 'function', function: { name: 'image.generate', arguments: '{"pro' } }] }, finish_reason: null }] });
    sseData(res, { id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'mpt":"海报"}' } }] }, finish_reason: null }] });
    if (includeUsage) {
      sseData(res, { id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const interval = scenario === 'slow-stream' || scenario === 'slow-total' ? Math.max(cfg.chunkIntervalMs, 1) : 0;
  let sent = 0;
  for (const piece of pieces) {
    if (res.destroyed) return; // 客户端中断（超时 abort）→ 立即停手
    sseData(res, chunkPayload(piece, model));
    sent += 1;
    if (interval > 0) await sleep(interval);
    if (scenario === 'stall-mid-stream' && sent >= Math.max(cfg.stallAfterChunks, 1)) return; // 静默（不 end）
  }
  if (scenario === 'slow-total') { await sleep(Math.max(interval, 1)); }
  if (res.destroyed) return;
  if (includeUsage && scenario !== 'no-usage') {
    sseData(res, { id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 } });
  }
  res.write('data: [DONE]\n\n');
  if (scenario === 'hang-after-done') return; // 不发 FIN：客户端必须能自行收尾（不挂住）
  res.end();
}

function completionJson(replyText: string, model: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-fake', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
  };
}

/** 手工运行入口（dev/调试：`tsx scripts/fake-openai-server.ts`；测试一律用 startFakeOpenAIServer 内嵌启动） */
async function main(): Promise<void> {
  const port = envInt('FAKE_OPENAI_PORT', 8899);
  const srv = await startFakeOpenAIServer({ port, scenario: (process.env.FAKE_OPENAI_SCENARIO as FakeScenario) ?? 'ok' });
  // eslint-disable-next-line no-console
  console.log(`[fake-openai] listening ${srv.url}（scenario=${process.env.FAKE_OPENAI_SCENARIO ?? 'ok'}）`);
}

if (require.main === module) void main();
