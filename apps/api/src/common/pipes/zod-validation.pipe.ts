import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';

/** 用法：@UsePipes(new ZodValidationPipe(LoginSchema)) —— zod 单源校验 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `参数校验失败：${detail}` });
    }
    return result.data;
  }
}
