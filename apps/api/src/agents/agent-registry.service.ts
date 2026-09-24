import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TaskIntent } from '@ai-agent/shared';
import { PrismaService } from '../modules/prisma/prisma.service';
import { MediaGenerationService } from '../modules/generations/media-generation.service';
import { AgentLoopService } from '../core/agent-loop/agent-loop.service';
import { ContextAssembler } from '../core/context/context-assembler';
import { Agent } from './agent.types';
import { GeneralAssistantAgent } from './general/general.agent';
import { ImageAgent } from './image/image.agent';
import { VideoAgent } from './video/video.agent';

const DEFAULT_AGENT_MAPPING: Record<string, string> = {
  chat: 'general-assistant',
  image_generation: 'image',
  video_generation: 'video',
  image_analysis: 'general-assistant',
  file_analysis: 'general-assistant',
  agent_task: 'general-assistant',
  workflow: 'general-assistant',
};

/**
 * Agent 注册表（DB 配置驱动，替代 ChatService 硬编码 switch）：
 * 启动时加载 enabled Agent 行，kind=builtin 按 slug 映射代码类，kind=custom 用通用 Loop Agent。
 * 意图 → Agent 映射来自 routingPolicy.agentMapping（后台可改）。
 */
@Injectable()
export class AgentRegistryService implements OnModuleInit {
  private readonly logger = new Logger('AgentRegistry');
  private agents = new Map<string, Agent>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AgentLoopService) private readonly loop: AgentLoopService,
    @Inject(ContextAssembler) private readonly context: ContextAssembler,
    @Inject(MediaGenerationService) private readonly generations: MediaGenerationService,
  ) {}

  async onModuleInit() { await this.refresh(); }

  async refresh(): Promise<void> {
    const rows = await this.prisma.agent.findMany({
      where: { enabled: true },
      include: { activeVersion: true },
    });
    const next = new Map<string, Agent>();
    for (const row of rows) {
      if (!row.activeVersion) {
        this.logger.warn(`Agent ${row.slug} 无 activeVersion，跳过加载（需在后台发布版本）`);
        continue;
      }
      const agent = this.buildAgent(row);
      if (agent) next.set(row.slug, agent);
    }
    this.agents = next;
    this.logger.log(`Agents 已加载: ${this.agents.size} 个`);
  }

  async resolveForIntent(intent: TaskIntent): Promise<Agent> {
    const settings = await this.prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    const mapping = (settings?.value as { agentMapping?: Record<string, string> } | null)?.agentMapping ?? DEFAULT_AGENT_MAPPING;
    const slug = mapping[intent.type] ?? 'general-assistant';
    return this.agents.get(slug) ?? this.agents.get('general-assistant') ?? this.buildFallback();
  }

  get(slug: string): Agent | undefined { return this.agents.get(slug); }
  list(): Agent[] { return [...this.agents.values()]; }

  private buildAgent(row: {
    id: string; slug: string; kind: string;
    activeVersion: {
      id: string; version: number; systemPrompt: string; modelId: string | null;
      tools: unknown; temperature: number; maxTokens: number | null; config: unknown;
    } | null;
  }): Agent | null {
    const kind = row.kind === 'custom' ? 'general-assistant' : row.slug;
    const v = row.activeVersion!; // refresh 已保证存在
    switch (kind) {
      case 'general-assistant': {
        const cfg = (v.config ?? {}) as { maxSteps?: number; requiresTools?: boolean; knowledge?: { enabled?: boolean }; contextBudgetTokens?: number };
        return new GeneralAssistantAgent({
          loop: this.loop, context: this.context,
          config: {
            id: row.id, systemPrompt: v.systemPrompt, modelId: v.modelId,
            tools: (v.tools as string[]) ?? [], temperature: v.temperature,
            maxTokens: v.maxTokens ?? undefined, maxSteps: cfg.maxSteps,
            requiresTools: cfg.requiresTools,
            versionId: v.id, // Run 锁定版本（immutable 快照）
            knowledgeEnabled: cfg.knowledge?.enabled ?? false,
            // 预算只读自服务端 AgentVersion 配置；非法值在 assembler 侧忽略回默认
            contextBudgetTokens: cfg.contextBudgetTokens,
          },
        });
      }
      case 'image':
        return new ImageAgent({ generations: this.generations });
      case 'video':
        return new VideoAgent({ generations: this.generations });
      default:
        this.logger.warn(`未知 Agent slug: ${row.slug}（kind=${row.kind}），跳过加载`);
        return null;
    }
  }

  private buildFallback(): Agent {
    this.logger.error('注册表中无可用 Agent（含 general-assistant），请检查 seed');
    throw new Error('没有可用的 Agent');
  }
}
