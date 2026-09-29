import { Module } from '@nestjs/common';
import { MemoriesController } from './memories.controller';
import { MemoryCandidatesController } from './memory-candidates.controller';
import { MemoryModule } from '../../core/memory/memory.module';

/**
 * 记忆 HTTP 面（M2 记忆 CRUD + M12-P3 候选裁决面）。
 * 候选控制器独立于 `MemoriesController`：两张表、两套状态机（Memory 三态 vs MemoryCandidate 三态），
 * 但同属记忆域、共享同一 RBAC 口径（JWT + userId 谓词）。
 */
@Module({ imports: [MemoryModule], controllers: [MemoriesController, MemoryCandidatesController] })
export class MemoriesModule {}
