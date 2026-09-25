/**
 * M8-P7 能力匹配（纯函数）：
 * - `models.capabilities` 显式声明 true → 命中（任意能力）；
 * - 显式声明类能力（function_calling / vision）**只认显式声明**——llm 类型不等于会调工具/能读图；
 * - 其余能力按模型类型兜底匹配（llm/image/video/embedding）。
 * 平台级声明（ProviderCapability 行）由调用方另行并入，不在此处推断。
 */
import { ModelType } from '@prisma/client';
import { CAPABILITY_MODEL_KEYS, CAPABILITY_MODEL_TYPES, EXPLICIT_ONLY_CAPABILITIES, RoutingCapability } from './provider-routing.types';

export interface MatchableModel {
  id: string;
  type: ModelType;
  capabilities: unknown;
  enabled?: boolean;
}

/** models.capabilities[key] === true */
export function declaresCapabilityKey(capabilities: unknown, capability: RoutingCapability): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const bag = capabilities as Record<string, unknown>;
  return CAPABILITY_MODEL_KEYS[capability].some((key) => bag[key] === true);
}

/** 该模型是否支持某能力（enabled=false 一律不支持） */
export function modelSupports(model: MatchableModel, capability: RoutingCapability): boolean {
  if (model.enabled === false) return false;
  if (declaresCapabilityKey(model.capabilities, capability)) return true;
  if (EXPLICIT_ONLY_CAPABILITIES.includes(capability)) return false;
  return CAPABILITY_MODEL_TYPES[capability].includes(model.type);
}
