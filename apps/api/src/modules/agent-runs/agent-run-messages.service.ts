import { Inject, Injectable } from '@nestjs/common';
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
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 校验 run 归属（userId 首条件，防枚举 404） */
  private async requireRun(userId: string, runId: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id: runId, userId }, select: { id: true } });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, '运行不存在');
  }

  /** 追加一条 transcript 消息（sequence 自动分配） */
  async append(userId: string, runId: string, message: TranscriptMessageInput) {
    await this.requireRun(userId, runId);
    const data = {
      runId,
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls as never,
    };
    try {
      const last = await this.prisma.agentRunMessage.findFirst({ where: { runId }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
      return await this.prisma.agentRunMessage.create({ data: { ...data, sequence: (last?.sequence ?? -1) + 1 } });
    } catch (err) {
      // UNIQUE(runId, sequence) 竞态兜底：并发写者重算一次；再冲突则抛出（单写者模型下不应发生）
      if ((err as { code?: string }).code === 'P2002') {
        const last = await this.prisma.agentRunMessage.findFirst({ where: { runId }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
        return await this.prisma.agentRunMessage.create({ data: { ...data, sequence: (last?.sequence ?? -1) + 1 } });
      }
      throw err;
    }
  }

  /** 按序重放（resume 重建 LLM message sequence 的唯一输入） */
  async list(userId: string, runId: string) {
    await this.requireRun(userId, runId);
    return this.prisma.agentRunMessage.findMany({ where: { runId }, orderBy: { sequence: 'asc' } });
  }
}
