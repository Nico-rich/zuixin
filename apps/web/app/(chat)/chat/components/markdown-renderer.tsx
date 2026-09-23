'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-zinc-800">
      <div className="flex items-center justify-between bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400">
        <span>{language || 'text'}</span>
        <button onClick={() => void copy()} className="flex items-center gap-1 hover:text-zinc-200">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-sm leading-relaxed"><code>{code}</code></pre>
    </div>
  );
}

export function MarkdownRenderer({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn('max-w-none space-y-2 text-[15px] leading-relaxed text-zinc-200', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <>{children}</>, // pre 由 CodeBlock 接管
          code(props) {
            const { children, className: cls, ...rest } = props;
            const match = /language-([\w-]+)/.exec(cls ?? '');
            if (match) return <CodeBlock language={match[1]} code={String(children).replace(/\n$/, '')} />;
            return <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-sm" {...rest}>{children}</code>;
          },
          h1: (p) => <h1 className="mb-2 mt-4 text-xl font-bold" {...p} />,
          h2: (p) => <h2 className="mb-2 mt-4 text-lg font-bold" {...p} />,
          h3: (p) => <h3 className="mb-1 mt-3 text-base font-semibold" {...p} />,
          ul: (p) => <ul className="list-disc space-y-1 pl-5" {...p} />,
          ol: (p) => <ol className="list-decimal space-y-1 pl-5" {...p} />,
          a: (p) => <a className="text-blue-400 underline" target="_blank" rel="noreferrer" {...p} />,
          p: (p) => <p className="my-2" {...p} />,
          blockquote: (p) => <blockquote className="border-l-2 border-zinc-600 pl-3 text-zinc-400" {...p} />,
          table: (p) => <table className="my-2 w-full border-collapse text-sm" {...p} />,
          th: (p) => <th className="border border-zinc-700 px-2 py-1 text-left" {...p} />,
          td: (p) => <td className="border border-zinc-700 px-2 py-1" {...p} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
