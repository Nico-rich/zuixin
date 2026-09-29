import { describe, expect, it } from 'vitest';
import {
  ACCIDENT_DROPPED_TABLE,
  assertDrillContainer,
  assertOwnContainer,
  assertOwnVolume,
  summarizeCounts,
  verifyIncidentFootprint,
  NAME_PATTERN,
} from './pitr-backup-crosscheck';

/**
 * M12-P5：交叉验证里**唯一能做纯函数单测**的部分——"分歧是否恰好是事故足迹"的判定，
 * 以及"删除/连接前先认名字"的安全闸门。
 *
 * 为什么这两块必须先单测：它们一个决定**结论**（PASS/FAIL），一个决定**会不会误删别人的资源**。
 * 真实的四层比对（指纹/行数/抽样）需要一台真实实例，属于 `--confirm` 演练的覆盖范围
 * （见 docs/operations/m12-pitr-backup-crosscheck.md 的实测数字）。
 */
describe('verifyIncidentFootprint（分歧必须**恰好**是事故足迹）', () => {
  const expectation = { missingTables: [ACCIDENT_DROPPED_TABLE], expectedDeltas: { Plan: 3 } };

  it('恰好匹配 ⇒ ok：删掉的表在对照侧不存在、Plan 差 3 行、其余表逐表一致', () => {
    const reference = { User: 12, Plan: 3, UsageRecord: 5, pitr_drill_event: 4, _prisma_migrations: 38 };
    const other = { User: 12, Plan: 0, pitr_drill_event: 4, _prisma_migrations: 38 }; // UsageRecord 被事故 DROP
    const verdict = verifyIncidentFootprint({ reference, other, expectation });
    expect(verdict.ok).toBe(true);
    expect(verdict.unexpected).toEqual([]);
    expect(verdict.entries.find((e) => e.table === ACCIDENT_DROPPED_TABLE)).toMatchObject({ reference: 5, other: null, ok: true });
    // 差值方向固定为"参考侧 − 对照侧"：事故删数据 ⇒ 恢复侧更多 ⇒ 正差值
    expect(verdict.entries.find((e) => e.table === 'Plan')).toMatchObject({ delta: 3, ok: true, note: '差值 3（= 期望）' });
  });

  it('未声明的差异 ⇒ 绝不放过（行数差与期望不符）', () => {
    const verdict = verifyIncidentFootprint({
      reference: { Plan: 3, User: 12 },
      other: { Plan: 1, User: 12 }, // 事故只删了 2 行？与期望 3 不符
      expectation,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.unexpected).toEqual(['Plan']);
    expect(verdict.entries.find((e) => e.table === 'Plan')?.note).toBe('差值 2，期望 3');
  });

  it('未声明的"表消失" ⇒ 失败（对照侧缺失但没写进 missingTables）', () => {
    const verdict = verifyIncidentFootprint({
      reference: { Plan: 3, Secret: 1 },
      other: { Plan: 3 },
      expectation: { missingTables: [], expectedDeltas: {} },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.unexpected).toEqual(['Secret']);
    expect(verdict.entries.find((e) => e.table === 'Secret')?.delta).toBeNull();
  });

  it('对照侧多出表 ⇒ 失败（事故不会创建表；这通常意味着比对的两侧接反了）', () => {
    const verdict = verifyIncidentFootprint({
      reference: { Plan: 3 },
      other: { Plan: 3, Extra: 1 },
      expectation: { missingTables: [], expectedDeltas: {} },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.unexpected).toEqual(['Extra']);
    expect(verdict.entries.find((e) => e.table === 'Extra')?.note).toContain('多出该表');
  });

  it('表集合完全相同且差值全为 0 ⇒ ok（两侧一致本身不算"分歧"，是"没有分歧"）', () => {
    const counts = { User: 1, Plan: 3, pitr_drill_ledger: 500 };
    const verdict = verifyIncidentFootprint({
      reference: counts,
      other: { ...counts },
      expectation: { missingTables: [], expectedDeltas: {} },
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.entries.map((e) => e.table)).toEqual(['Plan', 'User', 'pitr_drill_ledger']);
  });

  it('空库两侧都空 ⇒ 无差异即 ok（不因"没有表"就报错）', () => {
    expect(verifyIncidentFootprint({ reference: {}, other: {}, expectation }).ok).toBe(true);
  });
});

describe('summarizeCounts（报告里的表数/行数口径唯一）', () => {
  it('表数 = 键数、行数 = 求和；空对象 ⇒ 0/0', () => {
    expect(summarizeCounts({ a: 2, b: 3 })).toEqual({ tables: 2, rows: 5 });
    expect(summarizeCounts({})).toEqual({ tables: 0, rows: 0 });
  });
});

describe('资源命名闸门（删除/连接前先认名字，绝不"尽力而为地删"）', () => {
  it('本脚本自己的容器/卷名匹配；drill 的名字、别人的名字、近似名一律拒绝', () => {
    const mine = 'pitr-xcheck-20260929-101112-abcdef-xr';
    const myVol = 'pitr-xcheck-20260929-101112-abcdef-data';
    expect(NAME_PATTERN.test(mine)).toBe(true);
    expect(() => assertOwnContainer(mine)).not.toThrow();
    expect(() => assertOwnVolume(myVol)).not.toThrow();
    for (const bad of [
      'pitr-drill-20260929-101112-abcdef-src', // 上游 drill 的（只读，绝不删）
      'pitr-xcheck-20260929-101112-abcdef', // 少后缀
      'pitr-xcheck-20260929-101112-abcdef-src', // 后缀不在白名单
      'docker-postgres-1',
      'pitr-xcheck-2026-101112-abcdef-xr', // 时间戳格式不对
      '',
    ]) {
      expect(() => assertOwnContainer(bad), `期望拒绝：${bad}`).toThrow();
    }
    expect(() => assertOwnVolume('pitr-xcheck-20260929-101112-abcdef')).toThrow();
  });

  it('drill 容器名匹配（只读连接同样先认名字）：src/dst 接受，其它拒绝', () => {
    expect(() => assertDrillContainer('pitr-drill-20260929-101112-abcdef-dst')).not.toThrow();
    expect(() => assertDrillContainer('pitr-drill-20260929-101112-abcdef-src')).not.toThrow();
    for (const bad of ['pitr-drill-20260929-101112-abcdef-restore', 'pitr-xcheck-20260929-101112-abcdef-xr', 'postgres']) {
      expect(() => assertDrillContainer(bad), `期望拒绝：${bad}`).toThrow();
    }
  });
});
