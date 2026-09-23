export type ContentPart = { type: 'text'; text: string } | { type: 'image'; imageUrl: string };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' | 'json_schema'; schema?: unknown };
  signal?: AbortSignal;
}

export interface ChatUsage { inputTokens: number; outputTokens: number; }

export interface ChatResponse { content: string; usage?: ChatUsage; }

export type LLMChunk = { type: 'text'; text: string } | { type: 'usage'; usage: ChatUsage };

export interface LLMProvider {
  readonly kind: 'llm';
  chat(params: ChatParams): Promise<ChatResponse>;
  stream(params: ChatParams): AsyncIterable<LLMChunk>;
}
