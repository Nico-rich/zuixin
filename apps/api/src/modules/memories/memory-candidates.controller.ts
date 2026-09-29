import { Body, Controller, Get, Inject, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { MemoryCandidateService } from '../../core/memory/memory-candidate.service';
import { DecideCandidateDto, DecideCandidateDtoSchema } from './memories.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * M12-P3：记忆候选人工裁决面（把 `MemoryCandidateService.decide()` 从死代码接到 HTTP —— 审计：
 * "MemoryCandidateService.decide() 零生产调用方"）。
 *
 * 为什么必须有这个面：来源可信度闸门（审计风险 2）把 **LLM 来源**（`memory.create_candidate` 工具、
 * 带 toolCallId 的 `feedback.submit` / `performance.capture`）的记忆**一律**压在 `candidate` 态
 * ——它们永不自动进上下文。这只有在"人真的能裁决"时才成立；否则闸门等价于"永久丢弃"。
 *
 * 归属与隔离（与 knowledge/memories 域同纪律）：
 * - 谓词一律 `{id, userId}`（**不是**先按 id 取行再判归属）：跨用户与幽灵 id 走同一条 404
 *   「记忆候选不存在」，零信息差（防枚举，不给越权者"存在性"信号）；
 * - 候选行不复用 `MemoriesController`（表不同、状态机不同），但共享同一 RBAC 口径：JWT 守卫 + userId 谓词。
 */
@Controller('memories/candidates')
@UseGuards(JwtAuthGuard)
export class MemoryCandidatesController {
  constructor(@Inject(MemoryCandidateService) private readonly candidates: MemoryCandidateService) {}

  /** 待裁决候选列表（默认只出 candidate；提升/拒绝后的历史可通过 status 查询） */
  @Get()
  list(
    @Req() req: Request & { user: AuthedUser },
    @Query('status') status?: string,
    @Query('take') take?: string,
  ) {
    return this.candidates.listCandidates(req.user.userId, { status, take: Number(take) || undefined });
  }

  /**
   * 裁决：`{decision: 'active'|'rejected'}`。
   * 行不存在/非本人/已非候选 → 404（同码同文案；幂等语义：重复裁决也是 404，绝不二次提升）。
   */
  @Patch(':id/decide')
  async decide(
    @Req() req: Request & { user: AuthedUser },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(DecideCandidateDtoSchema)) dto: DecideCandidateDto,
  ) {
    const decided = await this.candidates.decide(req.user.userId, id, dto.decision);
    // 不存在 / 非本人 / 已非候选 → 同一条 404（零信息差；重复裁决亦 404，绝不二次提升）
    if (!decided) throw new AppError(ErrorCode.NOT_FOUND, '记忆候选不存在');
    return { id, status: dto.decision };
  }
}
