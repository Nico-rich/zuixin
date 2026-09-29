import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { PolicyThresholds, deepMerge } from './policy-thresholds';
import { SYSTEM_SETTING_KEYS, SystemSettingKeySpec, findSystemSettingKey } from './system-settings.keys';
import { ZodError } from 'zod';

export interface SystemSettingView {
  key: string;
  description: string;
  /** 读取投影后的生效值（白名单子键之外的内容**绝不回显**） */
  value: unknown;
  /** 只读子键（配额面等；可见不可写——红线：不开放 quota/RBAC 面） */
  readOnlySubKeys: readonly string[];
  updatedAt: Date | null;
}

/**
 * M12-P4 系统策略设置（**唯一受控写入口**）。
 *
 * 不变量（本服务即登记载体）：
 * - 白名单硬编码（`SYSTEM_SETTING_KEYS`）：未知键 → 404，白名单外的存储内容**绝不回显**；
 * - RBAC = **仅平台管理员**（`user.role='admin'`，DB 权威读取，**不采信 token 声明**）——
 *   组织 owner/admin 一律 403；LLM/Agent **无任何写路径**（ToolsModule 不注册 settings 工具）；
 * - 每次写入**强制审计**（复用 AuditService.write；写失败不阻断业务，但审计面降级可见）；
 * - 值校验 = 白名单 schema（strict 写面 + strip 读面 + 生效值跨字段一致性）；非法值 400 绝不落库；
 * - 写路径**绝不**触碰权限/quota/provider/审批状态：本服务只读写 system_settings 一张表。
 */
@Injectable()
export class SystemSettingsService {
  private readonly logger = new Logger('SystemSettings');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ===== 身份（平台管理员）=====

  /** 平台管理员判定（与 extensions/marketplace 同口径：DB 权威，绝不依赖 token 声明） */
  async isPlatformAdmin(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user?.role === 'admin';
  }

  /** 非平台管理员 → 403（**所有**读写入口的第一道裁决） */
  async assertPlatformAdmin(userId: string): Promise<void> {
    if (!(await this.isPlatformAdmin(userId))) {
      throw new AppError(ErrorCode.FORBIDDEN, '系统策略设置仅平台管理员可访问');
    }
  }

  // ===== 读（管理面）=====

