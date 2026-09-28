import { AppError, ErrorCode } from '../../common/errors/app-error';

/**
 * M10-P7 图片元数据清洗（审计 SA-19/X-18 的 EXIF 隐私面）。
 *
 * 纯二进制实现（不引入 sharp/imagemin 等原生依赖——约束见 M10 计划"不新增依赖"）：
 * - JPEG：SOI 之后逐段遍历，**剔除全部 APP1 段**（EXIF 与 XMP 都在 APP1）；保留 APP0(JFIF)、
 *   APP2(ICC)、APP13/14、DQT/SOF/DHT 等其余段原样字节。遍历到 SOS 即停止并原样拷贝后续
 *   压缩数据（熵编码段内不存在 APP1，且逐字节扫描会破坏字节填充规则）。
 * - PNG：剔除 eXIf / tEXt / zTXt / iTXt / COM 块（EXIF 与文本注释）；保留 IHDR/PLTE/IDAT/IEND
 *   与色彩配置块（iCCP/sRGB/gAMA/pHYs），删除整块不影响剩余块的 CRC。
 *
 * 安全性质：
 * 1. **绝不静默损坏图片**：结构不自洽（段长越界、非法 marker、块长越界）→ 抛 VALIDATION_ERROR
 *    （400）拒绝上传，而不是"strip 失败就存原样"（那会让 EXIF 静默漏出）。
 * 2. 清洗只做减法：不新增/改写任何字节，未被剔除的字节与输入**完全相同**（单测逐段比对）。
 * 3. 未被覆盖的格式（GIF/WebP 的 EXIF/XMP）如实记录为边界：本模块仅对 image/jpeg 与 image/png
 *    生效，其余类型原样透传（`sanitizeImageMetadata` 的 default 分支）。
 */

export interface MetadataStripResult {
  buffer: Buffer;
  /** 是否发生剔除（false = 原样返回，可能是无元数据或不做处理的类型） */
  stripped: boolean;
  /** JPEG 段 / PNG 块 的剔除数量 */
  removedSegments: number;
  removedBytes: number;
  /** 剔除的段/块类型（可观测：EXIF 出现频率） */
  removedKinds: string[];
}

function unchanged(buf: Buffer): MetadataStripResult {
  return { buffer: buf, stripped: false, removedSegments: 0, removedBytes: 0, removedKinds: [] };
}

const MALFORMED_JPEG = 'JPEG 结构非法（段长越界或非法标记）';
const MALFORMED_PNG = 'PNG 结构非法（块长越界或缺少 IEND）';

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP1 = 0xe1;

/** 无长度字段的独立标记：TEM(0x01) 与 RSTn(0xD0-D7) */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/**
 * JPEG：剔除全部 APP1（EXIF/XMP）段。
 * 输入须已通过 `sniffMatchesMime('image/jpeg', buf)`（FFD8FF 前缀）。
 */
export function stripJpegExif(buf: Buffer): MetadataStripResult {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== SOI) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, MALFORMED_JPEG);
  }
  const kept: Buffer[] = [buf.subarray(0, 2)]; // SOI 原样保留
  const removedKinds: string[] = [];
  let removedBytes = 0;
  let i = 2;

  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new AppError(ErrorCode.VALIDATION_ERROR, MALFORMED_JPEG);
    // 允许填充字节（连续 0xFF 是合法的段间填充）
    let markerPos = i;
    while (markerPos + 1 < buf.length && buf[markerPos + 1] === 0xff) markerPos++;
    if (markerPos + 1 >= buf.length) throw new AppError(ErrorCode.VALIDATION_ERROR, MALFORMED_JPEG);
    const marker = buf[markerPos + 1];

    if (marker === EOI || marker === SOS) {
      // 图像数据起点（或文件尾）：剩余部分原样拷贝后结束（熵编码段内无 APP1，且不得逐字节解析）
      kept.push(buf.subarray(i));
      break;
    }
    if (isStandaloneMarker(marker)) {
      kept.push(buf.subarray(i, markerPos + 2));
      i = markerPos + 2;
      continue;
    }
    const segStart = i;
    if (markerPos + 4 > buf.length) throw new AppError(ErrorCode.VALIDATION_ERROR, MALFORMED_JPEG);
    const segLen = buf.readUInt16BE(markerPos + 2);
    if (segLen < 2) throw new AppError(ErrorCode.VALIDATION_ERROR, MALFORMED_JPEG);
    const segEnd = markerPos + 2 + segLen;
    if (segEnd > buf.length) throw new AppError(ErrorCode.VALIDATION_ERROR, MALFORMED_JPEG);

    if (marker === APP1) {
      removedKinds.push('APP1');
      removedBytes += segEnd - segStart;
    } else {
      kept.push(buf.subarray(segStart, segEnd));
    }
    i = segEnd;
  }

  if (removedKinds.length === 0) return unchanged(buf);
  return {
    buffer: Buffer.concat(kept),
    stripped: true,
    removedSegments: removedKinds.length,
    removedBytes,
    removedKinds,
  };
}

/** PNG 中承载"元数据/隐私"的块类型（EXIF + 文本注释）；色彩与像素块一律保留 */
const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'COM']);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * PNG：剔除 eXIf / tEXt / zTXt / iTXt / COM 块（整块丢弃——剩余块的 CRC 各自独立，无需重算）。
 */
export function stripPngMetadata(buf: Buffer): MetadataStripResult {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, MALFORMED_PNG);
  }
  const kept: Buffer[] = [buf.subarray(0, 8)];
  const removedKinds: string[] = [];
  let removedBytes = 0;
  let i = 8;
  let sawIend = false;

  while (i < buf.length) {
    if (i + 12 > buf.length) throw new AppError(ErrorCode.VALIDATION_ERROR, MALFORMED_PNG);
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;
    if (len > 0x7fffffff || end > buf.length) throw new AppError(ErrorCode.VALIDATION_ERROR, MALFORMED_PNG);
    if (PNG_METADATA_CHUNKS.has(type)) {
      removedKinds.push(type);
      removedBytes += end - i;
    } else {
      kept.push(buf.subarray(i, end));
    }
    i = end;
    if (type === 'IEND') { sawIend = true; break; }
  }
  if (!sawIend) throw new AppError(ErrorCode.VALIDATION_ERROR, MALFORMED_PNG);
  if (i < buf.length) kept.push(buf.subarray(i)); // IEND 之后的尾部字节原样保留（合法 PNG 不存在，但绝不截断）

  if (removedKinds.length === 0) return unchanged(buf);
  return {
    buffer: Buffer.concat(kept),
    stripped: true,
    removedSegments: removedKinds.length,
    removedBytes,
    removedKinds,
  };
}

/** 按 MIME 分派清洗；不在覆盖范围内的类型原样透传（边界见文件头注释 3） */
export function sanitizeImageMetadata(mime: string, buf: Buffer): MetadataStripResult {
  if (mime === 'image/jpeg') return stripJpegExif(buf);
  if (mime === 'image/png') return stripPngMetadata(buf);
  return unchanged(buf);
}
