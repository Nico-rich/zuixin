import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { OAuthProvidersService } from './oauth/oauth-providers.service';
import { CredentialService } from './credentials.service';
import { CONNECTION_SELECT } from './connections.dto';
import { AuditService } from '../audit/audit.service';
import { OrganizationsService } from '../organizations/organizations.service';

const OAUTH_STATE_TTL_MS = 10 * 60_000; // 短时 single-use（10min）

/**
 * M7-P2 Connection 生命周期（统一第三方账号连接体系）：
 * - start：建 OAuthState（single-use + user/project/provider 绑定）→ authorizeUrl；
 * - callback：state 单次消费（条件更新 usedAt）→ 交换 token → 加密入库 → 建/复活 Connection
 *   （providerAccountId 相同 = reconnect：revoked/expired → active + 凭证替换）；
 * - refresh：委托 CredentialService（竞态折叠 + expired 标记）；revoked → 409；
 * - revoke：条件更新 active/expired → revoked（重复 revoke 409）+ best-effort 远端吊销；
 * - 读：全部 userId 首条件（404 防枚举）；响应永不携带凭证字段（DTO 层 select）。
 */
@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger('Connections');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OAuthProvidersService) private readonly providers: OAuthProvidersService,
    @Inject(CredentialService) private readonly credentials: CredentialService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
  ) {}

  private requireProvider(name: string) {
    const provider = this.providers.get(name);
    if (!provider) throw new AppError(ErrorCode.PROVIDER_UNSUPPORTED, '不支持的 Provider');
    return provider;
  }

  async list(userId: string, provider?: string) {
    return this.prisma.connection.findMany({
      where: { userId, ...(provider ? { provider } : {}) },
      orderBy: { createdAt: 'desc' },
      select: CONNECTION_SELECT,
    });
  }

  async get(userId: string, id: string) {
    // M10-P15（BUG-14）：**用户级资源，唯一归属谓词 = `userId`**。
    // 旧实现为 `OR: [{ userId }, { 组织成员 }]`：连接行**永不**挂共享组织（创建时一律挂
    // `ensurePersonalOrganization(userId)`，见 `callback`），却给了"组织成员"分支——只要连接者把
    // 他人邀进自己的个人组织（`invitations` 未拦个人组织），该成员即可读到同事连接的
    // `providerAccountId`/`scope`/`expiresAt`。而 `list`/`refresh`/`revoke`/`remove` 全是 `{ id, userId }`
    // ——读面比写面宽即横向越权（同一组织内的用户间越权）。此处与其余路径对齐：非本人一律 404 防枚举。
    const c = await this.prisma.connection.findFirst({
      where: { id, userId },
      select: CONNECTION_SELECT,
    });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '连接不存在');
    return c;
  }

  /** 发起 OAuth：state 落库（user+project+provider 绑定，10min）→ 返回 authorizeUrl（+state 供测试/mock 回调） */
  async start(userId: string, provider: string, dto: { projectId?: string | null }) {
    this.requireProvider(provider);
    if (dto.projectId) {
      const p = await this.prisma.project.findFirst({ where: { id: dto.projectId, userId, deletedAt: null } });
      if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
    }
    const state = randomBytes(24).toString('hex');
    await this.prisma.oAuthState.create({
      data: {
        userId, provider, state,
        projectId: dto.projectId ?? null,
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      },
    });
    return { authorizeUrl: this.requireProvider(provider).buildAuthorizeUrl(state), state };
  }

  /**
   * OAuth 回调：state 单次消费（usedAt 条件更新 = 唯一赢家；重复/过期/越权 → 400）。
   * 交换成功后：同 (userId, provider, providerAccountId) 已存在 → 复活并替换凭证（reconnect）；
   * 否则新建 Connection。凭证加密入库，响应只含连接投影。
   */
  async callback(userId: string, provider: string, q: { state: string; code: string }) {
    this.requireProvider(provider);
    const row = await this.prisma.oAuthState.findUnique({ where: { state: q.state } });
    if (!row || row.userId !== userId || row.provider !== provider) {
      throw new AppError(ErrorCode.OAUTH_STATE_INVALID, 'OAuth state 无效');
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new AppError(ErrorCode.OAUTH_STATE_EXPIRED, 'OAuth state 已过期，请重新发起');
    }
    // 单次消费：条件更新 usedAt null → now；输家（重复 callback/并发）→ 400
    const consumed = await this.prisma.oAuthState.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (consumed.count === 0) throw new AppError(ErrorCode.OAUTH_STATE_INVALID, 'OAuth state 已使用或已过期');

    const tokens = await this.requireProvider(provider).exchangeCode(q.code); // 失败（PROVIDER_AUTH）向上抛

    // reconnect：同账号已有连接（含 revoked/expired）→ 复活 + 凭证替换；否则新建
    const existing = await this.prisma.connection.findFirst({
      where: { userId, provider, providerAccountId: tokens.providerAccountId },
    });
    if (existing) {
      await this.credentials.store(existing.id, tokens);
      const revived = await this.prisma.connection.update({
        where: { id: existing.id },
        data: { status: 'active', revokedAt: null, projectId: row.projectId ?? existing.projectId, scope: tokens.scope as never },
        select: CONNECTION_SELECT,
      });
      return revived;
    }
    // M8-P1：连接挂组织（缺省 = 个人组织）
    const organizationId = (await this.orgs.ensurePersonalOrganization(userId)).id;
    const connection = await this.prisma.connection.create({
      data: {
        userId, provider, projectId: row.projectId,
        organizationId,
        providerAccountId: tokens.providerAccountId,
        status: 'active', scope: tokens.scope as never,
      },
      select: CONNECTION_SELECT,
    });
    await this.credentials.store(connection.id, tokens);
    this.logger.log({ userId, provider, connectionId: connection.id }, 'OAuth 连接建立');
    await this.audit.write({
      userId, action: 'connection.established', projectId: row.projectId,
      targetType: 'connection', targetId: connection.id, connectionId: connection.id,
      metadata: { provider, providerAccountId: tokens.providerAccountId },
    });
    return connection;
  }

  async refresh(userId: string, id: string) {
    const c = await this.prisma.connection.findFirst({ where: { id, userId }, select: { id: true, status: true } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '连接不存在');
    if (c.status === 'revoked') throw new AppError(ErrorCode.CONNECTION_REVOKED, '连接已吊销，请重新连接');
    await this.credentials.refresh(c.id); // 竞态折叠；失败已附带状态标记
    return this.get(userId, id);
  }

  async revoke(userId: string, id: string) {
    const c = await this.prisma.connection.findFirst({ where: { id, userId }, select: { id: true, status: true, provider: true, projectId: true } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '连接不存在');
    const done = await this.prisma.connection.updateMany({
      where: { id, userId, status: { in: ['active', 'expired'] } },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    if (done.count === 0) throw new AppError(ErrorCode.CONNECTION_REVOKED, '连接已吊销');
    // best-effort 远端吊销（本地状态已以 DB 为准）
    const refreshToken = await this.credentials.getRefreshToken(c.id);
    if (refreshToken) {
      await this.requireProvider(c.provider).revoke(refreshToken).catch(() => undefined);
    }
    this.logger.log({ userId, connectionId: id }, '连接已吊销');
    await this.audit.write({
      userId, action: 'connection.revoked', projectId: c.projectId ?? undefined,
      targetType: 'connection', targetId: id, connectionId: id, metadata: { provider: c.provider },
    });
    return this.get(userId, id);
  }

  async remove(userId: string, id: string) {
    const c = await this.prisma.connection.findFirst({ where: { id, userId }, select: { id: true } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '连接不存在');
    await this.prisma.connection.delete({ where: { id: c.id } }); // credentials 级联删除
    return { deleted: true };
  }
}
