import type { APIResponse, Page } from '@playwright/test';
import { API_ORIGIN, FOREIGN_ORIGIN, WEB_ORIGIN } from './support/stack';
import { XRW, expect, test, uniqueTag } from './support/fixtures';

/**
 * 覆盖点 7：CORS / CSRF 的**浏览器侧**行为（M8 安全审计第 10 条：浏览器侧 CORS/CSRF NOT VERIFIED）。
 *
 * 这里验证的是“真实浏览器 + 真实同源代理 + 真实 cookie jar”下的端到端语义，而不是服务端头字段的复读：
 * - CSRF：同源写请求在删掉 `X-Requested-With` 后必须被拒（且**真的没有生效**），加回即放行；
 * - 跨站表单（浏览器能发出的唯一“无自定义头 + 带 cookie”的写请求形态）必须被拒；
 * - CORS：白名单源可读（含预检放行 CSRF 头）、非白名单源一律不可读，且被拦截的原始响应无任何放行头；
 * - Cookie：HttpOnly/SameSite/Path 在浏览器 cookie jar 里的实际取值，以及 `document.cookie` 不可见。
 *
 * 攻击者源：`http://127.0.0.1:3000`（与 web 同进程、不同 origin —— 本机上真实存在、且不在 CORS 白名单内）。
 * 其页面由 `page.route` 就地伪造（不依赖后端能经 127.0.0.1 访问；origin 由 URL 决定，与内容来源无关），
 * 且**不注入 CSP**——否则浏览器的 `form-action` 会直接拦下表单，掩盖服务端 CSRF 的真实结论。
 */
const CSRF_MESSAGE = '非法请求来源';

