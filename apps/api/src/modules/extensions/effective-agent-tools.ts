import type { ToolPermission } from '../../core/tools/tool.types';
import {
  ExtensionKind, ExtensionPermissionName, KIND_PERMISSION_SCOPE, KIND_REQUIRED_PERMISSION, WRAPPABLE_TOOL_PERMISSIONS,
} from './manifest';

/**
 * Pre-M9 F4：kind=agent 扩展的**唯一一处** effective tools 计算（权限提升防线）。
 *
 * 语义（交集，绝不并集——清单自声明永远是"请求"，不是"授权"）：
 *   effective = 请求清单 ∩ 平台工具注册表（存在且已注册） ∩ 扩展可获得的工具权限面（read/write/generate）
 *               ∩ 扩展/组织策略面（扩展已声明权限 + 可选组织级工具策略）
 *
 * 由此保证：
 * - external_action / destructive / financial（以及任何非 read/write/generate 面）的工具**绝不因 manifest 自声明而获得**：
 *   平台管理员通过"注册表 + 权限位"掌握授权控制面，扩展清单只能在其内做减集；
 * - 未知/已下线的工具名、ext.* 扩展链、组织策略未放行的工具一律剔除（**剔除方向唯一：只减不增**）；
 * - 声明权限绝不扩张工具集：多声明权限（或声明配置类权限）不来带任何工具。
 *
 * 返回被剔除清单（含原因）供调用方审计（logger.warn）与持久化（AgentVersion.config 既有 JSON 列）。
 */

/** agent 类扩展可获得的工具权限面：只读/写入/生成（破坏性/财务/外部副作用/凭证/工作流变更一律不可获得） */
export const AGENT_TOOL_PERMISSION_FACE: readonly string[] = WRAPPABLE_TOOL_PERMISSIONS;

/** 本计算只服务 kind=agent（kind=tool 的 baseTool 走 requirePlatformTool 的既有拒绝契约） */
const AGENT_KIND: ExtensionKind = 'agent';

/** 剔除原因（稳定枚举值：日志/持久化/测试断言共用） */
export type DroppedToolReason =
  /** 平台注册表中不存在（未注册或已下线） */
  | 'platform_tool_not_registered'
  /** 工具权限面不在扩展可获得面（external_action/destructive/financial 等） */
  | 'tool_permission_not_wrappable'
  /** 扩展链（禁止引用其它扩展工具） */
  | 'extension_chain_forbidden'
  /** 组织级工具策略未放行 */
  | 'org_policy_denied'
  /** 扩展策略面不成立（权限域越界 / 缺核心权限）→ 不得获得任何工具 */
  | 'extension_policy_denied';

export interface DroppedTool {
  name: string;
  reason: DroppedToolReason;
  /** 人类可读原因（中文），用于日志/拒绝消息 */
  detail: string;
}

/** 平台工具注册表查询（唯一事实源：工具是否存在 + 其权限位） */
export type PlatformToolLookup = (name: string) => { permission: ToolPermission } | undefined;

export interface EffectiveAgentToolsInput {
  /** 审计标识（扩展 id 或 slug） */
  extensionId: string;
  /** manifest 请求清单（声明） */
  requested: readonly string[];
  /** 扩展已声明的平台权限（扩展/组织策略面；只能收紧，绝不扩张工具集） */
  declaredPermissions: readonly ExtensionPermissionName[];
  /** 平台工具注册表查询 */
  lookup: PlatformToolLookup;
  /** 组织级工具策略（当前仓库无该表/列 → 生产调用不传 = 无额外限制；保留该维度供未来策略接入，不新增表/列） */
  orgAllowlist?: readonly string[];
  /** 剔除审计回调（调用方接 logger.warn） */
  onDropped?: (drop: DroppedTool) => void;
}

export interface EffectiveAgentTools {
  /** 真正可写入 Agent.tools 的清单（交集结果） */
  tools: string[];
  /** 被剔除清单（含原因；空数组 = 清单完全在授权面内） */
  dropped: DroppedTool[];
}

/**
 * 计算 kind=agent 扩展的 effective tools（唯一实现；install / setEnabled / materializeAgent 三条路径共用）。
 * 纯函数：不触库、不写库，只依赖平台注册表查询 + 扩展声明权限。
 */
export function resolveEffectiveAgentTools(input: EffectiveAgentToolsInput): EffectiveAgentTools {
  const tools: string[] = [];
  const dropped: DroppedTool[] = [];
  const drop = (name: string, reason: DroppedToolReason, detail: string): void => {
    const item: DroppedTool = { name, reason, detail };
    dropped.push(item);
    input.onDropped?.(item);
  };

  // 策略面（扩展声明权限）：kind 权限域复核 + 核心权限必须声明（越界/缺失 → 该扩展不得获得任何工具）
  const scope = KIND_PERMISSION_SCOPE[AGENT_KIND] as readonly string[];
  const outOfScope = input.declaredPermissions.filter((p) => !scope.includes(p));
  const missingCore = !input.declaredPermissions.includes(KIND_REQUIRED_PERMISSION[AGENT_KIND]);
  const policyDetail = outOfScope.length
    ? `扩展声明了 kind=${AGENT_KIND} 权限域外的权限：${outOfScope.join(', ')}`
    : `扩展未声明 kind=${AGENT_KIND} 核心权限 ${KIND_REQUIRED_PERMISSION[AGENT_KIND]}`;

  const seen = new Set<string>();
  for (const raw of input.requested) {
    // 防御 DB 脏数据（历史/篡改行可能含非字符串项）：归一化为审计可读文本，绝不因脏数据抛错
    const name = typeof raw === 'string' ? raw.trim() : String(raw ?? '');
    if (seen.has(name)) continue; // 重复声明只按首次出现处理（去重不是安全事件，不记剔除）
    seen.add(name);
    if (!name) {
      drop(name, 'platform_tool_not_registered', '工具名为空');
      continue;
    }
    // ① 扩展/组织策略面：声明权限域越界或缺核心权限 → 一律不授予（fail-closed，绝不"部分放行"）
    if (outOfScope.length || missingCore) {
      drop(name, 'extension_policy_denied', policyDetail);
      continue;
    }
    // ② 禁止扩展链（ext.* 不得出现在 agent 工具清单中）
    if (name.startsWith('ext.')) {
      drop(name, 'extension_chain_forbidden', '不得引用其它扩展工具（禁止扩展链）');
      continue;
    }
    // ③ 平台白名单：必须存在于平台工具注册表（未注册/已下线一律不授予）
    const tool = input.lookup(name);
    if (!tool) {
      drop(name, 'platform_tool_not_registered', '平台工具注册表中不存在（未注册或已下线）');
      continue;
    }
    // ④ 权限面：只读/写入/生成之外的权限（external_action/destructive/financial 等）绝不由清单自声明获得
    if (!AGENT_TOOL_PERMISSION_FACE.includes(tool.permission)) {
      drop(name, 'tool_permission_not_wrappable', `工具权限面 ${tool.permission} 不在扩展可获得面（${AGENT_TOOL_PERMISSION_FACE.join('/')}）`);
      continue;
    }
    // ⑤ 组织级工具策略（若接入）：未放行一律不授予
    if (input.orgAllowlist && !input.orgAllowlist.includes(name)) {
      drop(name, 'org_policy_denied', '组织级工具策略未放行该工具');
      continue;
    }
    tools.push(name);
  }
  return { tools, dropped };
}
