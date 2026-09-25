import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../organizations/authorization.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { ToolRegistry } from '../../core/tools/tool-registry.service';
import { Tool } from '../../core/tools/tool.types';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { DnsResolver, SSRF_RESOLVER, assertSafeUrl } from '../security/ssrf-guard';
import {
  EXTENSION_KINDS, ExtensionKind, ExtensionManifest, ExtensionPermissionName, WRAPPABLE_TOOL_PERMISSIONS,
  checkParamConstraints, parseManifest, renderAgentPrompt, signChecksum, verifySignature, zodObjectKeys,
} from './manifest';

/**
 * M8-P6 Extension SDK —— 扩展注册表 / 安装 / 声明式物化。
 *
 * 安全边界（贯穿全服务）：
 * - **绝不执行任意第三方代码**：扩展只有声明式 manifest；"生效"= 包装平台已有工具（输入约束前置校验后透传，
 *   ToolContext 不变、权限不提升）/ 创建平台 Agent/Provider 行 / 返回步骤模板声明；
 * - 版本不可变：draft → published（签名）→ deprecated → archived，绝不逆向；published 版本行永不 UPDATE 内容；
 * - 安装版本锁定：ExtensionInstallation.versionId 固定，绝不漂移（升级 = 显式重新 install）；
 * - 权限：平台白名单 + kind 能力域；安装需组织 agent.write；平台级扩展仅平台管理员可管理；
 * - 凭证：manifest 绝不携带；provider 类安装时由组织 config 提供 → CryptoService AES-256-GCM 加密落库。
 */
