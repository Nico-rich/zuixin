import { ChatWorkspace } from '../components/chat-workspace';

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChatWorkspace conversationId={id} />;
}
