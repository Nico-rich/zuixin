import { z } from 'zod';

export const StartConnectionSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
});
export type StartConnectionDto = z.infer<typeof StartConnectionSchema>;

export const CallbackQuerySchema = z.object({
  state: z.string().min(8).max(128),
  code: z.string().min(1).max(512),
});
export type CallbackQueryDto = z.infer<typeof CallbackQuerySchema>;

/** 连接对外投影（六不原则：绝不包含凭证字段） */
export interface ConnectionView {
  id: string;
  provider: string;
  providerAccountId: string | null;
  status: 'active' | 'expired' | 'revoked';
  scope: unknown;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const CONNECTION_SELECT = {
  id: true, userId: true, projectId: true, provider: true, providerAccountId: true,
  status: true, scope: true, expiresAt: true, revokedAt: true, lastSyncedAt: true,
  createdAt: true, updatedAt: true,
} as const;