@Injectable()
export class ExtensionsService implements OnModuleInit {
  private readonly logger = new Logger('Extensions');
  /** 本进程已注册的扩展工具（重启后为空 → onModuleInit 自愈重建） */
  private readonly registeredTools = new Map<string, { installationId: string; extensionId: string; versionId: string }>();
  private readonly platformKey: string;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    // M8-P8：provider baseUrl 的 DNS 层 SSRF 校验（解析器可替换；@Optional 保持最小可构造性）
    @Optional() @Inject(SSRF_RESOLVER) private readonly dnsResolver?: DnsResolver,
  ) {
    this.platformKey = process.env.ENCRYPTION_KEY ?? '';
  }

  /** 启动自愈：重新注册全部 enabled tool 类安装（进程重启后注册表为空 → 由 DB 事实重建） */
  async onModuleInit(): Promise<void> {
    try {
      await this.reconcile();
    } catch (err) {
      this.logger.error(`扩展工具启动加载失败（不影响启动）：${(err as Error).message}`);
    }
  }

  // ===== 可见性 / 授权 =====

  /** 平台级扩展（organizationId=null）仅平台管理员可管理；组织私有扩展需该组织 agent.write */
  private async assertCanManage(userId: string, organizationId: string | null): Promise<void> {
    if (organizationId) {
      await this.authz.authorize(userId, organizationId, 'agent.write');
      return;
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user || user.role !== 'admin') throw new AppError(ErrorCode.FORBIDDEN, '平台级扩展仅平台管理员可管理');
  }

  /** 目标组织可见性：平台级扩展所有组织可见；组织私有扩展仅该组织可见（跨组织 404 防枚举） */
  private assertVisible(ext: { organizationId: string | null }, organizationId: string): void {
    if (ext.organizationId && ext.organizationId !== organizationId) throw new AppError(ErrorCode.NOT_FOUND, '扩展不存在');
  }

  /** organizationId 必填（防 undefined 退化成"任意组织"——多租户边界） */
  private requireOrgId(organizationId: string | undefined | null): string {
    if (!organizationId || typeof organizationId !== 'string') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '缺少 organizationId');
    }
    return organizationId;
  }

  private async requireExtension(id: string) {
    const ext = await this.prisma.extension.findUnique({ where: { id } });
    if (!ext) throw new AppError(ErrorCode.NOT_FOUND, '扩展不存在');
    return ext;
  }

  private async requireInstallation(extensionId: string, organizationId: string) {
    const installation = await this.prisma.extensionInstallation.findUnique({
      where: { organizationId_extensionId: { organizationId, extensionId } },
    });
    if (!installation) throw new AppError(ErrorCode.NOT_FOUND, '扩展未安装');
    return installation;
  }

  // ===== 声明校验（含平台资源引用）=====

  /** 平台工具引用校验：必须存在、非扩展工具（禁止扩展链）、权限可包装（只读/写入/生成） */
  private requirePlatformTool(name: string): Tool {
    if (name.startsWith('ext.')) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '扩展 manifest 非法：不得引用其它扩展工具（禁止扩展链）');
    }
    const tool = this.registry.get(name);
    if (!tool) throw new AppError(ErrorCode.VALIDATION_ERROR, `扩展 manifest 非法：平台工具不存在 ${name}`);
    if (!(WRAPPABLE_TOOL_PERMISSIONS as readonly string[]).includes(tool.permission)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `扩展 manifest 非法：工具 ${name}（permission=${tool.permission}）不可被扩展包装`);
    }
    return tool;
  }

  private validateRefs(manifest: ExtensionManifest): void {
    if (manifest.kind === 'tool' && manifest.tool) {
      const base = this.requirePlatformTool(manifest.tool.baseTool);
      const keys = zodObjectKeys(base.inputSchema);
      for (const param of Object.keys(manifest.tool.paramConstraints ?? {})) {
        if (keys && !keys.includes(param)) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, `扩展 manifest 非法：paramConstraints 引用了 baseTool 不存在的参数 ${param}`);
        }
      }
    }
    if (manifest.kind === 'agent' && manifest.agent) {
      for (const name of manifest.agent.tools) this.requirePlatformTool(name);
    }
    if (manifest.kind === 'workflow_step' && manifest.workflow_step) {
      const params = manifest.workflow_step.params as { toolName?: unknown };
      if (manifest.workflow_step.stepType === 'tool' && typeof params.toolName === 'string') this.requirePlatformTool(params.toolName);
    }
  }

  private parse(raw: unknown, slug: string) {
    const parsed = parseManifest(raw, { slug });
    this.validateRefs(parsed.manifest);
    return parsed;
  }

  // ===== CRUD / 版本状态机 =====

  async create(userId: string, input: {
    organizationId?: string | null; name: string; slug: string; description?: string; kind: ExtensionKind; manifest: unknown;
  }) {
    const organizationId = input.organizationId ?? null;
    await this.assertCanManage(userId, organizationId);
    if (!EXTENSION_KINDS.includes(input.kind)) throw new AppError(ErrorCode.VALIDATION_ERROR, '扩展 kind 非法');
    const parsed = this.parse(input.manifest, input.slug);
    if (parsed.manifest.kind !== input.kind) throw new AppError(ErrorCode.VALIDATION_ERROR, 'kind 与 manifest.kind 不一致');

    const dup = await this.prisma.extension.findUnique({ where: { slug: input.slug } });
    if (dup) throw new AppError(ErrorCode.VALIDATION_ERROR, '扩展 slug 已存在');

    const extension = await this.prisma.extension.create({
      data: {
        organizationId, ownerUserId: userId, name: input.name, slug: input.slug,
        description: input.description ?? null, kind: input.kind, status: 'draft',
      },
    });
    const version = await this.prisma.extensionVersion.create({
      data: {
        extensionId: extension.id, version: 1, status: 'draft',
        manifest: parsed.manifest as unknown as Prisma.InputJsonValue,
        checksum: parsed.checksum, signature: null,
      },
    });
    await this.materializePermissions(version.id, parsed.permissions);
    return { extension, version: await this.prisma.extensionVersion.findUnique({ where: { id: version.id }, include: { permissions: true } }) };
  }

  /** 更新 = 新版本 draft（published/archived 版本行永不被修改） */
  async update(userId: string, id: string, input: { name?: string; description?: string; manifest?: unknown }) {
    const ext = await this.requireExtension(id);
    await this.assertCanManage(userId, ext.organizationId);
    if (ext.status === 'archived') throw new AppError(ErrorCode.VALIDATION_ERROR, '已归档扩展不可再修改');

    let versionId: string | undefined;
    if (input.manifest !== undefined) {
      const parsed = this.parse(input.manifest, ext.slug);
      if (parsed.manifest.kind !== ext.kind) throw new AppError(ErrorCode.VALIDATION_ERROR, 'kind 与 manifest.kind 不一致');
      const draft = await this.prisma.extensionVersion.findFirst({ where: { extensionId: id, status: 'draft' }, orderBy: { version: 'desc' } });
      if (draft) {
        // 仅更新 draft 行（且置空签名——发布时重算/重签）
        await this.prisma.extensionVersion.update({
          where: { id: draft.id },
          data: { manifest: parsed.manifest as unknown as Prisma.InputJsonValue, checksum: parsed.checksum, signature: null },
        });
        versionId = draft.id;
      } else {
        const max = await this.prisma.extensionVersion.aggregate({ where: { extensionId: id }, _max: { version: true } });
        const created = await this.prisma.extensionVersion.create({
          data: {
            extensionId: id, version: (max._max.version ?? 0) + 1, status: 'draft',
            manifest: parsed.manifest as unknown as Prisma.InputJsonValue, checksum: parsed.checksum, signature: null,
          },
        });
        versionId = created.id;
      }
      await this.materializePermissions(versionId, parsed.permissions);
    }
    const extension = await this.prisma.extension.update({
      where: { id },
      data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}) },
    });
    const version = versionId
      ? await this.prisma.extensionVersion.findUnique({ where: { id: versionId }, include: { permissions: true } })
      : null;
    return { extension, version };
  }

  /** 发布：draft → published + HMAC 签名（checksum 摘要 + 平台密钥）；旧 published → archived（版本仍锁定） */
  async publish(userId: string, id: string, versionId?: string) {
    const ext = await this.requireExtension(id);
    await this.assertCanManage(userId, ext.organizationId);
    if (ext.status === 'archived') throw new AppError(ErrorCode.VALIDATION_ERROR, '已归档扩展不可发布（状态机绝不逆向）');

    const target = versionId
      ? await this.prisma.extensionVersion.findFirst({ where: { id: versionId, extensionId: id } })
      : await this.prisma.extensionVersion.findFirst({ where: { extensionId: id, status: 'draft' }, orderBy: { version: 'desc' } });
    if (!target) throw new AppError(ErrorCode.VALIDATION_ERROR, '没有可发布的版本');
    if (target.status !== 'draft') throw new AppError(ErrorCode.VALIDATION_ERROR, `只有 draft 版本可发布（当前 ${target.status}）`);

    // 发布前重新校验（平台工具在 draft 期间可能已被移除）
    const parsed = this.parse(target.manifest, ext.slug);
    // 签名 = HMAC(manifest checksum, 平台密钥)；checksum 与落库 manifest 必须同源（install 会复算比对）
    const checksum = parsed.checksum;
    const signature = signChecksum(checksum, this.platformKey);

    await this.prisma.$transaction([
      this.prisma.extensionVersion.updateMany({ where: { extensionId: id, status: 'published' }, data: { status: 'archived' } }),
      this.prisma.extensionVersion.update({
        where: { id: target.id },
        data: { status: 'published', checksum, signature, manifest: parsed.manifest as unknown as Prisma.InputJsonValue },
      }),
      this.prisma.extension.update({ where: { id }, data: { status: 'published' } }),
    ]);
    await this.materializePermissions(target.id, parsed.permissions);
    return this.prisma.extensionVersion.findUnique({ where: { id: target.id }, include: { permissions: true } });
  }

  async deprecate(userId: string, id: string) {
    const ext = await this.requireExtension(id);
    await this.assertCanManage(userId, ext.organizationId);
    if (ext.status !== 'published') throw new AppError(ErrorCode.VALIDATION_ERROR, `只有 published 扩展可弃用（当前 ${ext.status}）`);
    const updated = await this.prisma.extension.update({ where: { id }, data: { status: 'deprecated' } });
    await this.reconcile(); // 弃用即下线：tool 类扩展从注册表移除
    return updated;
  }

  async archive(userId: string, id: string) {
    const ext = await this.requireExtension(id);
    await this.assertCanManage(userId, ext.organizationId);
    if (ext.status !== 'published' && ext.status !== 'deprecated') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `只有 published/deprecated 扩展可归档（当前 ${ext.status}）`);
    }
    const updated = await this.prisma.extension.update({ where: { id }, data: { status: 'archived' } });
    await this.reconcile();
    return updated;
  }

  // ===== 查询（org 可见：平台级 + 本组织私有 + 已安装）=====

  async list(userId: string, organizationId: string) {
    this.requireOrgId(organizationId);
    await this.authz.authorize(userId, organizationId, 'agent.read');
    const extensions = await this.prisma.extension.findMany({
      where: { OR: [{ organizationId: null }, { organizationId }] },
      include: { versions: { orderBy: { version: 'desc' }, include: { permissions: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const installations = await this.prisma.extensionInstallation.findMany({ where: { organizationId } });
    const byExt = new Map(installations.map((i) => [i.extensionId, i]));
    return extensions.map((e) => ({ ...e, installation: byExt.get(e.id) ?? null }));
  }

  /** 市场目录：仅已发布（平台级 + 本组织私有）；含安装状态与当前锁定版本 */
  async catalog(userId: string, organizationId: string) {
    this.requireOrgId(organizationId);
    await this.authz.authorize(userId, organizationId, 'organization.read');
    const extensions = await this.prisma.extension.findMany({
      where: { status: 'published', OR: [{ organizationId: null }, { organizationId }] },
      include: { versions: { where: { status: 'published' }, orderBy: { version: 'desc' }, include: { permissions: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const installations = await this.prisma.extensionInstallation.findMany({ where: { organizationId } });
    const byExt = new Map(installations.map((i) => [i.extensionId, i]));
    return extensions.map((e) => ({
      id: e.id, name: e.name, slug: e.slug, description: e.description, kind: e.kind,
      scope: e.organizationId ? 'organization' : 'platform',
      publishedVersion: e.versions[0] ?? null,
      installation: byExt.get(e.id) ?? null,
    }));
  }

  async get(userId: string, id: string, organizationId: string) {
    this.requireOrgId(organizationId);
    await this.authz.authorize(userId, organizationId, 'agent.read');
    const ext = await this.requireExtension(id);
    this.assertVisible(ext, organizationId);
    const versions = await this.prisma.extensionVersion.findMany({
      where: { extensionId: id }, include: { permissions: true }, orderBy: { version: 'desc' },
    });
    const installation = await this.prisma.extensionInstallation.findUnique({
      where: { organizationId_extensionId: { organizationId, extensionId: id } },
    });
    return { ...ext, versions, installation: installation ?? null };
  }

  async installations(userId: string, organizationId: string) {
    this.requireOrgId(organizationId);
    await this.authz.authorize(userId, organizationId, 'agent.read');
    const rows = await this.prisma.extensionInstallation.findMany({ where: { organizationId }, orderBy: { installedAt: 'desc' } });
    const extensions = await this.prisma.extension.findMany({ where: { id: { in: rows.map((r) => r.extensionId) } } });
    const versions = await this.prisma.extensionVersion.findMany({ where: { id: { in: rows.map((r) => r.versionId) } } });
    const extById = new Map(extensions.map((e) => [e.id, e]));
    const verById = new Map(versions.map((v) => [v.id, v]));
    return rows.map((r) => ({
      ...r,
      extension: extById.get(r.extensionId) ?? null,
      // 版本锁定：安装行只回显锁定版本（绝不跟随最新发布）
      pinnedVersion: verById.get(r.versionId) ?? null,
    }));
  }

  /** workflow_step 类安装的步骤模板（供创建 workflow 时引用；本 Phase 不改执行器） */
  async stepTemplates(userId: string, organizationId: string) {
    this.requireOrgId(organizationId);
    await this.authz.authorize(userId, organizationId, 'agent.read');
    const rows = await this.prisma.extensionInstallation.findMany({ where: { organizationId, status: 'enabled' } });
    const exts = await this.prisma.extension.findMany({
      where: { id: { in: rows.map((r) => r.extensionId) }, kind: 'workflow_step', status: 'published' },
    });
    const versions = await this.prisma.extensionVersion.findMany({ where: { id: { in: rows.map((r) => r.versionId) } } });
    const verById = new Map(versions.map((v) => [v.id, v]));
    return rows
      .map((r) => ({ installation: r, ext: exts.find((e) => e.id === r.extensionId), version: verById.get(r.versionId) }))
      .filter((x) => x.ext && x.version)
      .map((x) => {
        const manifest = x.version!.manifest as unknown as ExtensionManifest;
        return {
          extensionId: x.ext!.id, extensionSlug: x.ext!.slug, versionId: x.version!.id, version: x.version!.version,
          name: manifest.workflow_step!.name, stepType: manifest.workflow_step!.stepType,
          description: manifest.workflow_step!.description ?? null, params: manifest.workflow_step!.params ?? {},
          permissions: manifest.permissions,
        };
      });
  }

  // ===== 安装 / 启用 / 卸载 =====

  async install(userId: string, id: string, input: { organizationId: string; versionId?: string; config?: Record<string, unknown> }) {
    await this.authz.authorize(userId, input.organizationId, 'agent.write');
    const ext = await this.requireExtension(id);
    this.assertVisible(ext, input.organizationId);

    const version = input.versionId
      ? await this.prisma.extensionVersion.findFirst({ where: { id: input.versionId, extensionId: id } })
      : await this.prisma.extensionVersion.findFirst({ where: { extensionId: id, status: 'published' }, orderBy: { version: 'desc' } });
    if (!version) throw new AppError(ErrorCode.VALIDATION_ERROR, '没有可安装的已发布版本');
    if (version.status !== 'published') throw new AppError(ErrorCode.VALIDATION_ERROR, '未发布版本不可安装');

    // 完整性校验：checksum 必须与 manifest 内容一致 + 发布签名必须有效（防篡改/防伪造）
    const manifest = version.manifest as unknown as ExtensionManifest;
    const parsed = this.parse(manifest, ext.slug);
    if (parsed.checksum !== version.checksum) throw new AppError(ErrorCode.VALIDATION_ERROR, '版本校验和不一致（manifest 被篡改）');
    if (!verifySignature(version.checksum, version.signature, this.platformKey)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '版本签名无效（未发布或签名不匹配）');
    }
    if (manifest.kind !== ext.kind) throw new AppError(ErrorCode.VALIDATION_ERROR, 'kind 与 manifest.kind 不一致');

    await this.materializePermissions(version.id, parsed.permissions);
    const safeConfig = this.sanitizeInstallConfig(input.config);

    const installation = await this.prisma.extensionInstallation.upsert({
      where: { organizationId_extensionId: { organizationId: input.organizationId, extensionId: id } },
      create: {
        organizationId: input.organizationId, extensionId: id, versionId: version.id, status: 'enabled',
        config: safeConfig as unknown as Prisma.InputJsonValue, installedByUserId: userId,
      },
      // 显式升级：重新 install 才切换锁定版本（installation 绝不自动漂移）
      update: { versionId: version.id, status: 'enabled', config: safeConfig as unknown as Prisma.InputJsonValue },
    });

    const materialized = await this.materialize(installation.id, ext, version.id, manifest, input.organizationId, input.config);
    await this.reconcile();
    return { installation, materialized, permissions: parsed.permissions };
  }

  async uninstall(userId: string, id: string, organizationId: string) {
    await this.authz.authorize(userId, organizationId, 'agent.write');
    const ext = await this.requireExtension(id);
    this.assertVisible(ext, organizationId);
    const installation = await this.requireInstallation(id, organizationId);
    await this.prisma.extensionInstallation.delete({ where: { id: installation.id } });
    // 物化资源"标记"失效而非删除：AgentRun/GenerationTask 有 FK 引用（保留审计与血缘）
    await this.deactivateMaterialized(ext, organizationId);
    await this.reconcile();
    return { uninstalled: true, extensionId: id, organizationId };
  }

  async setEnabled(userId: string, id: string, organizationId: string, enabled: boolean) {
    await this.authz.authorize(userId, organizationId, 'agent.write');
    const ext = await this.requireExtension(id);
    this.assertVisible(ext, organizationId);
    const installation = await this.requireInstallation(id, organizationId);
    const nextStatus = enabled ? 'enabled' : 'disabled';
    if (installation.status === nextStatus) {
      await this.reconcile();
      return installation;
    }
    const updated = await this.prisma.extensionInstallation.update({ where: { id: installation.id }, data: { status: nextStatus } });
    const version = await this.prisma.extensionVersion.findUnique({ where: { id: installation.versionId } });
    if (enabled) {
      if (version) await this.materialize(installation.id, ext, version.id, version.manifest as unknown as ExtensionManifest, organizationId);
    } else {
      await this.deactivateMaterialized(ext, organizationId);
    }
    await this.reconcile();
    return updated;
  }

  // ===== 物化（声明式生效）=====

  private async materialize(
    installationId: string, ext: { id: string; slug: string; name: string; description: string | null; kind: string },
    versionId: string, manifest: ExtensionManifest, organizationId: string, installConfig?: Record<string, unknown>,
  ): Promise<{ kind: string; toolName?: string; agentId?: string; providerId?: string }> {
    switch (manifest.kind) {
      case 'tool':
        // tool 类由注册表回收函数（reconcile）统一注册——调用方在本方法后执行
        return { kind: 'tool', toolName: manifest.tool!.name };
      case 'agent': {
        const agentId = await this.materializeAgent(ext, versionId, manifest, organizationId);
        return { kind: 'agent', agentId };
      }
      case 'provider': {
        const providerId = await this.materializeProvider(ext, versionId, manifest, organizationId, installConfig);
        return { kind: 'provider', providerId };
      }
      case 'workflow_step':
        // 只登记声明：模板由 GET /extensions/steps 查询（不执行）
        return { kind: 'workflow_step' };
      default:
        throw new AppError(ErrorCode.VALIDATION_ERROR, `未知扩展 kind: ${manifest.kind}`);
    }
  }

  /** agent 类：物化为组织私有 Agent（scope=organization, kind=custom）+ 已发布 AgentVersion */
  private async materializeAgent(
    ext: { id: string; slug: string; name: string; description: string | null },
    versionId: string, manifest: ExtensionManifest, organizationId: string,
  ): Promise<string> {
    const block = manifest.agent!;
    const slug = extensionAgentSlug(ext.slug, organizationId);
    const systemPrompt = renderAgentPrompt(block.systemPrompt, {
      'extension.name': ext.name,
      'extension.slug': ext.slug,
      'extension.description': ext.description ?? '',
      'organization.id': organizationId,
    });

    const existing = await this.prisma.agent.findUnique({ where: { slug }, include: { activeVersion: true } });
    if (!existing) {
      const agent = await this.prisma.agent.create({
        data: {
          slug, name: block.name, description: block.description, kind: 'custom', scope: 'organization',
          organizationId, enabled: true,
        },
      });
      const created = await this.prisma.agentVersion.create({
        data: {
          agentId: agent.id, version: 1, status: 'published', systemPrompt, tools: block.tools,
          temperature: 0.7, config: { extensionId: ext.id, extensionVersion: versionId },
        },
      });
      await this.prisma.agent.update({ where: { id: agent.id }, data: { activeVersionId: created.id } });
      return agent.id;
    }

    // 幂等：同一锁定版本重复 install → 不新建版本行（版本不可变、无谓漂移）
    const current = existing.activeVersion;
    const currentConfig = (current?.config ?? {}) as { extensionVersion?: string };
    if (current && currentConfig.extensionVersion === versionId) {
      await this.prisma.agent.update({ where: { id: existing.id }, data: { enabled: true } });
      return existing.id;
    }
    const max = await this.prisma.agentVersion.aggregate({ where: { agentId: existing.id }, _max: { version: true } });
    const created = await this.prisma.agentVersion.create({
      data: {
        agentId: existing.id, version: (max._max.version ?? 0) + 1, status: 'draft', systemPrompt, tools: block.tools,
        temperature: 0.7, config: { extensionId: ext.id, extensionVersion: versionId },
      },
    });
    await this.prisma.$transaction([
      this.prisma.agentVersion.updateMany({ where: { agentId: existing.id, status: 'published' }, data: { status: 'archived' } }),
      this.prisma.agentVersion.update({ where: { id: created.id }, data: { status: 'published' } }),
      this.prisma.agent.update({ where: { id: existing.id }, data: { activeVersionId: created.id, enabled: true } }),
    ]);
    return existing.id;
  }

  /** provider 类：物化 Provider + Model 行（apiKey 由组织安装 config 提供并加密落库） */
  private async materializeProvider(
    ext: { id: string; slug: string; name: string },
    versionId: string, manifest: ExtensionManifest, organizationId: string, installConfig?: Record<string, unknown>,
  ): Promise<string> {
    const block = manifest.provider!;
    // M8-P8 SSRF：manifest 解析阶段已做同步白名单校验（协议/主机名/IP 字面量）；
    // 此处补 DNS 解析层校验——公网域名解析到私网/回环/link-local（含 169.254.169.254 metadata）一律拒绝。
    // 说明：平台不跟随重定向；provider 调用侧不得启用自动重定向（见 docs/security/m8-security-audit.md SSRF 节）。
    await assertSafeUrl(block.baseUrl, { ...(this.dnsResolver ? { resolve: this.dnsResolver } : {}) });
    const apiKey = typeof installConfig?.apiKey === 'string' ? installConfig.apiKey.trim() : '';
    const orgHash = hashSuffix(organizationId);
    // Provider 表无组织列（平台级资源）→ 以确定性命名隔离各组织安装实例
    const providerName = `${block.name} [ext:${ext.slug}:${orgHash}]`;

    let provider = await this.prisma.provider.findFirst({ where: { name: providerName } });
    // 首次安装必须由组织提供密钥；重新启用（enable）复用已加密落库的密钥（绝不明文回显/重复索取）
    const apiKeyEncrypted = apiKey ? this.crypto.encrypt(apiKey) : (provider?.apiKeyEncrypted ?? '');
    if (!apiKeyEncrypted) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'provider 类扩展安装必须由组织提供 config.apiKey（manifest 绝不携带密钥）');
    }
    if (!provider) {
      provider = await this.prisma.provider.create({
        data: {
          name: providerName, type: block.models[0].type, adapter: 'openai-compatible', baseUrl: block.baseUrl,
          apiKeyEncrypted, enabled: true, healthStatus: 'untested',
          retryConfig: { extensionId: ext.id, extensionVersion: versionId, organizationId },
        },
      });
    } else {
      provider = await this.prisma.provider.update({
        where: { id: provider.id },
        data: { adapter: 'openai-compatible', baseUrl: block.baseUrl, apiKeyEncrypted, enabled: true },
      });
    }

    const declaredIds = block.models.map((m) => m.apiModelId);
    for (const m of block.models) {
      const existing = await this.prisma.model.findFirst({ where: { providerId: provider.id, apiModelId: m.apiModelId } });
      if (existing) {
        await this.prisma.model.update({ where: { id: existing.id }, data: { name: m.name, type: m.type, enabled: m.enabled ?? true } });
      } else {
        await this.prisma.model.create({
          data: { providerId: provider.id, name: m.name, apiModelId: m.apiModelId, type: m.type, enabled: m.enabled ?? true },
        });
      }
    }
    // 声明外的模型：禁用（绝不删除——历史任务/用量有 FK 引用）
    await this.prisma.model.updateMany({
      where: { providerId: provider.id, apiModelId: { notIn: declaredIds } }, data: { enabled: false },
    });
    return provider.id;
  }

  /** 物化资源失效（卸载/禁用）：标记而非删除 */
  private async deactivateMaterialized(ext: { slug: string; kind: string }, organizationId: string): Promise<void> {
    if (ext.kind === 'agent') {
      await this.prisma.agent.updateMany({ where: { slug: extensionAgentSlug(ext.slug, organizationId) }, data: { enabled: false } });
    }
    if (ext.kind === 'provider') {
      const providers = await this.prisma.provider.findMany({ where: { name: { contains: `[ext:${ext.slug}:${hashSuffix(organizationId)}]` } } });
      for (const p of providers) {
        await this.prisma.provider.update({ where: { id: p.id }, data: { enabled: false } });
        await this.prisma.model.updateMany({ where: { providerId: p.id }, data: { enabled: false } });
      }
    }
  }

  /** 权限行物化（版本级；幂等 upsert + 清理已移除的权限） */
  private async materializePermissions(versionId: string, permissions: ExtensionPermissionName[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.extensionPermission.deleteMany({ where: { versionId, name: { notIn: permissions } } }),
      ...permissions.map((name) => this.prisma.extensionPermission.upsert({
        where: { versionId_name: { versionId, name } },
        create: { versionId, name, scope: 'organization', description: PERMISSION_DESCRIPTIONS[name] ?? null },
        update: {},
      })),
    ]);
  }

  /** 安装 config 落库前脱敏：密钥字段一律不入库（provider 的 apiKey 已单独加密写 Provider 表） */
  private sanitizeInstallConfig(config?: Record<string, unknown>): Record<string, unknown> {
    if (!config) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config)) {
      if (/(api[-_]?key|apikey|secret|token|password|passwd|credential|private[-_]?key)/i.test(k)) continue;
      out[k] = v;
    }
    return out;
  }

  // ===== 工具物化 / 注册表回收 =====

  /**
   * 注册表回收（幂等、可重入）：
   * - 期望集合 = status=enabled 且扩展 status=published 且锁定版本 status=published 的 tool 类安装；
   * - 同一工具名多个安装实例（多组织）→ 注册一次（包装体与 base 工具的访问控制由 ToolContext 保证）；
   * - 与已注册集合求差：移除不再需要的 + 注册缺失/锁定版本变化的。
   */
  async reconcile(): Promise<void> {
    const installations = await this.prisma.extensionInstallation.findMany({ where: { status: 'enabled' }, orderBy: { installedAt: 'asc' } });
    if (!installations.length && !this.registeredTools.size) return;
    const extensions = await this.prisma.extension.findMany({
      where: { id: { in: installations.map((i) => i.extensionId) }, status: 'published', kind: 'tool' },
    });
    const versions = await this.prisma.extensionVersion.findMany({
      where: { id: { in: installations.map((i) => i.versionId) }, status: 'published' },
    });
    const extById = new Map(extensions.map((e) => [e.id, e]));
    const verById = new Map(versions.map((v) => [v.id, v]));

    const desired = new Map<string, { installationId: string; extensionId: string; versionId: string; manifest: ExtensionManifest }>();
    for (const inst of installations) {
      const ext = extById.get(inst.extensionId);
      const version = verById.get(inst.versionId);
      if (!ext || !version) continue;
      const manifest = version.manifest as unknown as ExtensionManifest;
      if (manifest?.kind !== 'tool' || !manifest.tool) continue;
      if (!desired.has(manifest.tool.name)) {
        desired.set(manifest.tool.name, { installationId: inst.id, extensionId: ext.id, versionId: version.id, manifest });
      }
    }

    for (const [name, entry] of [...this.registeredTools]) {
      const want = desired.get(name);
      if (!want || want.versionId !== entry.versionId || want.installationId !== entry.installationId) {
        this.registry.unregister(name);
        this.registeredTools.delete(name);
      }
    }

    for (const [name, want] of desired) {
      if (this.registeredTools.has(name)) continue;
      const base = this.registry.get(want.manifest.tool!.baseTool);
      if (!base) {
        this.logger.warn(`扩展工具 ${name} 的 baseTool ${want.manifest.tool!.baseTool} 不存在，跳过注册`);
        continue;
      }
      try {
        this.registry.register(this.buildWrappedTool(name, want.manifest, base));
        this.registeredTools.set(name, { installationId: want.installationId, extensionId: want.extensionId, versionId: want.versionId });
      } catch (err) {
        this.logger.warn(`扩展工具注册失败 ${name}: ${(err as Error).message}`);
      }
    }
  }

  /** 声明式包装：输入约束前置校验 → 透传 baseTool（ToolContext 不变、权限不提升、绝不注入代码） */
  private buildWrappedTool(name: string, manifest: ExtensionManifest, base: Tool): Tool {
    const block = manifest.tool!;
    const constraints = block.paramConstraints;
    return {
      name,
      description: block.description,
      inputSchema: base.inputSchema,
      outputSchema: base.outputSchema,
      permission: base.permission,              // 绝不提升：沿用平台工具的权限位
      requiresApproval: base.requiresApproval,
      timeoutMs: base.timeoutMs,
      retryPolicy: base.retryPolicy,
      execute: async (input: unknown, ctx) => {
        const violation = checkParamConstraints(constraints, input);
        if (violation) throw new AppError(ErrorCode.VALIDATION_ERROR, `扩展参数约束拒绝：${violation}`);
        return base.execute(input, ctx);
      },
    };
  }

  /** 当前已注册的扩展工具名（可观测性/测试） */
  registeredToolNames(): string[] {
    return [...this.registeredTools.keys()];
  }
}

/** 组织内 Agent slug（Agent.slug 全局唯一 → 以 org 哈希后缀隔离） */
export function extensionAgentSlug(extensionSlug: string, organizationId: string): string {
  return `ext-${extensionSlug}-${hashSuffix(organizationId)}`;
}

function hashSuffix(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'tool.execute': '以调用者身份执行被包装的平台工具',
  'agent.run': '创建并运行扩展 Agent（平台 Agent 体系）',
  'provider.call': '调用扩展声明的 openai-compatible provider',
  'workflow.step': '在 workflow 定义中引用扩展步骤模板',
  'config.read': '读取安装配置（非密钥部分）',
  'config.write': '写入安装配置（非密钥部分）',
};
