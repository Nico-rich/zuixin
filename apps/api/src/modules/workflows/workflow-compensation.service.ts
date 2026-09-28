import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { COMPENSATABLE_TYPES, WorkflowDefinition, WorkflowStepDef } from './workflow-types';

/** 步骤行事实（补偿判定只依赖 DB 事实，绝不依赖内存） */
export interface StepRowFact {
  stepIndex: number;
  stepId: string;
  status: string;
  attempt: number;
  output?: unknown;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface CompensationPlanItem {
  /** 失败前已成功的步骤（补偿的"被撤销对象"） */
  targetStepId: string;
  targetStepIndex: number;
  compensateStepId: string;
  /** 补偿步骤在定义中的下标 = 其幂等锚点行（UNIQUE(runId,stepIndex)） */
  compensateStepIndex: number;
}

export interface CompensationRecord {
  /** 被补偿的已成功步骤 id */
  stepId: string;
  compensateStepId: string;
  /** 补偿锚点行下标 */
  stepIndex: number;
  status: 'completed' | 'failed' | 'skipped';
  errorCode?: string;
  errorMessage?: string;
}

/**
 * M9-P4 Compensation（saga 逆序补偿；**幂等锚点 = 步骤行**）：
 *
 * 语义：
 * - 触发：某步骤**非瞬态失败**（重试耗尽后仍失败）→ 对"已成功且声明了 compensate 的步骤"按 stepIndex **逆序**执行补偿；
 * - 幂等：补偿复用被引用步骤自身的 `UNIQUE(runId, stepIndex)` 锚点行 + 同一副作用幂等键（执行器按 stepIndex 生成）
 *   ——锚点行已 completed → **跳过，绝不重复执行副作用**（崩溃在 finalize 之前重放时同样成立）；
 * - 失败容错：补偿步骤自身失败只**记录**（行 failed + 记录进 run.output）→ 继续下一条，**绝不重试/绝不无限重试**；
 * - 中止（lease fencing）：signal 已中止 → 不执行、不写任何行（该 run 归新 owner，绝不分叉）；
 * - 补偿步骤类型收敛为可单独执行的单一动作（tool / external_action）——写副作用仍走既有外部动作体系
 *   （审批绑定 + 幂等键 + 审计），绝不新增绕过路径。
 */
@Injectable()
export class WorkflowCompensationService {
  private readonly logger = new Logger('WorkflowCompensation');

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 补偿计划：已成功（completed）步骤中声明了 compensate 的步骤，按 stepIndex **逆序** */
  plan(def: WorkflowDefinition, rows: readonly StepRowFact[]): CompensationPlanItem[] {
    const items: CompensationPlanItem[] = [];
    for (const row of [...rows].sort((a, b) => b.stepIndex - a.stepIndex)) {
      if (row.status !== 'completed') continue;
      const step = def.steps.find((s) => s.id === row.stepId);
      if (!step?.compensate) continue;
      const index = def.steps.findIndex((s) => s.id === step.compensate);
      if (index < 0) continue; // 定义校验已拦；此处防御性跳过
      items.push({
        targetStepId: step.id, targetStepIndex: row.stepIndex,
        compensateStepId: step.compensate, compensateStepIndex: index,
      });
    }
    return items;
  }

  /**
   * 执行补偿链（幂等；单条失败不影响其余）。
   * @param invoke 由执行器注入的"单步执行"回调（依赖倒置——避免 executor ↔ compensation 循环依赖）
   */
  async run(input: {
    runId: string;
    def: WorkflowDefinition;
    rows: readonly StepRowFact[];
    signal?: AbortSignal;
    invoke: (step: WorkflowStepDef, stepIndex: number) => Promise<unknown>;
  }): Promise<CompensationRecord[]> {
    const items = this.plan(input.def, input.rows);
    const records: CompensationRecord[] = [];
    for (const item of items) {
      const row = input.rows.find((r) => r.stepIndex === item.compensateStepIndex);
      // 幂等：锚点行已 completed → 该补偿的副作用**早已发生**（同一幂等键），绝不重复执行
      if (row?.status === 'completed') {
        records.push(this.record(item, 'completed'));
        continue;
      }
      const step = input.def.steps[item.compensateStepIndex];
      if (!step || !COMPENSATABLE_TYPES.includes(step.type)) {
        records.push(this.record(item, 'failed', ErrorCode.VALIDATION_ERROR, `补偿步骤定义缺失或类型不支持: ${item.compensateStepId}`));
        continue;
      }
      if (input.signal?.aborted) {
        records.push(this.record(item, 'skipped', ErrorCode.AGENT_CANCELLED, '执行已中止（lease fencing）'));
        break; // 已被接管：不执行、不写任何行（终态与补偿记录由新 owner 续跑）
      }
      try {
        const output = await input.invoke(step, item.compensateStepIndex);
        if (input.signal?.aborted) {
          records.push(this.record(item, 'skipped', ErrorCode.AGENT_CANCELLED, '执行已中止（lease fencing）'));
          break; // 中止后绝不落行（避免与新 owner 的写入竞争）
        }
        await this.writeRow(input.runId, item, row, {
          status: 'completed', output: (output ?? null) as never, completedAt: new Date(),
        });
        records.push(this.record(item, 'completed'));
      } catch (err) {
        if (input.signal?.aborted) {
          records.push(this.record(item, 'skipped', ErrorCode.AGENT_CANCELLED, '执行已中止（lease fencing）'));
          break;
        }
        const appErr = err instanceof AppError ? err : new AppError(ErrorCode.INTERNAL, (err as Error).message);
        // 补偿失败：记录 + 继续下一条（绝不重试——补偿是"尽力而为的回滚"，反复重试会放大副作用风险）
        await this.writeRow(input.runId, item, row, {
          status: 'failed', errorCode: appErr.code, errorMessage: appErr.message, completedAt: new Date(),
        });
        records.push(this.record(item, 'failed', appErr.code, appErr.message));
        this.logger.warn(
          { runId: input.runId, stepId: item.compensateStepId, errorCode: appErr.code },
          '补偿步骤失败（已记录，绝不重试）',
        );
      }
    }
    if (records.length > 0) {
      this.logger.warn({ runId: input.runId, count: records.length }, '补偿链执行完成');
    }
    return records;
  }

  private record(item: CompensationPlanItem, status: CompensationRecord['status'], errorCode?: string, errorMessage?: string): CompensationRecord {
    return {
      stepId: item.targetStepId, compensateStepId: item.compensateStepId, stepIndex: item.compensateStepIndex,
      status, ...(errorCode ? { errorCode } : {}), ...(errorMessage ? { errorMessage } : {}),
    };
  }

  /** 锚点行写入（stepType='compensation' 留痕；行复用——绝不新建第二行） */
  private async writeRow(
    runId: string,
    item: CompensationPlanItem,
    row: StepRowFact | undefined,
    data: Record<string, unknown>,
  ): Promise<void> {
    const payload = { stepType: 'compensation', attempt: (row?.attempt ?? 0) + 1, ...data };
    if (row) {
      await this.prisma.workflowStepRun.update({
        where: { workflowRunId_stepIndex: { workflowRunId: runId, stepIndex: item.compensateStepIndex } },
        data: payload as never,
      });
      return;
    }
    await this.prisma.workflowStepRun.create({
      data: {
        workflowRunId: runId, stepId: item.compensateStepId, stepIndex: item.compensateStepIndex,
        startedAt: new Date(), ...payload,
      } as never,
    });
  }
}
