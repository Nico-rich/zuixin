export type ContentPart = { type: 'text'; text: string } | { type: 'image'; imageUrl: string };

// ===== M4: 统一 Tool Calling 内部协议（AgentLoop 不感知任何 Provider 格式）=====
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string; // JSON 字符串
}

export interface ToolDefinitionWire {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  tool_call_id?: string;            // role=tool 时回填
  tool_calls?: ToolCallRequest[];   // role=assistant 且携带工具调用时
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' | 'json_schema'; schema?: unknown };
  tools?: ToolDefinitionWire[];     // 工具定义（adapter 转 provider 格式）
  signal?: AbortSignal;
}

export interface ChatUsage { inputTokens: number; outputTokens: number; }

export interface ChatResponse { content: string; toolCalls?: ToolCallRequest[]; usage?: ChatUsage; }

/** 流式分块：文本与工具调用可在同一流中先后出现（adapter 聚合 delta 后一次产出 tool_calls） */
export type LLMChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; toolCalls: ToolCallRequest[] }
  | { type: 'usage'; usage: ChatUsage };

/** 非流式回合的统一结果 */
export type LLMTurn =
  | { type: 'final'; content: string; usage?: ChatUsage }
  | { type: 'tool_calls'; content?: string; toolCalls: ToolCallRequest[]; usage?: ChatUsage };

export interface LLMProvider {
  readonly kind: 'llm';
  chat(params: ChatParams): Promise<ChatResponse>;
  stream(params: ChatParams): AsyncIterable<LLMChunk>;
}
