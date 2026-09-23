import { Controller, Get, Inject, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { AttachmentsService } from './attachments.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { AuthedUser, JwtAuthGuard } from '../auth/jwt-auth.guard';

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // multer 总闸（按类型细分在 service 层）

@Controller('attachments')
@UseGuards(JwtAuthGuard)
export class AttachmentsController {
  constructor(@Inject(AttachmentsService) private readonly attachments: AttachmentsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
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
    stream.pipe(res);
  }
}
