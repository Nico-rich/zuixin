import { z } from 'zod';

/**
 * M13+（模型配置页）：Provider 管理 PATCH 的**唯一可写面**（strict：未知键 → 400，绝不静默丢弃）。
 *
 * 不可变面：id/name/type/adapter/healthStatus/retryConfig 一律不可写——由 strictObject 结构性保证
 * （不写"选择性忽略"逻辑，fail loud）。
 *
 * 只写语义：apiKey 非空 → 加密落库（CryptoService.encrypt 自描述 v{n} 密文）；空串/缺省 → 不改
 * （读取面只有 hasKey 布尔，**绝无任何路径回显 Key**）。
 */
export const ProviderPatchSchema = z
  .strictObject({
    /** 只写；trim 后空串 = 保持不变（缺省亦同） */
    apiKey: z.string().max(4096).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    /** mock adapter 允许 ''；其余必须过 SSRF 同步判定（服务层裁决） */
    baseUrl: z.string().trim().max(2048).optional(),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    /**
     * 模型级启停（M13+ 模型配置页）：seed 里真实生图/生视频模型默认停用，
     * 仅靠 provider 级 enabled 无法让它们可被路由选中——必须可改 Model.enabled。
     * 每个 id 必须**属于该 provider**（服务层裁决；跨厂商模型 id → 400）。
     */
    models: z
      .array(z.strictObject({ id: z.string().min(1).max(200), enabled: z.boolean() }))
      .min(1)
      .max(100)
      .optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: '补丁不能为空（空补丁不产生任何变更）' });

export type ProviderPatch = z.infer<typeof ProviderPatchSchema>;
