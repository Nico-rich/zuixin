/**
 * vitest setupFile（**必须在 ./src/env.ts 之后注册**）：设测试基建标记。
 *
 * env.ts 用 `loadEnv({ override: true })` 载入 .env——本文件在其后执行，同进程内写
 * process.env，保证每个 e2e spec 构建 AppModule 时 TestProviderBootstrapService 会
 * 幂等启用 mock 替身（用户在生产库里的停用配置不影响测试套件）。
 * 见 src/providers/test-provider-bootstrap.service.ts 的完整取舍说明。
 */
process.env.TEST_ENSURE_MOCK_PROVIDERS = '1';
