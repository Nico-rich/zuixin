import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

/** 测试用 QueryClient：关闭重试，失败即暴露（避免 mock 之外的静默重试掩盖断言） */
export function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function Providers({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={makeQueryClient()}>{children}</QueryClientProvider>;
}

export function renderWithQuery(ui: ReactElement): RenderResult {
  return render(ui, { wrapper: Providers });
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

/** 等待一个条件成立（轮询微任务 + 定时器），避免依赖固定 sleep */
export async function until(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('until: 条件在超时前未成立');
    await new Promise((r) => setTimeout(r, 5));
  }
}
