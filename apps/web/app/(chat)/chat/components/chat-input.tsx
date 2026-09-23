'use client';
import { useState } from 'react';
import { Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function ChatInput({ onSend, onStop, streaming }: { onSend: (t: string) => void; onStop: () => void; streaming: boolean }) {
  const [value, setValue] = useState('');

  const submit = () => {
    const text = value.trim();
    if (!text || streaming) return;
    onSend(text);
    setValue('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex items-end gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 p-2">
      <Textarea
        value={value}
        placeholder="输入你的问题…（Enter 发送 / Shift+Enter 换行）"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        className="max-h-40 min-h-[40px] flex-1 resize-none border-0 bg-transparent focus-visible:ring-0"
      />
      {streaming
        ? <Button variant="outline" size="icon" onClick={onStop} title="停止生成"><Square className="fill-current" /></Button>
        : <Button size="icon" onClick={submit} disabled={!value.trim()} title="发送"><Send /></Button>}
    </div>
  );
}
