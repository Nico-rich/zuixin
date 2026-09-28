/**
 * M9-P6 发布条目服务（publish / withdraw / reject / revise 状态机 + 平台上架门禁）。
 *
 * 上架门禁（**唯一入口** `assertPublishable`，创建与每次发布都跑；绝不执行 manifest 内容）：
 *   ① 扩展存在 + 归属可管理：组织私有扩展 → 该组织 `agent.write`；平台级扩展 → 平台管理员
 *      （与 M8-P6 `ExtensionsService.assertCanManage` 同口径）；
 *   ② 扩展状态必须为 `published`（draft/deprecated/archived 一律拒绝上架）；
 *   ③ 必须存在 `published` 版本行，且现场复算校验：`parseManifest` 重解析（M8-P6 唯一校验入口）
 *      → checksum 与落库一致（防篡改）→ `verifySignature` 通过（防伪造）——
 *      与 `ExtensionsService.install` 的完整性校验逐字同口径，**绝不复制第二套校验规则**；
 *   ④ 发布者组织由服务端从扩展推导（**绝不接受请求体 organizationId**，防冒名发布）；
 *   ⑤ 平台白名单/权限域/签名等一切"M8-P6 语义"原样保留——Marketplace 只做展示层，绝不放宽任何一条。
 *
 * 状态机：见 marketplace-status.ts（draft→published→rejected；rejected 无直达 published 的边，
 * 必须先 revise 回 draft 再 publish——强制重走门禁）。状态推进一律**条件更新**（updateMany +
 * 当前状态谓词），CAS 失配（并发/状态已变）→ 409 语义的 VALIDATION_ERROR，绝不盲目覆盖。
 */

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { AuditService } from '../audit/audit.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { ExtensionManifest, parseManifest, verifySignature } from '../extensions/manifest';
import { MarketplaceAccessService, PublicationScopeRow } from './marketplace-access.service';
import {
  ChangelogSchema, CompatibilitySchema, CreatePublicationDto, RejectPublicationDto, UpdatePublicationDto,
} from './marketplace.dto';
import { PublicationStatus, assertPublicationTransition } from './marketplace-status';

/** 门禁通过后返回的上下文（供创建/发布复用；permissions 为 manifest 声明的平台权限名） */
export interface PublicationGate {
  extensionId: string;
  extensionSlug: string;
  extensionName: string;
  extensionKind: string;
  versionId: string;
  versionNumber: number;
  publisherOrganizationId: string;
  permissions: string[];
}

