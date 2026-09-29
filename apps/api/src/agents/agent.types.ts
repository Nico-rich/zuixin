import { AgentEvent, TaskIntent } from '@ai-agent/shared';
import { ChatMessage } from '../providers/llm/llm.types';

export interface AttachmentMeta { id: string; type: 'image' | 'video' | 'file'; mimeType: string; url: string; }

export interface AgentContext {
  userId: string;
  conversationId: string;
  messageId: string;
  /** 会话所属项目（Loop 上下文/记忆/制品归属） */
  projectId?: string;
  userMessage: string;
  attachments: AttachmentMeta[];
  history: ChatMessage[];
  intent: TaskIntent;
  mode: 'normal' | 'thinking' // 预留，未接线（M12 Final Audit 登记：零运行时消费者）;
  signal?: AbortSignal; // 用户停止生成 → 传播到 Provider 流
}

export interface Agent {
  readonly id: string;
  execute(ctx: AgentContext): AsyncIterable<AgentEvent>;
}
