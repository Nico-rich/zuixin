import type { Metadata } from 'next';
import { Providers } from '@/components/providers';
import { AppShell } from '@/components/app-shell';
import './globals.css';

export const metadata: Metadata = { title: 'AI Agent 智能创作平台', description: '万能 AI 助手：对话、生图、生视频' };

/**
 * 根布局（M13-F1）：Providers（react-query）→ AppShell（全局导航外壳）→ 页面。
 * 全局导航在这里挂载 ⇒ 任何新增页面（W2~W9）自动获得左栏导航与 toast 容器。
 * 鉴权在 middleware.ts（服务端）完成；AppShell 只做会话失效的客户端兜底。
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