/** 条目行（Prisma 生成类型的最小投影——单测可注入纯对象） */
export interface PublicationRow extends PublicationScopeRow {
  id: string;
  category: string;
  description: string;
  changelog: unknown;
  compatibility: unknown;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class PublicationsService {
  /** 平台签名密钥（与 ExtensionsService 同源：ENCRYPTION_KEY；缺失时 verifySignature 必然失败 → fail-closed） */
  private readonly platformKey: string;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrganizationsService) private readonly orgs: OrganizationsService,
    @Inject(MarketplaceAccessService) private readonly access: MarketplaceAccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.platformKey = process.env.ENCRYPTION_KEY ?? '';
  }

  // ===== 门禁 =====

  /**
   * 上架门禁（M9-P6 唯一入口）。绝不执行 manifest 中的任何内容——只做声明式校验与签名验证。
   */
  async assertPublishable(userId: string, extensionId: string): Promise<PublicationGate> {
    const ext = await this.prisma.extension.findUnique({ where: { id: extensionId } });
    if (!ext) throw new AppError(ErrorCode.NOT_FOUND, '扩展不存在');

    let publisherOrganizationId: string;
    if (ext.organizationId) {
      await this.access.requireWrite(userId, ext.organizationId); // 组织私有扩展：本组织 agent.write
      publisherOrganizationId = ext.organizationId;
    } else {
      // 平台级扩展：仅平台管理员可上架（发布者组织 = 其个人组织；客户端无法指定）
      if (!(await this.access.isPlatformAdmin(userId))) {
        throw new AppError(ErrorCode.FORBIDDEN, '平台级扩展仅平台管理员可发布到市场');
      }
      publisherOrganizationId = (await this.orgs.ensurePersonalOrganization(userId)).id;
    }

    if (ext.status !== 'published') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `扩展当前状态为 ${ext.status}，须为 published 才能上架市场`);
    }
    const version = await this.prisma.extensionVersion.findFirst({
      where: { extensionId, status: 'published' }, orderBy: { version: 'desc' },
    });
    if (!version) throw new AppError(ErrorCode.VALIDATION_ERROR, '扩展尚无已发布版本：须先经平台发布（draft 版本不可上架）');

    // 平台校验复算（与 extensions.install 同口径：重解析 + checksum + 签名；任一不符一律拒绝）
    const manifest = version.manifest as unknown as ExtensionManifest;
    const parsed = parseManifest(manifest, { slug: ext.slug });
    if (parsed.checksum !== version.checksum) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '版本校验和不一致（manifest 被篡改）——上架被拒绝');
    }
    if (!verifySignature(version.checksum, version.signature, this.platformKey)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '版本签名无效（未发布或签名不匹配）——上架被拒绝');
    }
    if (manifest.kind !== ext.kind) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'kind 与 manifest.kind 不一致——上架被拒绝');
    }

    return {
      extensionId: ext.id,
      extensionSlug: ext.slug,
      extensionName: ext.name,
      extensionKind: ext.kind,
      versionId: version.id,
      versionNumber: version.version,
      publisherOrganizationId,
      permissions: [...parsed.permissions],
    };
  }

  // ===== 状态机写路径 =====

  /** 创建草稿条目（一扩展一条目：extensionId 唯一）；上架须再调 publish */
  async create(userId: string, dto: CreatePublicationDto): Promise<PublicationRow> {
    const gate = await this.assertPublishable(userId, dto.extensionId);
    const existing = await this.prisma.extensionPublication.findUnique({ where: { extensionId: dto.extensionId } });
    if (existing) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '该扩展已存在发布条目（一扩展一条目：请改为编辑/重新发布）');
    }
    const created = await this.prisma.extensionPublication.create({
      data: {
        organizationId: gate.publisherOrganizationId,
        userId,
        extensionId: dto.extensionId,
        status: 'draft',
        category: dto.category,
        description: dto.description,
        changelog: (dto.changelog ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue,
        compatibility: (dto.compatibility ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue,
      },
    });
    await this.writeAudit(userId, created.organizationId, 'marketplace.publication.create', created.id, {
      extensionId: created.extensionId, category: created.category, status: created.status, version: gate.versionNumber,
    });
    return created as PublicationRow;
  }

  /** 编辑条目元数据：**仅 draft/rejected**（已上架须先撤回，避免公开内容静默变更） */
  async update(userId: string, id: string, dto: UpdatePublicationDto): Promise<PublicationRow> {
    const pub = await this.require(id);
    await this.access.assertPublicationWrite(userId, pub, '发布条目不存在');
    if (pub.status === 'published') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '已上架条目不可直接编辑：请先撤回（withdraw）再修改');
    }
    if (dto.changelog) ChangelogSchema.parse(dto.changelog);
    if (dto.compatibility) CompatibilitySchema.parse(dto.compatibility);
    const updated = await this.prisma.extensionPublication.update({
      where: { id },
      data: {
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.changelog !== undefined ? { changelog: (dto.changelog ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue } : {}),
        ...(dto.compatibility !== undefined ? { compatibility: (dto.compatibility ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue } : {}),
      },
    });
    await this.writeAudit(userId, updated.organizationId, 'marketplace.publication.update', id, { status: updated.status });
    return updated as PublicationRow;
  }

  /** 上架：draft → published（重跑门禁：扩展此刻仍须通过平台校验） */
  async publish(userId: string, id: string): Promise<PublicationRow> {
    const pub = await this.require(id);
    await this.access.assertPublicationWrite(userId, pub, '发布条目不存在');
    const next = assertPublicationTransition(pub.status as PublicationStatus, 'publish');
    const gate = await this.assertPublishable(userId, pub.extensionId);
    if (gate.publisherOrganizationId !== pub.organizationId) {
      // 发布者组织绝不因扩展归属变化而漂移（防"借壳上架"）
      throw new AppError(ErrorCode.VALIDATION_ERROR, '扩展归属与发布者组织不一致——上架被拒绝');
    }
    const updated = await this.casStatus(id, pub.status as PublicationStatus, next);
    await this.writeAudit(userId, updated.organizationId, 'marketplace.publication.publish', id, {
      extensionId: updated.extensionId, version: gate.versionNumber, permissions: gate.permissions,
    });
    return updated;
  }

  /** 撤回：published → draft（作者侧下架；目录立即不可见，可再发布） */
  async withdraw(userId: string, id: string): Promise<PublicationRow> {
    const pub = await this.require(id);
    await this.access.assertPublicationWrite(userId, pub, '发布条目不存在');
    const next = assertPublicationTransition(pub.status as PublicationStatus, 'withdraw');
    const updated = await this.casStatus(id, pub.status as PublicationStatus, next);
    await this.writeAudit(userId, updated.organizationId, 'marketplace.publication.withdraw', id, {});
    return updated;
  }

  /** 修订：rejected → draft（驳回后回草稿；再上架必须重走 publish 门禁） */
  async revise(userId: string, id: string): Promise<PublicationRow> {
    const pub = await this.require(id);
    await this.access.assertPublicationWrite(userId, pub, '发布条目不存在');
    const next = assertPublicationTransition(pub.status as PublicationStatus, 'revise');
    const updated = await this.casStatus(id, pub.status as PublicationStatus, next);
    await this.writeAudit(userId, updated.organizationId, 'marketplace.publication.revise', id, {});
    return updated;
  }

  /**
   * 驳回（治理侧下架）：published → rejected。
   * 治理权经 `access.assertModerationRights`（M10-P6 显式判定：owner/admin 或平台管理员）——
   * 与评审审核**同一判定入口**，绝不各自推导（审计 D7 / M9-02）。
   */
  async reject(userId: string, id: string, dto: RejectPublicationDto): Promise<PublicationRow> {
    const pub = await this.require(id);
    await this.access.assertModerationRights(userId, pub, '发布条目不存在');
    const next = assertPublicationTransition(pub.status as PublicationStatus, 'reject');
    const updated = await this.casStatus(id, pub.status as PublicationStatus, next);
    await this.writeAudit(userId, updated.organizationId, 'marketplace.publication.reject', id, { reason: dto.reason });
    return updated;
  }

  // ===== 读 =====

  private async require(id: string): Promise<PublicationRow> {
    const pub = await this.prisma.extensionPublication.findUnique({ where: { id } });
    if (!pub) throw new AppError(ErrorCode.NOT_FOUND, '发布条目不存在');
    return pub as PublicationRow;
  }

  /** 服务内使用：非成员 404（防枚举）；服务内**不做**权限位判定（调用方已判定） */
  async getRowForAccess(id: string): Promise<PublicationRow> {
    return this.require(id);
  }

  // ===== 内部 =====

  /**
   * 条件更新（CAS）：谓词含"期望的当前状态"，并发/状态已变 → count=0 → 拒绝（绝不盲目覆盖）。
   * 状态推进的唯一落库方式——见顶注"状态推进一律条件更新"。
   */
  private async casStatus(id: string, from: PublicationStatus, to: PublicationStatus): Promise<PublicationRow> {
    const counts = await this.prisma.extensionPublication.updateMany({ where: { id, status: from }, data: { status: to } });
    if (counts.count !== 1) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `发布状态已被并发修改（期望 ${from} → ${to}）`);
    }
    return this.require(id);
  }

  private async writeAudit(
    userId: string, organizationId: string, action: string, targetId: string, metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.write({
      userId, organizationId, action, targetType: 'extension_publication', targetId, metadata,
    }).catch(() => undefined); // best-effort：审计失败绝不阻断主流程
  }
}
