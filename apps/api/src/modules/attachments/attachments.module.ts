import { Module } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { AttachmentsController } from './attachments.controller';
import { BillingModule } from '../billing/billing.module';

/** M10-P7：追加 BillingModule（附件配额裁决 + attachment_upload 计量入账） */
@Module({
  imports: [BillingModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
