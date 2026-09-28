import OpenAI from 'openai';
import { EmbeddingProvider } from '../embedding.types';
import { manualRedirectFetch } from '../../../modules/security/provider-base-url.guard';
import { mapSdkError } from '../../llm/errors';

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
    // M10-P2：SDK timeout/abort（无 status/code）归一为 PROVIDER_TIMEOUT（可重试），
    // 而非不可重试的 PROVIDER_UNKNOWN/裸 INTERNAL（与 openai-compatible adapter 同一归一管道）
    try {
      const res = await this.client.embeddings.create({ model: this.model, input: inputs });
      return res.data.map((d) => d.embedding);
    } catch (err) { throw mapSdkError(err); }
  }
}
