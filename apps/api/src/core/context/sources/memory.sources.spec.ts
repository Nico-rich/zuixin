import { describe, it, expect, vi } from 'vitest';
import { ProjectMemorySource, UserMemorySource } from './memory.sources';

const memoryRow = (id: string, category: string, content: string) => ({ id, category, content });

function makeMemories(rows: Array<{ id: string; category: string; content: string }>) {
  return {
    list: vi.fn().mockResolvedValue(rows),
    markUsed: vi.fn().mockResolvedValue(undefined),
  };
}

describe('UserMemorySource', () => {
  it('取 active 用户记忆，前缀标记 + order=20 + markUsed', async () => {
    const memories = makeMemories([memoryRow('m1', 'preference', '亚马逊主图 2000×2000')]);
    const source = new UserMemorySource(memories as never);
    const blocks = await source.collect({ userId: 'u1', conversationId: 'c1' });
    expect(memories.list).toHaveBeenCalledWith('u1', { scope: 'user', status: 'active' });
    expect(blocks).toEqual([{
      scope: 'user', role: 'user',
      content: '【用户长期记忆】偏好：亚马逊主图 2000×2000',
      order: 20,
    }]);
    expect(memories.markUsed).toHaveBeenCalledWith(['m1']);
  });

  it('无记忆 → 空数组（不产生任何数据）', async () => {
    const memories = makeMemories([]);
    const source = new UserMemorySource(memories as never);
    expect(await source.collect({ userId: 'u1', conversationId: 'c1' })).toEqual([]);
  });
});

describe('ProjectMemorySource', () => {
  it('无 projectId → 空数组', async () => {
    const memories = makeMemories([]);
    const source = new ProjectMemorySource(memories as never);
    expect(await source.collect({ userId: 'u1', conversationId: 'c1' })).toEqual([]);
    expect(memories.list).not.toHaveBeenCalled();
  });

  it('有 projectId → 项目记忆前缀标记 + order=10', async () => {
    const memories = makeMemories([memoryRow('m2', 'project_context', '品牌：科技感插排，黑金配色')]);
    const source = new ProjectMemorySource(memories as never);
    const blocks = await source.collect({ userId: 'u1', conversationId: 'c1', projectId: 'p1' });
    expect(memories.list).toHaveBeenCalledWith('u1', { scope: 'project', projectId: 'p1', status: 'active' });
    expect(blocks[0]).toMatchObject({
      content: '【项目记忆】项目背景：品牌：科技感插排，黑金配色',
      order: 10,
    });
  });

  it('超过 10 条截断', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => memoryRow(`m${i}`, 'other', `内容${i}`));
    const memories = makeMemories(rows);
    const source = new UserMemorySource(memories as never);
    const blocks = await source.collect({ userId: 'u1', conversationId: 'c1' });
    expect(blocks.length).toBe(10);
  });
});
