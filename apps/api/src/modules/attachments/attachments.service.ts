import { Inject, Injectable, Logger } from '@nestjs/common';
import { Attachment } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { StorageAdapter } from '../../core/storage/storage.types';
import { maxBytesForMime, sanitizeFilename, sniffMatchesMime, storageExtensionForMime, typeForMime } from '../security/upload-guard';
import { QuotaService } from '../billing/quota.service';
import { BillingService } from '../billing/billing.service';
import { assertZipSafe } from './archive-guard';
import { sanitizeImageMetadata } from './image-metadata';
import { attachmentQuotaExceeded } from './attachment-errors';

const MAX_IMAGE_DATA_URL_BYTES = 8 * 1024 * 1024;

/** zip 容器类型（docx/xlsx）：走压缩炸弹声明校验；其余类型不适用 */
const ZIP_CONTAINER_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export interface UploadFileInput {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger('Attachments');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject('STORAGE_ADAPTER') private readonly storage: StorageAdapter,
    // M10-P7：配额裁决（服务端）+ 计量入账（预留 → 账本 → 释放），只消费 billing 公共 API
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(BillingService) private readonly billing: BillingService,
  ) {}

  /**
   * 上传：白名单/大小/文件头校验 → 内容安全（zip 声明校验 + 元数据清洗）→ 配额预留 → 对象存储 → 附件行。
   *
   * M8-P8 加固（顺序即防线）：
   * 1. MIME 白名单（与 multer fileFilter 同一份定义）；
   * 2. 大小上限按类型；以 buffer.length 为权威（绝不信任调用方传入的 size 字段）；
   * 3. 文件头与声明 MIME 一致性（防伪造 Content-Type 绕过白名单）；
   * 4. originalName 走 sanitizeFilename（去路径/控制字符/前导点，超长截断）；
   * 5. storageKey 扩展名只来自服务端 MIME 映射（**用户文件名彻底不参与存储键**）。
   *
   * M10-P7 追加（审计 SA-19/X-18/SA-20）：
   * 6. zip 容器（docx/xlsx）central directory **声明体积**校验——平台不解压 zip，炸弹防护面 =
   *    拒绝声明超限的炸弹文件（边界见 archive-guard.ts 头注释）；
   * 7. 图片元数据清洗（JPEG APP1/EXIF、PNG 文本与 eXIf 块）——落库与存储都用**清洗后**字节，
   *    因此 sizeBytes/storageKey 的对象大小与库内行严格一致；
   * 8. 每用户附件配额：assertQuota(kind=attachment_upload, refId=attachmentId) 预留 →
   *    成功后写账本行（durable 计数，幂等键 `att:{id}`）→ 释放预留；任一步失败都回滚释放预留。
   *
   * 顺序理由：①~⑦ 是纯内存校验（无外部副作用、无成本），放在配额之前——被拒的坏文件绝不占用
   * 配额、也不产生"预留后立即回滚"的噪声；配额只覆盖真正产生资源消耗的存储/落库窗口。
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

    // M10-P7 ①：压缩炸弹声明校验（仅 zip 容器；不通过 → 400 ATTACHMENT_UNZIP_REJECTED）
    if (ZIP_CONTAINER_MIMES.has(file.mimetype)) {
      const verdict = assertZipSafe(file.buffer);
      this.logger.debug({ userId, mime: file.mimetype, ...verdict.inspection }, 'zip 声明校验通过');
    }

    // M10-P7 ②：元数据清洗（只做减法，字节内容除被剔除的段外与输入完全一致）
    const cleaned = sanitizeImageMetadata(file.mimetype, file.buffer);
    const storedBytes = cleaned.buffer.length;

    // M10-P7 ③：配额预留（attachmentId 预生成作预留幂等键；超额 → 429 ATTACHMENT_QUOTA_EXCEEDED）
    const attachmentId = randomUUID();
    const organizationId = await this.assertAttachmentQuota(userId, attachmentId, meta?.conversationId);

    const ext = storageExtensionForMime(file.mimetype);
    const originalName = sanitizeFilename(file.originalname);
    const now = new Date();
    const storageKey = `${userId}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${attachmentId}${ext}`;
    let stored = false;
    try {
      await this.storage.put(storageKey, Readable.from(cleaned.buffer), { contentType: file.mimetype, sizeBytes: storedBytes });
      stored = true;
      const attachment = await this.prisma.attachment.create({
        data: {
          id: attachmentId, userId, kind: 'upload', type, mimeType: file.mimetype,
          storageKey, originalName: originalName ?? undefined, sizeBytes: storedBytes, status: 'ready',
          conversationId: meta?.conversationId, messageId: meta?.messageId,
          metadata: cleaned.stripped
            ? { metadataStripped: true, removedSegments: cleaned.removedSegments, removedBytes: cleaned.removedBytes, removedKinds: cleaned.removedKinds }
            : undefined,
        },
      });
      // 预留 → 账本（durable 计数）→ 释放：与 run/媒体任务同一套 C1 语义（终态释放，绝不残留占用）。
      // 崩在账本与释放之间只会**多计**（预留 1h TTL 自愈），绝不漏计。
      await this.billing.recordUsage({
        userId, organizationId, kind: 'attachment_upload', quantity: 1,
        idempotencyKey: `att:${attachmentId}`,
        metadata: { attachmentId, mimeType: file.mimetype, sizeBytes: storedBytes },
      });
      await this.quota.release(attachmentId, 'attachment_upload');
      return attachment;
    } catch (err) {
      // 上传失败回滚：释放预留（幂等，绝不残留占用额度）+ 尽力清理已落对象（避免孤儿对象）
      await this.quota.release(attachmentId, 'attachment_upload');
      if (stored) await this.storage.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  /**
   * 配额预留：超额（QUOTA_EXCEEDED）→ 专码 429 ATTACHMENT_QUOTA_EXCEEDED；其余错误原样上抛。
   * 组织归属：会话所属项目 > 用户个人组织（与 chat/agent-run 的归集口径一致）。
   */
  private async assertAttachmentQuota(userId: string, attachmentId: string, conversationId?: string): Promise<string> {
    let projectId: string | null = null;
    if (conversationId) {
      const conversation = await this.prisma.conversation.findFirst({
        where: { id: conversationId, userId }, select: { projectId: true },
      });
      projectId = conversation?.projectId ?? null;
    }
    try {
      const { organizationId } = await this.quota.assertQuota(userId, projectId, 'attachment_upload', 1, attachmentId);
      return organizationId;
    } catch (err) {
      if ((err as { code?: string }).code === ErrorCode.QUOTA_EXCEEDED) {
        throw attachmentQuotaExceeded(`附件配额已用尽：${(err as Error).message}`);
      }
      throw err;
    }
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
