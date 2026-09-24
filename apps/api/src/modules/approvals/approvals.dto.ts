import { z } from 'zod';

/** GET /approvals 过滤（分页预留；默认最近 50 条） */
export const ListApprovalsSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  status: z.enum(['requested', 'approved', 'rejected', 'expired', 'cancelled']).optional(),
  agentRunId: z.string().uuid().optional(),
});
export type ListApprovalsDto = z.infer<typeof ListApprovalsSchema>;
