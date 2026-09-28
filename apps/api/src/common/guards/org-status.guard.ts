import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { ErrorCode } from '../errors/app-error';

/**
 * M10-P14（审计 X-21）组织禁用状态守卫：`Organization.status = disabled` 时的**资源面**拒绝（403 ORG_DISABLED）。
 *
 * 语义（与软删 `deletedAt` 是两个不同的治理动作）：
 * - `deletedAt`：组织被删除 → 既有的「组织不存在」路径（AuthorizationService.membership 过滤 deletedAt=null）；
 * - `status=disabled`：组织被**冻结**（欠费/违规/客户主动停用）→ 组织数据保留、组织内成员仍可登录，
 *   但**任何组织级资源访问与管理操作一律拒绝**（fail-closed，对成员/owner/平台管理员一致），
 *   唯一例外是治理端点（`POST /organizations/:id/disable|enable`），其 RBAC 由服务层裁决。
 *
 * 覆盖范围（本守卫的判定点）：
 * - 请求中的组织上下文来源，按优先级：`@OrgStatusIdParam('id')` 声明的路由参数 → `:organizationId` / `:orgId`
 *   路由参数 → `organizationId` / `orgId` 查询串 → 请求体同名字段；
 * - 请求不含组织上下文时**不做判定**（组织列表/创建、邀请接受等——邀请接受的组织归属来自邀请行，
 *   由 OrganizationsService.acceptInvitation 在服务层校验）；
 * - 路由参数 `:id` 只有被 `@OrgStatusIdParam('id')` 显式声明时才当作组织 id
 *   （extensions 控制器的 `:id` 是**扩展 id**，绝不能被误当作组织 id 判定）。
 *
 * 豁免（必须是显式、逐端点的 metadata，**不做角色豁免**）：
 * - `@SkipOrgStatusCheck()`：治理端点（`POST /organizations/:id/disable|enable`）—— 组织被禁用后仍须可达，
 *   否则不可恢复；其 RBAC（平台管理员 / 组织 owner）由服务层裁决；
 * - **平台管理员不豁免**：角色豁免意味着"任何携带 role=admin 的令牌可绕过冻结"（令牌陈旧/角色已回收时
 *   即成旁路），且平台在冻结组织上的可达性已由治理端点的显式豁免保证（冻结必须可恢复，但绝不靠角色旁路）。
 *   平台运维若确需访问禁用组织的数据面，应在**该端点**显式 `@SkipOrgStatusCheck()` 并单独裁决 RBAC
 *   （逐端点、可审计），而非在本守卫开口子。
 *
 * 服务层纵深（同一禁用语义，非本守卫重复实现）：
 * - `AuthorizationService.require/authorize`：组织禁用 → 403 ORG_DISABLED（覆盖所有走 org RBAC 的服务路径）；
 * - `OrganizationsService.acceptInvitation`：禁用组织不可再接纳新成员；
 * - `ExtensionsService`：禁用组织的扩展管理/安装/启用一律拒绝。
 *
 * **集成挂载要求（本 Phase 不做，由集成阶段统一接）**：`OrgStatusGuard` 应在 app.module 全局挂载
 * （`APP_GUARD`，顺序在 JwtAuthGuard 之后），使**全部**组织级控制器受同一判定覆盖；本 Phase 只在
 * `OrganizationsApiModule` / `ExtensionsApiModule` 的控制器上挂载并测试锁定（全局挂载点属 A8/集成阶段）。
 *
 * 登录路径（A1 范围）：登录流的 org.status 检查在 AccessGuard/auth（A1）；本守卫不触碰登录路径。
 *
 * 错误形态：`ORG_DISABLED` 的 HTTP 状态映射属全局过滤器（GlobalExceptionFilter.httpStatusOf，非本 Phase 所有权），
 * 故此处直接抛 `HttpException(403, { code: ORG_DISABLED })`——今日即得 403 + 稳定错误码；集成阶段若在过滤器补
 * `ORG_DISABLED → 403` 映射，本实现行为不变（过滤器 HttpException 分支优先，响应体形状一致）。
 */
export const ORG_STATUS_SKIP_KEY = 'm10p14:skip_org_status';
export const ORG_STATUS_PARAM_KEY = 'm10p14:org_id_param';

/** 治理端点豁免（组织禁用后仍可达；RBAC 由服务层裁决） */
export const SkipOrgStatusCheck = () => SetMetadata(ORG_STATUS_SKIP_KEY, true);

/** 声明「哪个路由参数是组织 id」（organizations 控制器 `:id` = 组织 id；extensions 控制器 `:id` = 扩展 id） */
export const OrgStatusIdParam = (param: string) => SetMetadata(ORG_STATUS_PARAM_KEY, param);

/**
 * 组织禁用态的统一拒绝错误（守卫 + 服务层共用，保证错误码/状态码同源）。
 * 403 + `ORG_DISABLED`（与 A1 登录路径使用的同一错误码）。
 */
export function orgDisabledError(message = '组织已被禁用'): HttpException {
  return new HttpException({ code: ErrorCode.ORG_DISABLED, message }, HttpStatus.FORBIDDEN);
}

@Injectable()
export class OrgStatusGuard implements CanActivate {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(ORG_STATUS_SKIP_KEY, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const organizationId = this.resolveOrganizationId(ctx, req);
    if (!organizationId) return true; // 请求不含组织上下文 → 本守卫不判定（端点自身或服务层裁决）

    // 每次请求一次主键点查（不做进程内缓存：禁用必须立即生效，缓存的陈旧窗口在安全判定上不可接受）
    const org = await this.prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: { status: true },
    });
    if (!org) return true; // 组织不存在/已软删 → 交给端点既有的 404/403 裁决（不改变既有语义）
    if (org.status === 'disabled') throw orgDisabledError();
    return true;
  }

  /** 组织上下文解析（顺序固定；`@OrgStatusIdParam` 未声明时 `params.id` 绝不参与判定） */
  private resolveOrganizationId(ctx: ExecutionContext, req: Request): string | undefined {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const query = (req.query ?? {}) as Record<string, unknown>;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const declared = this.reflector.getAllAndOverride<string>(ORG_STATUS_PARAM_KEY, [ctx.getHandler(), ctx.getClass()]);
    const candidates = [
      declared ? params[declared] : undefined,
      params.organizationId, params.orgId,
      query.organizationId, query.orgId,
      body.organizationId, body.orgId,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
    return undefined;
  }
}
