import { describe, it, expect } from 'vitest';
import { CryptoService } from './crypto.service';
import { ErrorCode } from '../../common/errors/app-error';
import { DEFAULT_REWRAP_BATCH_SIZE, runRewrap, type RewrapRow, type RewrapStore } from './rewrap.runner';

const K1 = Buffer.alloc(32, 7).toString('base64');
const K2 = Buffer.alloc(32, 9).toString('base64');
const K_FOREIGN = Buffer.alloc(32, 11).toString('base64'); // 第三方密钥：伪造"未知版本"密文用（绝不配进密钥集）

const v1 = new CryptoService({ keys: { 1: K1 }, currentVersion: 1 });
const v2 = new CryptoService({ keys: { 1: K1, 2: K2 }, currentVersion: 2 });

/** 历史 3 段格式（无版本前缀）= 版本 1：真实存量数据的老格式，必须同样被迁移 */
const legacy = (crypto: CryptoService, plain: string): string => crypto.encrypt(plain, 1).replace(/^v1\./, '');
/** 未知版本密文：格式合法（`v9.`）但密钥集里没有 9 → 无法恢复明文 */
const bogusV9 = (plain: string): string => new CryptoService(K_FOREIGN).encrypt(plain).replace(/^v1\./, 'v9.');

function row(id: string, type: string, payload: string, keyVersion: number): RewrapRow {
  return { id, connectionId: 'conn-1', type, encryptedValue: payload, keyVersion };
}

interface Hooks {
  /** 写回前钩子（模拟并发：store() 的"删除重建"把密文换掉） */
  beforeUpdate?: (args: { where: { id: string; encryptedValue?: string } }) => void;
  /** 指定行的写入抛错（模拟批内写入失败 → 整批回滚） */
  failOnId?: string;
}

/**
 * 内存假库：忠实模拟四件事——
 * 1. `orderBy id asc` + `where.id.gt` 的**主键范围**分页语义（与真实 SQL `WHERE id > $1 ORDER BY id LIMIT n` 一致，
 *    被删除的行不会让结果集消失 —— 这正是刻意不用 Prisma `cursor` 的原因）；
 * 2. `updateMany` 的 **CAS 谓词**（`where.encryptedValue` 失配 ⇒ count 0）；
 * 3. `$transaction` 的**回滚**（写进暂存层，提交才落库；抛错丢弃暂存）；
 * 4. 行可以被外部删除（`table.delete`）。
 */
function makeStore(rows: RewrapRow[], hooks: Hooks = {}) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  const calls = { findMany: 0, tx: 0, updateMany: 0, committed: 0 };
  const updatedIds: string[] = [];

  const applyUpdate = (target: Map<string, RewrapRow>, args: { where: { id: string; encryptedValue?: string }; data: { encryptedValue: string; keyVersion: number } }) => {
    calls.updateMany += 1;
    if (hooks.failOnId !== undefined && args.where.id === hooks.failOnId) throw new Error('模拟写入失败');
    const current = target.get(args.where.id);
    if (!current) return { count: 0 };
    // CAS：谓词里的旧密文必须仍与当前一致（并发替换后 count=0，绝不覆盖他人写入）
    if (args.where.encryptedValue !== undefined && current.encryptedValue !== args.where.encryptedValue) return { count: 0 };
    const next = { ...current, encryptedValue: args.data.encryptedValue, keyVersion: args.data.keyVersion };
    target.set(args.where.id, next);
    updatedIds.push(args.where.id);
    return { count: 1 };
  };

  const store: RewrapStore = {
    credential: {
      findMany: async (args) => {
        calls.findMany += 1;
        let list = [...table.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const after = args.where?.id.gt;
        if (after !== undefined) list = list.filter((r) => r.id > after);
        return list.slice(0, args.take).map((r) => ({ ...r }));
      },
      updateMany: async (args) => applyUpdate(table, args),
    },
    $transaction: async (fn) => {
      calls.tx += 1;
      const staged = new Map<string, RewrapRow>();
      const view = {
        get: (id: string) => staged.get(id) ?? table.get(id),
        set: (id: string, r: RewrapRow) => staged.set(id, r),
      };
      const tx = {
        credential: {
          updateMany: async (args: { where: { id: string; encryptedValue?: string }; data: { encryptedValue: string; keyVersion: number } }) => {
            hooks.beforeUpdate?.(args);
            return applyUpdate(view as unknown as Map<string, RewrapRow>, args);
          },
        },
      };
      const result = await fn(tx); // 抛错 ⇒ 暂存层被丢弃（= 回滚）
      for (const [id, r] of staged) table.set(id, { ...r });
      calls.committed += staged.size;
      return result;
    },
  };
  return { store, table, calls, updatedIds };
}

