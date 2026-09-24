import { Module } from '@nestjs/common';
import { CommerceService } from './commerce.service';
import { MockCommerceAdapter } from './mock-commerce.adapter';

/** M7-P4 服务层（API 与 Worker 共用——Tool 在 Worker 进程执行；无 HTTP 面，工具即接口） */
@Module({
  providers: [CommerceService, MockCommerceAdapter],
  exports: [CommerceService],
})
export class CommerceModule {}
