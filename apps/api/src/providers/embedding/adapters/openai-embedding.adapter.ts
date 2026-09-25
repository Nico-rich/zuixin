import OpenAI from 'openai';
import { EmbeddingProvider } from '../embedding.types';
import { manualRedirectFetch } from '../../../modules/security/provider-base-url.guard';

export interface OpenAIEmbeddingConfig { baseUrl: string; apiKey: string; timeoutMs: number; }

/** OpenAI text-embedding-3-* 系列（OpenAI 兼容端点可用） */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'embedding' as const;
  private readonly client: OpenAI;

  constructor(private readonly cfg: OpenAIEmbeddingConfig, private readonly model: string, private readonly dimensions: number) {
    // Pre-M9 F3-B：禁止自动跟随重定向
    this.client = new OpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey, timeout: cfg.timeoutMs, maxRetries: 0, fetch: manualRedirectFetch });
  }

  getDimensions(): number { return this.dimensions; }

  async embed(inputs: string[]): Promise<number[][]> {
    const res = await this.client.embeddings.create({ model: this.model, input: inputs });
    return res.data.map((d) => d.embedding);
  }
}
