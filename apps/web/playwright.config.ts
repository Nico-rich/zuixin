import { defineConfig } from '@playwright/test';
import { API_ORIGIN, MOCK_DELAY_MS, REDIS_URL, WEB_ORIGIN, resolveChannel } from './e2e/support/stack';

/**
 * M11-P13：真实浏览器 e2e 配置。
 *
 * - **本机浏览器**：`channel:'chrome'`（缺省自动退化 msedge；都不可用则显式报错，绝不静默改用下载版）。
 * - **真进程**：globalSetup 起 api + worker + web 真进程，globalTeardown 全量回收（见 e2e/support/stack.ts）。
 * - **串行**：workers=1 / fullyParallel=false——共享一套 api/web/redis 实例（REDIS db /33），且用例之间
 *   存在有意为之的进程级交互（task-card 会临时停/起 worker），并行会互相破坏确定性。
 * - **产物不外溢**：outputDir/report 都落在 node_modules 下，git 工作区保持干净。
 */
const channel = resolveChannel();

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0, // 真实浏览器验证：失败即事实，不做重试掩盖
  timeout: 180_000,
  expect: { timeout: 20_000 },
  globalTimeout: 45 * 60_000,
  globalSetup: './e2e/support/global-setup.ts',
  globalTeardown: './e2e/support/global-teardown.ts',
  outputDir: 'node_modules/.playwright-artifacts',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'node_modules/.playwright-report' }],
  ],
  use: {
    baseURL: WEB_ORIGIN,
    channel,
    headless: true,
    launchOptions: {
      /**
       * Chrome 138+ 的 Local Network Access（PNA 后继）会**在发出请求之前**就拒绝一切跨源 loopback 请求
       * （实测 Chrome 153：cors/no-cors/<img>/XHR 全部 net::ERR_FAILED，控制台 `Permission was denied for
       * this request to access the loopback address space`）。它掩盖了**本 API 自身的 CORS 决策**，
       * 使“浏览器侧 CORS 是否真的拦住跨源读取”无法被观测 —— 而后者正是 M8 审计 #10 待验证项。
       * 故本套件显式关闭该浏览器侧前置限制，让请求真实到达服务端、由 CORS 规则与 fetch 语义决出结果；
       * LNA 自身的行为作为观测事实记录在 M11-P13 报告里（不作为断言，避免绑死浏览器版本）。
       */
      args: ['--disable-features=LocalNetworkAccessChecks'],
    },
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280, height: 900 },
  },
  metadata: {
    api: API_ORIGIN,
    web: WEB_ORIGIN,
    redis: REDIS_URL,
    mockDelayMs: MOCK_DELAY_MS,
    browserChannel: channel,
  },
});
