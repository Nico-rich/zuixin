import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { HttpException } from '@nestjs/common';
import { ZIP_GUARD_LIMITS, assertZipSafe, inspectZip } from './archive-guard';
import { AttachmentHttpError } from './attachment-errors';
import {
  BOMB_INFLATED_BYTES, buildZip, makeBombZip, makeDeclaredBombZip, makeMalformedZip,
  makeManyEntriesZip, makeNormalZip, makeSmallHighRatioZip, readFirstEntryPayload,
} from '../../../test/support/attachment-fixtures';

/**
 * M10-P7 zip 解压炸弹防护单测（审计 SA-19/X-18）。
 *
 * 夹具是**真实二进制**：炸弹 zip 的条目不压缩体积确实等于 40MB（本文件用 inflateRawSync 复核），
 * 不是"只改 header 的假炸弹"；正常 zip 是标准 central directory 结构。
 */
describe('archive-guard（M10-P7 压缩炸弹声明校验）', () => {
  it('正常 docx 形态 zip → 放行，声明体积/条目数/膨胀比可观测', () => {
    const zip = makeNormalZip();
    const verdict = inspectZip(zip);
    expect(verdict.ok).toBe(true);
    expect(verdict.inspection).toMatchObject({ entries: 3, inputBytes: zip.length, zip64: false });
    expect(verdict.inspection!.uncompressedBytes).toBeGreaterThan(0);
    expect(verdict.inspection!.uncompressedBytes).toBeLessThan(ZIP_GUARD_LIMITS.MAX_UNCOMPRESSED_BYTES);
    expect(() => assertZipSafe(zip)).not.toThrow();
  });

  it('真实炸弹 zip（可 inflate 出 40MB）→ 拒绝 RATIO_LIMIT（400 ATTACHMENT_UNZIP_REJECTED）', () => {
    const zip = makeBombZip();
    // 前置证明：这不是"只改 header 的假炸弹"——真实压缩数据 inflate 后确实是 40MB
    expect(inflateRawSync(readFirstEntryPayload(zip)).length).toBe(BOMB_INFLATED_BYTES);
    expect(zip.length).toBeLessThan(200 * 1024); // 40KB 级输入 → 膨胀比 ~1000:1

    const verdict = inspectZip(zip);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('RATIO_LIMIT');
    expect(verdict.inspection!.uncompressedBytes).toBe(BOMB_INFLATED_BYTES);
    expect(verdict.inspection!.ratio).toBeGreaterThan(ZIP_GUARD_LIMITS.MAX_EXPANSION_RATIO);

    try {
      assertZipSafe(zip);
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(AttachmentHttpError);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as AttachmentHttpError).code).toBe('ATTACHMENT_UNZIP_REJECTED');
      expect((err as AttachmentHttpError).getStatus()).toBe(400);
    }
  });

  it('声明解压总量超硬上限（1KB 输入谎报 600MB）→ 拒绝 UNCOMPRESSED_LIMIT', () => {
    const verdict = inspectZip(makeDeclaredBombZip());
    expect(verdict).toMatchObject({ ok: false, reason: 'UNCOMPRESSED_LIMIT' });
    expect(verdict.inspection!.uncompressedBytes).toBe(600 * 1024 * 1024);
  });

  it('高压缩比但解压后 < 32MB（8MB 空格）→ 放行（防误杀：膨胀比只在大体积上启用）', () => {
    const zip = makeSmallHighRatioZip();
    const verdict = inspectZip(zip);
    expect(verdict.ok).toBe(true);
    expect(verdict.inspection!.ratio).toBeGreaterThan(ZIP_GUARD_LIMITS.MAX_EXPANSION_RATIO); // 比很高
    expect(verdict.inspection!.uncompressedBytes).toBeLessThan(ZIP_GUARD_LIMITS.MIN_RATIO_CHECK_BYTES);
  });

  it('畸形 zip（无 central directory/EOCD）→ 拒绝 MALFORMED', () => {
    const verdict = inspectZip(makeMalformedZip());
    expect(verdict).toMatchObject({ ok: false, reason: 'MALFORMED', inspection: null });
    expect(verdict.detail).toContain('EOCD');
  });

  it('声明条目数超上限（zip of death）→ 拒绝 ENTRY_LIMIT（且不遍历条目）', () => {
    const verdict = inspectZip(makeManyEntriesZip(50_000));
    expect(verdict).toMatchObject({ ok: false, reason: 'ENTRY_LIMIT' });
    expect(verdict.detail).toContain('50000');
  });

  it('zip64：体积写在 zip64 扩展字段 → 同样按声明裁决（小体积放行 / 炸弹拒绝）', () => {
    const safe = inspectZip(buildZip64(4096));
    expect(safe.ok).toBe(true);
    expect(safe.inspection).toMatchObject({ zip64: true, uncompressedBytes: 4096 });

    const bomb = inspectZip(buildZip64(600 * 1024 * 1024));
    expect(bomb).toMatchObject({ ok: false, reason: 'UNCOMPRESSED_LIMIT' });
    expect(bomb.inspection!.uncompressedBytes).toBe(600 * 1024 * 1024);
  });

  it('边界：截断的 zip（EOCD 被截掉一半）→ MALFORMED，绝不静默放行', () => {
    const truncated = makeNormalZip().subarray(0, makeNormalZip().length - 30);
    expect(inspectZip(truncated)).toMatchObject({ ok: false, reason: 'MALFORMED' });
  });

  it('防护自身开销可控：50MB 级声明的解析是 O(CD 条目数)，不分配声明体积内存', () => {
    const zip = makeDeclaredBombZip(50 * 1024 * 1024);
    const before = process.memoryUsage().heapUsed;
    inspectZip(zip);
    const delta = process.memoryUsage().heapUsed - before;
    expect(delta).toBeLessThan(32 * 1024 * 1024); // 绝不为"声明 50MB"分配 50MB
  });
});

