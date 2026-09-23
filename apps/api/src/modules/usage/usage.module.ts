import { Global, Module } from '@nestjs/common';
import { UsageService } from './usage.service';

@Global()
@Module({ providers: [UsageService], exports: [UsageService] })
export class UsageModule {}
