/**
 * Agent 工具目录（前端常量，M13-W2）
 *
 * 事实源：`apps/api/src/core/tools/tools.module.ts` 的工厂注册处 + `apps/api/src/core/tools/builtin/*.ts`
 * 里每个 Tool 的 `name`（ToolRegistry 注册表）。**后端没有工具目录端点**——全仓 33 个 controller 中
 * 没有 tools controller（工具在 core/tools 内，只有运行时 `ToolRegistry.list()`，无 HTTP 面），
 * 所以这里用前端常量渲染多选清单，并在此登记同步义务：后端新增/改名工具时本清单需同步。
 *
 * 边界：本清单**只是 UI 可选项**，不是授权面。服务端 `ToolRegistry.listForAgent()` 按
 * AgentVersion.tools 取子集，未注册的名字被静默丢弃；扩展打包的动态工具名为 `ext.*`
 * （extensions.service 注册），不在本清单里——它们不会因此丢失，见 tool-picker.tsx。
 */
export interface AgentToolEntry {
  /** 工具名（= 后端 Tool.name，直接写入 AgentVersion.tools 数组） */
  name: string;
  /** 分组（仅用于 UI 归类，不是后端概念） */
  group: string;
}

export const AGENT_TOOL_CATALOG: readonly AgentToolEntry[] = [
  { name: 'image.generate', group: '媒体生成' },
  { name: 'video.generate', group: '媒体生成' },
  { name: 'knowledge.search', group: '知识' },
  { name: 'memory.create_candidate', group: '记忆' },
  { name: 'artifact.create', group: '制品' },
  { name: 'agent.delegate', group: '协作' },
  { name: 'feedback.submit', group: '反馈与绩效' },
  { name: 'performance.capture', group: '反馈与绩效' },
  { name: 'performance.insights', group: '反馈与绩效' },
  { name: 'commerce.analysis.generate', group: '商业分析' },
  { name: 'creativeBrief.create', group: '商业分析' },
  { name: 'commerce.products.list', group: '电商数据（只读）' },
  { name: 'commerce.products.get', group: '电商数据（只读）' },
  { name: 'commerce.orders.list', group: '电商数据（只读）' },
  { name: 'commerce.orders.summary', group: '电商数据（只读）' },
  { name: 'commerce.traffic.summary', group: '电商数据（只读）' },
  { name: 'commerce.ads.campaigns.list', group: '电商数据（只读）' },
  { name: 'commerce.ads.performance', group: '电商数据（只读）' },
  { name: 'commerce.analytics.summary', group: '电商数据（只读）' },
  { name: 'commerce.analytics.compare', group: '电商数据（只读）' },
  { name: 'external_action.execute', group: '外部动作（需审批）' },
  { name: 'external_action.demo', group: '外部动作（需审批）' },
];

/** 按分组聚合（保持清单顺序），供工具多选分组渲染 */
export function groupedToolCatalog(): Array<{ group: string; tools: AgentToolEntry[] }> {
  const groups: Array<{ group: string; tools: AgentToolEntry[] }> = [];
  for (const tool of AGENT_TOOL_CATALOG) {
    const last = groups[groups.length - 1];
    if (last && last.group === tool.group) last.tools.push(tool);
    else groups.push({ group: tool.group, tools: [tool] });
  }
  return groups;
}

/** 已知工具名集合（用于标注「版本里存在但目录未登记」的工具，如 ext.*） */
export function isKnownTool(name: string): boolean {
  return AGENT_TOOL_CATALOG.some((t) => t.name === name);
}

/** 把 AgentVersion.tools（unknown，可能是任意 JSON）安全收窄为字符串数组 */
export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}
