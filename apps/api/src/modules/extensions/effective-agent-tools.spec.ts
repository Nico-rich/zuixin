import { describe, it, expect, vi } from 'vitest';
import { AGENT_TOOL_PERMISSION_FACE, DroppedTool, resolveEffectiveAgentTools } from './effective-agent-tools';
import { ToolPermission } from '../../core/tools/tool.types';

/** 平台工具注册表替身（名字 → 权限位；未列出的名字 = 注册表中不存在） */
const PLATFORM_TOOLS: Record<string, ToolPermission> = {
  'knowledge.search': 'read',
  'artifact.create': 'write',
  'image.generate': 'generate',
  'external_action.execute': 'external_action',
  'external_action.demo': 'external_action',
  'billing.charge': 'financial',
  'db.drop': 'destructive',
};

const lookup = (name: string): { permission: ToolPermission } | undefined =>
  PLATFORM_TOOLS[name] ? { permission: PLATFORM_TOOLS[name] } : undefined;

function resolve(requested: readonly string[], over: Partial<Parameters<typeof resolveEffectiveAgentTools>[0]> = {}) {
  return resolveEffectiveAgentTools({
    extensionId: 'ext-1',
    requested,
    declaredPermissions: ['agent.run'],
    lookup,
    ...over,
  });
}

const reasonsOf = (dropped: DroppedTool[]): string[] => dropped.map((d) => d.reason);

/**
 * Pre-M9 F4：effective agent tools = 请求清单 ∩ 平台注册表 ∩ 可包装权限面 ∩ 扩展/组织策略面（交集，绝不并集）。
 * 关键不变量：external_action / destructive / financial 等权限面**绝不**因 manifest 自声明而获得。
 */
