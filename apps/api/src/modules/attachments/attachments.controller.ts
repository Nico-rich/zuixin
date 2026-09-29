import { Controller, Get, Inject, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { AttachmentsService } from './attachments.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MAX_MB_BY_TYPE, MULTIPART_OVERHEAD_BYTES, isAllowedMime, maxBytesForMime } from '../security/upload-guard';

/** multer 总闸 = 最大分类型上限（video 200MB）；分类型上限在 fileFilter 与服务层双重校验 */
const MAX_UPLOAD_BYTES = Math.max(...Object.values(MAX_MB_BY_TYPE)) * 1024 * 1024;

/**
 * M8-P8 上传边界（白名单/上限与 service 共用 security/upload-guard 同一份定义）：
 * 1. 白名单外的 MIME 在进入内存缓冲前即拒绝（fileFilter）；
 * 2. 按声明 MIME 的分类型上限 + Content-Length 提前拒绝（避免"image 白名单 + 200MB 包"整包进内存）；
 * 3. 真实字节数/文件头一致性由 service 复核（Content-Length 与声明 MIME 都可被客户端伪造）。
 */
const UPLOAD_OPTIONS = {
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req: Request, file: Express.Multer.File, cb: (error: Error | null, acceptFile: boolean) => void) => {
    if (!isAllowedMime(file.mimetype)) {
      cb(new AppError(ErrorCode.VALIDATION_ERROR, `不支持的文件类型：${file.mimetype}`), false);
      return;
    }
    const maxBytes = maxBytesForMime(file.mimetype);
    const declared = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes + MULTIPART_OVERHEAD_BYTES) {
      cb(new AppError(ErrorCode.VALIDATION_ERROR, `文件超过大小限制（${maxBytes / 1024 / 1024}MB）`), false);
      return;
    }
    cb(null, true);
  },
};

@Controller('attachments')
@UseGuards(JwtAuthGuard)
export class AttachmentsController {
  constructor(@Inject(AttachmentsService) private readonly attachments: AttachmentsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', UPLOAD_OPTIONS))
  async upload(@UploadedFile() file: Express.Multer.File | undefined, @Req() req: Request & { user: AuthedUser }) {
    if (!file) throw new AppError(ErrorCode.VALIDATION_ERROR, '缺少文件（字段名 file）');
    return this.attachments.save(req.user.userId, {
      buffer: file.buffer, mimetype: file.mimetype, originalname: file.originalname, size: file.size,
    });
  }

  @Get(':id')
  async get(@Req() req: Request & { user: AuthedUser }, @Param('id') id: string, @Res() res: Response) {
    const att = await this.attachments.getById(req.user.userId, id);
    const stream = await this.attachments.openStream(att);
    res.setHeader('Content-Type', att.mimeType);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(att.originalName ?? att.id)}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    // 读流 error 绝不裸奔（字节-行错位的 TOCTOU 兜底）：未发头 → 404；已发头 → 断连。缺此处理，
    // unhandled 'error' 事件会打崩整个 API 进程（2026-09-29 实抓：e2e 临时存储与共享库错配触发）。
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: '附件文件缺失' } });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  }
}
