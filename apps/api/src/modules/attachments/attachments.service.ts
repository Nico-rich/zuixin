import { Inject, Injectable } from '@nestjs/common';
import { Attachment, AttachmentType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { LIMITS } from '@ai-agent/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { StorageAdapter } from '../../core/storage/storage.types';

const ALLOWED_MIME: Record<string, AttachmentType> = {
  'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image', 'image/gif': 'image',
  'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video',
  'application/pdf': 'file',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'file', // docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'file', // xlsx
  'text/plain': 'file', 'text/markdown': 'file', 'text/csv': 'file',
};

const DEFAULT_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv',
};

const MAX_IMAGE_DATA_URL_BYTES = 8 * 1024 * 1024;

export interface UploadFileInput {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject('STORAGE_ADAPTER') private readonly storage: StorageAdapter,
  ) {}

  /** 上传：类型/大小校验 → 对象存储 → 附件行（kind=upload） */
  async save(userId: string, file: UploadFileInput, meta?: { conversationId?: string; messageId?: string }) {
    const type = ALLOWED_MIME[file.mimetype];
    if (!type) throw new AppError(ErrorCode.VALIDATION_ERROR, `不支持的文件类型：${file.mimetype}`);
    const maxBytes = Number(LIMITS[`${type.toUpperCase()}_MAX_MB` as keyof typeof LIMITS]) * 1024 * 1024;
    if (file.size <= 0) throw new AppError(ErrorCode.VALIDATION_ERROR, '文件为空');
    if (file.size > maxBytes) throw new AppError(ErrorCode.VALIDATION_ERROR, `文件超过大小限制（${maxBytes / 1024 / 1024}MB）`);

    const ext = (extname(file.originalname) || DEFAULT_EXT[file.mimetype] || '').toLowerCase();
    const now = new Date();
    const storageKey = `${userId}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${randomUUID()}${ext}`;
    await this.storage.put(storageKey, Readable.from(file.buffer), { contentType: file.mimetype, sizeBytes: file.size });
    return this.prisma.attachment.create({
      data: {
        userId, kind: 'upload', type, mimeType: file.mimetype,
        storageKey, originalName: file.originalname || undefined, sizeBytes: file.size, status: 'ready',
        conversationId: meta?.conversationId, messageId: meta?.messageId,
      },
    });
  }

  /** 归属校验 + 取附件 */
  async getById(userId: string, id: string): Promise<Attachment> {
    const att = await this.prisma.attachment.findFirst({ where: { id, userId } });
    if (!att) throw new AppError(ErrorCode.NOT_FOUND, '附件不存在');
    return att;
  }

  async openStream(att: Attachment): Promise<Readable> {
    if (!this.storage.getStream) throw new AppError(ErrorCode.INTERNAL, '存储驱动不支持流式读取');
    return this.storage.getStream(att.storageKey);
  }

  /** 图片转 base64 data URL（vision 模型 / 生图参考图用）；超限返回 null（跳过而非报错） */
  async imageDataUrl(att: Attachment): Promise<string | null> {
    if (att.type !== 'image' || att.sizeBytes > MAX_IMAGE_DATA_URL_BYTES) return null;
    try {
      const stream = await this.openStream(att);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return `data:${att.mimeType};base64,${Buffer.concat(chunks).toString('base64')}`;
    } catch {
      return null;
    }
  }
}
