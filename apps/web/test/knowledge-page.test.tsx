import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import KnowledgePage from '@/app/knowledge/page';
import { checkDocumentFile } from '@/app/knowledge/components/upload-document-dialog';
import { jsonResponse, renderWithQuery } from './helpers';

/**
 * 知识库页（M13-W3）——**全部断言打在真实 HTTP 语义上**（无假数据、无本地伪造）：
 * 页面必须自己发 `GET /api/v1/knowledge/documents`；写路径必须打到后端既有端点
 * （POST /documents、POST /documents/:id/reindex、DELETE /documents/:id，file 源先 POST /attachments）。
 *
 * 覆盖：列表 / 空态 / 加载骨架 / 错误重试 / 上传（文本与文件两条路径 + MIME 闸门）/ 详情预览 / 重建索引 / 删除确认。
 */

type Doc = {
  id: string; kbId: string | null; userId: string; projectId: string | null; name: string;
  sourceType: 'text' | 'file'; content: string | null; sourceUri: string | null; storageKey: string | null;
  mimeType: string | null; sizeBytes: number | null; contentHash: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed'; errorCode: string | null; chunkCount: number;
  version: number; metadata: unknown; createdAt: string; updatedAt: string;
};

function doc(overrides: Partial<Doc> = {}): Doc {
  return {
    id: 'd1', kbId: null, userId: 'u1', projectId: null, name: '产品需求说明',
    sourceType: 'text', content: '这是文档正文。', sourceUri: null, storageKey: null,
    mimeType: null, sizeBytes: null, contentHash: 'h', status: 'ready', errorCode: null,
    chunkCount: 4, version: 1, metadata: null,
    createdAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-28T10:05:00.000Z',
    ...overrides,
  };
}

