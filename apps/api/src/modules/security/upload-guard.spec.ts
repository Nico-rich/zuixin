import { describe, it, expect } from 'vitest';
import {
  ALLOWED_MIME, FILENAME_MAX_LENGTH, isAllowedMime, maxBytesForMime, sanitizeFilename,
  sniffMatchesMime, storageExtensionForMime, typeForMime,
} from './upload-guard';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(10)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(4)]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(8)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7', 'latin1'), Buffer.alloc(8)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(12)]);

describe('upload-guard / 白名单与分类型上限', () => {
  it('白名单内 MIME → 类型映射正确', () => {
    expect(typeForMime('image/png')).toBe('image');
    expect(typeForMime('video/mp4')).toBe('video');
    expect(typeForMime('application/pdf')).toBe('file');
    expect(typeForMime('text/csv')).toBe('file');
  });

  it.each(['application/x-msdownload', 'text/html', 'image/svg+xml', 'application/javascript', 'application/x-httpd-php', 'application/octet-stream', 'image/svg', ''])(
    '白名单外 MIME 拒绝：%s', (mime) => {
      expect(isAllowedMime(mime)).toBe(false);
      expect(typeForMime(mime)).toBeNull();
      expect(maxBytesForMime(mime)).toBe(0);
    });

  it('分类型上限：image 20MB / video 200MB / file 50MB', () => {
    expect(maxBytesForMime('image/png')).toBe(20 * 1024 * 1024);
    expect(maxBytesForMime('video/mp4')).toBe(200 * 1024 * 1024);
    expect(maxBytesForMime('application/pdf')).toBe(50 * 1024 * 1024);
    expect(maxBytesForMime('text/plain')).toBe(50 * 1024 * 1024);
  });

  it('存储扩展名只来自服务端 MIME 映射（无映射 → 空串，绝不回退用户输入）', () => {
    expect(storageExtensionForMime('image/png')).toBe('.png');
    expect(storageExtensionForMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('.docx');
    expect(storageExtensionForMime('image/svg+xml')).toBe('');
    expect(Object.keys(ALLOWED_MIME).every((m) => typeof storageExtensionForMime(m) === 'string')).toBe(true);
  });
});

describe('upload-guard / sanitizeFilename', () => {
  it('剥离路径分量（POSIX 与 Windows）', () => {
    expect(sanitizeFilename('../../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitizeFilename('/absolute/path/report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('C:\\Users\\x\\文档.docx')).toBe('文档.docx');
  });

  it('剥离控制字符/双向控制符/非法字符', () => {
    expect(sanitizeFilename('a\u0000b\u001fc.png')).toBe('abc.png');
    expect(sanitizeFilename('evil\u202egnp.exe')).toBe('evilgnp.exe');
    expect(sanitizeFilename('a<b>c:d"e|f?g*h.png')).toBe('abcdefgh.png');
  });

  it('前导点/空白（隐藏文件与 `.`/`..`）被剥离或拒绝', () => {
    expect(sanitizeFilename('.htaccess')).toBe('htaccess');
    expect(sanitizeFilename('..')).toBeNull();
    expect(sanitizeFilename('.')).toBeNull();
    expect(sanitizeFilename('...')).toBeNull();
    expect(sanitizeFilename('   ')).toBeNull();
    expect(sanitizeFilename('')).toBeNull();
    expect(sanitizeFilename(null)).toBeNull();
    expect(sanitizeFilename(undefined)).toBeNull();
  });

  it('超长截断并保留扩展名', () => {
    const long = `${'a'.repeat(500)}.png`;
    const out = sanitizeFilename(long)!;
    expect(out.length).toBeLessThanOrEqual(FILENAME_MAX_LENGTH);
    expect(out.endsWith('.png')).toBe(true);
  });

  it('正常文件名不被改写（含中文/空格/括号）', () => {
    expect(sanitizeFilename('季度 报表 (final).pdf')).toBe('季度 报表 (final).pdf');
    expect(sanitizeFilename('photo-2026_09.jpeg')).toBe('photo-2026_09.jpeg');
  });

  it('sanitize 结果绝不含路径分隔符（可用于任何落盘/展示场景）', () => {
    for (const raw of ['a/b/c.png', 'a\\b\\c.png', '../x', '..%2f..%2fetc', 'x/../../y.txt']) {
      const out = sanitizeFilename(raw);
      if (out) expect(out).not.toMatch(/[\\/]/);
    }
  });
});

describe('upload-guard / sniffMatchesMime（文件头一致性）', () => {
  it.each([
    ['image/png', PNG], ['image/jpeg', JPEG], ['image/gif', GIF], ['image/webp', WEBP],
    ['video/mp4', MP4], ['video/quicktime', MP4], ['video/webm', WEBM],
    ['application/pdf', PDF],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP],
    ['text/plain', Buffer.from('hello world')], ['text/csv', Buffer.from('a,b\n1,2')], ['text/markdown', Buffer.from('# t')],
  ] as Array<[string, Buffer]>)('声明与内容一致：%s → 通过', (mime, buf) => {
    expect(sniffMatchesMime(mime, buf)).toBe(true);
  });

  it('伪造 Content-Type：文本/可执行内容冒充图片 → 拒绝', () => {
    expect(sniffMatchesMime('image/png', Buffer.from('<html><script>alert(1)</script>'))).toBe(false);
    expect(sniffMatchesMime('image/png', Buffer.from('MZ\x90\x00'))).toBe(false);
    expect(sniffMatchesMime('image/jpeg', Buffer.from('#!/bin/sh\nrm -rf /'))).toBe(false);
    expect(sniffMatchesMime('application/pdf', Buffer.from('<svg onload=alert(1)>'))).toBe(false);
    expect(sniffMatchesMime('video/mp4', Buffer.from('PK\x03\x04'))).toBe(false);
    expect(sniffMatchesMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('%PDF-1.4'))).toBe(false);
  });

  it('文本类：含 NUL 字节（二进制冒充文本）→ 拒绝', () => {
    expect(sniffMatchesMime('text/plain', Buffer.from([0x68, 0x00, 0x69]))).toBe(false);
    expect(sniffMatchesMime('text/csv', Buffer.from([0x00, 0x01, 0x02]))).toBe(false);
  });

  it('空缓冲/超短缓冲 → 拒绝（不进白名单"空文件"漏洞）', () => {
    expect(sniffMatchesMime('image/png', Buffer.alloc(0))).toBe(false);
    expect(sniffMatchesMime('image/png', Buffer.from([0x89, 0x50]))).toBe(false);
    expect(sniffMatchesMime('video/mp4', Buffer.alloc(6))).toBe(false);
  });

  it('白名单外 MIME 一律拒绝（双保险）', () => {
    expect(sniffMatchesMime('image/svg+xml', Buffer.from('<svg/>'))).toBe(false);
  });
});
