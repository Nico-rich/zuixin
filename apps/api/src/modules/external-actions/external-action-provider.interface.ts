/**
 * M7-P3 外部动作 Provider Adapter 统一抽象：
 * Agent 绝不直连 Shopify/Amazon/Meta/Google/TikTok API——
 * 链路固定为 Agent → Tool → ExternalActionService → Provider Adapter → External API。
 * accessToken 由 CredentialService 服务端解密后注入（本请求内存态，绝不落库/回传/进 Tool 结果）。
 * 幂等约定：同一 externalRequestId 的重复调用必须返回同一结果（Provider 侧去重；
 * mock 实现完整演示，真实平台用其原生幂等键）。
 */
export interface ExternalActionRequest {
  provider: string;
  actionType: string;
  payload: Record<string, unknown>;
  /** 服务端生成的远端幂等键（重试/崩溃恢复复用同一键） */
  externalRequestId: string;
  connectionId: string;
  /** 服务端解密的真实凭证——只在 Adapter 调用链存在 */
  accessToken: string;
  signal: AbortSignal;
}

export interface ExternalActionProvider {
  name: string;
  execute(req: ExternalActionRequest): Promise<unknown>;
}
