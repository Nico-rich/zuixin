import OpenAI from 'openai';
import { ImageGenerationParams, ImageGenerationResult, ImageProvider } from '../image.types';
import { manualRedirectFetch } from '../../../modules/security/provider-base-url.guard';

export interface OpenAICompatibleImageConfig { baseUrl: string; apiKey: string; timeoutMs: number; }

type ImageGenFn = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** OpenAI gpt-image-1 / dall-e-3（同步接口） */
export class OpenAIImageAdapter implements ImageProvider {
  readonly kind = 'image' as const;
  private readonly genFn: ImageGenFn;

  constructor(cfg: OpenAICompatibleImageConfig, injected?: { generate?: ImageGenFn }) {
    // Pre-M9 F3-B：禁止自动跟随重定向
    const client = new OpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey, timeout: cfg.timeoutMs, maxRetries: 0, fetch: manualRedirectFetch });
    this.genFn = injected?.generate ?? (async (body) => (await client.images.generate(body as never)) as unknown as Record<string, unknown>);
  }

  async generate(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    const body: Record<string, unknown> = {
      model: params.model,
      prompt: params.prompt,
      n: params.count ?? 1,
      size: params.size ?? '1024x1024',
    };
    if (params.quality) body.quality = params.quality;
    const r = await this.genFn(body);
    const data = (r.data as Array<{ url?: string; b64_json?: string }>) ?? [];
    return {
      images: data.filter((d) => d.url || d.b64_json).map((d) => ({
        url: d.url ?? `data:image/png;base64,${d.b64_json}`,
      })),
      usage: { imageCount: data.length, providerModel: params.model },
    };
  }
}
