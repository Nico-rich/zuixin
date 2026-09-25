import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards, UsePipes } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { FeedbackService } from './feedback.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

const SubmitFeedbackSchema = z.strictObject({
  projectId: z.string().uuid().optional().nullable(),
  subjectType: z.enum(['artifact', 'creativeBrief', 'product', 'campaign', 'ad', 'generationTask', 'agentRun', 'analysis']),
  subjectId: z.string().min(1).max(100),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

const CapturePerformanceSchema = z.strictObject({
  projectId: z.string().uuid().optional().nullable(),
  artifactId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  adId: z.string().uuid().optional(),
  platform: z.string().min(1).max(40).optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  metrics: z.strictObject({
    impressions: z.number().int().min(0),
    clicks: z.number().int().min(0),
    spend: z.number().min(0),
    conversions: z.number().int().min(0),
    revenue: z.number().min(0),
    orders: z.number().int().min(0),
  }),
});

/** M7-P8 Feedback/Performance API（JWT + ownership + 404 防枚举） */
@Controller('feedback')
@UseGuards(JwtAuthGuard)
export class FeedbackController {
  constructor(@Inject(FeedbackService) private readonly feedback: FeedbackService) {}

  @Post()
  @UsePipes(new ZodValidationPipe(SubmitFeedbackSchema))
  submit(@Req() req: Request & { user: AuthedUser }, @Body() dto: z.infer<typeof SubmitFeedbackSchema>) {
    return this.feedback.submit(req.user.userId, dto);
  }

  @Get()
  list(@Req() req: Request & { user: AuthedUser }, @Query('subjectType') subjectType?: string, @Query('subjectId') subjectId?: string) {
    return this.feedback.list(req.user.userId, { subjectType, subjectId });
  }

  @Post('performance')
  @UsePipes(new ZodValidationPipe(CapturePerformanceSchema))
  capture(@Req() req: Request & { user: AuthedUser }, @Body() dto: z.infer<typeof CapturePerformanceSchema>) {
    return this.feedback.capturePerformance(req.user.userId, dto);
  }

  @Get('performance')
  listPerformance(@Req() req: Request & { user: AuthedUser }, @Query('artifactId') artifactId?: string, @Query('campaignId') campaignId?: string) {
    return this.feedback.listPerformance(req.user.userId, { artifactId, campaignId });
  }

  @Get('performance/insights')
  insights(@Req() req: Request & { user: AuthedUser }, @Query('limit') limit?: string) {
    return this.feedback.insights(req.user.userId, Number(limit) || 10);
  }
}
