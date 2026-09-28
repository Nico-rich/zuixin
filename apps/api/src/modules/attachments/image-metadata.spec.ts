import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { AppError } from '../../common/errors/app-error';
import { sanitizeImageMetadata, stripJpegExif, stripPngMetadata } from './image-metadata';
import { makeJpegWithExif, makePngWithMetadata, parsePngChunks, walkJpegSegments } from '../../../test/support/attachment-fixtures';

/**
 * M10-P7 图片元数据清洗单测（审计 SA-19/X-18）。
 *
 * 断言强度说明：
 * - JPEG：无解码依赖可用（约束禁装图像库），故以"段级逐字节等价"证明可解码性不变——
 *   剔除的只有 APP1（EXIF/XMP，解码器不读），其余每个段与输入**完全相同**，SOS 之后的熵编码
 *   数据整体原样拷贝。
 * - PNG：IDAT 是 zlib 流，可**真实解压**像素数据比对，且每块 CRC 可**真实校验**——
 *   元数据块删除后像素路径与 CRC 全部自洽（真解码往返）。
 */
describe('image-metadata（M10-P7 EXIF/元数据清洗）', () => {
  it('JPEG：剔除全部 APP1(EXIF/XMP)，其余段逐字节不变，熵编码数据原样保留', () => {
    const input = makeJpegWithExif();
    const before = walkJpegSegments(input);
    expect(before.filter((s) => s.marker === 0xe1).length).toBe(2); // 前置：确有 2 个 APP1

    const result = stripJpegExif(input);
    expect(result.stripped).toBe(true);
    expect(result.removedSegments).toBe(2);
    expect(result.removedKinds).toEqual(['APP1', 'APP1']);
    expect(result.removedBytes).toBe(before.filter((s) => s.marker === 0xe1).reduce((n, s) => n + (s.end - s.start), 0));
    expect(result.buffer.length).toBe(input.length - result.removedBytes);

    // 十六进制断言：清洗后以 SOI + APP0(JFIF, 段长 0x0010) 开头（APP1 整段消失）
    expect(result.buffer.subarray(0, 6).toString('hex')).toBe('ffd8' + 'ffe0' + '0010');
    // EXIF/XMP 载荷与签名绝不存在于输出中（含 GPS 文本/XMP 命名空间）
    expect(result.buffer.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
    expect(result.buffer.includes(Buffer.from('xmpmeta', 'latin1'))).toBe(false);
    expect(result.buffer.includes(Buffer.from('Orientation', 'latin1'))).toBe(false);

    // 保留段逐字节等价（APP0/APP2/DQT/SOF0/DHT/SOS+扫描数据/EOI）
    const after = walkJpegSegments(result.buffer);
    const beforeKept = before.filter((s) => s.marker !== 0xe1);
    expect(after.length).toBe(beforeKept.length);
    for (let i = 0; i < beforeKept.length; i++) {
      expect(after[i].marker).toBe(beforeKept[i].marker);
      expect(Buffer.compare(
        result.buffer.subarray(after[i].start, after[i].end),
        input.subarray(beforeKept[i].start, beforeKept[i].end),
      )).toBe(0);
    }
    // 结构完整性：仍有 SOS 且以 EOI 结尾（解码器可达扫描数据）
    expect(after.some((s) => s.marker === 0xda)).toBe(true);
    expect(result.buffer.subarray(-2).toString('hex')).toBe('ffd9');
    // 熵编码数据中的 0xFF00 字节填充与 RST0 完整保留（绝不逐字节解析扫描段）
    expect(result.buffer.includes(Buffer.from([0xff, 0x00, 0x12, 0x34, 0xff, 0xd0, 0x56, 0x78]))).toBe(true);
  });

  it('JPEG：无 APP1 → 原样返回（stripped=false，buffer 同一引用，绝不复制改写）', () => {
    const noExif = stripJpegExif(makeJpegWithExif()).buffer;
    const again = stripJpegExif(noExif);
    expect(again.stripped).toBe(false);
    expect(again.buffer).toBe(noExif);
  });

  it('JPEG：段长越界（畸形）→ 400 VALIDATION_ERROR，绝不静默存原样', () => {
    const broken = Buffer.from(makeJpegWithExif());
    broken.writeUInt16BE(0xffff, 4); // APP0 段长写成远超文件大小
    expect(() => stripJpegExif(broken)).toThrowError(AppError);
    try { stripJpegExif(broken); } catch (err) { expect((err as AppError).code).toBe('VALIDATION_ERROR'); }
    // 非 0xFF 起始（SOI 后不是段）同样拒绝
    const garbage = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64, 0x41)]);
    try { stripJpegExif(garbage); throw new Error('应当抛错'); }
    catch (err) { expect((err as AppError).code).toBe('VALIDATION_ERROR'); }
  });

  it('PNG：剔除 eXIf/tEXt，像素路径（IDAT 解压）与剩余块 CRC 全自洽（真解码往返）', () => {
    const input = makePngWithMetadata();
    const beforeChunks = parsePngChunks(input);
    expect(beforeChunks.map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'eXIf', 'IDAT', 'IEND']);
    expect(beforeChunks.every((c) => c.crcOk)).toBe(true); // 前置：夹具本身是合法 PNG（CRC 正确）
    const pixelsBefore = inflateRawSync(input.subarray(
      input.indexOf(Buffer.from('IDAT', 'latin1')) + 4,
      input.indexOf(Buffer.from('IDAT', 'latin1')) + 4 + input.readUInt32BE(input.indexOf(Buffer.from('IDAT', 'latin1')) - 4),
    ));

    const result = stripPngMetadata(input);
    expect(result.stripped).toBe(true);
    expect(result.removedKinds).toEqual(['tEXt', 'eXIf']);

    const afterChunks = parsePngChunks(result.buffer);
    expect(afterChunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(afterChunks.every((c) => c.crcOk), '剩余块 CRC 必须仍然正确（整块删除不影响其它块）').toBe(true);

    // 像素数据真实可比：IDAT 解压出与清洗前完全相同的扫描行（图片本身未被破坏）
    const idatPos = result.buffer.indexOf(Buffer.from('IDAT', 'latin1'));
    const idatLen = result.buffer.readUInt32BE(idatPos - 4);
    const pixelsAfter = inflateRawSync(result.buffer.subarray(idatPos + 4, idatPos + 4 + idatLen));
    expect(Buffer.compare(pixelsAfter, pixelsBefore)).toBe(0);
    expect(pixelsAfter.toString('hex')).toBe('007f');

    // 元数据载荷（GPS 文本 / Exif 签名）绝不残留在输出中
    expect(result.buffer.includes(Buffer.from('GPS 37.7749', 'latin1'))).toBe(false);
    expect(result.buffer.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
  });

  it('PNG：无元数据块 → 原样返回；缺 IEND / 块长越界 → 400 VALIDATION_ERROR', () => {
    const stripped = stripPngMetadata(makePngWithMetadata()).buffer;
    const again = stripPngMetadata(stripped);
    expect(again.stripped).toBe(false);
    expect(again.buffer).toBe(stripped);

    const noIend = makePngWithMetadata();
    const cut = noIend.subarray(0, noIend.length - 12); // 去掉 IEND
    try { stripPngMetadata(cut); throw new Error('应当抛错'); }
    catch (err) { expect((err as AppError).code).toBe('VALIDATION_ERROR'); }

    const badLen = Buffer.from(makePngWithMetadata());
    badLen.writeUInt32BE(0x7fffffff, 8); // IHDR 块长越界
    try { stripPngMetadata(badLen); throw new Error('应当抛错'); }
    catch (err) { expect((err as AppError).code).toBe('VALIDATION_ERROR'); }
  });

  it('未覆盖类型（gif/webp/文本）原样透传——边界如实记录，不做未验证的"清洗"', () => {
    const gif = Buffer.from('GIF89a-not-really-a-gif', 'latin1');
    expect(sanitizeImageMetadata('image/gif', gif)).toMatchObject({ stripped: false, removedSegments: 0 });
    expect(sanitizeImageMetadata('image/gif', gif).buffer).toBe(gif);
    const text = Buffer.from('hello', 'latin1');
    expect(sanitizeImageMetadata('text/plain', text).buffer).toBe(text);
  });
});
