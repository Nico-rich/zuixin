import { describe, it, expect } from 'vitest';
import { ChatStreamEventSchema } from '../src';

describe('ChatStreamEventSchema（SSE 线上协议）', () => {
  it('解析 message_start/message_delta/message_end', () => {
    expect(ChatStreamEventSchema.parse({ type: 'message_start', messageId: 'm1', conversationId: 'c1', role: 'assistant', createdAt: '2026-09-23T00:00:00Z' }).type).toBe('message_start');
    expect(ChatStreamEventSchema.parse({ type: 'message_delta', delta: '你好' }).delta).toBe('你好');
    expect(ChatStreamEventSchema.parse({ type: 'message_end', messageId: 'm1', status: 'completed' }).status).toBe('completed');
  });

  it('未来事件类型（task.progress）已在协议中', () => {
    const e = ChatStreamEventSchema.parse({ type: 'task.progress', taskId: 't1', progress: 50, message: '生成中 50%' });
    expect(e.progress).toBe(50);
  });

  it('未知 type 拒绝', () => {
    expect(() => ChatStreamEventSchema.parse({ type: 'nope', foo: 1 })).toThrow();
  });

  it('message_end 状态枚举严格', () => {
    expect(() => ChatStreamEventSchema.parse({ type: 'message_end', messageId: 'm', status: 'weird' })).toThrow();
  });
});
