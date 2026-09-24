import { Module } from '@nestjs/common';
import { CommerceService } from './commerce.service';
import { CommerceAnalysisService } from './commerce-analysis.service';
import { MockCommerceAdapter } from './mock-commerce.adapter';
import { ArtifactsModule } from '../artifacts/artifacts.module';

/** M7-P4/P5 服务层（API 与 Worker 共用——Tool 在 Worker 进程执行；无 HTTP 面，工具即接口） */
@Module({
  imports: [ArtifactsModule],
  providers: [CommerceService, CommerceAnalysisService, MockCommerceAdapter],
  exports: [CommerceService, CommerceAnalysisService],
})
export class CommerceModule {}
