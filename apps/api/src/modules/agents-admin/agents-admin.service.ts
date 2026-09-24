import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { AgentRegistryService } from '../../agents/agent-registry.service';

export interface CreateAgentInput {
  slug: string;
  name: string;
  description?: string;
  kind: string;
  systemPrompt: string;
  tools?: string[];
  modelId?: string | null;
  temperature?: number;
  maxTokens?: number | null;
  config?: Record<string, unknown>;
}

export interface DraftEditInput {
  systemPrompt?: string;
  tools?: string[];
  modelId?: string | null;
  temperature?: number;
  maxTokens?: number | null;
  config?: Record<string, unknown>;
}

/**
 * Agent 管理（Admin）——版本生命周期核心：
 * - 定义只存在于 AgentVersion；published/archived **不可变**（服务层守卫：更新只允许 draft）；
 * - 修改 Agent = 编辑/新建 draft → publish 生成新版本（旧 published → archived）；
 * - 回滚 = activeVersionId 指回目标版本（零复制）；
 * - AgentRun 在创建时锁定 agentVersionId，此后永不改变。
 */
@Injectable()
export class AgentsAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AgentRegistryService) private readonly registry: AgentRegistryService,
  ) {}

  list() {
    return this.prisma.agent.findMany({ include: { activeVersion: true, versions: { orderBy: { version: 'desc' } } } });
  }

  get(id: string) {
    return this.prisma.agent.findUnique({ where: { id }, include: { activeVersion: true, versions: { orderBy: { version: 'desc' } } } });
  }

  async create(input: CreateAgentInput) {
    const agent = await this.prisma.agent.create({
      data: { slug: input.slug, name: input.name, description: input.description, kind: input.kind },
    });
    const v1 = await this.prisma.agentVersion.create({
      data: {
        agentId: agent.id, version: 1, status: 'draft',
        systemPrompt: input.systemPrompt, tools: input.tools ?? [],
        modelId: input.modelId, temperature: input.temperature ?? 0.7,
        maxTokens: input.maxTokens, config: (input.config ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    return { agent, draftVersion: v1 };
  }

  /** 编辑草稿：不存在则基于 activeVersion 复制开新 draft（版本 n+1） */
  async editDraft(agentId: string, input: DraftEditInput) {
    const agent = await this.requireAgent(agentId);
    let draft = await this.prisma.agentVersion.findFirst({ where: { agentId, status: 'draft' } });
    if (!draft) {
      const base = agent.activeVersionId
        ? await this.prisma.agentVersion.findUnique({ where: { id: agent.activeVersionId } })
        : null;
      const nextVersion = await this.prisma.agentVersion.aggregate({ where: { agentId }, _max: { version: true } });
      draft = await this.prisma.agentVersion.create({
        data: {
          agentId, version: (nextVersion._max.version ?? 0) + 1, status: 'draft',
          systemPrompt: base?.systemPrompt ?? '',
          tools: (base?.tools as string[] | undefined) ?? [],
          modelId: base?.modelId ?? null,
          temperature: base?.temperature ?? 0.7,
          maxTokens: base?.maxTokens ?? null,
          config: base?.config as Prisma.InputJsonValue | undefined,
        },
      });
    }
    // 守卫：更新目标必须是 draft（数据库层面 status 条件 + 服务层语义）
    return this.prisma.agentVersion.update({
      where: { id: draft.id },
      data: {
        ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        ...(input.config !== undefined ? { config: input.config as Prisma.InputJsonValue } : {}),
      },
    });
  }

  /** 发布：draft → published（旧 published → archived），activeVersionId 切换 */
  async publish(agentId: string) {
    const agent = await this.requireAgent(agentId);
    const draft = await this.prisma.agentVersion.findFirst({ where: { agentId, status: 'draft' } });
    if (!draft) throw new AppError(ErrorCode.VALIDATION_ERROR, '没有可发布的草稿');
    await this.prisma.$transaction([
      this.prisma.agentVersion.updateMany({ where: { agentId, status: 'published' }, data: { status: 'archived' } }),
      this.prisma.agentVersion.update({ where: { id: draft.id }, data: { status: 'published' } }),
      this.prisma.agent.update({ where: { id: agentId }, data: { activeVersionId: draft.id } }),
    ]);
    await this.registry.refresh(); // 后台变更即时生效
    return this.prisma.agentVersion.findUnique({ where: { id: draft.id } });
  }

  /** 回滚：activeVersionId 指回目标 published/archived 版本（零复制） */
  async rollback(agentId: string, versionId: string) {
    const agent = await this.requireAgent(agentId);
    const target = await this.prisma.agentVersion.findFirst({ where: { id: versionId, agentId } });
    if (!target || target.status === 'draft') throw new AppError(ErrorCode.VALIDATION_ERROR, '回滚目标必须是已发布或归档版本');
    await this.prisma.agent.update({ where: { id: agent.id }, data: { activeVersionId: target.id } });
    await this.registry.refresh();
    return target;
  }

  /** 启停 Agent（不改版本） */
  async setEnabled(agentId: string, enabled: boolean) {
    await this.requireAgent(agentId);
    await this.prisma.agent.update({ where: { id: agentId }, data: { enabled } });
    await this.registry.refresh();
  }

  private async requireAgent(id: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new AppError(ErrorCode.NOT_FOUND, 'Agent 不存在');
    return agent;
  }
}
