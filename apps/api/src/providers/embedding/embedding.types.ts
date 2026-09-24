/** Embedding Provider 统一接口（维度由 provider capability 决定，不硬编码） */
export interface EmbeddingProvider {
  readonly kind: 'embedding';
  embed(inputs: string[]): Promise<number[][]>;
  getDimensions(): number;
}
