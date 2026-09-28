import { describe, it, expect, vi } from 'vitest';
import { AttachmentsService } from './attachments.service';
import { AttachmentHttpError } from './attachment-errors';
import { AppError } from '../../common/errors/app-error';
import { makeBombZip, makeJpegWithExif, makeNormalZip, makePngWithMetadata } from '../../../test/support/attachment-fixtures';

/**
 * M10-P7 附件服务的三段新增行为（审计 SA-19/X-18/SA-20）：
 * ① 配额预留/回滚释放/账本入账的**顺序与幂等键**；② zip 声明校验在配额之前；③ 元数据清洗后的
 * 字节与大小才是落库/落存储的权威。
 */

type Mocks = ReturnType<typeof makeService>;

/** 存储驱动入参（与 StorageAdapter.put 一致；显式声明便于对 mock.calls 做类型安全断言） */
interface StoredStream { read: () => Buffer }

function makeService() {
  const prisma = {
    attachment: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data })) },
    conversation: { findFirst: vi.fn(async (_args: { where: Record<string, unknown> }) => null as { projectId: string | null } | null) },
  };
  const storage = {
    put: vi.fn(async (_key: string, _body: StoredStream, _meta: { contentType: string; sizeBytes: number }) => undefined),
    delete: vi.fn(async (_key: string) => undefined),
    createPresignedUrl: vi.fn(async (_key: string) => 'local://x'),
    getStream: vi.fn(async (_key: string) => null),
  };
  const quota = {
    assertQuota: vi.fn(async (_userId: string, _projectId: string | null, _kind: string, _quantity: number, _refId: string) =>
      ({ organizationId: 'org-personal', consumed: 0, total: 100, reservationId: 'res-1' })),
    release: vi.fn(async (_refId: string, _kind: string) => undefined),
  };
  const billing = { recordUsage: vi.fn(async (_input: Record<string, unknown>) => undefined) };
  const svc = new AttachmentsService(prisma as never, storage as never, quota as never, billing as never);
  return { svc, prisma, storage, quota, billing };
}

const upload = (m: Mocks, mimetype: string, buffer: Buffer, name = 'x.bin', meta?: { conversationId?: string }) =>
  m.svc.save('user-1', { buffer, mimetype, originalname: name, size: buffer.length }, meta);

describe('AttachmentsService 配额（M10-P7）', () => {
  it('上传成功：预留 → 存储/落库 → 账本入账 → 释放预留（顺序固定，refId=attachmentId 幂等键）', async () => {
    const m = makeService();
    const png = makePngWithMetadata();
    const row = await upload(m, 'image/png', png, 'a.png');

    const [userId, projectId, kind, quantity, refId] = m.quota.assertQuota.mock.calls[0] as unknown as [string, string | null, string, number, string];
    expect({ userId, projectId, kind, quantity }).toEqual({ userId: 'user-1', projectId: null, kind: 'attachment_upload', quantity: 1 });
    expect(refId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.id).toBe(refId); // 幂等键 = 附件 id（同一上传重放绝不二次计量）
    expect((m.prisma.attachment.create.mock.calls[0][0] as { data: { id: string } }).data.id).toBe(refId);

    expect(m.billing.recordUsage).toHaveBeenCalledTimes(1);
    expect(m.billing.recordUsage.mock.calls[0][0]).toMatchObject({
      userId: 'user-1', organizationId: 'org-personal', kind: 'attachment_upload', quantity: 1,
      idempotencyKey: `att:${refId}`,
    });
    // 终态释放：账本入账**之后**才释放（先落 durable 计数，再放预留——顺序反转会漏计）
    expect(m.quota.release).toHaveBeenCalledWith(refId, 'attachment_upload');
    expect(m.quota.release.mock.invocationCallOrder[0]).toBeGreaterThan(m.billing.recordUsage.mock.invocationCallOrder[0]);
  });

  it('配额超限（QUOTA_EXCEEDED）→ 429 ATTACHMENT_QUOTA_EXCEEDED，绝不落对象/落库/计量', async () => {
    const m = makeService();
    m.quota.assertQuota.mockRejectedValue(new AppError('QUOTA_EXCEEDED', '本月 attachment_upload 配额已用尽（100/100）'));
    await expect(upload(m, 'image/png', makePngWithMetadata(), 'a.png')).rejects.toMatchObject({
      code: 'ATTACHMENT_QUOTA_EXCEEDED',
    });
    try { await upload(m, 'image/png', makePngWithMetadata(), 'a.png'); } catch (err) {
      expect(err).toBeInstanceOf(AttachmentHttpError);
      expect((err as AttachmentHttpError).getStatus()).toBe(429);
    }
    expect(m.storage.put).not.toHaveBeenCalled();
    expect(m.prisma.attachment.create).not.toHaveBeenCalled();
    expect(m.billing.recordUsage).not.toHaveBeenCalled();
    expect(m.quota.release).not.toHaveBeenCalled(); // 预留由 assertQuota 自身回滚，服务层不重复释放
  });

  it('存储失败 → 释放预留 + 不落库 + 不计量（预留绝不残留占用）', async () => {
    const m = makeService();
    m.storage.put.mockRejectedValue(new Error('S3 不可达'));
    await expect(upload(m, 'image/png', makePngWithMetadata(), 'a.png')).rejects.toThrow('S3 不可达');
    expect(m.prisma.attachment.create).not.toHaveBeenCalled();
    expect(m.billing.recordUsage).not.toHaveBeenCalled();
    expect(m.quota.release).toHaveBeenCalledTimes(1);
    expect(m.storage.delete).not.toHaveBeenCalled(); // put 未成功 → 无孤儿对象可清
  });

  it('落库失败（对象已写）→ 释放预留 + 尽力清理已落对象', async () => {
    const m = makeService();
    m.prisma.attachment.create.mockRejectedValue(new Error('unique 冲突'));
    await expect(upload(m, 'image/png', makePngWithMetadata(), 'a.png')).rejects.toThrow('unique 冲突');
    expect(m.quota.release).toHaveBeenCalledTimes(1);
    expect(m.storage.delete).toHaveBeenCalledTimes(1);
    expect(m.billing.recordUsage).not.toHaveBeenCalled();
  });

  it('会话归属：conversationId 命中同用户会话 → 用会话项目组织（与 chat/run 归集口径一致）', async () => {
    const m = makeService();
    m.prisma.conversation.findFirst.mockResolvedValue({ projectId: 'proj-9' });
    await upload(m, 'image/png', makePngWithMetadata(), 'a.png', { conversationId: 'conv-1' });
    expect(m.prisma.conversation.findFirst.mock.calls[0][0]).toMatchObject({ where: { id: 'conv-1', userId: 'user-1' } });
    expect((m.quota.assertQuota.mock.calls[0] as unknown[])[1]).toBe('proj-9');
  });
});

