import { crc32, deflateRawSync } from 'node:zlib';

/**
 * M10-P7 附件安全测试夹具（zip / jpeg / png 的真实二进制构造）。
 *
 * 只被 `*.spec.ts` / `*.e2e-spec.ts` 引用（不在 vitest include 的收集范围内）；纯函数、无副作用。
 * 构造出的文件都是**真实二进制**：zip 走 DEFLATE 真实压缩 + 真实 central directory，
 * PNG 的 IDAT 可被 zlib 真实 inflate、CRC 由 crc32 真实计算——断言因此不是"对着自造结构自证"。
 */

// ─────────────────────────────── ZIP ───────────────────────────────

export interface ZipEntrySpec {
  name: string;
  /** 真实内容（决定 local header 里的压缩数据；CD 的声明值默认等于它） */
  data: Buffer;
  /** 可选：central directory 中**声明**的 uncompressed size（伪造/自报，用于炸弹构造） */
  declaredUncompressed?: number;
  /** true = stored（不压缩），默认 deflate */
  store?: boolean;
}

const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

/**
 * 构造一个结构完整的 ZIP（local header + DEFLATE 数据 + central directory + EOCD）。
 * 不解压、不校验 CRC 语义，只保证"真实解压器能读"的字节结构。
 */
export function buildZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.store ? 0 : 8;
    const payload = entry.store ? entry.data : deflateRawSync(entry.data);
    const declared = entry.declaredUncompressed ?? entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc32(entry.data) >>> 0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc32(entry.data) >>> 0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(declared, 24); // ← 声明值（可与真实值不一致，模拟炸弹/畸形）
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 取单条目 zip 中第一条目的**真实压缩数据**（用于测试自行 inflate 复核） */
export function readFirstEntryPayload(zip: Buffer): Buffer {
  const nameLen = zip.readUInt16LE(26);
  const payloadLen = zip.readUInt32LE(18);
  return zip.subarray(30 + nameLen, 30 + nameLen + payloadLen);
}

/** 正常 zip（docx 形态）：若干小条目，声明体积与真实一致 */
export function makeNormalZip(): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>', 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(`<w:document>${'正文'.repeat(200)}</w:document>`, 'utf8') },
    { name: 'word/media/image1.bin', data: Buffer.alloc(4096, 0xab) },
  ]);
}

/** 真实炸弹的解压目标体积（> 32MB 膨胀比门槛，且 DEFLATE 后仅数十 KB） */
export const BOMB_INFLATED_BYTES = 40 * 1024 * 1024;

/**
 * **真实**解压炸弹：单条目内容确实是 40MB（全零，DEFLATE 后约 40KB），central directory
 * 声明的解压体积也是 40MB。任何真实解压器都会展开出 40MB —— 用 `readFirstEntryPayload` +
 * inflateRawSync 可复核"这不是只改了 header 的假炸弹"。
 */
export function makeBombZip(inflatedBytes: number = BOMB_INFLATED_BYTES): Buffer {
  return buildZip([{ name: 'bomb.bin', data: Buffer.alloc(inflatedBytes, 0) }]);
}

/** 只伪造声明值的炸弹（真实内容 1KB，声明 600MB）：覆盖"声明总量硬上限"分支，无需分配大内存 */
export function makeDeclaredBombZip(declaredBytes = 600 * 1024 * 1024): Buffer {
  return buildZip([{ name: 'huge.bin', data: Buffer.alloc(1024, 0x41), declaredUncompressed: declaredBytes }]);
}

/** 畸形 zip：PK 头 + 完全没有 central directory/EOCD（伪装成容器） */
export function makeMalformedZip(): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(512, 0x00)]);
}

/** 高压缩比但解压后 < 32MB 的 zip：必须放行（膨胀比规则只在大体积上生效，防误杀） */
export function makeSmallHighRatioZip(): Buffer {
  return buildZip([{ name: 'small.txt', data: Buffer.alloc(8 * 1024 * 1024, 0x20) }]);
}

/** 声明条目数超上限的 zip（zip of death 形态：条目数谎报） */
export function makeManyEntriesZip(declaredEntries = 50_000): Buffer {
  const out = Buffer.from(buildZip([{ name: 'a.txt', data: Buffer.from('a', 'utf8') }]));
  const eocd = out.length - 22;
  out.writeUInt16LE(declaredEntries & 0xffff, eocd + 8);
  out.writeUInt16LE(declaredEntries & 0xffff, eocd + 10);
  return out;
}

// ─────────────────────────────── JPEG ───────────────────────────────