  /** 受控键清单 + 当前生效值（只列白名单键） */
  async list(): Promise<SystemSettingView[]> {
    const rows = await this.prisma.systemSetting.findMany({
      where: { key: { in: SYSTEM_SETTING_KEYS.map((s) => s.key) } },
      select: { key: true, value: true, updatedAt: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return SYSTEM_SETTING_KEYS.map((spec) => this.view(spec, byKey.get(spec.key) ?? null));
  }

  /** 单键读取（非白名单键 → 404：既不是"资源不存在"的枚举缺口，也不存在隐式放行） */
  async get(key: string): Promise<SystemSettingView> {
    const spec = findSystemSettingKey(key);
    if (!spec) throw new AppError(ErrorCode.NOT_FOUND, `受控键不存在: ${key}`);
    const row = await this.prisma.systemSetting.findUnique({ where: { key }, select: { key: true, value: true, updatedAt: true } });
    return this.view(spec, row);
  }

  // ===== 校验（不写入；实验晋级面复用同一白名单）=====

  /**
   * 校验补丁（**不写库**）：未知键 → 404；配额类子键 → 400；strict schema 不符 → 400。
   * 返回规范化后的补丁（只含白名单子键）。
   */
  validatePatch(key: string, input: unknown): Record<string, unknown> {
    const spec = findSystemSettingKey(key);
    if (!spec) throw new AppError(ErrorCode.NOT_FOUND, `受控键不存在: ${key}`);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '设置值必须是对象');
    }
    const patch = input as Record<string, unknown>;
    if (Object.keys(patch).length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, '补丁不能为空（空补丁不产生任何变更）');
    }
    if (spec.blockedSubKeys) {
      const hit = spec.blockedSubKeys.names.filter((n) => n in patch);
      if (hit.length > 0) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          `${key}.${hit.join('/')} ${spec.blockedSubKeys.reason}（本 API 不开放写入口）`,
        );
      }
    }
    const parsed = spec.patchSchema.safeParse(patch);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `${key} 值非法：${formatIssues(parsed.error)}`);
    }
    return parsed.data as Record<string, unknown>;
  }

  // ===== 写（唯一入口）=====

  /**
   * 受控写入（PATCH 语义：深合并 + 白名单投影 + 生效值校验 + 强制审计）。
   * `opts.action` 允许调用方登记更精确的语义（如实验晋级），审计动作名不同但**同一条受控路径**。
   */
  async patch(
    userId: string,
    key: string,
    input: unknown,
    opts: { action?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<SystemSettingView> {
    await this.assertPlatformAdmin(userId); // 红线：LLM/Agent/普通成员无写路径
    const spec = findSystemSettingKey(key);
    if (!spec) throw new AppError(ErrorCode.NOT_FOUND, `受控键不存在: ${key}`);
    const patch = this.validatePatch(key, input);

    const current = await this.readProjected(spec);
    const merged = spec.readSchema.safeParse(deepMerge(current, patch));
    if (!merged.success) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `${key} 合并后值非法：${formatIssues(merged.error)}`);
    }
    const stored = merged.data as Record<string, unknown>;
    spec.validateEffective?.(stored); // 严格生效值校验（跨字段一致性）

    await this.prisma.systemSetting.upsert({
      where: { key },
      update: { value: stored as never },
      create: { key, value: stored as never },
    });

    // 审计（**best-effort**：AuditService.write 自身吞掉 DB 错误并记日志；此处再兜一层 try/catch，
    // 保证"审计面失效绝不阻断策略写入"是**本服务的字面契约**——策略已落库，绝不因审计降级而对外报错）
    try {
      await this.audit.write({
        userId,
        action: opts.action ?? 'systemSetting.update',
        targetType: 'systemSetting',
        targetId: key,
        organizationId: null,
        result: 'ok',
        metadata: { key, changed: Object.keys(patch), before: current, after: stored, ...(opts.metadata ?? {}) },
      });
    } catch (err) {
      this.logger.warn(`审计写入失败（策略已落库；审计面降级）: key=${key} err=${(err as Error).message}`);
    }
    const row = await this.prisma.systemSetting.findUnique({ where: { key }, select: { key: true, value: true, updatedAt: true } });
    this.logger.log({ actor: userId, key, changed: Object.keys(patch) }, '系统策略设置已更新');
    return this.view(spec, row);
  }

  // ===== 内部 =====

  /** 投影后的存储值（strip：白名单之外的存储内容在此被丢弃，绝无泄漏到运行面的路径） */
  private async readProjected(spec: SystemSettingKeySpec): Promise<Record<string, unknown>> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: spec.key }, select: { value: true } });
    const raw = row?.value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const parsed = spec.readSchema.safeParse(raw);
    return parsed.success ? (parsed.data as Record<string, unknown>) : {};
  }

  private view(spec: SystemSettingKeySpec, row: { key: string; value: unknown; updatedAt: Date } | null): SystemSettingView {
    const raw = row?.value;
    const parsed = raw && typeof raw === 'object' && !Array.isArray(raw) ? spec.readSchema.safeParse(raw) : null;
    const stored = parsed?.success ? parsed.data : null;
    return {
      key: spec.key,
      description: spec.description,
      value: spec.resolveEffective ? spec.resolveEffective(stored) : stored,
      readOnlySubKeys: spec.blockedSubKeys?.names ?? [],
      updatedAt: row?.updatedAt ?? null,
    };
  }
}

/** zod 错误 → 稳定可读文本（与 ZodValidationPipe 同格式：path: message） */
function formatIssues(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

export { SYSTEM_SETTING_KEYS };
export type { PolicyThresholds };
