import { createHash } from 'node:crypto';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/**
 * Pre-M9 Approval Binding：审批必须绑定**具体动作**（不是只绑 run/工具调用行）。
 *
 * 威胁：审批记录原本只说明"某个 run 的某次工具调用被批准了"。真正执行时的动作来自另一处事实
 * （引擎 resume 时 LLM 给出的参数、工作流里另一个步骤解析出的载荷、外部动作调用方传入的 payload），
 * 二者之间没有任何校验 → 审批通过 A 动作、实际执行 B 动作（金额/收件人/目标/被删资源被替换）即为越权。
 * 更极端：工作流里"审批步骤"与"外部动作步骤"完全解耦，任何审批都能"解锁"任意后续写操作。
 *
 * 设计（不新增表/列——`Approval.payload` 是 JSON）：
 *   payload = { ...业务字段, __binding: { actionType, payloadHash, boundAt } }
 *   payloadHash = sha256(stableStringify(action))  ← 稳定序列化：对象键排序、数组保序、undefined 剔除
 * 执行前三处（引擎审批门 / 工作流审批步骤 / external-actions.verifyApproval）都调用本文件的
 * `assertApprovalBinding` 重算并比对，**任何缺失或不一致 → 拒绝执行**（APPROVAL_BINDING_MISMATCH）。
 *
 * 单一实现原则：本文件是 binding 的唯一读写/校验入口（三处共用，绝不各写一份）。
 * 向后兼容：升级前创建的审批没有 `__binding` → 一律拒绝执行（fail-closed；重新发起审批即可恢复）。
 */

/** 嵌入 payload 的绑定字段名 */
export const APPROVAL_BINDING_KEY = '__binding';

export interface ApprovalBinding {
  /** 动作类型（引擎=工具名；工作流=步骤 id；外部动作=actionType） */
  actionType: string;
  /** 稳定序列化后动作载荷的 sha256（hex） */
  payloadHash: string;
  /** 绑定时刻（ISO；审计用，不参与比较） */
  boundAt: string;
}

/** 稳定序列化：对象键排序 + 数组保序 + undefined 剔除（与键顺序/空白无关，跨进程可复算） */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return 'null'; // 函数/symbol 等不可序列化值：统一为 null（不参与语义）
}

/** 动作载荷摘要（sha256 hex） */
export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/** 构造绑定 */
export function buildBinding(actionType: string, action: unknown, now: Date = new Date()): ApprovalBinding {
  return { actionType, payloadHash: hashPayload(action), boundAt: now.toISOString() };
}

/** 把绑定嵌入 payload（返回新对象，绝不修改入参） */
export function bindPayload(
  payload: Record<string, unknown> | null | undefined,
  actionType: string,
  action: unknown,
  now: Date = new Date(),
): Record<string, unknown> {
  return { ...(payload ?? {}), [APPROVAL_BINDING_KEY]: buildBinding(actionType, action, now) };
}

/** 读取绑定（缺失/结构非法 → null；由 assertApprovalBinding 统一拒绝） */
export function readBinding(payload: unknown): ApprovalBinding | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>)[APPROVAL_BINDING_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { actionType, payloadHash, boundAt } = raw as Record<string, unknown>;
  if (typeof actionType !== 'string' || actionType === '' || typeof payloadHash !== 'string' || payloadHash === '') return null;
  return { actionType, payloadHash, boundAt: typeof boundAt === 'string' ? boundAt : '' };
}

/**
 * 执行前校验：重算 `hashPayload(action)` 并与审批内绑定逐项比对；不一致/缺失一律拒绝执行。
 * @throws AppError(APPROVAL_BINDING_MISMATCH)
 */
export function assertApprovalBinding(input: { payload: unknown; actionType: string; action: unknown; reason?: string }): void {
  const label = input.reason ? `（${input.reason}）` : '';
  const binding = readBinding(input.payload);
  if (!binding) {
    throw new AppError(
      ErrorCode.APPROVAL_BINDING_MISMATCH,
      `审批未绑定具体动作，拒绝执行${label}`,
    );
  }
  if (binding.actionType !== input.actionType) {
    throw new AppError(
      ErrorCode.APPROVAL_BINDING_MISMATCH,
      `审批绑定的动作类型不一致（批准=${binding.actionType}，实际=${input.actionType}），拒绝执行${label}`,
    );
  }
  const actualHash = hashPayload(input.action);
  if (actualHash !== binding.payloadHash) {
    throw new AppError(
      ErrorCode.APPROVAL_BINDING_MISMATCH,
      `审批绑定的载荷摘要不一致（批准=${binding.payloadHash.slice(0, 12)}…，实际=${actualHash.slice(0, 12)}…），拒绝执行${label}`,
    );
  }
}

/**
 * 统一审批判定（**按权限分类**，不再只看 external_action 或单看 requiresApproval）：
 * financial / destructive / external_action 三类工具一律需要人工审批。
 */
export const APPROVAL_REQUIRED_PERMISSIONS: readonly string[] = ['external_action', 'financial', 'destructive'];

export function requiresHumanApproval(tool: { permission?: string | null; requiresApproval?: boolean | null }): boolean {
  if (tool.requiresApproval) return true;
  return typeof tool.permission === 'string' && APPROVAL_REQUIRED_PERMISSIONS.includes(tool.permission);
}
