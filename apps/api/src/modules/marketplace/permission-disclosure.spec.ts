import { describe, it, expect } from 'vitest';
import { DISCLOSURE_POLICY, buildPermissionDisclosure } from './permission-disclosure';
import { ExtensionManifest } from '../extensions/manifest';

/**
 * M9-P6 权限披露单测（**只读展示投影**）：
 * - 复用 Pre-M9 F4 的唯一实现（resolveEffectiveAgentTools）——断言披露结果与 F4 口径逐字一致；
 * - 披露**只减不增**：平台注册表中不存在 / 权限面不可包装（external_action/destructive/financial）/
 *   ext.* 扩展链 / 权限域越界 → 必被剔除且带稳定原因码；
 * - 披露对象恒带 readOnly=true 与 policy 文案（防消费方误读为"授权"）；
 * - **与本模块其余部分无数据通路**：评分/审核/安装量不参与计算（输入里根本没有这些字段）。
 */
const REGISTRY: Record<string, { permission: string }> = {
  'knowledge.search': { permission: 'read' },
  'feedback.create': { permission: 'write' },
  'image.generate': { permission: 'generate' },
  'external.action': { permission: 'external_action' },
  'artifact.delete': { permission: 'destructive' },
};
const lookup = (name: string) => REGISTRY[name] as never;

function agentManifest(tools: string[]): ExtensionManifest {
  return {
    manifestVersion: 1, kind: 'agent', permissions: ['agent.run'],
    agent: { name: 'a', description: 'd', systemPrompt: 'p', tools },
  } as unknown as ExtensionManifest;
}

describe('buildPermissionDisclosure（M9-P6 权限披露）', () => {
  it('agent 类：请求 ∩ 注册表 ∩ 可包装面 → effective；越权请求全部被剔除并带原因', () => {
    const disclosure = buildPermissionDisclosure({
      kind: 'agent',
      manifest: agentManifest(['knowledge.search', 'feedback.create', 'image.generate', 'external.action', 'artifact.delete', 'ghost.tool', 'ext.other.tool']),
      declaredPermissions: [{ name: 'agent.run', scope: 'organization', description: null }],
      lookup,
    });
    expect(disclosure.readOnly).toBe(true);
    expect(disclosure.policy).toBe(DISCLOSURE_POLICY);
    expect(disclosure.requestedTools).toHaveLength(7);
    expect(disclosure.effectiveTools).toEqual(['knowledge.search', 'feedback.create', 'image.generate']);
    const reasons = Object.fromEntries(disclosure.droppedTools.map((d) => [d.name, d.reason]));
    expect(reasons['external.action']).toBe('tool_permission_not_wrappable');
    expect(reasons['artifact.delete']).toBe('tool_permission_not_wrappable');
    expect(reasons['ghost.tool']).toBe('platform_tool_not_registered');
    expect(reasons['ext.other.tool']).toBe('extension_chain_forbidden');
  });

  it('声明权限域越界 → 一律不授予任何工具（fail-closed，绝不部分放行）', () => {
    const disclosure = buildPermissionDisclosure({
      kind: 'agent',
      manifest: agentManifest(['knowledge.search']),
      declaredPermissions: [{ name: 'provider.call', scope: 'organization', description: null }],
      lookup,
    });
    expect(disclosure.effectiveTools).toEqual([]);
    expect(disclosure.droppedTools[0].reason).toBe('extension_policy_denied');
  });

  it('tool 类：披露被包装的 baseTool 及其平台权限位与可包装性（不产生工具请求面）', () => {
    const disclosure = buildPermissionDisclosure({
      kind: 'tool',
      manifest: {
        manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'],
        tool: { name: 'ext.x.search', description: 'd', baseTool: 'knowledge.search' },
      } as unknown as ExtensionManifest,
      declaredPermissions: [{ name: 'tool.execute', scope: 'organization', description: '只读检索' }],
      lookup,
    });
    expect(disclosure.wrappedTool).toEqual({
      name: 'ext.x.search', baseTool: 'knowledge.search', baseToolPermission: 'read', wrappable: true,
    });
    expect(disclosure.requestedTools).toEqual([]);
    expect(disclosure.effectiveTools).toEqual([]);
    expect(disclosure.declaredPermissions[0]).toEqual({ name: 'tool.execute', scope: 'organization', description: '只读检索' });
  });

  it('tool 类 baseTool 不可包装或未注册 → wrappable=false（平台绝不放行该包装）', () => {
    for (const [baseTool, permission] of [['artifact.delete', 'destructive'], ['ghost.tool', null]] as const) {
      const disclosure = buildPermissionDisclosure({
        kind: 'tool',
        manifest: {
          manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'],
          tool: { name: 'ext.x.w', description: 'd', baseTool },
        } as unknown as ExtensionManifest,
        declaredPermissions: [],
        lookup,
      });
      expect(disclosure.wrappedTool?.wrappable).toBe(false);
      expect(disclosure.wrappedTool?.baseToolPermission).toBe(permission);
    }
  });

  it('provider / workflow_step 类：无工具面，仅披露声明权限（不臆造工具清单）', () => {
    for (const kind of ['provider', 'workflow_step'] as const) {
      const disclosure = buildPermissionDisclosure({
        kind,
        manifest: { manifestVersion: 1, kind, permissions: [] } as unknown as ExtensionManifest,
        declaredPermissions: [{ name: 'config.read', scope: 'organization', description: null }],
        lookup,
      });
      expect(disclosure.wrappedTool).toBeNull();
      expect(disclosure.requestedTools).toEqual([]);
      expect(disclosure.droppedTools).toEqual([]);
    }
  });

  it('脏数据防御：kind 与定义块缺失 → 空清单且不抛错（读路径绝不因历史行 500）', () => {
    const disclosure = buildPermissionDisclosure({
      kind: 'agent',
      manifest: { manifestVersion: 1, kind: 'agent', permissions: ['agent.run'] } as unknown as ExtensionManifest,
      declaredPermissions: [],
      lookup,
    });
    expect(disclosure.effectiveTools).toEqual([]);
    expect(disclosure.requestedTools).toEqual([]);
  });

  it('披露是纯投影：不修改入参 manifest/权限行（只读语义的机械保证）', () => {
    const manifest = agentManifest(['knowledge.search', 'external.action']);
    const frozen = JSON.parse(JSON.stringify(manifest));
    const declared = [{ name: 'agent.run' as const, scope: 'organization', description: null }];
    buildPermissionDisclosure({ kind: 'agent', manifest, declaredPermissions: declared, lookup });
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(frozen);
    expect(declared).toHaveLength(1);
  });
});
