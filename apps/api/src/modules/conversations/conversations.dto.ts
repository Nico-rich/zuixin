import { z } from 'zod';
import { decodeCursor } from './cursor';

export const CreateConversationDtoSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  projectId: z.string().uuid().nullable().optional(),
});
export type CreateConversationDto = z.infer<typeof CreateConversationDtoSchema>;

export const UpdateConversationDtoSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  projectId: z.string().uuid().nullable().optional(), // null = 移出项目
});
export type UpdateConversationDto = z.infer<typeof UpdateConversationDtoSchema>;

/**
 * M10-P3（ARCH-11）游标分页查询参数：`limit` / `before` / `after`。
 *
 * 兼容性：三者**全部可选**——不传任何分页参数时行为与旧版一致（取首页，条数 = 该端点的历史默认值），
 * 既有调用方（Web 侧边栏 / 历史消息）无需改动。
 * 语义：
 * - `after=<cursor>`：取游标**之后**（更新/更晚）的一页，按端点自身排序方向推进；
 * - `before=<cursor>`：取游标**之前**（更早）的一页；
 * - 二者互斥（同时给出 → 400 VALIDATION_ERROR，避免"窗口语义不明"的静默裁决）。
 * 游标在管道内即校验合法性（非法 → 400），服务层只需使用，不做二次兜底解析。
 */
const CursorStringSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => decodeCursor(v) !== null, { message: '游标非法（须为服务端返回的 nextCursor/prevCursor 原值）' });

const PageQueryFields = {
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: CursorStringSchema.optional(),
  after: CursorStringSchema.optional(),
};

const mutuallyExclusiveCursors = (v: { before?: string; after?: string }) => !(v.before && v.after);

export const ListConversationsQuerySchema = z
  .object({
    projectId: z.string().uuid().optional(),
    ...PageQueryFields,
  })
  .refine(mutuallyExclusiveCursors, { message: 'before 与 after 不能同时使用', path: ['before'] });
export type ListConversationsQuery = z.infer<typeof ListConversationsQuerySchema>;

export const ListMessagesQuerySchema = z
  .object({ ...PageQueryFields })
  .refine(mutuallyExclusiveCursors, { message: 'before 与 after 不能同时使用', path: ['before'] });
export type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;
