import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../../core/crypto/crypto.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { ProviderPatch, ProviderPatchSchema } from './providers-admin.schema';
import { isMockAdapter } from '../security/provider-base-url.guard';
import { checkUrlSync } from '../security/ssrf-guard';
import { LLMManagerService } from '../../providers/llm/llm-manager.service';
import { ImageManagerService } from '../../providers/image/image-manager.service';
import { VideoManagerService } from '../../providers/video/video-manager.service';
import { EmbeddingManagerService } from '../../providers/embedding/embedding-manager.service';

/** GET 投影（手写字段——**绝不回显 apiKeyEncrypted**；行内含密文，投影即安全边界） */
export interface ProviderModelView {
  id: string; name: string; apiModelId: string; type: string; enabled: boolean; priority: number;
  isDefault: boolean; contextWindow: number | null;
  inputPrice: number; outputPrice: number; unitPrice: number; capabilities: unknown;
}
export interface ProviderView {
  id: string; name: string; type: string; adapter: string; baseUrl: string;
  enabled: boolean; priority: number; timeoutMs: number;
  /** apiKeyEncrypted !== ''（只回布尔；**绝不回显任何形式的 Key**） */
  hasKey: boolean;
  /** 密文版本（轮换运维用；取自自描述密文，无任何明文/密文泄漏） */
  keyVersion: number | null;
  healthStatus: string;
  /** 内存 adapter 是否已建（false = 已停用或加载失败） */
  loaded: boolean;
  /** 加载失败归因（provider-degradation 记录；未加载且无归因 = 已停用等其它情形） */
  degradedReason: string | null;
  /** 扩展托管（只回布尔，绝不回 org 哈希等行内细节） */
  managedByExtension: boolean;
  models: ProviderModelView[];
  createdAt: Date; updatedAt: Date;
}

/** 四个 manager 的最小共用面（providers-admin 只依赖 refresh + providerStatus） */
type ProviderManagerLike = { refresh(): Promise<void>; providerStatus(id: string): { loaded: boolean; degradedReason: string | null } };

/**
 * M13+（模型配置页）Provider 管理面（**平台管理员**）。
 *
 * 边界（红线）：
 * - RBAC = 仅平台管理员（DB 权威 role='admin'，与 system-settings 同口径）；组织 owner/admin 一律 403；
 * - **只写不回读**：apiKey 明文只存在于本次调用栈（加密落库 → 审计/日志/响应零明文）；
 *   读取面只有 hasKey/keyVersion（自描述密文的版本号），绝无任何回显路径；
 * - 不可变面：type/adapter/name/healthStatus 不可写（strict schema 结构性保证）；
 * - baseUrl 写时走 SSRF **同步**判定（协议 allowlist/凭证/主机名/IP 字面量；刻意不做 DNS——
 *   离线/CI 不应误杀保存；调用期的 assertProviderBaseUrlSafe 仍是 fail-closed 权威闸门）；
 * - 每次写入**强制审计**（action=provider.update；best-effort，审计面降级绝不阻断配置生效）；
 * - 写库成功后按 type 调对应 manager.refresh() **热生效**（无重启）；
 * - LLM/Agent 无任何写路径（ToolsModule 不注册本面工具）。
 */
