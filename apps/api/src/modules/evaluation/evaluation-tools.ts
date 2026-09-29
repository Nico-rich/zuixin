/**
 * M12-P4 评测工具能力（**纯函数**：入参出参皆数据，便于单测）。
 *
 * 审计事实：M9 起 `EvaluationRunnerService` **完全不传 tools**（"不传 tools：评测绝不执行工具"），
 * 于是带工具的 Agent 无法被评测——模型不知道有哪些工具，rule 评测器的 `tool_called(name)` 永远不成立。
 *
 * 本文件定义评测面的工具裁决（三条闸门，任一不过 → 400，绝不静默降级）：
 * 1. **权限子集**：请求的工具必须 ⊆ AgentVersion.tools——**绝不下发超越 Agent 权限的工具**
 *    （AgentVersion 的工具清单是该 Agent 的能力边界，评测不得扩权）；
 * 2. **注册存在**：必须已在 ToolRegistry 注册（未注册 = 不可评测，绝不"静默丢弃后照样跑"）；
 * 3. **模型能力**：模型声明 `functionCalling === false` 时拒绝（与 Agent 引擎 MUST-3 同口径——
 *    能力不支持时不下发工具，而评测里"悄悄不下发"等于评测结论失真，故显式拒绝）。
 *
 * 语义边界：本函数只**声明**工具（返回冻结的 wire 定义），**绝不执行**——执行面在 runner，
 * runner 无 ToolRegistry 依赖（结构上不可能执行工具）。
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import { ToolRegistry } from '../../core/tools/tool-registry.service';
import { ToolDefinitionWire } from '../../providers/llm/llm.types';
import { AppError, ErrorCode } from '../../common/errors/app-error';

export interface EvaluationToolPlan {
  /** 实际下发给模型的工具名（去重后；恒为 AgentVersion.tools 的子集） */
  tools: string[];
  /** 冻结的工具定义（写入 configSnapshot；runner 只读） */
  definitions: ToolDefinitionWire[];
}

export function resolveEvaluationTools(input: {
  registry: ToolRegistry;
  /** 客户端声明的工具白名单（缺省空 = 不下发任何工具，M9 行为保持） */
  requested: readonly string[];
  /** AgentVersion 声明的工具清单（权限边界） */
  allowedAgentTools: readonly string[];
  /** 目标模型声明的能力（null = 创建期未知，交由执行期能力闸门兜底） */
  capabilities?: Record<string, unknown> | null;
}): EvaluationToolPlan {
  const tools = [...new Set(input.requested)];
  if (tools.length === 0) return { tools: [], definitions: [] };

  const beyond = tools.filter((t) => !input.allowedAgentTools.includes(t));
  if (beyond.length > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `工具不在 Agent 版本允许清单内：${beyond.join('、')}`);
  }
  const missing = tools.filter((t) => !input.registry.has(t));
  if (missing.length > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `工具未注册：${missing.join('、')}`);
  }
  if (input.capabilities && input.capabilities['functionCalling'] === false) {
    // HTTP 契约：这是**客户端可自行修正**的请求（换模型或去掉 tools）→ 400（UNSUPPORTED_PARAMETER）。
    // 执行期的同一条件仍用 NO_TOOL_CAPABILITY 记为 case 终态（与 Agent 引擎的 MUST-3 同口径）——
    // 两个码的差异只在层次（请求期 vs 执行期），语义同一：**绝不静默不下发工具后照跑**。
    throw new AppError(ErrorCode.UNSUPPORTED_PARAMETER, '所选模型声明不支持工具调用，无法评测带工具的 Agent');
  }

  const definitions = input.registry.listForAgent(tools).map((t): ToolDefinitionWire => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.inputSchema as never) as Record<string, unknown>,
    },
  }));
  return { tools, definitions };
}
