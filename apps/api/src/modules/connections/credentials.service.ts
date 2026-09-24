import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { OAuthProvidersService } from './oauth/oauth-providers.service';
import { OAuthTokenSet } from './oauth/oauth-provider.interface';

/**
 * M7-P2 凭证服务（六不原则的执行者）：
 * - at rest 全部 AES-256-GCM 密文（复用 CryptoService；e2e 断言 DB 密文 ≠ 明文）；
 * - 明文只在本服务内存中出现，绝不进 DTO/API 响应/prompt/log；
 * - Tool 只能拿 connectionId 引用，由本服务（或 Provider Adapter 调用方）服务端解密。
 * - refresh 竞态：进程内单实例语义——并发 refresh 共享同一 in-flight Promise（远端调用只发生一次）；
 *   多实例由「凭证行替换 + connection 状态条件更新」兜底（无锁设计，文档化为单 API 进程部署约束）。
 */
@Injectable()
export class CredentialService {
  private readonly logger = new Logger('Credentials');
  /** connectionId → in-flight refresh Promise（并发折叠；完成即移除） */
  private readonly refreshes = new Map<string, Promise<{ accessToken: string }>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(OAuthProvidersService) private readonly providers: OAuthProvidersService,
  ) {}

  /** 令牌集落库：access/refresh 各自删除重建（密文）；连接 expiresAt 同步 */
  async store(connectionId: string, tokens: OAuthTokenSet): Promise<void> {
    const expiresAt = tokens.expiresInSeconds ? new Date(Date.now() + tokens.expiresInSeconds * 1000) : null;
    await this.prisma.$transaction(async (tx) => {
      await tx.credential.deleteMany({ where: { connectionId, type: 'access_token' } });
      await tx.credential.create({
        data: { connectionId, type: 'access_token', encryptedValue: this.crypto.encrypt(tokens.accessToken), expiresAt },
      });
      if (tokens.refreshToken) {
        await tx.credential.deleteMany({ where: { connectionId, type: 'refresh_token' } });
        await tx.credential.create({
          data: { connectionId, type: 'refresh_token', encryptedValue: this.crypto.encrypt(tokens.refreshToken) },
        });
      }
      await tx.connection.update({
        where: { id: connectionId },
        data: { expiresAt, lastSyncedAt: new Date() },
      });
    });
  }

  /** 服务端解密 access token（仅 Provider Adapter 调用链使用；绝不返回给 HTTP/Tool 结果） */
  async getAccessToken(connectionId: string): Promise<{ token: string; expiresAt: Date | null } | null> {
    const row = await this.prisma.credential.findFirst({
      where: { connectionId, type: 'access_token' },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return null;
    return { token: this.crypto.decrypt(row.encryptedValue), expiresAt: row.expiresAt };
  }

  /** 服务端解密 refresh token */
  async getRefreshToken(connectionId: string): Promise<string | null> {
    const row = await this.prisma.credential.findFirst({
      where: { connectionId, type: 'refresh_token' },
      orderBy: { createdAt: 'desc' },
    });
    return row ? this.crypto.decrypt(row.encryptedValue) : null;
  }

  /**
   * 刷新（竞态折叠：同一连接并发调用只执行一次远端 refresh）。
   * 失败语义：远端吊销/过期（PROVIDER_AUTH）→ connection 标记 expired 后抛出原错误；
   * 本地 revoked → 409 CONNECTION_REVOKED；无 refresh token → 409 CONNECTION_NOT_REFRESHABLE。
   */
  refresh(connectionId: string): Promise<{ accessToken: string }> {
    const inFlight = this.refreshes.get(connectionId);
    if (inFlight) return inFlight;
    const p = this.doRefresh(connectionId).finally(() => { this.refreshes.delete(connectionId); });
    this.refreshes.set(connectionId, p);
    return p;
  }

  private async doRefresh(connectionId: string): Promise<{ accessToken: string }> {
    const conn = await this.prisma.connection.findUnique({ where: { id: connectionId } });
    if (!conn) throw new AppError(ErrorCode.NOT_FOUND, '连接不存在');
    if (conn.status === 'revoked') throw new AppError(ErrorCode.CONNECTION_REVOKED, '连接已吊销，请重新连接');
    const provider = this.providers.get(conn.provider);
    if (!provider) throw new AppError(ErrorCode.PROVIDER_UNSUPPORTED, '不支持的 Provider');
    const refreshToken = await this.getRefreshToken(connectionId);
    if (!refreshToken) throw new AppError(ErrorCode.CONNECTION_NOT_REFRESHABLE, '该连接不支持刷新');
    try {
      const tokens = await provider.refreshToken(refreshToken);
      await this.store(connectionId, tokens);
      return { accessToken: tokens.accessToken };
    } catch (err) {
      // 远端吊销/过期 → 本地标记 expired（reconnect 可复活）；原错误上抛（PROVIDER_AUTH）
      if (err instanceof AppError && err.code === ErrorCode.PROVIDER_AUTH) {
        await this.prisma.connection.updateMany({
          where: { id: connectionId, status: 'active' },
          data: { status: 'expired' },
        }).catch(() => undefined);
      }
      throw err;
    }
  }
}