@Injectable()
export class ProvidersAdminService {
  private readonly logger = new Logger('ProvidersAdmin');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(LLMManagerService) private readonly llm: LLMManagerService,
    @Inject(ImageManagerService) private readonly image: ImageManagerService,
    @Inject(VideoManagerService) private readonly video: VideoManagerService,
    @Inject(EmbeddingManagerService) private readonly embedding: EmbeddingManagerService,
  ) {}

  /** 平台管理员判定（DB 权威，绝不采信 token 声明——与 system-settings 同口径） */
  async isPlatformAdmin(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user?.role === 'admin';
  }

  async assertPlatformAdmin(userId: string): Promise<void> {
    if (!(await this.isPlatformAdmin(userId))) {
      throw new AppError(ErrorCode.FORBIDDEN, '模型配置仅平台管理员可访问');
    }
  }

  async list(): Promise<ProviderView[]> {
    const rows = await this.prisma.provider.findMany({
      orderBy: [{ type: 'asc' }, { priority: 'asc' }, { id: 'asc' }],
      include: { models: { orderBy: [{ priority: 'asc' }, { id: 'asc' }] } },
    });
    return rows.map((row) => this.toView(row));
  }

  async patch(userId: string, id: string, input: unknown): Promise<ProviderView> {
    await this.assertPlatformAdmin(userId);

    const provider = await this.prisma.provider.findUnique({ where: { id } });
    if (!provider) throw new AppError(ErrorCode.NOT_FOUND, 'provider 不存在');

    const parsed = ProviderPatchSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `provider 补丁非法：${formatIssues(parsed.error)}`);
    }
    const patch = parsed.data as ProviderPatch;

    // 写库前全量裁决（非法值 400 绝不落库）
    const data: Record<string, unknown> = {};

    if (patch.apiKey !== undefined) {
      const trimmed = patch.apiKey.trim();
      if (trimmed.length > 0) data.apiKeyEncrypted = this.crypto.encrypt(trimmed);
      // 空串 = 不改（只写语义）
    }
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.priority !== undefined) data.priority = patch.priority;
    if (patch.timeoutMs !== undefined) data.timeoutMs = patch.timeoutMs;
    if (patch.baseUrl !== undefined) {
      if (patch.baseUrl === '') {
        if (!isMockAdapter(provider.adapter)) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, 'baseUrl 不能为空（仅 mock adapter 允许空 baseUrl）');
        }
        data.baseUrl = '';
      } else {
        const verdict = checkUrlSync(patch.baseUrl, { allowHttp: process.env.PROVIDER_ALLOW_HTTP === 'true' });
        if (!verdict.ok) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, `baseUrl 不安全：${verdict.detail ?? verdict.reason}`);
        }
        data.baseUrl = patch.baseUrl;
      }
    }

    const updated = await this.prisma.provider.update({ where: { id }, data });

    // 热生效：按 type 刷新对应 manager（整体重建内存 adapter 表；在途请求持有的旧 adapter 不受影响）
    try {
      await this.managerFor(provider.type).refresh();
    } catch (err) {
      // 刷新失败不掩盖配置结果（内存面可能滞后，重启自愈）；审计面同样降级可见
      this.logger.warn(`provider 已更新但 refresh 失败（重启后生效）: id=${id} err=${(err as Error).message}`);
    }

    // 审计（best-effort；metadata 显式投影，**绝不 spread 行**——行内含 apiKeyEncrypted）
    try {
      await this.audit.write({
        userId,
        action: 'provider.update',
        targetType: 'provider',
        targetId: id,
        organizationId: null,
        result: 'ok',
        metadata: {
          changed: Object.keys(patch),
          keyChanged: data.apiKeyEncrypted !== undefined,
          before: { enabled: provider.enabled, priority: provider.priority, baseUrl: provider.baseUrl, timeoutMs: provider.timeoutMs, hasKey: provider.apiKeyEncrypted !== '' },
          after: { enabled: updated.enabled, priority: updated.priority, baseUrl: updated.baseUrl, timeoutMs: updated.timeoutMs, hasKey: updated.apiKeyEncrypted !== '' },
        },
      });
    } catch (err) {
      this.logger.warn(`审计写入失败（配置已生效；审计面降级）: id=${id} err=${(err as Error).message}`);
    }

    return this.toView(await this.prisma.provider.findUniqueOrThrow({
      where: { id }, include: { models: { orderBy: [{ priority: 'asc' }, { id: 'asc' }] } },
    }));
  }

  private managerFor(type: string): ProviderManagerLike {
    switch (type) {
      case 'llm': return this.llm;
      case 'image': return this.image;
      case 'video': return this.video;
      case 'embedding': return this.embedding;
      default: return { refresh: async () => undefined, providerStatus: () => ({ loaded: false, degradedReason: null }) };
    }
  }

  private toView(row: {
    id: string; name: string; type: string; adapter: string; baseUrl: string;
    enabled: boolean; priority: number; timeoutMs: number; apiKeyEncrypted: string;
    healthStatus: string; retryConfig: unknown;
    createdAt: Date; updatedAt: Date;
    models: Array<{
      id: string; name: string; apiModelId: string; type: string; enabled: boolean; priority: number;
      isDefault: boolean; contextWindow: number | null;
      inputPrice: number; outputPrice: number; unitPrice: number; capabilities: unknown;
    }>;
  }): ProviderView {
    let keyVersion: number | null = null;
    if (row.apiKeyEncrypted) {
      try { keyVersion = this.crypto.keyVersionOf(row.apiKeyEncrypted); } catch { keyVersion = null; }
    }
    const status = this.managerFor(row.type).providerStatus(row.id);
    return {
      id: row.id, name: row.name, type: row.type, adapter: row.adapter, baseUrl: row.baseUrl,
      enabled: row.enabled, priority: row.priority, timeoutMs: row.timeoutMs,
      hasKey: row.apiKeyEncrypted !== '',
      keyVersion,
      healthStatus: row.healthStatus,
      loaded: status.loaded,
      degradedReason: status.degradedReason,
      managedByExtension: Boolean((row.retryConfig as { extensionId?: unknown } | null)?.extensionId),
      models: row.models.map((m) => ({
        id: m.id, name: m.name, apiModelId: m.apiModelId, type: m.type, enabled: m.enabled, priority: m.priority,
        isDefault: m.isDefault, contextWindow: m.contextWindow,
        inputPrice: m.inputPrice, outputPrice: m.outputPrice, unitPrice: m.unitPrice, capabilities: m.capabilities,
      })),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }
}

function formatIssues(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}
