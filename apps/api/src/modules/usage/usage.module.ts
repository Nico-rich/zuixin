import { Global, Module } from '@nestjs/common';
import { UsageService } from './usage.service';
import { UsageController } from './usage.controller';

@Global()
@Module({ controllers: [UsageController], providers: [UsageService], exports: [UsageService] })
export class UsageModule {}
