import { Suspense } from 'react';
import { ChatWorkspace } from '../components/chat-workspace';

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center text-zinc-500">加载中…</div>}>
      <ChatWorkspace conversationId={id} />
    </Suspense>
  );
}
