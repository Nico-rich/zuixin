import { AttachmentType } from '@prisma/client';
import { LIMITS } from '@ai-agent/shared';

/**
 * M8-P8 上传安全（唯一白名单来源：multer fileFilter 与 AttachmentsService 共用同一份定义，
 * 避免"边界校验一份、业务校验另一份"的漂移）。
 *
 * 四道防线：
 * 1. MIME 白名单（客户端声明值）——白名单之外在 multer 阶段即拒绝（不进内存缓冲）；
 * 2. 分类型大小上限——按声明 MIME 取上限，并在 fileFilter 阶段用 Content-Length 提前拒绝
 *    （避免 200MB 上限下"小类型大文件"整包进内存）；
 * 3. 文件头（magic bytes）与声明 MIME 一致性——防"改名/改 Content-Type 绕过白名单"；
 * 4. 文件名 sanitize + 存储键扩展名只来自服务端 MIME 映射（**绝不使用用户文件名**）。
 */

/** 声明 MIME → 附件类型（白名单；不在表内一律拒绝） */
export const ALLOWED_MIME: Record<string, AttachmentType> = {
  'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image', 'image/gif': 'image',
  'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video',
  'application/pdf': 'file',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'file', // docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'file', // xlsx
  'text/plain': 'file', 'text/markdown': 'file', 'text/csv': 'file',
};

/** 服务端 MIME → 存储扩展名（存储键扩展名唯一来源；用户文件名不参与） */
export const DEFAULT_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

export const MAX_MB_BY_TYPE: Record<AttachmentType, number> = {
  image: LIMITS.IMAGE_MAX_MB, video: LIMITS.VIDEO_MAX_MB, file: LIMITS.FILE_MAX_MB,
};

/** multipart 头/边界开销容忍（提前拒绝时使用；业务层仍以真实字节数复核） */
export const MULTIPART_OVERHEAD_BYTES = 8 * 1024;

export function typeForMime(mime: string): AttachmentType | null {
  return ALLOWED_MIME[mime] ?? null;
}

export function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME[mime] !== undefined;
}

export function maxBytesForMime(mime: string): number {
  const type = typeForMime(mime);
  return type ? MAX_MB_BY_TYPE[type] * 1024 * 1024 : 0;
}

/** 存储键扩展名：只允许服务端映射（无映射 → 空串，绝不回退到用户输入） */
export function storageExtensionForMime(mime: string): string {
  return DEFAULT_EXT[mime] ?? '';
}

export const FILENAME_MAX_LENGTH = 180;
/** 控制字符 + 双向文本控制符（可伪造显示名） */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]', 'g');
/** 路径分隔符与 Windows 非法字符 */
const ILLEGAL_CHARS = /[<>:"/\\|?*]/g;

/**
 * 文件名 sanitize（用于展示/落库的 originalName）：
 * 1. 只取最后一个路径分量（同时处理 `/` 与 `\`）；
 * 2. 去控制字符/双向控制符/路径分隔符/Windows 非法字符；
 * 3. 去前导点与空白（隐藏文件、`.`/`..`）；
 * 4. 超长截断（保留扩展名）；
 * 5. 结果为空或纯点 → null（调用方落库原样 null，绝不回退到原始输入）。
 */
export function sanitizeFilename(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const parts = raw.split(/[\\/]/);
  let name = parts[parts.length - 1] ?? '';
  name = name.replace(CONTROL_CHARS, '').replace(ILLEGAL_CHARS, '');
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '').trim();
  if (!name || /^\.*$/.test(name)) return null;
  if (name.length > FILENAME_MAX_LENGTH) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, FILENAME_MAX_LENGTH - ext.length) + ext;
  }
  return name;
}

const has = (b: Buffer, bytes: number[], offset = 0): boolean =>
  b.length >= offset + bytes.length && bytes.every((v, i) => b[offset + i] === v);

/** 文本类：只要求不含 NUL 字节（不做编码判定——编码猜测不是安全边界） */
function looksTextual(buf: Buffer): boolean {
  return !buf.subarray(0, 8192).includes(0);
}

function isZipContainer(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b
    && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)
    && (buf[3] === 0x04 || buf[3] === 0x06 || buf[3] === 0x08);
}

/**
 * 文件头与声明 MIME 一致性（防伪造 Content-Type 绕过白名单）。
 * 返回 true = 允许；无法嗅探的类型（文本类）按"无 NUL 字节"弱校验。
 */
export function sniffMatchesMime(mime: string, buf: Buffer): boolean {
  switch (mime) {
    case 'image/png': return has(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg': return has(buf, [0xff, 0xd8, 0xff]);
    case 'image/gif': {
      const head = buf.subarray(0, 6).toString('latin1');
      return head === 'GIF87a' || head === 'GIF89a';
    }
    case 'image/webp':
      return buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF'
        && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'video/mp4':
    case 'video/quicktime': {
      // ISO-BMFF / QuickTime：字节 4..8 为顶层 box 类型（ftyp/moov/mdat/wide/free）
      if (buf.length < 12) return false;
      const box = buf.subarray(4, 8).toString('latin1');
      return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(box);
    }
    case 'video/webm': return has(buf, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'application/pdf': return buf.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return isZipContainer(buf);
    case 'text/plain':
    case 'text/markdown':
    case 'text/csv':
      return looksTextual(buf);
    default:
      return false; // 白名单外：拒绝（与 isAllowedMime 一致的双保险）
  }
}
