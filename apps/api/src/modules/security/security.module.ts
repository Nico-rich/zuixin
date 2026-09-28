import { Global, Module } from '@nestjs/common';
import { AccessGuardService } from './access-guard.service';
import { SessionEventsService } from './session-events.service';
import { SSRF_RESOLVER, nodeDnsResolver } from './ssrf-guard';
import { SafeRemoteFetcher } from './safe-remote-fetcher.service';
import { nodePinnedTransport, PINNED_TRANSPORT } from './pinned-transport';

/**
 * M8-P8 安全面（@Global：认证/扩展/工作流等既有模块直接复用，无需各自 import）。
 * 本模块只提供"纯防线"能力（无控制器、无业务状态）：
 * - AccessGuardService：禁用用户阻断 + 会话撤销判定 + jti 黑名单的缓存友好读取；
 * - SessionEventsService（M10-P1）：Redis pub/sub `session-events` 跨实例撤销传播 + jti 黑名单/记账；
 * - SSRF_RESOLVER：SSRF 防线的 DNS 解析器（测试与替换点；默认 node:dns）；
 * - PINNED_TRANSPORT（M10-P1）：连接固定传输层（socket 只连已校验地址，防 DNS rebinding）；
 * - SafeRemoteFetcher（Pre-M9 F3-A）：服务端取回远端资源的唯一入口（逐跳 SSRF + 白名单 + 限额 + 连接固定）。
 */
@Global()
@Module({
  providers: [
    AccessGuardService,
    SessionEventsService,
    { provide: SSRF_RESOLVER, useValue: nodeDnsResolver },
    { provide: PINNED_TRANSPORT, useValue: nodePinnedTransport },
    SafeRemoteFetcher,
  ],
  exports: [AccessGuardService, SessionEventsService, SSRF_RESOLVER, PINNED_TRANSPORT, SafeRemoteFetcher],
})
export class SecurityModule {}
