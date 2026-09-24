import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { StorageAdapter } from '../storage/storage.types';
import { EmbeddingManagerService } from '../../providers/embedding/embedding-manager.service';
import { ChunkingService } from './chunking.service';
import { KnowledgeRepository, SearchResultChunk } from './knowledge.repository';

const SUPPORTED_TEXT_MIME = ['text/plain', 'text/markdown', 'text/csv'];

export interface SearchOptions {
  topK?: number;
  similarityThreshold?: number;
}

/**
 * Knowledge 服务层（统一入口：ContextAssembler KnowledgeSource 与 knowledge.search Tool 都经此，不重复实现）。
 * - 文档生命周期：pending → processing → ready / failed（P5 同步 ingestion，不建新队列）；
 * - Memory 与 Knowledge 严格分离：本服务不读写 memories 表；
 * - Embedding 经 EmbeddingProvider 抽象，不直连任何厂商 SDK。
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger('Knowledge');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject('STORAGE_ADAPTER') private readonly storage: StorageAdapter,
    @Inject(EmbeddingManagerService) private readonly embeddings: EmbeddingManagerService,
    @Inject(ChunkingService) private readonly chunking: ChunkingService,
    @Inject(KnowledgeRepository) private readonly repo: KnowledgeRepository,
  ) {}

  /** 创建文档并同步完成 ingestion（P5 同步；异步队列留 M6） */
  async createDocument(userId: string, input: {
    name: string; projectId?: string; sourceType: 'text' | 'file';
    content?: string; attachmentId?: string;
  }) {
    if (input.sourceType === 'text') {
      if (!input.content?.trim()) throw new AppError(ErrorCode.VALIDATION_ERROR, 'text 源必须提供 content');
      const doc = await this.repo.createDocument({
        userId, projectId: input.projectId, name: input.name, sourceType: 'text', content: input.content,
      });
      return this.ingestDocument(userId, doc.id);
    }
    // file 源：P5 支持 txt/md/csv（经已上传附件读取）
    if (!input.attachmentId) throw new AppError(ErrorCode.VALIDATION_ERROR, 'file 源必须提供 attachmentId');
    const att = await this.prisma.attachment.findFirst({ where: { id: input.attachmentId, userId } });
    if (!att) throw new AppError(ErrorCode.NOT_FOUND, '附件不存在');
    if (!SUPPORTED_TEXT_MIME.includes(att.mimeType)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `不支持的文档类型（P5 支持 ${SUPPORTED_TEXT_MIME.join('/')}）`);
    }
    if (!this.storage.getStream) throw new AppError(ErrorCode.INTERNAL, '存储驱动不支持读取');
    const chunks: Buffer[] = [];
    for await (const c of await this.storage.getStream(att.storageKey)) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf-8');
    const doc = await this.repo.createDocument({
      userId, projectId: input.projectId, name: input.name, sourceType: 'file',
      storageKey: att.storageKey, mimeType: att.mimeType, sizeBytes: att.sizeBytes,
      contentHash: createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),
    });
    return this.ingestText(userId, doc.id, text);
  }

  /** 重新索引（re-index）：清空 chunks → 重新分块/embedding */
  async reindex(userId: string, documentId: string) {
    const doc = await this.repo.getDocument(userId, documentId);
    const text = doc.content ?? await this.readFileText(doc.storageKey, doc.mimeType);
    return this.ingestText(userId, documentId, text);
  }

  getDocument(userId: string, id: string) {
    return this.repo.getDocument(userId, id);
  }

  listDocuments(userId: string, projectId?: string) {
    return this.repo.listDocuments(userId, projectId);
  }

  async deleteDocument(userId: string, id: string) {
    await this.repo.deleteDocument(userId, id); // chunks 级联删除
  }

  /** 检索（user scope + project scope；相似度过滤在 SQL 层） */
  async search(userId: string, projectId: string | undefined, query: string, options: SearchOptions = {}): Promise<SearchResultChunk[]> {
    if (!query.trim()) return [];
    const resolved = await this.embeddings.resolveDefault();
    const [queryEmbedding] = await resolved.provider.embed([query]);
    return this.repo.searchSimilarChunks({
      userId, projectId: projectId ?? null,
      queryEmbedding,
      topK: options.topK ?? 5,
      similarityThreshold: options.similarityThreshold ?? 0.3,
    });
  }

  private async ingestDocument(userId: string, documentId: string) {
    const doc = await this.repo.getDocument(userId, documentId);
    return this.ingestText(userId, documentId, doc.content ?? await this.readFileText(doc.storageKey, doc.mimeType));
  }

  private async ingestText(userId: string, documentId: string, text: string) {
    const doc = await this.repo.getDocument(userId, documentId);
    try {
      await this.repo.updateDocumentStatus(userId, documentId, { status: 'processing' });
      const pieces = this.chunking.chunk(text);
      if (!pieces.length) throw new AppError(ErrorCode.VALIDATION_ERROR, '文档内容为空');
      const resolved = await this.embeddings.resolveDefault();
      const vectors = await resolved.provider.embed(pieces);
      await this.repo.deleteChunks(documentId);
      await this.repo.createChunks(
        documentId, userId, doc.projectId ?? null, resolved.apiModelId,
        pieces.map((content, i) => ({ content, tokenCount: Math.ceil(content.length / 2), embedding: vectors[i] })),
      );
      await this.repo.updateDocumentStatus(userId, documentId, { status: 'ready', chunkCount: pieces.length, version: { increment: 1 } });
      return this.repo.getDocument(userId, documentId);
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError(ErrorCode.INTERNAL, (err as Error).message);
      await this.repo.updateDocumentStatus(userId, documentId, { status: 'failed', errorCode: appErr.code }).catch(() => undefined);
      throw appErr;
    }
  }

  private async readFileText(storageKey: string | null, mimeType: string | null): Promise<string> {
    if (!storageKey || !this.storage.getStream) throw new AppError(ErrorCode.VALIDATION_ERROR, '文档缺少可读内容');
    if (mimeType && !SUPPORTED_TEXT_MIME.includes(mimeType)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `不支持的文档类型（P5 支持 ${SUPPORTED_TEXT_MIME.join('/')}）`);
    }
    const chunks: Buffer[] = [];
    for await (const c of await this.storage.getStream(storageKey)) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf-8');
  }
}