describe('F4 resolveEffectiveAgentTools（交集语义 / 权限提升防线）', () => {
  it('越权工具被剔除：external_action / financial / destructive 显式声明也不放行，合法工具仍在', () => {
    const r = resolve(['external_action.execute', 'external_action.demo', 'billing.charge', 'db.drop', 'knowledge.search', 'artifact.create']);
    expect(r.tools).toEqual(['knowledge.search', 'artifact.create']);
    expect(r.dropped.map((d) => d.name)).toEqual(['external_action.execute', 'external_action.demo', 'billing.charge', 'db.drop']);
    expect(new Set(reasonsOf(r.dropped))).toEqual(new Set(['tool_permission_not_wrappable']));
    // 原因文案必须点名权限面（审计可读）
    expect(r.dropped[0].detail).toContain('external_action');
    expect(r.dropped[2].detail).toContain('financial');
    expect(r.dropped[3].detail).toContain('destructive');
  });

  it('权限面全覆盖：read / write / generate 三类工具全部保留', () => {
    expect(AGENT_TOOL_PERMISSION_FACE).toEqual(['read', 'write', 'generate']);
    const r = resolve(['knowledge.search', 'artifact.create', 'image.generate']);
    expect(r.tools).toEqual(['knowledge.search', 'artifact.create', 'image.generate']);
    expect(r.dropped).toEqual([]);
  });

  it('未知工具名被剔除（平台注册表中不存在 / 已下线）', () => {
    const r = resolve(['knowledge.search', 'nope.tool', 'externalaction.execute']);
    expect(r.tools).toEqual(['knowledge.search']);
    expect(r.dropped.map((d) => d.name)).toEqual(['nope.tool', 'externalaction.execute']);
    expect(reasonsOf(r.dropped)).toEqual(['platform_tool_not_registered', 'platform_tool_not_registered']);
  });

  it('交集语义：清单声明的 permission 绝不能扩大工具集（多声明/配置类权限不带来任何工具）', () => {
    const base = resolve(['knowledge.search', 'external_action.execute'], { declaredPermissions: ['agent.run'] });
    const more = resolve(['knowledge.search', 'external_action.execute'], {
      declaredPermissions: ['agent.run', 'config.read', 'config.write'],
    });
    const less = resolve(['knowledge.search', 'external_action.execute'], { declaredPermissions: ['agent.run', 'config.read'] });
    expect(more.tools).toEqual(base.tools);
    expect(less.tools).toEqual(base.tools);
    expect(base.tools).not.toContain('external_action.execute');
    expect(more.dropped).toEqual(base.dropped);
  });

  it('扩展链：ext.* 工具一律剔除（禁止扩展自举提权）', () => {
    const r = resolve(['ext.other.search', 'knowledge.search']);
    expect(r.tools).toEqual(['knowledge.search']);
    expect(reasonsOf(r.dropped)).toEqual(['extension_chain_forbidden']);
  });

  it('策略面 fail-closed：缺 agent.run 核心权限 → 不得获得任何工具（即使工具本身合法）', () => {
    const r = resolve(['knowledge.search', 'artifact.create'], { declaredPermissions: ['config.read'] });
    expect(r.tools).toEqual([]);
    expect(reasonsOf(r.dropped)).toEqual(['extension_policy_denied', 'extension_policy_denied']);
    expect(r.dropped[0].detail).toContain('agent.run');
  });

  it('策略面 fail-closed：声明 kind=agent 权限域外的权限（如 provider.call）→ 不得获得任何工具', () => {
    const r = resolve(['knowledge.search'], { declaredPermissions: ['agent.run', 'provider.call'] as never });
    expect(r.tools).toEqual([]);
    expect(reasonsOf(r.dropped)).toEqual(['extension_policy_denied']);
    expect(r.dropped[0].detail).toContain('provider.call');
  });

  it('组织策略（预留维度）：orgAllowlist 未放行的剔除；放行的保留；缺省 = 无额外限制', () => {
    const denied = resolve(['knowledge.search', 'artifact.create'], { orgAllowlist: ['knowledge.search'] });
    expect(denied.tools).toEqual(['knowledge.search']);
    expect(reasonsOf(denied.dropped)).toEqual(['org_policy_denied']);
    // 缺省不传 → 无额外限制（当前仓库无组织级工具策略表）
    expect(resolve(['knowledge.search', 'artifact.create']).tools).toEqual(['knowledge.search', 'artifact.create']);
    // 组织策略只能收紧、不能扩张
    const expanded = resolve(['external_action.execute'], { orgAllowlist: ['external_action.execute'] });
    expect(expanded.tools).toEqual([]);
  });

  it('组织策略空名单（[]）：M10-P14 组织白名单的 fail-closed 表达 → 全部工具剔除（含合法工具）', () => {
    const r = resolve(['knowledge.search', 'artifact.create'], { orgAllowlist: [] });
    expect(r.tools).toEqual([]);
    expect(reasonsOf(r.dropped)).toEqual(['org_policy_denied', 'org_policy_denied']);
    expect(r.dropped[0].detail).toContain('组织白名单');
  });

  it('剔除审计回调：每条剔除恰好回调一次（含 extensionId 无关的 name/reason/detail）', () => {
    const onDropped = vi.fn();
    const r = resolve(['external_action.execute', 'nope.tool', 'knowledge.search'], { onDropped });
    expect(onDropped).toHaveBeenCalledTimes(2);
    expect(onDropped.mock.calls.map((c) => (c[0] as DroppedTool).name)).toEqual(['external_action.execute', 'nope.tool']);
    expect(onDropped.mock.calls.every((c) => typeof (c[0] as DroppedTool).detail === 'string')).toBe(true);
    expect(r.tools).toEqual(['knowledge.search']);
  });

  it('去重 + 顺序稳定 + 空清单：重复声明只保留首次（重复不是安全事件）；空名剔除', () => {
    const dup = resolve(['knowledge.search', 'knowledge.search', 'artifact.create']);
    expect(dup.tools).toEqual(['knowledge.search', 'artifact.create']);
    expect(dup.dropped).toEqual([]);
    const empty = resolve([]);
    expect(empty.tools).toEqual([]);
    expect(empty.dropped).toEqual([]);
    expect(resolve(['']).dropped.map((d) => d.reason)).toEqual(['platform_tool_not_registered']);
  });

  it('防御 DB 脏数据：非字符串项被剔除而非抛错（物化路径不得因历史脏数据崩溃）', () => {
    const r = resolve(['knowledge.search', 42, null] as never);
    expect(r.tools).toEqual(['knowledge.search']);
    expect(r.dropped.map((d) => d.name)).toEqual(['42', '']);
  });
});
