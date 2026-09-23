'use client';
import { useRef, useState } from 'react';
import { Paperclip, Send, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { uploadAttachment } from '@/lib/api';

interface PendingAttachment { id: string; name: string; }

export function ChatInput({ onSend, onStop, streaming }: { onSend: (t: string, attachmentIds: string[]) => void; onStop: () => void; streaming: boolean }) {
  const [value, setValue] = useState('');
  const [uploads, setUploads] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const text = value.trim();
    if ((!text && uploads.length === 0) || streaming) return;
    onSend(text || '（附件）', uploads.map((u) => u.id));
    setValue('');
    setUploads([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onPick = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true); setUploadError('');
    try {
      const next: PendingAttachment[] = [];
      for (const file of Array.from(files).slice(0, 4)) {
        const res = await uploadAttachment(file);
        next.push({ id: res.data.id, name: file.name });
      }
      setUploads((prev) => [...prev, ...next]);
    } catch {
      setUploadError('上传失败，请检查文件类型与大小');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    void onPick(e.dataTransfer.files);
  };

  return (
    <div
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      className="rounded-2xl border border-zinc-800 bg-zinc-900 p-2"
    >
      {uploads.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 px-1">
          {uploads.map((u) => (
            <span key={u.id} className="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
              📎 {u.name}
              <button onClick={() => setUploads((prev) => prev.filter((x) => x.id !== u.id))} className="text-zinc-500 hover:text-red-400">
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => void onPick(e.target.files)} />
        <Button variant="ghost" size="icon" onClick={() => fileRef.current?.click()} disabled={uploading || streaming} title="上传附件">
          <Paperclip />
        </Button>
        <Textarea
          value={value}
          placeholder="输入你的问题…（Enter 发送 / Shift+Enter 换行，可拖拽上传图片）"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          className="max-h-40 min-h-[40px] flex-1 resize-none border-0 bg-transparent focus-visible:ring-0"
        />
        {streaming
          ? <Button variant="outline" size="icon" onClick={onStop} title="停止生成"><Square className="fill-current" /></Button>
          : <Button size="icon" onClick={submit} disabled={(!value.trim() && uploads.length === 0) || uploading} title="发送"><Send /></Button>}
      </div>
      {uploadError && <p className="mt-1 px-1 text-xs text-red-400">{uploadError}</p>}
    </div>
  );
}