describe('runRewrap（M11-P1：密钥版本迁移执行器）', () => {
  it('apply：v1（含历史 3 段格式）→ v2；已是当前版本的行不动', async () => {
    const { store, table, updatedIds } = makeStore([
      row('cred-1', 'access_token', legacy(v1, 'plain-A'), 1),
      row('cred-2', 'refresh_token', v1.encrypt('plain-B'), 1),
      row('cred-3', 'access_token', v2.encrypt('plain-C'), 2),
    ]);
    const stats = await runRewrap(store, v2, { apply: true });

    expect(stats).toMatchObject({ dryRun: false, scanned: 3, rewritten: 2, upToDate: 1, failed: 0, aborted: false });
    expect(stats.fromVersions).toEqual({ '1': 2 });
    expect(stats.configuredVersions).toEqual([1, 2]);
    expect(stats.targetVersion).toBe(2);
    expect(updatedIds.sort()).toEqual(['cred-1', 'cred-2']); // cred-3 未写库
    // 列与密文永不失配：keyVersion 恒等于密文自述版本，且 requireCurrent 可通过
    for (const r of table.values()) {
      expect(r.keyVersion).toBe(v2.keyVersionOf(r.encryptedValue));
      expect(() => v2.decrypt(r.encryptedValue, { requireCurrent: true })).not.toThrow();
    }
    expect(v2.decrypt(table.get('cred-1')!.encryptedValue)).toBe('plain-A'); // 明文不变（仅换代）
    expect(v2.decrypt(table.get('cred-2')!.encryptedValue)).toBe('plain-B');
  });

  it('默认 dry-run：只判定不写库（写库调用 0 次）', async () => {
    const { store, table, calls } = makeStore([
      row('cred-1', 'access_token', legacy(v1, 'p1'), 1),
      row('cred-2', 'access_token', v1.encrypt('p2'), 1),
    ]);
    const stats = await runRewrap(store, v2);

    expect(stats).toMatchObject({ dryRun: true, rewritten: 2, upToDate: 0, scanned: 2 });
    expect(calls.updateMany).toBe(0);
    expect(calls.tx).toBe(0);
    expect(table.get('cred-1')!.keyVersion).toBe(1); // 库中未变
  });

  it('幂等：重复运行第二次零写入（已是最新版本跳过）', async () => {
    const { store, calls } = makeStore([
      row('cred-1', 'access_token', legacy(v1, 'p1'), 1),
      row('cred-2', 'refresh_token', v1.encrypt('p2'), 1),
    ]);
    const first = await runRewrap(store, v2, { apply: true });
    const writesAfterFirst = calls.updateMany;
    const second = await runRewrap(store, v2, { apply: true });

    expect(first.rewritten).toBe(2);
    expect(second).toMatchObject({ rewritten: 0, upToDate: 2, failed: 0 });
    expect(calls.updateMany).toBe(writesAfterFirst); // 第二次没有任何写回
  });

  it('游标批量：batchSize 分批覆盖全部行，无重复无遗漏', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`cred-${String(i).padStart(4, '0')}`, 'access_token', v1.encrypt(`p${i}`), 1));
    const { store, table, calls, updatedIds } = makeStore(rows);
    const stats = await runRewrap(store, v2, { apply: true, batchSize: 2 });

    expect(stats.batches).toBe(13); // 12 批满 + 1 批 1 行（末批不足 batchSize）
    expect(stats.scanned).toBe(25);
    expect(stats.rewritten).toBe(25);
    expect(new Set(updatedIds).size).toBe(25); // 无重复写回
    expect(calls.tx).toBe(13); // 每批恰好一个事务
    expect([...table.values()].every((r) => r.keyVersion === 2)).toBe(true);
  });

  it('空表：零批次零写入（不误报）', async () => {
    const { store, calls } = makeStore([]);
    const stats = await runRewrap(store, v2, { apply: true });
    expect(stats).toMatchObject({ batches: 0, scanned: 0, rewritten: 0, failed: 0, aborted: false });
    expect(calls.updateMany).toBe(0);
  });

  it('每批一个事务：批内写入失败 ⇒ 整批回滚 + 中止 + batchErrors（前序批次保留）', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => row(`cred-${i + 1}`, 'access_token', v1.encrypt(`p${i + 1}`), 1));
    const { store, table } = makeStore(rows, { failOnId: 'cred-3' }); // cred-3 落在第 2 批
    const stats = await runRewrap(store, v2, { apply: true, batchSize: 2 });

    // 第 1 批（cred-1/cred-2）已提交；第 2 批（cred-3/cred-4）整批回滚
    expect(table.get('cred-1')!.keyVersion).toBe(2);
    expect(table.get('cred-2')!.keyVersion).toBe(2);
    expect(table.get('cred-3')!.keyVersion).toBe(1);
    expect(table.get('cred-4')!.keyVersion).toBe(1); // 同批未失败的行也一起回滚（原子性）
    expect(stats.aborted).toBe(true);
    expect(stats.batchErrors).toHaveLength(1);
    expect(stats.batchErrors[0]).toMatchObject({ batch: 2 });
    expect(stats.batchErrors[0].reason).toContain('模拟写入失败');
    expect(stats.batches).toBe(2); // 中止后不再扫描后续批次
  });

  it('单行失败不阻塞整批：未知版本（v9）记入 failures，同批其他行照常迁移', async () => {
    const { store, table } = makeStore([
      row('cred-1', 'access_token', legacy(v1, 'ok-1'), 1),
      row('cred-2', 'access_token', bogusV9('cannot-recover'), 9),
      row('cred-3', 'refresh_token', v1.encrypt('ok-3'), 1),
    ]);
    const stats = await runRewrap(store, v2, { apply: true });

    expect(stats).toMatchObject({ scanned: 3, rewritten: 2, failed: 1, remaining: 1, aborted: false });
    expect(stats.failures).toHaveLength(1);
    expect(stats.failures[0]).toMatchObject({ id: 'cred-2', code: ErrorCode.KEY_VERSION_INVALID });
    // 明细绝不泄漏明文/密钥
    const serialized = JSON.stringify(stats.failures);
    expect(serialized).not.toContain('cannot-recover');
    expect(serialized).not.toContain(K1);
    expect(serialized).not.toContain(K_FOREIGN);
    // 失败行原样保留（绝不产出"看起来迁移成功"的结果），好的行照常换代
    expect(table.get('cred-2')!.keyVersion).toBe(9);
    expect(v2.decrypt(table.get('cred-1')!.encryptedValue)).toBe('ok-1');
    expect(v2.decrypt(table.get('cred-3')!.encryptedValue)).toBe('ok-3');
  });

  it('失败明细上限：超出部分只计数（不无限堆积）', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`cred-${i + 1}`, 'access_token', bogusV9(`x${i}`), 9));
    const { store } = makeStore(rows);
    const stats = await runRewrap(store, v2, { apply: true, maxFailureDetails: 2 });
    expect(stats.failed).toBe(5);
    expect(stats.failures).toHaveLength(2);
    expect(stats.failuresTruncated).toBe(3);
  });

  it('drift 自愈：keyVersion 列与密文失配时按**密文自述版本**纠正（不重新加密）', async () => {
    const currentPayload = v2.encrypt('already-current');
    const stalePayload = legacy(v1, 'still-old');
    const { store, table } = makeStore([
      row('cred-1', 'access_token', currentPayload, 1), // 向下漂移：列说 v1，密文其实已是 v2
      row('cred-2', 'access_token', stalePayload, 9), // 向上漂移：列说 v9，密文其实是 v1（需要迁移）
    ]);
    const stats = await runRewrap(store, v2, { apply: true });

    expect(stats).toMatchObject({ scanned: 2, rewritten: 1, upToDate: 1, driftFixed: 2, failed: 0 });
    // 已是最新版本的漂移行：只修列，密文原样（不无谓换代）
    expect(table.get('cred-1')!.encryptedValue).toBe(currentPayload);
    expect(table.get('cred-1')!.keyVersion).toBe(2);
    // 旧密文的漂移行：换代到 v2 且列同步为 2
    expect(table.get('cred-2')!.keyVersion).toBe(2);
    expect(table.get('cred-2')!.keyVersion).toBe(v2.keyVersionOf(table.get('cred-2')!.encryptedValue));
  });

  it('并发替换（store() 删除重建）：CAS 失配 ⇒ count 0 跳过，绝不覆盖他人写入的新密文', async () => {
    const replacement = v2.encrypt('concurrently-refreshed');
    const { store, table } = makeStore([row('cred-1', 'access_token', legacy(v1, 'old'), 1)], {
      beforeUpdate: () => { table.set('cred-1', { ...table.get('cred-1')!, encryptedValue: replacement, keyVersion: 2 }); },
    });
    const stats = await runRewrap(store, v2, { apply: true });

    expect(stats).toMatchObject({ rewritten: 1, concurrentSkipped: 1, remaining: 1, failed: 0, aborted: false });
    expect(table.get('cred-1')!.encryptedValue).toBe(replacement); // 未被覆盖
    expect(v2.decrypt(table.get('cred-1')!.encryptedValue)).toBe('concurrently-refreshed');
  });

  it('上一批末行被并发删除：扫描继续（主键范围分页），绝不静默截断', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`cred-${i + 1}`, 'access_token', v1.encrypt(`p${i + 1}`), 1));
    // 第 1 批的末行（cred-2）在本批事务进行中被并发删除（store() 的删除重建语义）。
    // 用 Prisma `cursor: { id: 'cred-2' }` 时下一次 findMany 会因游标行不存在而返回**空集** → 扫描"正常结束"
    // 却漏掉 cred-3…cred-6（静默半成品）；主键范围谓词 `id > 'cred-2'` 不受影响，扫描继续。
    const { store, table } = makeStore(rows, {
      beforeUpdate: (args) => { if (args.where.id === 'cred-2') table.delete('cred-2'); },
    });
    const stats = await runRewrap(store, v2, { apply: true, batchSize: 2 });

    expect(stats.batches).toBe(3); // 没有被截断（2+2+2）
    expect(stats.scanned).toBe(6); // 游标位置之后的行全部读到
    expect(stats.concurrentSkipped).toBe(1); // 已被删除的行：CAS count=0，写入跳过（不复活、不覆盖）
    expect(stats.aborted).toBe(false);
    expect([...table.values()].every((r) => r.keyVersion === 2)).toBe(true);
  });

  it('--limit：只扫描 N 行后收尾（灰度试跑）', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`cred-${String(i).padStart(2, '0')}`, 'access_token', v1.encrypt(`p${i}`), 1));
    const { store, table } = makeStore(rows);
    const stats = await runRewrap(store, v2, { apply: true, limit: 3, batchSize: DEFAULT_REWRAP_BATCH_SIZE });

    expect(stats).toMatchObject({ scanned: 3, rewritten: 3, limitReached: true });
    expect([...table.values()].filter((r) => r.keyVersion === 2)).toHaveLength(3);
  });

  it('单密钥配置（无新版本）：一切已是当前版本，零写入', async () => {
    const { store, calls } = makeStore([row('cred-1', 'access_token', v1.encrypt('p'), 1)]);
    const stats = await runRewrap(store, v1, { apply: true });
    expect(stats).toMatchObject({ targetVersion: 1, configuredVersions: [1], rewritten: 0, upToDate: 1, failed: 0 });
    expect(calls.updateMany).toBe(0);
  });
});
