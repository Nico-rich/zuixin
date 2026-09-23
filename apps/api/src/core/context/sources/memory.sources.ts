import { Inject } from '@nestjs/common';
import { MemoryService } from '../../memory/memory.service';
import { AssembleContext, CONTEXT_ORDER, MemoryBlock, MemoryScope, MemorySource } from '../types';

/** 每条 source 参与组装的条数上限 */
const MEMORY_SOURCE_LIMIT = 10;

const CATEGORY_LABELS: Record<string, string> = {
  preference: '偏好',
  profile: '资料',
  instruction: '指令',
  project_context: '项目背景',
  workflow: '工作流',
  other: '其他',
};

/** 项目记忆源：取当前项目 active 记忆（importance 降序），role=user + 前缀标记注入 */
export class ProjectMemorySource implements MemorySource {
  readonly scope: MemoryScope = 'project';
  constructor(@Inject(MemoryService) private readonly memories: MemoryService) {}

  async collect(ctx: AssembleContext): Promise<MemoryBlock[]> {
    if (!ctx.projectId) return [];
    const rows = (await this.memories.list(ctx.userId, { scope: 'project', projectId: ctx.projectId, status: 'active' })).slice(0, MEMORY_SOURCE_LIMIT);
    if (rows.length) await this.memories.markUsed(rows.map((r) => r.id));
    return rows.map((m) => ({
      scope: 'project' as const,
      role: 'user' as const,
      content: `【项目记忆】${CATEGORY_LABELS[m.category] ?? m.category}：${m.content}`,
      order: CONTEXT_ORDER.project_memory,
    }));
  }
}

/** 用户记忆源：取用户级 active 记忆（importance 降序），role=user + 前缀标记注入 */
export class UserMemorySource implements MemorySource {
  readonly scope: MemoryScope = 'user';
  constructor(@Inject(MemoryService) private readonly memories: MemoryService) {}

  async collect(ctx: AssembleContext): Promise<MemoryBlock[]> {
    const rows = (await this.memories.list(ctx.userId, { scope: 'user', status: 'active' })).slice(0, MEMORY_SOURCE_LIMIT);
    if (rows.length) await this.memories.markUsed(rows.map((r) => r.id));
    return rows.map((m) => ({
      scope: 'user' as const,
      role: 'user' as const,
      content: `【用户长期记忆】${CATEGORY_LABELS[m.category] ?? m.category}：${m.content}`,
      order: CONTEXT_ORDER.user_memory,
    }));
  }
}
