import { unzipRejected } from './attachment-errors';

/**
 * M10-P7 压缩炸弹防护（审计 SA-19 / X-18）。
 *
 * ── 边界先说清楚：为什么是"解析声明体积"而不是"解压后实测体积" ──
 * 1. 附件链路**从不解压** zip 容器：docx/xlsx 一律原样落对象存储（仓库内无 adm-zip/yauzl/jszip
 *    等任何解压依赖，也没有解压调用点）。炸弹不会在本平台展开。
 * 2. 既然不解压，就不存在"解压后实测体积"这个可信观测点；唯一可用信号是 zip central
 *    directory 里的**声明体积**（uncompressed size）。声明可被攻击者伪造，但伪造的两个方向都
 *    对我们有利：往大报 → 被拒；往小报 → 我们仍然不解压，展开风险不落地。故裁决口径取
 *    "声明即成本"：声明超限即拒绝，绝不为了放行而低估。
 * 3. 残余风险（如实记录）：真实炸弹（声明不自洽/畸形的 zip）在**本平台**不会展开，但仍可能
 *    作为分发载体被下游（用户本机解压器、未来的文档解析器）展开。若将来引入解压
 *    （OCR/文档解析），必须叠加第二道防线——流式字节计数 + 硬上限中断，本模块只是第一道。
 * 4. 解析器自身的安全：只读缓冲区、只走 central directory（不解压、不分配声明体积的内存）、
 *    条目数与 CD 边界双重封顶，避免"防护自身被 zip of death 打挂"。
 */

/** 防护阈值（声明口径；单位字节） */
export const ZIP_GUARD_LIMITS = {
  /** 声明解压总量硬上限：超过即拒（与单文件 50MB 上限相比留足合法 docx/xlsx 空间） */
  MAX_UNCOMPRESSED_BYTES: 512 * 1024 * 1024,
  /** 声明膨胀比上限（uncompressed / 实际输入字节） */
  MAX_EXPANSION_RATIO: 100,
  /** 膨胀比只在超过此体积时才作为拒绝依据（小文件天然高压缩比，避免误杀合法小档） */
  MIN_RATIO_CHECK_BYTES: 32 * 1024 * 1024,
  /** 声明条目数上限（zip of death：百万空条目） */
  MAX_ENTRIES: 20_000,
} as const;

export type ZipGuardReason = 'MALFORMED' | 'ENTRY_LIMIT' | 'UNCOMPRESSED_LIMIT' | 'RATIO_LIMIT';

export interface ZipInspection {
  /** 声明条目数 */
  entries: number;
  /** 声明解压总量（字节） */
  uncompressedBytes: number;
  /** 实际输入字节（真实成本口径——比 CD 自报的 compressed size 可信） */
  inputBytes: number;
  /** 声明膨胀比（uncompressedBytes / inputBytes；两位小数） */
  ratio: number;
  /** 是否为 zip64 归档 */
  zip64: boolean;
}

export interface ZipGuardVerdict {
  ok: boolean;
  reason?: ZipGuardReason;
  detail: string;
  /** MALFORMED 时为 null（无法取得可信声明） */
  inspection: ZipInspection | null;
}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CDH_SIG = 0x02014b50;
const ZIP64_EXTRA_ID = 0x0001;

const EOCD_MIN_BYTES = 22;
const EOCD64_LOCATOR_BYTES = 20;
const CDH_MIN_BYTES = 46;
const MAX_COMMENT_BYTES = 0xffff;
const U32_SENTINEL = 0xffffffff;
const U16_SENTINEL = 0xffff;

