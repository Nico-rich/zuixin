import { Controller, Get, InternalServerErrorException, Inject, Res } from '@nestjs/common';
import { Response } from 'express';
import { HealthService, HealthReport } from './health.service';

/**
 * M8-P9 三端点（语义严格分离——探针误用会导致"依赖抖动 → 编排层重启 → 雪崩"）：
 * - `GET /api/v1/health/live`：进程存活。**恒定 200，不做任何依赖探测**，供 livenessProbe/restart 策略；
 * - `GET /api/v1/health/ready`：服务就绪。critical 依赖（DB/Redis）任一 down → **503**；
 *   非关键依赖（对象存储）down → 仍 200（报告 status='degraded'），供 Service/readinessProbe 摘流量；
 * - `GET /api/v1/health`：聚合报告（兼容既有契约：仍含 `status`），扩展 db/redis/queue/storage 明细。
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** 聚合健康报告（兼容扩展：status 字段语义不变，新增 db/redis/queue/storage/checks） */
  @Get()
  check(): Promise<HealthReport> {
    return this.health.check();
  }

  /** liveness：常量 200；即使 DB/Redis 全挂也必须 200（绝不因依赖故障重启进程） */
  @Get('live')
  live() {
    return this.health.live();
  }

  /** readiness：critical 依赖 down → 503（+ 完整报告，便于定位） */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const report = await this.health.check();
    if (!report.ready) res.status(503);
    return report;
  }

  @Get('boom') // 仅用于 e2e 验证统一错误 envelope
  boom() { throw new InternalServerErrorException('boom'); }
}

/**
 * 根级探针别名（K8s 探针配置最省事的写法：`/api/v1/live`、`/api/v1/ready`）。
 * 与 health/* 完全同源（同一 HealthService），不是第二套实现。
 */
@Controller()
export class ProbesController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get('live')
  live() {
    return this.health.live();
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const report = await this.health.check();
    if (!report.ready) res.status(503);
    return report;
  }
}
