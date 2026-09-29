import { Inject, Injectable } from '@nestjs/common';
import { Artifact, Prisma } from '@prisma/client';
import { Readable } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { StorageAdapter } from '../../core/storage/storage.types';
import { storageDeadlineMs, withStorageDeadline } from '../../core/storage/storage-timeouts';

export interface CreateArtifactInput {
  type: 'creative_brief' | 'image' | 'video' | 'report' | 'analysis' | 'other';
  title: string;
  summary?: string;
  content?: Record<string, unknown>;
  projectId?: string;
  conversationId?: string;
  messageId?: string;
  taskId?: string;
  /** AgentRun/ToolCall 追溯（非 Agent 场景留空——由调用链显式传递） */
  runId?: string;
  toolCallId?: string;
  /** M6-P4：resume 重放去重（部分唯一索引；同一 ToolCall 重试绝不产生第二个制品） */
  idempotencyKey?: string;
}

/** 列表硬上限（防"一次拉全表"；详情/下载不受影响） */
const MAX_LIST_LIMIT = 100;

/** 列表过滤（M13-W9 只读展示面；全部条件在 userId 归属之上叠加） */
export interface ListArtifactsInput {
  type?: CreateArtifactInput['type'];
  projectId?: string;
  conversationId?: string;
  runId?: string;
  limit?: number;
}

/**
 * 制品**响应投影**（M13-W9）：只暴露客户端渲染所需字段，绝不外泄内部列。
 *  - `storageKey` / `idempotencyKey` 属内部实现（存储路径是越权读取的钥匙；幂等键是重放去重面）；
 *  - 文件下载统一给**代理路径**（`/api/v1/artifacts/:id/download`，服务端做归属校验 + 流式回源）。
 */
export interface ArtifactView {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  content: unknown;
  status: string;
  projectId: string | null;
  conversationId: string | null;
  messageId: string | null;
  taskId: string | null;
  runId: string | null;
  toolCallId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** 非空 = 存在落库文件（经下方代理端点下载）；null = 纯结构化制品（无文件） */
  downloadUrl: string | null;
}

/** Artifact 最小写入方（M4）：仅 create/read，无 Workflow；归属校验与全站同模式 */
@Injectable()
export class ArtifactService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    // StorageModule 是 @Global（与 attachments 同一注入口径）；制品文件与附件共用同一驱动
    @Inject('STORAGE_ADAPTER') private readonly storage: StorageAdapter,
  ) {}

  async create(userId: string, input: CreateArtifactInput) {
    if (input.projectId) {
      const p = await this.prisma.project.findFirst({ where: { id: input.projectId, userId, deletedAt: null } });
      if (!p) throw new AppError(ErrorCode.NOT_FOUND, '项目不存在');
    }
    if (input.conversationId) {
      const c = await this.prisma.conversation.findFirst({ where: { id: input.conversationId, userId, deletedAt: null } });
      if (!c) throw new AppError(ErrorCode.NOT_FOUND, '对话不存在');
    }
    try {
      return await this.prisma.artifact.create({
        data: {
          userId,
          type: input.type,
          title: input.title,
          summary: input.summary,
          content: (input.content ?? undefined) as Prisma.InputJsonValue | undefined,
          projectId: input.projectId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          taskId: input.taskId,
          runId: input.runId,
          toolCallId: input.toolCallId,
          idempotencyKey: input.idempotencyKey,
          status: 'ready',
        },
      });
    } catch (err) {
      // M6-P4：幂等键冲突（部分唯一索引）→ 返回已有制品，绝不产生第二个（resume 重放收敛）
      if (input.idempotencyKey && (err as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.artifact.findFirst({ where: { idempotencyKey: input.idempotencyKey, userId } });
        if (existing) return existing;
      }
      throw err;
    }
  }

  async getById(userId: string, id: string) {
    const artifact = await this.prisma.artifact.findFirst({ where: { id, userId } });
    if (!artifact) throw new AppError(ErrorCode.NOT_FOUND, '制品不存在');
    return artifact;
  }

  async listByConversation(userId: string, conversationId: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id: conversationId, userId, deletedAt: null } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, '对话不存在');
    return this.prisma.artifact.findMany({
      where: { conversationId, userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  // ===== M13-W9 只读展示面（HTTP 消费）=====

  /**
   * 制品列表：**userId 恒为首条件**（服务端归属，绝不接受客户端传入的 userId/org）；
   * 类型/项目/会话/run 过滤一律在该归属之上叠加；分页用固定上限（无游标——制品是投影面，
   * 写路径已由 ToolCall 幂等键收敛，无高频写入）。
   */
  async list(userId: string, input: ListArtifactsInput = {}): Promise<ArtifactView[]> {
    const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 30)), MAX_LIST_LIMIT);
    const rows = await this.prisma.artifact.findMany({
      where: {
        userId,
        ...(input.type ? { type: input.type } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    // 列表不搬运 `content` 证据体（一次 100 行的 JSON 全量序列化是白送带宽；正文走详情端点）
    return rows.map((r) => ({ ...this.view(r), content: null }));
  }

  /** 详情：归属不符/不存在一律 404（同码同文案，不构成存在性预言机） */
  async detail(userId: string, id: string): Promise<ArtifactView> {
    return this.view(await this.getById(userId, id));
  }

  /**
   * 下载回源（**既有附件代理口径**：JWT + 归属校验（404 防枚举）+ 服务端流式读取 + 私有缓存）。
   * 与 attachments 的唯一差异是 Content-Disposition=attachment：artifact 无 mimeType 列，
   * 未知字节**绝不 inline 渲染**（外部/LLM 产出属 UNTRUSTED，inline 会成为 XSS 载体）。
   */
  async openStream(userId: string, id: string): Promise<{ artifact: ArtifactView; stream: Readable }> {
    const artifact = await this.getById(userId, id);
    if (!artifact.storageKey) throw new AppError(ErrorCode.NOT_FOUND, '制品无关联文件');
    if (!this.storage.getStream) throw new AppError(ErrorCode.INTERNAL, '存储驱动不支持流式读取');
    const stream = await withStorageDeadline(
      this.storage.getStream(artifact.storageKey), storageDeadlineMs(), 'artifact:getStream',
    );
    return { artifact: this.view(artifact), stream };
  }

  /** 行 → 响应投影（单一映射点：内部列只在此处被裁掉） */
  private view(row: Artifact): ArtifactView {
    return {
      id: row.id, type: row.type, title: row.title, summary: row.summary, content: row.content,
      status: row.status, projectId: row.projectId, conversationId: row.conversationId,
      messageId: row.messageId, taskId: row.taskId, runId: row.runId, toolCallId: row.toolCallId,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
      downloadUrl: row.storageKey ? `/api/v1/artifacts/${row.id}/download` : null,
    };
  }
}
