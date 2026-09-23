import { Module } from '@nestjs/common';
import { MemoriesController } from './memories.controller';
import { MemoryModule } from '../../core/memory/memory.module';

@Module({ imports: [MemoryModule], controllers: [MemoriesController] })
export class MemoriesModule {}
