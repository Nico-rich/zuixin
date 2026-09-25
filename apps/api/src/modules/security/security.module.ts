import { Global, Module } from '@nestjs/common';
import { AccessGuardService } from './access-guard.service';
import { SSRF_RESOLVER, nodeDnsResolver } from './ssrf-guard';

/**
 * M8-P8 安全面（@Global：认证/扩展/工作流等既有模块直接复用，无需各自 import）。
 * 本模块只提供"纯防线"能力（无控制器、无业务状态）：
 * - AccessGuardService：禁用用户阻断 + 会话撤销判定的缓存友好读取；
 * - SSRF_RESOLVER：SSRF 防线的 DNS 解析器（测试与替换点；默认 node:dns）。
 */
@Global()
@Module({
  providers: [
    AccessGuardService,
    { provide: SSRF_RESOLVER, useValue: nodeDnsResolver },
  ],
  exports: [AccessGuardService, SSRF_RESOLVER],
})
export class SecurityModule {}