describe('AttachmentsService 内容安全（M10-P7）', () => {
  it('真实炸弹 zip（docx 声明）→ 400 ATTACHMENT_UNZIP_REJECTED，且不进入配额/存储', async () => {
    const m = makeService();
    const bomb = makeBombZip();
    await expect(upload(m, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bomb, 'bomb.docx'))
      .rejects.toMatchObject({ code: 'ATTACHMENT_UNZIP_REJECTED' });
    expect(m.quota.assertQuota).not.toHaveBeenCalled(); // 纯内存校验先于配额（坏文件不占额度）
    expect(m.storage.put).not.toHaveBeenCalled();
    expect(m.prisma.attachment.create).not.toHaveBeenCalled();
  });

  it('正常 docx 形态 zip → 放行（防误杀）', async () => {
    const m = makeService();
    const row = await upload(m, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', makeNormalZip(), 'ok.docx');
    expect(row.type).toBe('file');
    expect(m.storage.put).toHaveBeenCalledTimes(1);
  });

  it('JPEG 带 EXIF → 存储与落库都用**清洗后**字节（EXIF 不进对象存储，也不进 vision data URL 链路）', async () => {
    const m = makeService();
    const jpeg = makeJpegWithExif();
    const row = await upload(m, 'image/jpeg', jpeg, 'photo.jpg');

    const [, stream, meta] = m.storage.put.mock.calls[0] as unknown as [string, { read: () => Buffer }, { contentType: string; sizeBytes: number }];
    const storedBuf = stream.read() as Buffer;
    expect(storedBuf.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
    expect(storedBuf.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(storedBuf.length).toBeLessThan(jpeg.length);
    expect(meta).toMatchObject({ contentType: 'image/jpeg', sizeBytes: storedBuf.length });

    const created = (m.prisma.attachment.create.mock.calls[0][0] as { data: { sizeBytes: number; metadata: Record<string, unknown> } }).data;
    expect(created.sizeBytes).toBe(storedBuf.length); // 库内大小 = 对象大小（绝不错位）
    expect(created.metadata).toMatchObject({ metadataStripped: true, removedKinds: ['APP1', 'APP1'] });
  });

  it('PNG 元数据块同时被剔除，且剥离后仍是可解压的合法 PNG', async () => {
    const m = makeService();
    const png = makePngWithMetadata();
    await upload(m, 'image/png', png, 'p.png');
    const [, stream] = m.storage.put.mock.calls[0] as unknown as [string, { read: () => Buffer }];
    const storedBuf = stream.read() as Buffer;
    expect(storedBuf.includes(Buffer.from('GPS 37.7749', 'latin1'))).toBe(false);
    expect(storedBuf.length).toBeLessThan(png.length);
    expect((m.prisma.attachment.create.mock.calls[0][0] as { data: { sizeBytes: number } }).data.sizeBytes).toBe(storedBuf.length);
  });

  it('清洗只做减法：清洗后字节仍通过文件头嗅探（FFD8FF / PNG 签名不被破坏）', async () => {
    const m = makeService();
    await upload(m, 'image/jpeg', makeJpegWithExif(), 'photo.jpg');
    await upload(m, 'image/png', makePngWithMetadata(), 'p.png');
    const stored = (m.storage.put.mock.calls.map((c) => (c[1] as { read: () => Buffer }).read()));
    expect(stored[0].subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(stored[1].subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});
