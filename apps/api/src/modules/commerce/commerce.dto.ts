import { z } from 'zod';

/** GET /commerce/{analyses,briefs} 列表参数（M13-W9；未知 query 键被剥除，无 userId/org 参数） */
export const ListCommerceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type ListCommerceQuery = z.infer<typeof ListCommerceQuerySchema>;
