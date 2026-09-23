import { Controller, Get, InternalServerErrorException } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() { return { status: 'ok' }; }

  @Get('boom') // 仅用于 e2e 验证统一错误 envelope
  boom() { throw new InternalServerErrorException('boom'); }
}
