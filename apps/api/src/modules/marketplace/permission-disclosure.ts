/**
 * M9-P6 权限披露（**只读展示投影**——绝不授权、绝不物化、绝不执行任何内容）。
 *
 * 逐字复用 M8-P6 / Pre-M9 F4 的唯一判定实现：
 * - 声明权限清单来自 manifest（平台权限白名单内的名字，见 extensions/manifest.ts）；
 * - kind=agent 的 effective tools 由 `resolveEffectiveAgentTools`（唯一实现）现算：
 *     effective = 请求清单 ∩ 平台工具注册表 ∩ 可包装权限面（read/write/generate）∩ 声明权限策略面
 *   被剔除项连同稳定原因码一并披露（只减不增，方向唯一）；
 * - kind=tool 披露被包装的 baseTool 及其平台权限位（可包装 = read/write/generate；否则显式标注不可包装）。
 *
 * 与本模块其余部分的关系：**评分、审核状态、安装量都不进入本计算**。
 * 换言之"给多少星"与"扩展能用哪些工具"在代码上不存在任何数据通路
 * （e2e 断言：低分/高分同一扩展的 effectiveTools 与安装后 Agent.tools 恒等）。
 */

import { ToolPermission } from '../../core/tools/tool.types';
import { DroppedTool, resolveEffectiveAgentTools } from '../extensions/effective-agent-tools';
import { ExtensionKind, ExtensionManifest, ExtensionPermissionName } from '../extensions/manifest';

/** 平台工具注册表查询（唯一事实源：工具是否存在 + 其权限位）——与 F4 同签名 */
export type DisclosureToolLookup = (name: string) => { permission: ToolPermission } | undefined;

/** 声明权限行（来自 ExtensionPermission 表；仅用于展示描述/scope，不参与裁决） */
export interface DeclaredPermissionView {
  name: ExtensionPermissionName;
  scope: string;
  description: string | null;
}

export interface WrappedToolDisclosure {
  name: string;
  baseTool: string;
  /** baseTool 在平台注册表中的权限位（未注册 → null） */
  baseToolPermission: string | null;
  /** 是否落在扩展可包装面（read/write/generate）——false 表示平台根本不允许该包装 */
  wrappable: boolean;
}

export interface PermissionDisclosure {
  /** 恒定 true：本对象是展示投影，任何调用方**不得**据此放行工具（授权判定只有 extensions 一处） */
  readOnly: true;
  kind: ExtensionKind;
  /** 披露口径说明（供 Web 原样展示，避免用户误读为"授权范围"） */
  policy: string;
  declaredPermissions: DeclaredPermissionView[];
  /** manifest 自声明的工具请求（永远是"请求"，不是授权） */
  requestedTools: string[];
  /** 平台实际会授予的工具（交集结果；仅 kind=agent 非空） */
  effectiveTools: string[];
  /** 被平台剔除的请求（含稳定原因码）；空数组 = 请求完全落在授权面内 */
  droppedTools: DroppedTool[];
  /** kind=tool 的被包装平台工具（其余 kind 为 null） */
  wrappedTool: WrappedToolDisclosure | null;
}

export const DISCLOSURE_POLICY =
  '权限 = manifest 声明 ∩ 平台权限白名单 ∩ 平台工具注册表 ∩ 组织策略；评分/审核状态/安装量均不参与授权';

const WRAPPABLE: readonly string[] = ['read', 'write', 'generate'];

export interface BuildDisclosureInput {
  kind: ExtensionKind;
  manifest: ExtensionManifest;
  declaredPermissions: readonly DeclaredPermissionView[];
  lookup: DisclosureToolLookup;
}

/**
 * 现算披露（纯函数，无 IO、不触库、无副作用）。
 * 对历史/脏数据一律 fail-closed：缺失定义块 → 空清单，绝不抛错也绝不"猜测"放宽。
 */
export function buildPermissionDisclosure(input: BuildDisclosureInput): PermissionDisclosure {
  const { manifest, kind } = input;
  const declaredPermissions = input.declaredPermissions.map((p) => ({ ...p }));
  let requestedTools: string[] = [];
  let effectiveTools: string[] = [];
  let droppedTools: DroppedTool[] = [];
  let wrappedTool: WrappedToolDisclosure | null = null;

  if (kind === 'agent' && manifest.agent) {
    requestedTools = [...manifest.agent.tools];
    const resolved = resolveEffectiveAgentTools({
      extensionId: 'disclosure',
      requested: requestedTools,
      declaredPermissions: declaredPermissions.map((p) => p.name),
      lookup: input.lookup,
    });
    effectiveTools = resolved.tools;
    droppedTools = resolved.dropped;
  }

  if (kind === 'tool' && manifest.tool) {
    const base = input.lookup(manifest.tool.baseTool);
    wrappedTool = {
      name: manifest.tool.name,
      baseTool: manifest.tool.baseTool,
      baseToolPermission: base?.permission ?? null,
      wrappable: base ? WRAPPABLE.includes(base.permission) : false,
    };
  }

  return {
    readOnly: true,
    kind,
    policy: DISCLOSURE_POLICY,
    declaredPermissions,
    requestedTools,
    effectiveTools,
    droppedTools,
    wrappedTool,
  };
}
