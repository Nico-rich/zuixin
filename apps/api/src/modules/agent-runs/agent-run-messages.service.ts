import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/** transcript 角色（合法 LLM tool-calling message sequence 的构成） */
export type TranscriptRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TranscriptMessageInput {
  role: TranscriptRole;
  content: string;
  /** role=tool 时 = LLM 生成的 call id（与 assistant.tool_calls 配对；非 ToolCall 行 id） */
  toolCallId?: string;
  /** role=assistant 时 = tool_calls 数组快照 [{id,name,arguments}]（resume 不重打 LLM 的决策事实） */
  toolCalls?: unknown;
}

/**
 * Agent Run Transcript（M6-P1 数据层）：
 * - append-only；UNIQUE(runId, sequence) 保证重放幂等（sequence 由单写者自增，P2002 竞态兜底）；
 * - userId 首条件：run 归属校验，身份只从 DB 行继承，绝不经 queue payload 指定；
 * - 不存 chain-of-thought（引擎调用侧保证，本层不复制任何推理内容）。
 * resume 重放（P3）唯一输入 = list() 顺序输出 + step/toolCall 行状态。
 */
@Injectable()
export class AgentRunMessagesService {
  private readonly logger = new Logger('AgentRunMessages');

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 校验 run 归属（userId 首条件，防枚举 404）+ 取末条 sequence——**一次**往返完成（P1 性能包）：
   * 归属过滤仍是查询首条件（不存在的 run / 非本人 run → null → 404，语义与拆分两次查询逐字一致）；
   * 嵌套 select 取最后一行 sequence 替代独立的 MAX 查询。
   */
  private async requireRunWithLastSequence(userId: string, runId: string): Promise<number> {
    const run = await this.prisma.agentRun.findFirst({
      where: { id: runId, userId },
      select: { id: true, messages: { orderBy: { sequence: 'desc' }, take: 1, select: { sequence: true } } },
    });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, '运行不存在');
    return run.messages[0]?.sequence ?? -1;
  }

  /** 追加一条 transcript 消息（sequence 自动分配） */
  async append(userId: string, runId: string, message: TranscriptMessageInput) {
    const data = {
      runId,
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls as never,
    };
    try {
      const last = await this.requireRunWithLastSequence(userId, runId);
      return await this.prisma.agentRunMessage.create({ data: { ...data, sequence: last + 1 } });
    } catch (err) {
      // UNIQUE(runId, sequence) 竞态兜底：并发写者重算一次；再冲突则抛出（单写者模型下不应发生）
      if ((err as { code?: string }).code === 'P2002') {
        const last = await this.requireRunWithLastSequence(userId, runId);
        return await this.prisma.agentRunMessage.create({ data: { ...data, sequence: last + 1 } });
      }
      throw err;
    }
  }

  /**
   * 批量 seed 初始 transcript（P1 性能包；替代「逐条 append = 每条 3 次往返」）：
   * - 单次 createMany（**一次**往返）写入全部行，sequence 由调用方按数组下标给定（0..n-1）；
   * - `skipDuplicates`：撞 UNIQUE(runId, sequence) 的行被跳过而非整批失败——幂等语义不变
   *   （同一 run 重复 seed 绝不产生重复 transcript，也绝不覆盖已存在的决策事实）；
   * - 归属：仅由 createAsync/retry 在**本调用刚创建的 run**（runId 服务端 randomUUID 生成，
   *   无任何外部输入路径）上调用，越权不可达，故不再重复 requireRun（省一次往返）；
   * - 降级：createMany 整体失败（如驱动不支持）→ 逐条 append（保留 userId 归属校验），绝不丢 transcript。
   */
  async seed(userId: string, runId: string, messages: TranscriptMessageInput[]): Promise<number> {
    if (!messages.length) return 0;
    const data = messages.map((message, sequence) => ({
      runId,
      sequence,
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls as never,
    }));
    try {
      const result = await this.prisma.agentRunMessage.createMany({ data, skipDuplicates: true });
      return result.count;
    } catch (err) {
      this.logger.warn(`createMany 批量 seed 失败，降级逐条 append: ${(err as Error).message}`);
      for (const message of messages) await this.append(userId, runId, message);
      return messages.length;
    }
  }

  /** 校验 run 归属（userId 首条件，防枚举 404） */
  private async requireRun(userId: string, runId: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id: runId, userId }, select: { id: true } });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, '运行不存在');
  }

  /** 按序重放（resume 重建 LLM message sequence 的唯一输入） */
  async list(userId: string, runId: string) {
    await this.requireRun(userId, runId);
    return this.prisma.agentRunMessage.findMany({ where: { runId }, orderBy: { sequence: 'asc' } });
  }
}
