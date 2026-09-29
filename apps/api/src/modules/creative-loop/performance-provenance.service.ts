/**
 * M12-P1 绩效事实**来源判别**（审计 R1 最高项：堵死 agent 自证）。
 *
 * 威胁：`performance.capture` 是 **agent 可写工具**——一个被授权的 Agent 可以在自己的假设跑完观察窗后
 * 调它回传一组好看的数字，从而让"按判据自动判定"把假设判为 validated（LLM/Agent 实质决定了治理判定）。
 *
 * 修法（**零 schema 变更**，见 insight-rules.ts 的来源谓词说明）：`CreativePerformance` 无来源列，
 * 故来源信号取既有 **ToolCall 幂等账本**——agent 工具路径一律经 `withToolCallLedger` 把工具返回值
 * （含 `performanceId`）与副作用行**同事务**写入 `ToolCall.output`，HTTP 直调路径无 toolCallId（不记账本，
 * 也非 agent 工具面）。于是：
 *
 *   非 agent 来源行 = 在窗口事实里，且**未被任何 agent 工具账本引用**的 `CreativePerformance` 行。
 *
 * 完整性（本服务的关键不变量，**宁可拒绝自动判定也不放过伪造行**）：
 * - 账本枚举**不设时间下界**：工具调用可能在审批门等待很久后才落行（`startedAt` 早于事实窗口），
 *   若按下界裁剪就会漏掉伪造行（fail-open）。查询走既有 `@@index([toolName, startedAt])` 的
 *   倒序索引扫描 + `take` 上限，故**依然有界**，且只取"最近 N 次"（更早的调用只有在它能写下窗口内事实时
 *   才重要——那种情况必然伴随大量调用，被上限拦下 → 判定为**不可信**而非"干净"）；
 * - 枚举触到上限（`complete=false`）→ **一律 fail-closed**：调用方必须放弃按判据自动判定
 *   （绩效派生指标视同缺失 → `awaiting-facts`），只有人工显式 decision 才能推进（人工判定不依赖该谓词）；
 * - 只按 `userId` 收窄（工具调用归属 = AgentRun 归属），**绝不跨租户**读账本。
 *
 * 依赖（跨模块不变量，登记于本文件以便审计）：`feedback.tools.ts` 的 `performance.capture` 必须继续
 * 透传 `ctx.toolCallId`（引擎恒注入），否则账本引用消失、来源判别退化为"全部计入"。本模块无法收口
 * 该工具（所有权边界），故以**单测 + e2e** 钉住"账本引用生效"这一行为面。
 */

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AGENT_PERFORMANCE_TOOL, agentPerformanceIds } from './insight-rules';

/** 账本枚举上限（有界载入；触顶 → 来源判别不可信 → 调用方 fail-closed） */
export const PROVENANCE_SCAN_LIMIT = 500;

export interface PerformanceProvenance {
  /** 由 agent 工具写入的绩效行 id（判定/洞察窗口须排除这些行） */
  ids: Set<string>;
  /** 账本枚举是否**完整**（false = 触到上限，绝不能读成"没有伪造行"） */
  complete: boolean;
  /** 实际扫描的账本条数（可观测；只读） */
  scanned: number;
  /** 判别口径标注（消费方按此分层，绝不与事实混淆） */
  rule: 'agent-tool-ledger-exclusion';
}

@Injectable()
export class PerformanceProvenanceService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 枚举该用户 agent 工具写入的绩效行 id（**只读**；账本 = `ToolCall.output`，绝不改写）。
   * 多取一条用于判别"是否触顶"——`take: LIMIT + 1` 是廉价且确定的存在性探测。
   */
  async agentAuthoredIds(userId: string): Promise<PerformanceProvenance> {
    const rows = await this.prisma.toolCall.findMany({
      where: {
        toolName: AGENT_PERFORMANCE_TOOL,
        output: { not: Prisma.DbNull }, // 只认**已落账本**的调用（running/waiting 行没有副作用事实）
        runStep: { run: { userId } }, // server-side 归属收窄：只读该用户 run 的账本
      },
      select: { output: true },
      orderBy: { startedAt: 'desc' },
      take: PROVENANCE_SCAN_LIMIT + 1,
    });
    const complete = rows.length <= PROVENANCE_SCAN_LIMIT;
    const scanned = complete ? rows : rows.slice(0, PROVENANCE_SCAN_LIMIT);
    return {
      ids: agentPerformanceIds(scanned.map((r) => r.output)),
      complete,
      scanned: scanned.length,
      rule: 'agent-tool-ledger-exclusion',
    };
  }
}
