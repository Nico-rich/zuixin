import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { ArtifactService } from './artifact.service';

/**
 * M13-W9 制品只读面（列表/详情/下载代理）——归属与投影是这里的两条防线：
 *  ① 归属：`userId` 恒为首条件；不存在/他人/跨租户一律 404（同码同文案）；
 *  ② 投影：`storageKey` / `idempotencyKey` 等内部列绝不外泄（storageKey 是越权读文件的钥匙）。
 */

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'art-1', userId: 'u1', projectId: 'p1', conversationId: 'c1', messageId: 'm1',
    taskId: null, runId: 'r1', toolCallId: 'tc1', type: 'report', title: '周报', summary: 's',
    content: { k: 'v' }, storageKey: null, idempotencyKey: 'idem-1', status: 'ready',
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
    ...over,
  };
}

function makeService(storage: { getStream?: (key: string) => Promise<Readable> } = {}) {
  const prisma = {
    artifact: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  const svc = new ArtifactService(prisma as never, { delete: vi.fn(), put: vi.fn(), createPresignedUrl: vi.fn(), ...storage } as never);
  return { svc, prisma };
}

describe('ArtifactService.list（M13-W9）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('userId 恒为首条件；type/projectId/conversationId/runId 在归属之上叠加', async () => {
    const { svc, prisma } = makeService();
    await svc.list('u1', { type: 'creative_brief', projectId: 'p1', conversationId: 'c1', runId: 'r1', limit: 5 });

    expect(prisma.artifact.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', type: 'creative_brief', projectId: 'p1', conversationId: 'c1', runId: 'r1' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
  });

  it('无过滤 → where 只有 userId（默认取 30 条）', async () => {
    const { svc, prisma } = makeService();
    await svc.list('u1');
    expect(prisma.artifact.findMany).toHaveBeenCalledWith({ where: { userId: 'u1' }, orderBy: { createdAt: 'desc' }, take: 30 });
  });

  it('limit 收敛到 1..100（越界值不得放大查询）', async () => {
    const { svc, prisma } = makeService();
    const takes = () => (prisma.artifact.findMany as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { take: number }).take);
    await svc.list('u1', { limit: 0 });
    await svc.list('u1', { limit: 1e9 });
    await svc.list('u1', { limit: 12.7 });
    expect(takes()).toEqual([1, 100, 12]);
  });

  it('列表投影裁掉内部列（storageKey/idempotencyKey/userId）与 content 证据体；无文件 → downloadUrl=null', async () => {
    const { svc, prisma } = makeService();
    (prisma.artifact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([row({ storageKey: null })]);

    const [view] = await svc.list('u1');

    expect(view).not.toHaveProperty('storageKey');
    expect(view).not.toHaveProperty('idempotencyKey');
    expect(view).not.toHaveProperty('userId');
    expect(view.downloadUrl).toBeNull();
    expect(view.content).toBeNull(); // 正文只在详情端点（列表一次 100 行不搬运大 JSON）
    expect(view).toMatchObject({ id: 'art-1', type: 'report', title: '周报', runId: 'r1', toolCallId: 'tc1' });
  });

  it('有文件 → downloadUrl 指向代理端点（绝不给出 storageKey / 预签名外链）', async () => {
    const { svc, prisma } = makeService();
    (prisma.artifact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([row({ storageKey: 'artifact/u1/x.png' })]);

    const [view] = await svc.list('u1');

    expect(view.downloadUrl).toBe('/api/v1/artifacts/art-1/download');
    expect(JSON.stringify(view)).not.toContain('artifact/u1/x.png');
  });
});

describe('ArtifactService.detail / openStream（M13-W9）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detail：归属不符/不存在 → 404（同码同文案，不区分存在性）', async () => {
    const { svc, prisma } = makeService();
    prisma.artifact.findFirst.mockResolvedValue(null);

    const err = await svc.detail('u1', 'art-other').catch((e) => e);
    expect(err).toMatchObject({ code: 'NOT_FOUND', message: '制品不存在' });
    expect(prisma.artifact.findFirst).toHaveBeenCalledWith({ where: { id: 'art-other', userId: 'u1' } });
  });

  it('openStream：无关联文件 → 404（不触碰存储驱动）', async () => {
    const { svc, prisma } = makeService({ getStream: vi.fn() });
    prisma.artifact.findFirst.mockResolvedValue(row({ storageKey: null }));

    await expect(svc.openStream('u1', 'art-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('openStream：有文件 → 归属校验后回源（存储读取发生在授权之后）', async () => {
    const stream = Readable.from([Buffer.from('bytes')]);
    const getStream = vi.fn().mockResolvedValue(stream);
    const { svc, prisma } = makeService({ getStream });
    prisma.artifact.findFirst.mockResolvedValue(row({ storageKey: 'artifact/u1/x.bin' }));

    const out = await svc.openStream('u1', 'art-1');

    expect(prisma.artifact.findFirst).toHaveBeenCalledWith({ where: { id: 'art-1', userId: 'u1' } });
    expect(getStream).toHaveBeenCalledWith('artifact/u1/x.bin');
    expect(out.stream).toBe(stream);
    expect(out.artifact.downloadUrl).toBe('/api/v1/artifacts/art-1/download');
  });

  it('openStream：他人制品 → 404 且**零存储读取**（授权先于回源）', async () => {
    const getStream = vi.fn();
    const { svc, prisma } = makeService({ getStream });
    prisma.artifact.findFirst.mockResolvedValue(null); // 非本人资源对调用方不可见

    await expect(svc.openStream('u1', 'art-other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(getStream).not.toHaveBeenCalled();
  });
});
