import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { CryptoService } from '../src/core/crypto/crypto.service';
import { runRewrap } from '../src/core/crypto/rewrap.runner';
import { CredentialService } from '../src/modules/connections/credentials.service';

/**
 * M11-P1（D1-09 / NV-11）密钥轮换收尾 e2e（真实 PostgreSQL）：
 *
 * 造存量 v1 凭证（含**历史 3 段格式**）→ 只读 dry-run 不改库 → 迁移（每批事务）→
 * ① DB 里 `keyVersion` 与密文同步换代到 v2 且 `requireCurrent` 可解（旧密钥窗口内仍可解）；
 * ② 读路径（CredentialService）在迁移前可读旧版本并记欠账、迁移后零欠账；
 * ③ 幂等：重复迁移零写入；④ 无法迁移的行（版本未知）如实失败且**不阻塞**其他行。
 *
 * 安全边界（本用例与全仓库其他 e2e **共享同一个开发库**）：
 * - 测试用**本用例自带的密钥对**（K1/K2），与仓库 .env 的 ENCRYPTION_KEY 无关；因此本用例的
 *   `apply` 只能解密/改写**它自己造的 4 行**——他人数据用生产密钥加密，在本用例的密钥集下解密必然
 *   失败（GCM 认证失败）⇒ 只会被计入失败行，**绝不可能被写库**。用例末尾另行断言"他人行逐字节未变"。
 * - 输出纪律：断言里不含任何明文与密钥值（只比对长度/等值/错误码），清理只删本用例自建的行。
 */

const K1 = Buffer.alloc(32, 21).toString('base64');
const K2 = Buffer.alloc(32, 22).toString('base64');

const v1 = new CryptoService({ keys: { 1: K1 }, currentVersion: 1 });
/** 轮换窗口：旧版本仍可解（这就是"不停机轮换"的含义） */
const v2 = new CryptoService({ keys: { 1: K1, 2: K2 }, currentVersion: 2 });

const LEGACY_PLAIN = 'm11p1-access-legacy-plain';
const MODERN_PLAIN = 'm11p1-refresh-modern-plain';
const CURRENT_PLAIN = 'm11p1-access-current-plain';
const BOGUS_PLAIN = 'm11p1-access-unreadable-plain';

