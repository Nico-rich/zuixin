import { Suspense } from 'react';
import { ChatWorkspace } from './components/chat-workspace';

export default function NewChatPage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center text-zinc-500">加载中…</div>}>
      <ChatWorkspace />
    </Suspense>
  );
}
