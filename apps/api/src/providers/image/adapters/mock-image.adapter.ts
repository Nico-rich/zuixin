import { ImageGenerationParams, ImageGenerationResult, ImageProvider } from '../image.types';

/** 1×1 PNG（dev/e2e 替身：无 Key 全链路可跑） */
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** dev/e2e 生图替身：返回硬编码 1×1 PNG（data URL），count 张 */
export class MockImageAdapter implements ImageProvider {
  readonly kind = 'image' as const;

  async generate(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    const count = Math.min(Math.max(params.count ?? 1, 1), 4);
    const images = Array.from({ length: count }, () => ({ url: `data:image/png;base64,${PNG_1PX_BASE64}`, width: 1, height: 1 }));
    return { images, usage: { imageCount: count, providerModel: params.model } };
  }
}
