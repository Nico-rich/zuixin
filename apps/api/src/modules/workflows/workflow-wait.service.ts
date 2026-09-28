import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { WAIT_MAX_MS, WorkflowContext, WorkflowStepDef, renderTemplate } from './workflow-types';

/** 等待计划（解析后的确定性事实；绝不依赖内存：期限一律落库） */
export type WaitPlan =
  | { kind: 'time'; untilMs: number }
  | { kind: 'agent_run'; childRunId: string };

/** 从步骤行 output 解析已落库的等待期限（等待中）——非法/缺失 → null */
export function parseWaitingUntil(rowOutput: unknown): number | null {
  if (!rowOutput || typeof rowOutput !== 'object') return null;
  const raw = (rowOutput as { waitingUntil?: unknown }).waitingUntil;
  if (typeof raw !== 'string') return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * M9-P4 Wait 条件解析/判定（**纯逻辑，无 IO**；落库与唤醒由执行器/唤醒服务承担）。
 *
 * 不变量：
 * - 等待条件三选一（untilMs / untilIso / childRunId），由 DTO + validateDefinition 双重保证；
 * - 相对时长（untilMs）只在**首次进入**时换算为绝对期限，之后一律从步骤行 `output.waitingUntil` 恢复
 *   ——崩溃恢复绝不重新计时（否则反复重启即可无限等待）；
 * - 期限判定 `now >= untilMs`：到期即前进（绝不早退，也绝不"提前唤醒就重算"）。
 */
@Injectable()
export class WorkflowWaitService {
  /** 解析等待条件（模板渲染 + 校验）；非法 → AppError(VALIDATION_ERROR) */
  resolve(def: NonNullable<WorkflowStepDef['wait']>, ctx: WorkflowContext, now: number = Date.now()): WaitPlan {
    if (def.childRunId) {
      const childRunId = renderTemplate(def.childRunId, ctx).trim();
      if (!childRunId) throw new AppError(ErrorCode.VALIDATION_ERROR, 'wait.childRunId 渲染结果为空');
      return { kind: 'agent_run', childRunId };
    }
    if (def.untilIso) {
      const until = Date.parse(def.untilIso);
      if (!Number.isFinite(until)) throw new AppError(ErrorCode.VALIDATION_ERROR, `wait.untilIso 非法: ${def.untilIso}`);
      return { kind: 'time', untilMs: until };
    }
    if (def.untilMs != null) {
      if (!Number.isFinite(def.untilMs) || def.untilMs < 0 || def.untilMs > WAIT_MAX_MS) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, `wait.untilMs 非法（0 ~ ${WAIT_MAX_MS}）`);
      }
      return { kind: 'time', untilMs: now + def.untilMs };
    }
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'wait 步骤缺少等待条件（untilMs/untilIso/childRunId 三选一）');
  }

  /** 从既有步骤行恢复期限（崩溃恢复：绝不重新计时）；无有效记录 → null（按首次进入处理） */
  persistedDeadline(rowOutput: unknown): number | null {
    return parseWaitingUntil(rowOutput);
  }

  /** 期限已到（now >= untilMs） */
  isDue(untilMs: number, now: number = Date.now()): boolean {
    return now >= untilMs;
  }

  /** 剩余等待毫秒（用于延迟唤醒调度；<= 0 表示已到期） */
  remaining(untilMs: number, now: number = Date.now()): number {
    return untilMs - now;
  }
}
