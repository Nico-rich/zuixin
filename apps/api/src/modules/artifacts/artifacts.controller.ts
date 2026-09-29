import { Controller, Get, Inject, Param, Query, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
import { Request, Response } from 'express';
import { ArtifactService, ListArtifactsInput } from './artifact.service';
import { ListArtifactsQuery, ListArtifactsQuerySchema } from './artifacts.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RateLimit, RateLimitGuard } from '../../core/rate-limit/rate-limit.guard';

/**
 * M13-W9 制品只读 REST（**Web 审计闭环断裂之二**：Artifacts 此前只有 service、无 HTTP 面，
 * 制品在 Web 上完全不可见）。红线：
 *  - 身份只从 JWT 取（`req.user.userId`，绝不接受客户端传入的 userId/org）；服务端归属过滤；
 *  - 不存在 / 他人制品 / 跨租户一律 **404 同码同文案**（反枚举，不做存在性区分）；
 *  - 只读面：本控制器**没有任何写端点**（制品的唯一写路径是 Agent 工具 `artifact.create`，
 *    经 ToolCall 幂等账本落库——"工具即接口"，HTTP 面绝不新增第二条写入路径）。
 */
@Controller('artifacts')
@UseGuards(JwtAuthGuard)
export class ArtifactsController {
  constructor(@Inject(ArtifactService) private readonly artifacts: ArtifactService) {}

  @Get()
  @UsePipes(new ZodValidationPipe(ListArtifactsQuerySchema))
  list(@Req() req: Request & { user: AuthedUser }, @Query() q: ListArtifactsQuery) {
    // zod 已校验；枚举/整数均已在 dto 收敛（与 ListArtifactsInput 同构）
    return this.artifacts.list(req.user.userId, q as ListArtifactsInput);
  }

  @Get(':id')
  get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string) {
    return this.artifacts.detail(req.user.userId, id);
  }

  /**
   * 文件下载（既有附件代理口径的服务端流式代理）。归属校验先于任何存储读取；
   * 无关联文件与无权限同样 404，绝不暴露"存在但无文件"与"根本不存在"的差异。
   */
  @Get(':id/download')
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'artifact-download', limit: 300, windowMs: 60_000 })
  async download(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Res() res: Response) {
    const { artifact, stream } = await this.artifacts.openStream(req.user.userId, id);
    res.setHeader('Content-Type', 'application/octet-stream');
    // attachment（非 inline）：制品字节可能来自 LLM/外部工具，属 UNTRUSTED，绝不交给浏览器渲染
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(artifact.title)}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.pipe(res);
  }
}