/** 路由式 fetch mock：按「方法 + 路径」分派，未命中即抛错（防止页面偷偷发未预期请求） */
function mockKnowledgeApi(init: { documents?: Doc[]; onList?: () => Response } = {}) {
  const documents = init.documents ?? [doc()];
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, opts?: RequestInit) => {
    const url = String(input);
    const method = opts?.method ?? 'GET';
    calls.push([url, opts]);
    if (method === 'GET' && url === '/api/v1/knowledge/documents') {
      return init.onList ? init.onList() : jsonResponse({ data: documents });
    }
    if (method === 'POST' && url === '/api/v1/attachments') {
      return jsonResponse({ data: { id: 'att-1', type: 'file', mimeType: 'text/markdown' } });
    }
    if (method === 'POST' && url === '/api/v1/knowledge/documents') {
      const body = JSON.parse(String(opts?.body)) as { name: string; sourceType: string };
      return jsonResponse({ data: doc({ id: 'd-new', name: body.name, sourceType: body.sourceType as Doc['sourceType'], chunkCount: 2 }) });
    }
    if (method === 'GET' && url.startsWith('/api/v1/knowledge/documents/')) {
      return jsonResponse({ data: doc({ id: url.split('/').pop()!, name: '产品需求说明', content: '详情预览正文' }) });
    }
    if (method === 'POST' && url.endsWith('/reindex')) {
      return jsonResponse({ data: doc({ id: 'd1', chunkCount: 9 }) });
    }
    if (method === 'DELETE' && url.startsWith('/api/v1/knowledge/documents/')) {
      return jsonResponse({ data: { id: 'd1' } });
    }
    throw new Error(`未预期的请求：${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

const row = (name: string) => screen.getByText(name).closest('tr') as HTMLTableRowElement;

describe('知识库页：列表 / 空态 / 加载 / 错误', () => {
  it('渲染文档行（名称/类型/状态/创建时间）并发真实列表请求', async () => {
    const { calls } = mockKnowledgeApi({ documents: [
      doc({ id: 'd1', name: '产品需求说明', sourceType: 'text', status: 'ready' }),
      doc({ id: 'd2', name: '素材清单.md', sourceType: 'file', status: 'failed', errorCode: 'EMBEDDING_FAILED' }),
    ] });
    renderWithQuery(<KnowledgePage />);

    expect(await screen.findByText('产品需求说明')).toBeInTheDocument();
    const first = row('产品需求说明');
    expect(within(first).getByText('文本')).toBeInTheDocument();
    expect(within(first).getByText('已就绪')).toBeInTheDocument();
    // 创建时间为 YYYY-MM-DD HH:mm 投影
    expect(within(first).getByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)).toBeInTheDocument();

    // 失败态必须如实呈现（否则用户看不到出路）
    const second = row('素材清单.md');
    expect(within(second).getByText('文件')).toBeInTheDocument();
    expect(within(second).getByText('失败')).toBeInTheDocument();
    expect(within(second).getByText(/EMBEDDING_FAILED/)).toBeInTheDocument();

    expect(calls.filter(([u, o]) => (o?.method ?? 'GET') === 'GET' && u === '/api/v1/knowledge/documents')).toHaveLength(1);
  });

  it('加载中显示骨架（不含任何「加载中…」文案，避免与只读页 e2e 收敛断言冲突）', async () => {
    const { fetchMock } = mockKnowledgeApi();
    let resolve!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { resolve = r; }));
    const { container } = renderWithQuery(<KnowledgePage />);

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByText('加载中…')).toBeNull();
    resolve(jsonResponse({ data: [doc()] }));
    expect(await screen.findByText('产品需求说明')).toBeInTheDocument();
  });

  it('空态：引导上传（并提供上传入口）', async () => {
    mockKnowledgeApi({ documents: [] });
    renderWithQuery(<KnowledgePage />);

    expect(await screen.findByText('知识库还没有文档')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传第一份文档' })).toBeInTheDocument();
    expect(screen.getByText(/\.txt \/ \.md \/ \.csv/)).toBeInTheDocument();
  });

  it('错误态：展示错误与重试，重试后渲染列表', async () => {
    let first = true;
    mockKnowledgeApi({ onList: () => {
      if (first) { first = false; return jsonResponse({ error: { code: 'INTERNAL', message: '服务异常' } }, 500); }
      return jsonResponse({ data: [doc()] });
    } });
    renderWithQuery(<KnowledgePage />);

    const banner = await screen.findByRole('alert');
    expect(within(banner).getByText('知识库文档加载失败')).toBeInTheDocument();
    expect(within(banner).getByText('服务异常')).toBeInTheDocument();
    // 错误横幅刻意不用 p.text-red-400（只读页 e2e 以该选择器判定页面错误态）
    expect(banner.tagName).toBe('DIV');

    fireEvent.click(within(banner).getByRole('button', { name: '重试' }));
    expect(await screen.findByText('产品需求说明')).toBeInTheDocument();
  });
});

describe('知识库页：上传文档', () => {
  it('文本来源：POST /documents（sourceType=text + content），成功后失效列表', async () => {
    const { calls } = mockKnowledgeApi();
    renderWithQuery(<KnowledgePage />);
    await screen.findByText('产品需求说明');

    fireEvent.click(screen.getByRole('button', { name: '上传文档' }));
    fireEvent.change(screen.getByLabelText('文档名称'), { target: { value: '新人手册' } });
    fireEvent.change(screen.getByLabelText('文档内容'), { target: { value: '正文内容' } });
    fireEvent.click(screen.getByRole('button', { name: '上传' }));

    await waitFor(() => {
      const created = calls.find(([u, o]) => u === '/api/v1/knowledge/documents' && o?.method === 'POST');
      expect(created, '必须打到 POST /api/v1/knowledge/documents').toBeTruthy();
      expect(JSON.parse(String(created![1]!.body))).toEqual({ name: '新人手册', sourceType: 'text', content: '正文内容' });
    });
    // 成功后对话框关闭 + 列表重新拉取（服务端是唯一事实源）
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(calls.filter(([u]) => u === '/api/v1/knowledge/documents').length).toBeGreaterThanOrEqual(2));
  });

  it('名称为空：本地拦截，不发任何请求', async () => {
    const { fetchMock } = mockKnowledgeApi();
    renderWithQuery(<KnowledgePage />);
    await screen.findByText('产品需求说明');

    fireEvent.click(screen.getByRole('button', { name: '上传文档' }));
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '上传' }));

    expect(await screen.findByText('请填写文档名称')).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('文件来源：先传附件再建文档；浏览器未上报类型时按扩展名回填 MIME', async () => {
    const { calls } = mockKnowledgeApi();
    renderWithQuery(<KnowledgePage />);
    await screen.findByText('产品需求说明');

    fireEvent.click(screen.getByRole('button', { name: '上传文档' }));
    fireEvent.click(screen.getByRole('tab', { name: '上传文件' }));

    // .md 在 Windows 上 file.type 常为空 → 必须由扩展名回填，否则后端附件白名单会拒
    fireEvent.change(screen.getByLabelText('文档文件'), { target: { files: [new File(['# 标题'], 'notes.md', { type: '' })] } });
    fireEvent.click(screen.getByRole('button', { name: '上传' }));

    await waitFor(() => {
      const upload = calls.find(([u]) => u === '/api/v1/attachments');
      expect(upload, 'file 源必须先 POST /api/v1/attachments').toBeTruthy();
      expect(upload![1]!.method).toBe('POST');
      const sent = (upload![1]!.body as FormData).get('file') as File;
      expect(sent.name).toBe('notes.md');
      expect(sent.type).toBe('text/markdown'); // 回填后的 MIME（multipart 分片类型取 File.type）
    });
    await waitFor(() => {
      const created = calls.find(([u, o]) => u === '/api/v1/knowledge/documents' && o?.method === 'POST');
      expect(JSON.parse(String(created![1]!.body))).toEqual({ name: 'notes.md', sourceType: 'file', attachmentId: 'att-1' });
    });
  });

  it('MIME 闸门与后端同口径：非文本类文件被本地拒绝（含纯函数边界）', async () => {
    const { fetchMock } = mockKnowledgeApi();
    renderWithQuery(<KnowledgePage />);
    await screen.findByText('产品需求说明');

    fireEvent.click(screen.getByRole('button', { name: '上传文档' }));
    fireEvent.click(screen.getByRole('tab', { name: '上传文件' }));
    fireEvent.change(screen.getByLabelText('文档文件'), { target: { files: [new File(['x'], 'scan.pdf', { type: 'application/pdf' })] } });
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '上传' }));

    expect(await screen.findByText(/不支持的文件类型：application\/pdf/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(before);

    // 纯函数口径（与后端 SUPPORTED_TEXT_MIME 一致）
    expect(checkDocumentFile(new File(['x'], 'a.txt', { type: 'text/plain' })).mime).toBe('text/plain');
    expect(checkDocumentFile(new File(['x'], 'a.csv', { type: '' })).mime).toBe('text/csv');
    expect(checkDocumentFile(new File(['x'], 'noext', { type: '' })).error).toMatch(/无法识别文件类型/);
    expect(checkDocumentFile(new File(['x'], 'a.png', { type: 'image/png' })).error).toMatch(/不支持的文件类型/);
  });
});

describe('知识库页：详情 / 重建索引 / 删除', () => {
  it('查看：单独取详情并只读预览正文', async () => {
    const { calls } = mockKnowledgeApi();
    renderWithQuery(<KnowledgePage />);
    await screen.findByText('产品需求说明');

    fireEvent.click(within(row('产品需求说明')).getByRole('button', { name: '查看' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('详情预览正文')).toBeInTheDocument();
    expect(within(dialog).getByText('内容预览')).toBeInTheDocument();
    expect(within(dialog).getByText('分块数')).toBeInTheDocument();
    // 只读预览：详情对话框内没有任何写操作按钮
    expect(within(dialog).queryByRole('button', { name: /删除|重建索引/ })).toBeNull();
    expect(calls.some(([u]) => u === '/api/v1/knowledge/documents/d1')).toBe(true);
  });

  it('重建索引：POST /documents/:id/reindex', async () => {
    const { calls } = mockKnowledgeApi();
    renderWithQuery(<KnowledgePage />);
    await screen.findByText('产品需求说明');

    fireEvent.click(within(row('产品需求说明')).getByRole('button', { name: '重建索引' }));

    await waitFor(() => expect(calls.some(([u, o]) => u === '/api/v1/knowledge/documents/d1/reindex' && o?.method === 'POST')).toBe(true));
  });

  it('删除：二次确认（取消不发请求；确认发 DELETE 并刷新列表）', async () => {
    const { calls } = mockKnowledgeApi();
    renderWithQuery(<KnowledgePage />);
    await screen.findByText('产品需求说明');

    fireEvent.click(within(row('产品需求说明')).getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('确认删除「产品需求说明」？')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter(([, o]) => o?.method === 'DELETE')).toHaveLength(0);

    fireEvent.click(within(row('产品需求说明')).getByRole('button', { name: '删除' }));
    const confirm = await screen.findByRole('dialog');
    fireEvent.click(within(confirm).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(calls.some(([u, o]) => u === '/api/v1/knowledge/documents/d1' && o?.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(calls.filter(([u]) => u === '/api/v1/knowledge/documents').length).toBeGreaterThanOrEqual(2));
  });
});
