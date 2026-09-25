import { Inject, Injectable } from '@nestjs/common';
import { Attachment } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { StorageAdapter } from '../../core/storage/storage.types';
import { maxBytesForMime, sanitizeFilename, sniffMatchesMime, storageExtensionForMime, typeForMime } from '../security/upload-guard';

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

  /**
   * 上传：白名单/大小/文件头校验 → 对象存储 → 附件行（kind=upload）。
   * M8-P8 加固（顺序即防线）：
   * 1. MIME 白名单（与 multer fileFilter 同一份定义）；
   * 2. 大小上限按类型；以 buffer.length 为权威（绝不信任调用方传入的 size 字段）；
   * 3. 文件头与声明 MIME 一致性（防伪造 Content-Type 绕过白名单）；
   * 4. originalName 走 sanitizeFilename（去路径/控制字符/前导点，超长截断）；
   * 5. storageKey 扩展名只来自服务端 MIME 映射（**用户文件名彻底不参与存储键**）。
   */
  async save(userId: string, file: UploadFileInput, meta?: { conversationId?: string; messageId?: string }) {
    const type = typeForMime(file.mimetype);
    if (!type) throw new AppError(ErrorCode.VALIDATION_ERROR, `不支持的文件类型：${file.mimetype}`);
    const maxBytes = maxBytesForMime(file.mimetype);
    const sizeBytes = file.buffer?.length ?? 0;
    if (sizeBytes <= 0) throw new AppError(ErrorCode.VALIDATION_ERROR, '文件为空');
    if (sizeBytes > maxBytes) throw new AppError(ErrorCode.VALIDATION_ERROR, `文件超过大小限制（${maxBytes / 1024 / 1024}MB）`);
    if (!sniffMatchesMime(file.mimetype, file.buffer)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `文件内容与声明类型不符：${file.mimetype}`);
    }

    const ext = storageExtensionForMime(file.mimetype);
    const originalName = sanitizeFilename(file.originalname);
    const now = new Date();
    const storageKey = `${userId}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${randomUUID()}${ext}`;
    await this.storage.put(storageKey, Readable.from(file.buffer), { contentType: file.mimetype, sizeBytes });
    return this.prisma.attachment.create({
      data: {
        userId, kind: 'upload', type, mimeType: file.mimetype,
        storageKey, originalName: originalName ?? undefined, sizeBytes, status: 'ready',
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