/** 向后扫描 EOCD 签名（注释最长 64KB + 记录 22 字节） */
function findEocd(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - (MAX_COMMENT_BYTES + EOCD_MIN_BYTES));
  for (let i = buf.length - EOCD_MIN_BYTES; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** zip64：从 EOCD64 记录读 64 位总量/条目数（仅当 32 位字段为哨兵值时） */
function readZip64(buf: Buffer, eocdPos: number): { entries: number; cdSize: number; cdOffset: number } | null {
  const locPos = eocdPos - EOCD64_LOCATOR_BYTES;
  if (locPos < 0 || buf.readUInt32LE(locPos) !== EOCD64_LOCATOR_SIG) return null;
  const recPos = Number(buf.readBigUInt64LE(locPos + 8));
  if (!Number.isSafeInteger(recPos) || recPos < 0 || recPos + 56 > buf.length) return null;
  if (buf.readUInt32LE(recPos) !== EOCD64_SIG) return null;
  const entries = Number(buf.readBigUInt64LE(recPos + 32));
  const cdSize = Number(buf.readBigUInt64LE(recPos + 40));
  const cdOffset = Number(buf.readBigUInt64LE(recPos + 48));
  if (![entries, cdSize, cdOffset].every((v) => Number.isSafeInteger(v) && v >= 0)) return null;
  return { entries, cdSize, cdOffset };
}

/**
 * zip64 扩展字段（0x0001）：按 header 中为哨兵的字段顺序取值
 * （uncompressed → compressed → local header offset → disk start，只取存在的）。
 */
function readZip64Sizes(buf: Buffer, extraPos: number, extraLen: number, needUncompressed: boolean, needCompressed: boolean): { uncompressed: number | null; compressed: number | null } {
  let p = extraPos;
  const end = extraPos + extraLen;
  while (p + 4 <= end && p + 4 <= buf.length) {
    const id = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    const body = p + 4;
    if (body + size > buf.length) break;
    if (id === ZIP64_EXTRA_ID) {
      // 8 字节字段按需顺序出现：uncompressed 在前
      let q = body;
      let uncompressed: number | null = null;
      let compressed: number | null = null;
      if (needUncompressed && q + 8 <= body + size) { uncompressed = Number(buf.readBigUInt64LE(q)); q += 8; }
      if (needCompressed && q + 8 <= body + size) { compressed = Number(buf.readBigUInt64LE(q)); q += 8; }
      return {
        uncompressed: uncompressed != null && Number.isSafeInteger(uncompressed) ? uncompressed : null,
        compressed: compressed != null && Number.isSafeInteger(compressed) ? compressed : null,
      };
    }
    p = body + size;
  }
  return { uncompressed: null, compressed: null };
}

/**
 * 解析 central directory 的**声明**体积（绝不读取/解压条目内容）。
 * 结构不自洽（无 EOCD / 越界 / 哨兵值无对应 zip64 记录）→ ok=false, reason=MALFORMED。
 */
export function inspectZip(buf: Buffer): ZipGuardVerdict {
  const malformed = (detail: string): ZipGuardVerdict => ({ ok: false, reason: 'MALFORMED', detail, inspection: null });

  if (buf.length < EOCD_MIN_BYTES) return malformed('文件过小，不构成合法 zip 归档');
  const eocdPos = findEocd(buf);
  if (eocdPos < 0) return malformed('未找到 zip 结束记录（EOCD）：声明为 zip 容器但结构不完整');
  if (eocdPos + EOCD_MIN_BYTES > buf.length) return malformed('zip 结束记录越界');

  let entries = buf.readUInt16LE(eocdPos + 10);
  let cdSize = buf.readUInt32LE(eocdPos + 12);
  let cdOffset = buf.readUInt32LE(eocdPos + 16);
  let zip64 = false;

  if (entries === U16_SENTINEL || cdSize === U32_SENTINEL || cdOffset === U32_SENTINEL) {
    const z64 = readZip64(buf, eocdPos);
    if (!z64) return malformed('zip64 哨兵值存在但缺少可解析的 zip64 结束记录');
    entries = z64.entries; cdSize = z64.cdSize; cdOffset = z64.cdOffset;
    zip64 = true;
  }

  // 声明条目数先行封顶：绝不为了遍历百万条目而付出解析成本（防护自身不被 zip of death 打挂）
  if (entries > ZIP_GUARD_LIMITS.MAX_ENTRIES) {
    return {
      ok: false, reason: 'ENTRY_LIMIT',
      detail: `声明条目数 ${entries} 超过上限 ${ZIP_GUARD_LIMITS.MAX_ENTRIES}`,
      inspection: { entries, uncompressedBytes: 0, inputBytes: buf.length, ratio: 0, zip64 },
    };
  }
  if (cdOffset + cdSize > buf.length) return malformed('central directory 越界（声明偏移/长度与文件实际大小不符）');

  let uncompressedTotal = 0;
  let pos = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (pos + CDH_MIN_BYTES > buf.length || buf.readUInt32LE(pos) !== CDH_SIG) {
      return malformed(`central directory 第 ${i + 1} 条记录不可解析（结构被截断或伪造）`);
    }
    const compSize = buf.readUInt32LE(pos + 20);
    let uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const next = pos + CDH_MIN_BYTES + nameLen + extraLen + commentLen;
    if (next > buf.length) return malformed('central directory 记录越界');

    if (uncompSize === U32_SENTINEL || compSize === U32_SENTINEL) {
      const sizes = readZip64Sizes(buf, pos + CDH_MIN_BYTES + nameLen, extraLen, uncompSize === U32_SENTINEL, compSize === U32_SENTINEL);
      // 哨兵值但无 zip64 扩展字段：要么是畸形，要么是真实的 4GB 级归档 → 两者都按"体积不可信"拒绝
      if (sizes.uncompressed == null) return malformed('条目声明了 zip64 体积但缺少可解析的 zip64 扩展字段');
      uncompSize = sizes.uncompressed;
      zip64 = true;
    }
    uncompressedTotal += uncompSize;
    if (!Number.isSafeInteger(uncompressedTotal)) return malformed('条目声明体积累加溢出');
    pos = next;
  }

  const inputBytes = buf.length;
  const ratio = inputBytes > 0 ? Math.round((uncompressedTotal / inputBytes) * 100) / 100 : 0;
  const inspection: ZipInspection = { entries, uncompressedBytes: uncompressedTotal, inputBytes, ratio, zip64 };

  if (uncompressedTotal > ZIP_GUARD_LIMITS.MAX_UNCOMPRESSED_BYTES) {
    return {
      ok: false, reason: 'UNCOMPRESSED_LIMIT', inspection,
      detail: `声明解压总量 ${uncompressedTotal} 字节超过上限 ${ZIP_GUARD_LIMITS.MAX_UNCOMPRESSED_BYTES} 字节`,
    };
  }
  if (uncompressedTotal > ZIP_GUARD_LIMITS.MIN_RATIO_CHECK_BYTES && ratio > ZIP_GUARD_LIMITS.MAX_EXPANSION_RATIO) {
    return {
      ok: false, reason: 'RATIO_LIMIT', inspection,
      detail: `声明膨胀比 ${ratio}:1 超过上限 ${ZIP_GUARD_LIMITS.MAX_EXPANSION_RATIO}:1（声明解压 ${uncompressedTotal} 字节 / 输入 ${inputBytes} 字节）`,
    };
  }
  return { ok: true, detail: `zip 声明校验通过（${entries} 条目 / ${uncompressedTotal} 字节 / ${ratio}:1）`, inspection };
}

/**
 * 上传前裁决：不通过 → 抛 ATTACHMENT_UNZIP_REJECTED（400）。
 * 只用于 zip 容器类型（docx/xlsx）；返回 verdict 供调用方记录可观测字段。
 */
export function assertZipSafe(buf: Buffer): ZipGuardVerdict {
  const verdict = inspectZip(buf);
  if (!verdict.ok) {
    throw unzipRejected(`压缩文件被拒绝（${verdict.reason}）：${verdict.detail}`);
  }
  return verdict;
}
