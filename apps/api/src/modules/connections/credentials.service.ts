import { Inject, Injectable, Logger } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { OAuthProvidersService } from './oauth/oauth-providers.service';
import { OAuthTokenSet } from './oauth/oauth-provider.interface';

/** Pre-M9 C5：跨实例刷新租约（DB 兜底）——持有者独占远端刷新，他实例等待其结果 */
const refreshLeaseMs = (): number => Number(process.env.CONNECTION_REFRESH_LEASE_MS) || 30_000;
const refreshWaitMs = (): number => Number(process.env.CONNECTION_REFRESH_WAIT_MS) || 2_000;
const REFRESH_POLL_MS = 50;

/**
 * M7-P2 凭证服务（六不原则的执行者）：
 * - at rest 全部 AES-256-GCM 密文（复用 CryptoService；e2e 断言 DB 密文 ≠ 明文）；
 * - 明文只在本服务内存中出现，绝不进 DTO/API 响应/prompt/log；
 * - Tool 只能拿 connectionId 引用，由本服务（或 Provider Adapter 调用方）服务端解密。
 * - refresh 竞态：进程内并发 refresh 共享同一 in-flight Promise（远端调用只发生一次）；
 *   跨实例由 **DB 条件更新租约** 兜底（Pre-M9 C5）：抢到租约者独占远端刷新，
 *   未抢到者等待并复用其结果——远端刷新在"多实例并发"下同样只发生一次。
 */
@Injectable()
export class CredentialService {
  private readonly logger = new Logger('Credentials');
  /** connectionId → in-flight refresh Promise（并发折叠；完成即移除） */
  private readonly refreshes = new Map<string, Promise<{ accessToken: string }>>();
  /** 实例标识（C5 租约归属：只清理自己持有的租约） */
  private readonly instanceId = `cred:${process.pid}:${randomBytes(4).toString('hex')}`;

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
    // C5 基线：本次尝试的开始时刻。输家判定"对端已刷新"的依据是
    // **此后是否出现凭证写入**（connection.lastSyncedAt，store() 唯一写入点）——
    // 而不是"令牌值与开始前不同"：后者在"对端已写完、自己才读到新令牌"的时序下会误判为超时。
    const startedAt = Date.now();
    const conn = await this.prisma.connection.findUnique({ where: { id: connectionId } });
    if (!conn) throw new AppError(ErrorCode.NOT_FOUND, '连接不存在');
    if (conn.status === 'revoked') throw new AppError(ErrorCode.CONNECTION_REVOKED, '连接已吊销，请重新连接');
    const provider = this.providers.get(conn.provider);
    if (!provider) throw new AppError(ErrorCode.PROVIDER_UNSUPPORTED, '不支持的 Provider');
    const refreshToken = await this.getRefreshToken(connectionId);
    if (!refreshToken) throw new AppError(ErrorCode.CONNECTION_NOT_REFRESHABLE, '该连接不支持刷新');

    // Pre-M9 C5：跨实例互斥（DB 条件更新兜底）——租约未过期 = 他实例正在刷新 → 等其结果，绝不发起第二次远端刷新
    const held = this.leaseUntil(conn.metadata);
    if (held > Date.now()) return this.awaitPeerRefresh(connectionId, startedAt);

    // 抢注：CAS on (id, status=active, updatedAt=读到的版本)——并发抢注只有一个赢家（@updatedAt 使并发写必然失配）
    const claimed = await this.prisma.connection.updateMany({
      where: { id: connectionId, status: 'active', updatedAt: conn.updatedAt },
      data: {
        metadata: {
          ...(conn.metadata as Record<string, unknown> | null ?? {}),
          refreshLeaseUntil: new Date(Date.now() + refreshLeaseMs()).toISOString(),
          refreshLeaseOwner: this.instanceId,
        } as never,
      },
    });
    if (claimed.count === 0) return this.awaitPeerRefresh(connectionId, startedAt); // 输家/状态已变：复用赢家结果

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
    } finally {
      await this.releaseLease(connectionId).catch(() => undefined); // 释放（失败由租约 TTL 兜底）
    }
  }

  /** 租约到期时间戳（0 = 无租约/已过期）；metadata 为 JSON 列——不新增 schema 字段 */
  private leaseUntil(metadata: unknown): number {
    const raw = (metadata as { refreshLeaseUntil?: string } | null)?.refreshLeaseUntil;
    const t = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(t) ? t : 0;
  }

  /** 释放自有租约（只清自己持有的；期间行被他人改动 → CAS 失配，等 TTL 自然过期） */
  private async releaseLease(connectionId: string): Promise<void> {
    const row = await this.prisma.connection.findUnique({
      where: { id: connectionId }, select: { metadata: true, updatedAt: true },
    });
    const meta = (row?.metadata as Record<string, unknown> | null) ?? null;
    if (!meta || meta.refreshLeaseOwner !== this.instanceId) return;
    const { refreshLeaseUntil: _u, refreshLeaseOwner: _o, ...rest } = meta;
    await this.prisma.connection.updateMany({
      where: { id: connectionId, updatedAt: row!.updatedAt },
      data: { metadata: rest as never },
    });
  }

  /**
   * 等待他实例完成刷新并复用其结果（跨实例折叠）。有界等待（refreshWaitMs，默认 2s）：
   * 判定依据 = `startedAt` 之后出现过凭证写入（`connection.lastSyncedAt`，`store()` 是唯一写入点）——
   * 与"令牌值是否变化"无关，因此对端先写完、自己后读到新令牌的时序同样能命中。
   * 超时（对端崩溃/失败）→ 409 CONNECTION_NOT_ACTIVE（可稍后重试；租约 TTL 过后可被接管）。
   */
  private async awaitPeerRefresh(connectionId: string, startedAt: number): Promise<{ accessToken: string }> {
    const deadline = Date.now() + refreshWaitMs();
    for (;;) {
      const row = await this.prisma.connection.findUnique({ where: { id: connectionId }, select: { lastSyncedAt: true } });
      const fresh = await this.getAccessToken(connectionId);
      if (fresh && row?.lastSyncedAt && row.lastSyncedAt.getTime() >= startedAt) {
        this.logger.log({ connectionId }, '另一实例已刷新凭证：复用其结果（未发起第二次远端刷新）');
        return { accessToken: fresh.token };
      }
      if (Date.now() >= deadline) break;
      await delay(REFRESH_POLL_MS);
    }
    throw new AppError(ErrorCode.CONNECTION_NOT_ACTIVE, '连接正在被其他实例刷新，请稍后重试');
  }
}
