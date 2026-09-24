/**
 * M7-P2 OAuth Provider 统一抽象：
 * Agent/Tool 绝不直接接触 token——只有 CredentialService 服务端解密后与 Provider Adapter 交互。
 * 真实平台（shopify/amazon/...）接入时实现本接口；无真实凭据时只允许 Mock 实现，禁止伪造真实 OAuth 成功。
 */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  /** 秒；缺省 = 不过期 */
  expiresInSeconds?: number;
  scope?: string[];
  /** 远端账号标识（reconnect 复用判定） */
  providerAccountId: string;
}

export interface OAuthProvider {
  /** 注册名（Connection.provider / URL 参数同源） */
  name: string;
  /** 构造授权跳转 URL（state 已由服务层生成并持久化） */
  buildAuthorizeUrl(state: string): string;
  /** 用回调 code 交换 token（失败抛 PROVIDER_AUTH） */
  exchangeCode(code: string): Promise<OAuthTokenSet>;
  /** 刷新 token（失败/吊销抛 PROVIDER_AUTH——服务层据此标记 connection expired） */
  refreshToken(refreshToken: string): Promise<OAuthTokenSet>;
  /** 远端吊销（best-effort，本地状态仍以 DB 为准） */
  revoke(refreshToken: string): Promise<void>;
}
