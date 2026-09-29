import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TaskIntent } from '@ai-agent/shared';
import { PrismaService } from '../modules/prisma/prisma.service';
import { MediaGenerationService } from '../modules/generations/media-generation.service';
import {
  loadAgentPerformance,
  parsePerformanceRanking,
  rankByAgentPerformance,
  type AgentPerformanceStat,
  type PerformanceRankingConfig,
} from '../modules/analytics/agent-performance';
import { AgentRuntimeEngine } from '../core/agent-loop/agent-runtime-engine';
import { ContextAssembler } from '../core/context/context-assembler';
import { Agent } from './agent.types';
import { GeneralAssistantAgent } from './general/general.agent';
import { ImageAgent } from './image/image.agent';
import { VideoAgent } from './video/video.agent';

/** 映射缺省/兜底 slug（无可解析候选时的既有行为：general-assistant） */
const FALLBACK_AGENT_SLUG = 'general-assistant';

/** 意图 → 候选 Agent slug（**静态顺序**；单值 = 单候选，数组 = 同映射目标多候选） */
const DEFAULT_AGENT_MAPPING: Record<string, string | string[]> = {
  chat: 'general-assistant',
  image_generation: 'image',
  video_generation: 'video',
  image_analysis: 'general-assistant',
  file_analysis: 'general-assistant',
  agent_task: 'general-assistant',
  workflow: 'general-assistant',
};

/** routingPolicy 中本服务消费的字段（其余字段归 router/model-resolver 等，绝不越界读写） */
export interface RoutingPolicyValue {
  agentMapping?: Record<string, string | string[]>;
  performanceRanking?: unknown;
}

/**
 * 映射值归一化 → 候选 slug 列表（**顺序 = 静态顺序**）：
 * 单 slug 与 `[slug]` 等价；非字符串/空串一律丢弃；重复 slug 去重（绝不重复占用候选位）。
 * 非法配置绝不抛错——退化为"无候选"，由调用方走既有兜底路径。
 */
export function candidateSlugs(value: string | string[] | undefined | null): string[] {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return [...new Set(raw.filter((slug): slug is string => typeof slug === 'string' && slug.length > 0))];
}

/**
 * Agent 注册表（DB 配置驱动，替代 ChatService 硬编码 switch）：
 * 启动时加载 enabled Agent 行，kind=builtin 按 slug 映射代码类，kind=custom 用通用 Loop Agent。
 * 意图 → Agent 映射来自 routingPolicy.agentMapping（后台可改；值可为 slug 或候选列表）。
 *
 * M12-P2 表现回流（**只调顺序，不调权限**）：
 * - 当同一意图映射到**多个候选**时，用近期 Agent 表现（失败率低者优先）打破静态顺序；
 * - 候选集合、工具集、版本、模型一律不由表现数据决定（红线：LLM/表现数据都不下发模型与路由选择权）；
 * - 表现数据缺失/样本不足/读取失败 → 逐字回退静态顺序（零行为漂移）；单候选时**绝不发起表现查询**。
 */
@Injectable()
export class AgentRegistryService implements OnModuleInit {
  private readonly logger = new Logger('AgentRegistry');
  private agents = new Map<string, Agent>();
  /**
   * slug → Agent 主键 id（= AgentRun.agentId）：表现数据的归因键是 DB 主键，
   * 而 media/builtin Agent 实例的 `agent.id` 是 slug（M2/M3 既有语义，不改），故按行登记真身 id。
   */
  private agentIds = new Map<string, string>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AgentRuntimeEngine) private readonly engine: AgentRuntimeEngine,
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
    const nextIds = new Map<string, string>();
    for (const row of rows) {
      if (!row.activeVersion) {
        this.logger.warn(`Agent ${row.slug} 无 activeVersion，跳过加载（需在后台发布版本）`);
        continue;
      }
      const agent = this.buildAgent(row);
      if (agent) {
        next.set(row.slug, agent);
        nextIds.set(row.slug, row.id);
      }
    }
    this.agents = next;
    this.agentIds = nextIds;
    this.logger.log(`Agents 已加载: ${this.agents.size} 个`);
  }

  /**
   * 意图 → Agent：
   * 1. routingPolicy.agentMapping[intent.type]（可后台改）→ 候选 slug 列表（静态顺序）；
   * 2. 解析已加载实例；**多候选**时用近期表现（失败率低者优先）打破静态顺序（M12-P2，只调顺序）；
   * 3. 无候选/全部不可解析 → 既有兜底 general-assistant → 仍无 → 抛错。
   */
  async resolveForIntent(intent: TaskIntent): Promise<Agent> {
    const settings = await this.prisma.systemSetting.findUnique({ where: { key: 'routingPolicy' } });
    const policy = (settings?.value ?? null) as RoutingPolicyValue | null;
    const mapping = policy?.agentMapping ?? DEFAULT_AGENT_MAPPING;
    const candidates = candidateSlugs(mapping[intent.type])
      .map((slug) => ({ slug, agent: this.agents.get(slug) }))
      .filter((candidate): candidate is { slug: string; agent: Agent } => !!candidate.agent);
    if (candidates.length === 0) return this.agents.get(FALLBACK_AGENT_SLUG) ?? this.buildFallback();
    if (candidates.length === 1) return candidates[0].agent; // 单候选：静态映射语义逐字不变，绝不查询表现数据
    return this.rankedFirst(candidates, policy?.performanceRanking);
  }

  /**
   * 多候选表现排序（稳定性打破，只改顺序）：
   * - 表现数据是**建议性输入**——读取失败/无数据/样本不足一律回退静态顺序（绝不因统计数据故障影响用户请求）；
   * - 候选集合本身不变：返回的是入参中的同一批 Agent 实例，工具集/版本/权限语义零变化；
   * - 归因键 = Agent 主键 id（= AgentRun.agentId），非实例 id（media Agent 实例 id 为 slug）。
   */
  private async rankedFirst(
    candidates: Array<{ slug: string; agent: Agent }>,
    config: unknown,
  ): Promise<Agent> {
    const ranking: PerformanceRankingConfig = parsePerformanceRanking(config);
    let stats: AgentPerformanceStat[] = [];
    try {
      stats = await loadAgentPerformance(this.prisma, { days: ranking.windowDays });
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'Agent 表现数据读取失败 → 回退静态顺序（表现数据仅作排序建议）');
      return candidates[0].agent;
    }
    const selected = rankByAgentPerformance(candidates, {
      agentId: (candidate) => this.agentIds.get(candidate.slug) ?? candidate.agent.id,
      stats,
      minSamples: ranking.minSamples,
    })[0];
    if (selected.slug !== candidates[0].slug) {
      this.logger.debug({ intentCandidates: candidates.map((c) => c.slug), selected: selected.slug }, 'Agent 候选按表现重排（仅顺序）');
    }
    return selected.agent;
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
          engine: this.engine, context: this.context,
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
