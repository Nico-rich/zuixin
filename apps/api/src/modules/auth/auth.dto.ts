import { z } from 'zod';
import { DEVICE_ID_MAX_LEN } from './auth.constants';

export const LoginDtoSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
  password: z.string().min(6, '密码至少 6 位').max(128),
  /**
   * M11-P2：可选设备标识（**仅作分组标识**，服务端不信任其内容，绝不影响鉴权裁决）。
   * 来源优先级：header `X-Device-Id` > body `deviceId`（见 auth.constants 的契约说明）。
   */
  deviceId: z.string().max(DEVICE_ID_MAX_LEN).optional(),
});
export type LoginDto = z.infer<typeof LoginDtoSchema>;