describe('M11-P1 密钥轮换（rewrap 脚本 + 读路径版本裁决，真实 DB）', () => {
  const prisma = new PrismaClient();
  let userId = '';
  let connA = ''; // v1 凭证（迁移对象）
  let connB = ''; // 已是当前版本（不动的对照）
  let connC = ''; // 版本未知（无法迁移）
  /** 他人（本用例之外）的凭证行快照：迁移期间必须逐字节不变 */
  let foreignBefore = new Map<string, string>();

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `m11-p1-rewrap-${Date.now()}@example.com`, passwordHash: 'unused-hash' },
    });
    userId = user.id;
    const conn = async (account: string) => (await prisma.connection.create({
      data: { userId, provider: 'mock', providerAccountId: account, status: 'active' },
    })).id;
    connA = await conn('m11-p1-a');
    connB = await conn('m11-p1-b');
    connC = await conn('m11-p1-c');

    const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    await prisma.credential.create({
      data: {
        connectionId: connA, type: 'access_token', keyVersion: 1, createdAt: t(4),
        encryptedValue: v1.encrypt(LEGACY_PLAIN, 1).replace(/^v1\./, ''), // 历史 3 段格式（无版本前缀）
      },
    });
    await prisma.credential.create({
      data: {
        connectionId: connA, type: 'refresh_token', keyVersion: 1, createdAt: t(3),
        encryptedValue: v1.encrypt(MODERN_PLAIN, 1), // 现代格式 v1
      },
    });
    await prisma.credential.create({
      data: {
        connectionId: connB, type: 'access_token', keyVersion: 2, createdAt: t(2),
        encryptedValue: v2.encrypt(CURRENT_PLAIN),
      },
    });
    await prisma.credential.create({
      data: {
        connectionId: connC, type: 'access_token', keyVersion: 9, createdAt: t(1),
        encryptedValue: v1.encrypt(BOGUS_PLAIN, 1).replace(/^v1\./, 'v9.'), // 版本 9 不在任何配置密钥中
      },
    });

    const mine = new Set([connA, connB, connC]);
    const others = await prisma.credential.findMany({ where: { connectionId: { notIn: [...mine] } } });
    foreignBefore = new Map(others.map((c) => [c.id, `${c.encryptedValue}|${c.keyVersion}`]));
  });

  afterAll(async () => {
    await prisma.connection.deleteMany({ where: { id: { in: [connA, connB, connC].filter(Boolean) } } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  });

  /** 读路径用的服务实例（与生产同一条代码路径；provider 依赖本用例不触碰） */
  const reader = () => new CredentialService(prisma as never, v2, {} as never);

  it('读路径：迁移前旧版本凭证可读（多密钥窗口）并记迁移欠账；未知版本 → KEY_VERSION_INVALID', async () => {
    const svc = reader();
    expect((await svc.getAccessToken(connA))?.token).toBe(LEGACY_PLAIN); // 历史格式 v1 正常解密
    expect(await svc.getRefreshToken(connA)).toBe(MODERN_PLAIN);
    expect(svc.staleKeyVersionStats()).toMatchObject({ total: 2, byVersion: { '1': 2 }, currentKeyVersion: 2 });

    expect((await svc.getAccessToken(connB))?.token).toBe(CURRENT_PLAIN);
    expect(svc.staleKeyVersionStats().total).toBe(2); // 当前版本不增加欠账

    await expect(svc.getAccessToken(connC)).rejects.toMatchObject({ code: 'KEY_VERSION_INVALID' });
    // 未知版本行在"必须最新密钥"的严格读面上表现为 CREDENTIAL_REWRAP_REQUIRED（脚本的失败行语义）
    const bogus = await prisma.credential.findFirstOrThrow({ where: { connectionId: connC } });
    expect(() => v2.decrypt(bogus.encryptedValue, { requireCurrent: true })).toThrow(/rewrap/);
  });

  it('dry-run（默认）：只判定不写库；apply：v1 → v2 且 keyVersion 同步；无法迁移的行如实失败', async () => {
    const beforeDry = await prisma.credential.findMany({ where: { connectionId: { in: [connA, connB, connC] } } });
    const dry = await runRewrap(prisma as never, v2, { apply: false, maxFailureDetails: 1000 });
    expect(dry.dryRun).toBe(true);
    expect(dry.rewritten).toBe(2); // 只有本用例的 2 行 v1 可被本用例密钥解密 ⇒ 在计划内
    const afterDry = await prisma.credential.findMany({ where: { connectionId: { in: [connA, connB, connC] } } });
    // dry-run 逐字节未写库（默认值就是"只读"，比"文档声称只读"更值得断言）
    expect(afterDry.map((c) => `${c.id}:${c.encryptedValue}:${c.keyVersion}`).sort())
      .toEqual(beforeDry.map((c) => `${c.id}:${c.encryptedValue}:${c.keyVersion}`).sort());

    const stats = await runRewrap(prisma as never, v2, { apply: true, batchSize: 500, maxFailureDetails: 1000 });
    expect(stats).toMatchObject({ dryRun: false, rewritten: 2, failed: expect.any(Number), aborted: false });
    expect(stats.fromVersions).toEqual({ '1': 2 });
    expect(stats.configuredVersions).toEqual([1, 2]);
    expect(stats.targetVersion).toBe(2);

    // ① 迁移结果：DB 行换代到 v2，keyVersion 与密文自述版本一致，requireCurrent 可解，明文不变
    const migrated = await prisma.credential.findMany({ where: { connectionId: connA } });
    expect(migrated).toHaveLength(2);
    expect(migrated.every((c) => c.keyVersion === 2)).toBe(true);
    expect(migrated.every((c) => v2.keyVersionOf(c.encryptedValue) === 2)).toBe(true);
    expect(migrated.every((c) => c.encryptedValue.startsWith('v2.'))).toBe(true);
    expect(migrated.every((c) => c.encryptedValue !== LEGACY_PLAIN && !c.encryptedValue.includes('plain'))).toBe(true);
    const plains = migrated.map((c) => v2.decrypt(c.encryptedValue, { requireCurrent: true }));
    expect(plains.sort()).toEqual([MODERN_PLAIN, LEGACY_PLAIN].sort()); // 明文不变（只是换代）

    // ② 已是当前版本的行：密文原样（不做无谓换代）
    const untouched = await prisma.credential.findFirstOrThrow({ where: { connectionId: connB } });
    expect(untouched.keyVersion).toBe(2);
    expect(v2.decrypt(untouched.encryptedValue)).toBe(CURRENT_PLAIN);

    // ③ 无法迁移的行：如实失败（绝不伪装成迁移成功），且不阻塞同表其他行
    const stillBogus = await prisma.credential.findFirstOrThrow({ where: { connectionId: connC } });
    expect(stillBogus.keyVersion).toBe(9);
    const mine = stats.failures.filter((f) => f.id === stillBogus.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].code).toBe('KEY_VERSION_INVALID');
    expect(JSON.stringify(mine)).not.toContain(BOGUS_PLAIN); // 明细绝不泄漏明文

    // ④ 他人数据逐字节未变（本用例只能改写自己造的、可被自己密钥解密的行）
    const others = await prisma.credential.findMany({ where: { connectionId: { notIn: [connA, connB, connC] } } });
    for (const row of others) {
      const before = foreignBefore.get(row.id);
      if (before === undefined) continue; // 期间新增的行（其他用例）不在快照内
      expect(`${row.encryptedValue}|${row.keyVersion}`).toBe(before);
    }
  });

  it('幂等：重复迁移零写入；迁移后读路径零欠账且明文不变', async () => {
    const second = await runRewrap(prisma as never, v2, { apply: true, maxFailureDetails: 1000 });
    expect(second.rewritten).toBe(0); // 已是最新版本 ⇒ 不写库
    expect(second.upToDate).toBeGreaterThanOrEqual(3); // connA×2 + connB

    const svc = reader();
    expect((await svc.getAccessToken(connA))?.token).toBe(LEGACY_PLAIN);
    expect(await svc.getRefreshToken(connA)).toBe(MODERN_PLAIN);
    expect(svc.staleKeyVersionStats().total).toBe(0); // 迁移后无旧版本读取（欠账清零）
  });
});