/** 段表项：{ marker, start, end }（end = 段尾后一字节） */
export interface JpegSegment { marker: number; start: number; end: number; }

const jpegSeg = (marker: number, payload: Buffer): Buffer => {
  const head = Buffer.alloc(4);
  head.writeUInt8(0xff, 0); head.writeUInt8(marker, 1);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
};

/**
 * 结构完整的 JPEG：
 * SOI + APP1(EXIF，含 Orientation) + APP1(XMP) + APP0(JFIF) + APP2(ICC) + DQT + SOF0 + DHT
 * + SOS + 熵编码数据（含 0xFF00 字节填充与 RSTn）+ EOI。
 *
 * 说明：EXIF/XMP 都在**可选**的 APP1 段，解码器只依赖 DQT/SOF/DHT/SOS 与熵编码数据；
 * 因此"逐字节保留除 APP1 外的全部段"即保持可解码性（测试断言保留段与输入逐字节相同）。
 * 本仓库约束禁装图像解码依赖，故不做真实解码往返（已如实记入 NOT VERIFIED）。
 */
export function makeJpegWithExif(): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]; // SOI

  // APP1 #1：EXIF（'Exif\0\0' + TIFF II + IFD0 一条 Orientation=6）
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(6, 18);
  tiff.writeUInt32LE(0, 22);
  parts.push(jpegSeg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])));
  // APP1 #2：XMP（同样必须被剥离）
  parts.push(jpegSeg(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from('<x:xmpmeta/>', 'latin1')])));
  // APP0 JFIF（保留：起点/单位信息）；APP2 ICC（保留）
  parts.push(jpegSeg(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])])));
  parts.push(jpegSeg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([1, 1]), Buffer.alloc(128, 0x11)])));
  parts.push(jpegSeg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 16)]))); // DQT
  parts.push(jpegSeg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])));             // SOF0（1x1 灰度）
  parts.push(jpegSeg(0xc4, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(16, 0), Buffer.alloc(12, 0)]))); // DHT（占位结构）

  // SOS：段长固定 8（2 + Ns 1 + Cs/Td 2 + Ss/Se/AhAl 3），其后为熵编码数据（整体拷贝，绝不逐字节解析）
  const sosHeader = Buffer.concat([Buffer.from([0xff, 0xda, 0x00, 0x08]), Buffer.from([1, 1, 0, 0, 63, 0])]);
  const scan = Buffer.from([0xff, 0x00, 0x12, 0x34, 0xff, 0xd0, 0x56, 0x78]); // 字节填充 + RST0
  parts.push(sosHeader, scan, Buffer.from([0xff, 0xd9])); // + EOI
  return Buffer.concat(parts);
}

/** 遍历 JPEG 段（SOI→SOS），返回段表（供断言"哪些段保留/被剔除"） */
export function walkJpegSegments(buf: Buffer): JpegSegment[] {
  const segments: JpegSegment[] = [];
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) break;
    let pos = i;
    while (pos + 1 < buf.length && buf[pos + 1] === 0xff) pos++;
    const marker = buf[pos + 1];
    if (marker === 0xd9 || marker === 0xda) { segments.push({ marker, start: i, end: buf.length }); break; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { segments.push({ marker, start: i, end: pos + 2 }); i = pos + 2; continue; }
    const end = pos + 2 + buf.readUInt16BE(pos + 2);
    segments.push({ marker, start: i, end });
    i = end;
  }
  return segments;
}

// ─────────────────────────────── PNG ───────────────────────────────

export interface PngChunk { type: string; length: number; crcOk: boolean; }

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** 真实可解码的 PNG（1x1 灰度）：IHDR + tEXt + eXIf + IDAT(zlib) + IEND；CRC 逐块真实 */
export function makePngWithMetadata(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); // 1x1
  ihdr.writeUInt8(8, 8); ihdr.writeUInt8(0, 9);       // 8bit 灰度
  ihdr.writeUInt8(0, 10); ihdr.writeUInt8(0, 11); ihdr.writeUInt8(0, 12);
  const idat = deflateRawSync(Buffer.from([0x00, 0x7f])); // 唯一扫描行：filter=0 + 像素 0x7f
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from('Comment\0GPS 37.7749,-122.4194', 'latin1')),
    pngChunk('eXIf', Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.alloc(16, 0x22)])),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 解析 PNG 块并真实校验每块 CRC（证明删除元数据块后剩余块仍自洽） */
export function parsePngChunks(buf: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const data = buf.subarray(i + 8, i + 8 + len);
    const expected = buf.readUInt32BE(i + 8 + len);
    chunks.push({ type, length: len, crcOk: (crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0) === expected });
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}