/**
 * 手工构造 zip64 归档（EOCD64 记录 + locator + 哨兵 EOCD + CD 内 zip64 扩展字段）。
 * 真实文档不可能这么大，但解析器必须正确读 **zip64 扩展字段**里的声明值——否则攻击者可用
 * zip64 形式绕过 32 位字段校验（"哨兵值即未知"= 漏判）。
 */
function buildZip64(declaredUncompressed: number): Buffer {
  const name = Buffer.from('z64.bin', 'utf8');
  const payload = Buffer.alloc(64, 0x5a); // stored 小数据（真实体积无关紧要）
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(45, 6);            // version needed: zip64
  local.writeUInt16LE(0, 8);             // stored
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localBlock = Buffer.concat([local, name, payload]);

  const zip64Extra = Buffer.alloc(4 + 16);
  zip64Extra.writeUInt16LE(0x0001, 0);
  zip64Extra.writeUInt16LE(16, 2);
  zip64Extra.writeBigUInt64LE(BigInt(declaredUncompressed), 4);
  zip64Extra.writeBigUInt64LE(BigInt(payload.length), 12);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(45, 4);
  cd.writeUInt16LE(45, 6);
  cd.writeUInt16LE(0, 10);
  cd.writeUInt32LE(payload.length, 20);
  cd.writeUInt32LE(0xffffffff, 24); // 哨兵：体积见 zip64 扩展字段
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt16LE(zip64Extra.length, 30);
  cd.writeUInt32LE(0, 42);
  const cdBlock = Buffer.concat([cd, name, zip64Extra]);

  const cdOffset = localBlock.length;
  const eocd64 = Buffer.alloc(56);
  eocd64.writeUInt32LE(0x06064b50, 0);
  eocd64.writeBigUInt64LE(BigInt(44), 4);  // 记录本体长度（56 - 12）
  eocd64.writeUInt16LE(45, 12);
  eocd64.writeUInt16LE(45, 14);
  eocd64.writeBigUInt64LE(BigInt(1), 24);  // 本盘条目数
  eocd64.writeBigUInt64LE(BigInt(1), 32);  // 总条目数
  eocd64.writeBigUInt64LE(BigInt(cdBlock.length), 40);
  eocd64.writeBigUInt64LE(BigInt(cdOffset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(cdOffset + cdBlock.length), 8); // EOCD64 记录偏移
  locator.writeUInt32LE(1, 16);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);

  return Buffer.concat([localBlock, cdBlock, eocd64, locator, eocd]);
}

// buildZip 在本文件用于对照：zip64 构造与常规构造的体积口径必须一致
describe('archive-guard 口径一致性', () => {
  it('同一份内容的常规 zip 与 zip64 zip 声明值一致（解析器不因编码形式漂移）', () => {
    expect(inspectZip(buildZip([{ name: 'a.bin', data: Buffer.alloc(4096, 1) }])).inspection!.uncompressedBytes)
      .toBe(inspectZip(buildZip64(4096)).inspection!.uncompressedBytes);
  });
});
