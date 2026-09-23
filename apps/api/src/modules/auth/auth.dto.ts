import { z } from 'zod';

export const LoginDtoSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
  password: z.string().min(6, '密码至少 6 位').max(128),
});
export type LoginDto = z.infer<typeof LoginDtoSchema>;