async function serveAttackerPage(page: Page, html: string): Promise<void> {
  await page.route(`${FOREIGN_ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }),
  );
}

interface ProbeResult { status: number; text: string }

test.describe('CORS / CSRF 浏览器侧行为', () => {
  test('同源写请求：无 X-Requested-With → 403 且未生效；带该头 → 放行（真实浏览器 + 真实 cookie）', async ({ authedPage: page, context }) => {
    const tag = uniqueTag('csrf');
    const originalTitle = `csrf-orig-${tag}`;
    await page.goto('/chat'); // 建立同源文档（evaluate 里的相对路径 fetch 需要页面上下文）
    const created = await context.request.post(`${WEB_ORIGIN}/api/v1/conversations`, { headers: XRW, data: { title: originalTitle } });
    expect(created.ok(), `创建探针会话失败：HTTP ${created.status()} ${await created.text()}`).toBe(true);
    const convId = (await created.json()).data.id as string;

    /** 走浏览器同源代理（/api/v1 → Next rewrites → api），cookie 由浏览器自动附带 */
    const patchViaBrowser = (withXrw: boolean, title: string): Promise<ProbeResult> =>
      page.evaluate(
        async ({ id, xrw, nextTitle }) => {
          const res = await fetch(`/api/v1/conversations/${id}`, {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...(xrw ? { 'X-Requested-With': 'XMLHttpRequest' } : {}) },
            body: JSON.stringify({ title: nextTitle }),
          });
          return { status: res.status, text: await res.text() };
        },
        { id: convId, xrw: withXrw, nextTitle: title },
      );

    // 1) 无 CSRF 头：中间件在路由/鉴权之前拒绝
    const blocked = await patchViaBrowser(false, `csrf-blocked-${tag}`);
    expect(blocked.status).toBe(403);
    const blockedBody = JSON.parse(blocked.text);
    expect(blockedBody.error.code).toBe('FORBIDDEN');
    expect(blockedBody.error.message).toContain(CSRF_MESSAGE);

    // 2) 真的没有生效：被拒的写请求不得留下任何痕迹
    const after = await context.request.get(`${WEB_ORIGIN}/api/v1/conversations/${convId}`);
    expect(after.ok()).toBe(true);
    expect((await after.json()).data.title).toBe(originalTitle);

    // 3) A/B：同一路由同一 body，仅补上 X-Requested-With → 放行并真实生效
    const allowed = await patchViaBrowser(true, `csrf-allowed-${tag}`);
    expect(allowed.status, `带 CSRF 头应放行，实际 ${allowed.status}：${allowed.text}`).toBe(200);
    expect(JSON.parse(allowed.text).data.title).toBe(`csrf-allowed-${tag}`);
  });

  test('跨站表单 POST（浏览器可发出的无自定义头写请求）→ 服务端 403，攻击者读不到响应', async ({ authedPage: page, context }) => {
    const tag = uniqueTag('xsrf');
    // 攻击者源不得看到受害者 cookie（cookie 作用域 = localhost，与源绑定）
    expect(await context.cookies(FOREIGN_ORIGIN)).toEqual([]);

    await serveAttackerPage(page, `<!doctype html><html lang="zh-CN"><body>
      <form id="f" method="POST" action="${API_ORIGIN}/api/v1/conversations">
        <input name="title" value="pwned-${tag}">
      </form>
    </body></html>`);
    await page.goto(`${FOREIGN_ORIGIN}/attack.html`);
    expect(await page.evaluate(() => location.origin)).toBe(FOREIGN_ORIGIN);

    const responsePromise = page.waitForResponse(
      (r) => r.url().includes('/api/v1/conversations') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    // setTimeout(...,0)：先让 evaluate 返回，再做真实表单提交（避免执行上下文随导航销毁）
    await page.evaluate(() => { const f = document.getElementById('f'); setTimeout(() => (f as HTMLFormElement).submit(), 0); });
    const res = await responsePromise;
    expect(res.status()).toBe(403);
    expect(await res.text()).toContain(CSRF_MESSAGE);

    // 表单提交即导航：落地页是 API 源的 JSON 文档（未创建任何会话，仅证明表单攻击无法携带 CSRF 头）
    await page.waitForURL((url) => url.host === new URL(API_ORIGIN).host, { timeout: 30_000 });
  });

  test('/hooks/ 公开端点：CSRF 豁免是窄口（豁免后仍由 HMAC 层拒绝，绝不放行写操作）', async ({ authedPage: page }) => {
    const tag = uniqueTag('hook');
    await page.goto('/chat');
    const probe = await page.evaluate(
      async ({ path, forged }) => {
        const res = await fetch(path, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, // 故意不带 X-Requested-With
          body: JSON.stringify({ forged }),
        });
        return { status: res.status, text: await res.text() };
      },
      { path: `/api/v1/hooks/workflows/${tag}`, forged: tag },
    );

    // csrf.middleware.ts 对该路径显式放行（webhook 由 HMAC 签名鉴权）→ 响应必须**不是** CSRF 的 FORBIDDEN 信封，
    // 而应由 webhook 校验层拒绝（未签名 = 非法载荷，401 WEBHOOK_SIGNATURE_INVALID）
    expect(probe.text).not.toContain(CSRF_MESSAGE);
    expect(probe.status, `未签名 webhook 请求不得成功，实际 ${probe.status}：${probe.text}`).toBeGreaterThanOrEqual(400);
  });

  test('CORS 头对照：白名单源放行（含预检的 X-Requested-With），非白名单源一律无放行头', async ({ context }) => {
    const read = async (res: APIResponse) => ({ status: res.status(), headers: await res.headers() });

    // 正向：白名单源（web 源）——必须能拿到 ACAO + credentials，否则生产同源反代下的前端会整体失效
    const allowed = await read(await context.request.fetch(`${API_ORIGIN}/api/v1/health`, { headers: { Origin: WEB_ORIGIN } }));
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(allowed.headers['vary'] ?? '').toContain('Origin');

    // 反向：非白名单源（同机器的 127.0.0.1 别名）——绝不回 ACAO（没有 ACAO，浏览器就不会把响应交给 JS）
    const foreign = await read(await context.request.fetch(`${API_ORIGIN}/api/v1/health`, { headers: { Origin: FOREIGN_ORIGIN } }));
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    // 观察事实（非放行）：`cors` 包对 `credentials:true` 是**无条件**下发 ACAC 的，与来源是否命中无关；
    // 仅有 ACAC 而无 ACAO 不构成放行（Fetch 规范：凭据模式下 ACAO 必须是具体来源）。
    // 这里把它固化为断言，避免未来“悄悄改成条件下发”时无人知晓；浏览器侧的真实后果见下一个用例。
    expect(foreign.headers['access-control-allow-credentials'], '当前实现：ACAC 无条件下发（无 ACAO 时不起放行作用）').toBe('true');

    // 预检：白名单源必须被允许携带 x-requested-with（CSRF 头与 CORS 必须相容，否则应用自身不可用）
    const okPreflight = await read(await context.request.fetch(`${API_ORIGIN}/api/v1/conversations`, {
      method: 'OPTIONS',
      headers: { Origin: WEB_ORIGIN, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'x-requested-with,content-type' },
    }));
    expect(okPreflight.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect((okPreflight.headers['access-control-allow-headers'] ?? '').toLowerCase()).toContain('x-requested-with');

    // 预检：非白名单源 → 无 ACAO（浏览器据此拦下真正的写请求：攻击者连请求都发不出去）
    const badPreflight = await read(await context.request.fetch(`${API_ORIGIN}/api/v1/conversations`, {
      method: 'OPTIONS',
      headers: { Origin: FOREIGN_ORIGIN, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'x-requested-with,content-type' },
    }));
    expect(badPreflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('浏览器侧跨源行为：cors 模式被拒 / no-cors 只得 opaque / 跨站不带 cookie（401）/ 跨源写无副作用 / 白名单源可读', async ({ authedPage: page, context }) => {
    const tag = uniqueTag('xorigin');
    const raw: Array<{ url: string; status: number; headers: Record<string, string> }> = [];
    const failedWrites: string[] = [];
    const consoleText: string[] = [];
    page.on('response', (res) => {
      if (!res.url().startsWith(API_ORIGIN)) return;
      void res.allHeaders().then((headers) => raw.push({ url: res.url(), status: res.status(), headers }));
    });
    page.on('requestfailed', (req) => {
      if (req.method() === 'POST' && req.url().startsWith(API_ORIGIN)) failedWrites.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText}`);
    });
    page.on('console', (msg) => consoleText.push(msg.text()));

    await serveAttackerPage(page, '<!doctype html><html lang="zh-CN"><body>attacker</body></html>');
    await page.goto(`${FOREIGN_ORIGIN}/attack.html`);

    // 1) 默认 cors 模式：浏览器按 CORS 规则拒绝把响应交给 JS（fetch reject，TypeError）
    const corsMode = await page.evaluate(async (api) => {
      try {
        const r = await fetch(`${api}/api/v1/auth/me`, { credentials: 'include' });
        return { rejected: false, status: r.status, type: r.type, name: '' };
      } catch (e) {
        return { rejected: true, status: 0, type: '', name: (e as Error).name };
      }
    }, API_ORIGIN);
    expect(corsMode.rejected, `跨源响应不得可读，实际 ${JSON.stringify(corsMode)}`).toBe(true);
    expect(corsMode.name).toBe('TypeError');

    // 2) no-cors 模式：请求真的发出去（真实跨源请求），但对 JS 完全不可读（opaque：status 0 / 无可读头 / body 空）
    const opaqueMode = await page.evaluate(async (api) => {
      const r = await fetch(`${api}/api/v1/auth/me`, { mode: 'no-cors', credentials: 'include' });
      return { type: r.type, status: r.status, readableHeaders: [...r.headers.keys()].length, body: await r.text() };
    }, API_ORIGIN);
    expect(opaqueMode.type).toBe('opaque');
    expect(opaqueMode.status).toBe(0);
    expect(opaqueMode.readableHeaders).toBe(0);
    expect(opaqueMode.body).toBe('');

    // 3) 跨源写请求携带自定义头（= CSRF 头）：攻击者拿不到任何结果，且服务端不会产生写入。
    //    实测（Chrome 153 关闭 LNA 检查后）：该请求会被真实发出（服务端侧因跨站不带 cookie 判 401），
    //    但**响应被 CORS 拒绝**（无 ACAO → net::ERR_FAILED）→ fetch 抛 TypeError。
    //    不假设“预检一定发出/一定拦住”：这里断言的是可观测结果（不可读 + 无副作用）。
    const attackerTitle = `xsrf-origin-${tag}`;
    const crossOriginWrite = await page.evaluate(async ({ api, title }) => {
      try {
        const r = await fetch(`${api}/api/v1/conversations`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ title }),
        });
        return { rejected: false, status: r.status };
      } catch (e) {
        return { rejected: true, status: 0, name: (e as Error).name };
      }
    }, { api: API_ORIGIN, title: attackerTitle });
    expect(crossOriginWrite.rejected, `跨源写请求不得可读，实际 ${JSON.stringify(crossOriginWrite)}`).toBe(true);
    expect(crossOriginWrite.name).toBe('TypeError');
    if (failedWrites.length) console.log(`[e2e] 跨源写请求被浏览器判失败：${failedWrites.join(' | ')}`);

    // 4) 原始响应（只有网络栈/测试运行器可见）：无 ACAO → 攻击者 JS 永远读不到内容；
    //    且跨站请求**不带会话 cookie**（SameSite=Lax 在浏览器侧真实生效）→ 服务端一律 401 未登录
    await expect.poll(() => raw.length, { message: '应能捕获到跨源原始响应' }).toBeGreaterThan(0);
    for (const r of raw) {
      expect(r.headers['access-control-allow-origin'], `${r.url} 不得回 ACAO`).toBeUndefined();
      console.log(`[e2e] 跨源原始响应：HTTP ${r.status} ${r.url}（无 ACAO；JS 侧 opaque/被拒）`);
    }
    const meRaw = raw.filter((r) => r.url.includes('/api/v1/auth/me'));
    expect(meRaw.length, '应捕获到跨源 /auth/me 的原始响应').toBeGreaterThan(0);
    expect(
      meRaw.map((r) => r.status),
      '跨站子请求不应携带 agent_access（SameSite=Lax）→ 服务端必须判未登录',
    ).toEqual(meRaw.map(() => 401));
    console.log(`[e2e] 攻击者源控制台（CORS/预检判定）：${consoleText.filter((t) => /CORS|preflight|Access-Control/i.test(t)).join(' | ')}`);

    // 4b) 无副作用：攻击者的写请求没有创建任何会话（唯一标题在鉴权视图里不存在）
    const listed = await context.request.get(`${WEB_ORIGIN}/api/v1/conversations?limit=50`);
    expect(listed.ok()).toBe(true);
    const titles = ((await listed.json()).data as Array<{ title?: string }>).map((c) => c.title);
    expect(titles, '跨源攻击请求不得产生任何写入').not.toContain(attackerTitle);

    // 5) 攻击者源读不到 web 源 cookie（HttpOnly + 作用域在浏览器侧生效）
    const attackerDocCookie = await page.evaluate(() => document.cookie);
    expect(attackerDocCookie).not.toContain('agent_access');
    expect(await context.cookies(FOREIGN_ORIGIN)).toEqual([]);

    // 6) Cookie 在浏览器 jar 内的实际属性（按 URL 过滤 = 浏览器真实的“该请求会不会带上它”判定：
    //    agent_access 全站可见；agent_refresh 因 Path=/api/v1/auth 只在刷新端点上可见）
    const access = (await context.cookies(WEB_ORIGIN)).find((c) => c.name === 'agent_access');
    const refresh = (await context.cookies(`${WEB_ORIGIN}/api/v1/auth/refresh`)).find((c) => c.name === 'agent_refresh');
    expect((await context.cookies(WEB_ORIGIN)).map((c) => c.name), 'Path 收窄：首页 URL 下不应匹配到 refresh cookie').not.toContain('agent_refresh');
    expect(access, 'agent_access 应在浏览器 cookie jar 内').toBeTruthy();
    expect(refresh, 'agent_refresh 应在浏览器 cookie jar 内').toBeTruthy();
    expect(access?.httpOnly).toBe(true);
    expect(access?.sameSite).toBe('Lax');
    expect(access?.path).toBe('/');
    expect(refresh?.httpOnly).toBe(true);
    expect(refresh?.path).toBe('/api/v1/auth'); // refresh 只在刷新端点上发送
    // 明文 http 本地开发：不带 Secure（Secure 的生产语义由 login.spec 与单测覆盖）
    expect(access?.secure).toBe(false);

    // 7) 对照（正向）：回到白名单源后，①同源经 Next 代理可读；②**跨源**直连 api 源也可读（CORS 白名单真的在放行）
    await page.unroute(`${FOREIGN_ORIGIN}/**`);
    await page.goto('/chat');
    const docCookie = await page.evaluate(() => document.cookie);
    expect(docCookie).not.toContain('agent_access');
    expect(docCookie).not.toContain('agent_refresh');
    const both = await page.evaluate(async ({ api }) => {
      const sameOrigin = await fetch('/api/v1/auth/me', { credentials: 'include' });
      const sameBody = await sameOrigin.json();
      const crossOrigin = await fetch(`${api}/api/v1/auth/me`, { credentials: 'include' });
      const crossBody = await crossOrigin.json();
      return {
        sameStatus: sameOrigin.status,
        crossStatus: crossOrigin.status,
        crossAcao: crossOrigin.headers.get('access-control-allow-origin'),
        sameEmail: sameBody.data?.user?.email ?? null,
        crossEmail: crossBody.data?.user?.email ?? null,
      };
    }, { api: API_ORIGIN });
    expect(both.sameStatus).toBe(200);
    expect(both.crossStatus, '白名单源跨源直连 api 应放行（证明拦截来自来源白名单，而非端点不可用）').toBe(200);
    // ACAO 不属于 CORS 安全响应头 → JS 读不到（null 是预期），放行只能由“状态 200 + 响应体可读”证明
    expect(both.crossAcao).toBeNull();
    expect(both.crossEmail).toBe(both.sameEmail);
    expect(both.crossEmail).toBeTruthy();
  });
});
