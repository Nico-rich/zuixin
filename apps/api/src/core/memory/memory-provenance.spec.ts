import { describe, it, expect } from 'vitest';
import {
  canAutoPromote, lifecycleOf, MEMORY_LIFECYCLE_KEY, MEMORY_ORIGIN_KEY, memoryOrigin, mergeMemoryMetadata, metaTime,
} from './memory-provenance';

describe('记忆来源可信度闸门（M12-P3 审计风险 2：提示注入持久化通道）', () => {
  it('显式标注优先：metadata.origin 覆盖 source 兜底（来源改名漂移绝不静默改判）', () => {
    expect(memoryOrigin({ source: 'feedback', metadata: { [MEMORY_ORIGIN_KEY]: 'user' } })).toBe('user');
    expect(memoryOrigin({ source: 'manual', metadata: { [MEMORY_ORIGIN_KEY]: 'agent' } })).toBe('agent');
    expect(memoryOrigin({ source: 'extractor', metadata: { [MEMORY_ORIGIN_KEY]: 'extractor' } })).toBe('extractor');
  });

  it('source 兜底表：manual → user；extractor → extractor；agent/feedback/assistant → agent', () => {
    expect(memoryOrigin({ source: 'manual' })).toBe('user');
    expect(memoryOrigin({ source: 'extractor' })).toBe('extractor');
    expect(memoryOrigin({ source: 'agent' })).toBe('agent'); // memory.create_candidate 工具（LLM 自报）
    expect(memoryOrigin({ source: 'feedback' })).toBe('agent'); // 历史行：无法证明人工 → 最低信任
    expect(memoryOrigin({ source: 'assistant' })).toBe('agent'); // 绩效派生（工具路径）
  });

  it('无来源/未知来源 → unknown（默认拒绝自动提升，放宽谓词即重开注入通道）', () => {
    expect(memoryOrigin({})).toBe('unknown');
    expect(memoryOrigin({ source: null })).toBe('unknown');
    expect(memoryOrigin({ source: 'whatever-else' })).toBe('unknown');
    expect(memoryOrigin({ source: 'manual', metadata: 'not-an-object' })).toBe('user'); // 非法 metadata 不炸
  });

  it('闸门白名单：只有 user / extractor 可自动提升；agent 与 unknown 一律拒绝', () => {
    expect(canAutoPromote({ source: 'manual' })).toBe(true);
    expect(canAutoPromote({ source: 'extractor' })).toBe(true);
    expect(canAutoPromote({ source: 'agent' })).toBe(false); // LLM 工具自报 → 只进候选待人工
    expect(canAutoPromote({ source: 'feedback' })).toBe(false);
    expect(canAutoPromote({ source: 'assistant' })).toBe(false);
    expect(canAutoPromote({})).toBe(false);
    // 显式标注可翻转，但仍必须落在白名单内（agent 标注绝不因 source 好看而放行）
    expect(canAutoPromote({ source: 'assistant', metadata: { [MEMORY_ORIGIN_KEY]: 'user' } })).toBe(true);
    expect(canAutoPromote({ source: 'manual', metadata: { [MEMORY_ORIGIN_KEY]: 'agent' } })).toBe(false);
  });

  it('mergeMemoryMetadata：生命周期簿记与既有语义键互不覆盖（幂等锚 kind/subjectId 绝不丢）', () => {
    const current = { kind: 'performance', subjectId: 'a1', [MEMORY_ORIGIN_KEY]: 'agent' };
    const merged = mergeMemoryMetadata(current, { [MEMORY_LIFECYCLE_KEY]: { demotedAt: 'T1' } }) as Record<string, unknown>;
    expect(merged).toMatchObject({ kind: 'performance', subjectId: 'a1', origin: 'agent' });
    expect(lifecycleOf(merged)).toEqual({ demotedAt: 'T1' });
    // 二次合并：lifecycle 子对象浅合并（既有键保留，新键加入）
    const again = mergeMemoryMetadata(merged, { [MEMORY_LIFECYCLE_KEY]: { userAffirmedAt: 'T2' } }) as Record<string, unknown>;
    expect(lifecycleOf(again)).toEqual({ demotedAt: 'T1', userAffirmedAt: 'T2' });
    expect((again as Record<string, unknown>).kind).toBe('performance');
  });

  it('mergeMemoryMetadata：undefined 键被丢弃，绝不把 lifecycle 写成 undefined 覆盖真值', () => {
    const merged = mergeMemoryMetadata({ [MEMORY_LIFECYCLE_KEY]: { demotedAt: 'T1' } }, {
      [MEMORY_LIFECYCLE_KEY]: { evictedAt: undefined, decayedAt: 'T3' },
    }) as Record<string, unknown>;
    expect(lifecycleOf(merged)).toEqual({ demotedAt: 'T1', decayedAt: 'T3' });
    // 无 metadata（null/字符串/数组）→ 从空对象起（绝不抛错）
    expect(mergeMemoryMetadata(null, { a: 1 })).toEqual({ a: 1 });
    expect(lifecycleOf(mergeMemoryMetadata('garbage', { a: 1 }))).toEqual({});
  });

  it('metaTime：ISO 字符串 / Date / epoch 都可读；非法值与缺失 → null（绝不把 NaN 当时间用）', () => {
    const meta = { [MEMORY_LIFECYCLE_KEY]: { demotedAt: '2026-09-01T00:00:00.000Z', bad: 'x', n: 1_700_000_000_000 } };
    expect(metaTime(meta, 'demotedAt')!.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(metaTime(meta, 'n')).toBeInstanceOf(Date);
    expect(metaTime(meta, 'bad')).toBeNull();
    expect(metaTime(meta, 'missing')).toBeNull();
    expect(metaTime(null, 'demotedAt')).toBeNull();
    expect(metaTime({ [MEMORY_LIFECYCLE_KEY]: { demotedAt: new Date('2026-01-01T00:00:00Z') } }, 'demotedAt')).toBeInstanceOf(Date);
  });
});
