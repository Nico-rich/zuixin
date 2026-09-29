'use client';

import { useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import {
  type CatalogEntry, type CreateExtensionInput, type Extension, type ExtensionKind,
} from '@/lib/services/extensions';
import type { OrganizationSummary } from '@/lib/services/organizations';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiErrorBadge, EXTENSION_KIND_OPTIONS, kindLabel } from './extension-ui';

/**
 * Extensions 管理页的三个写弹窗（M13-W7）：创建 / 更新 / 安装。
 *
 * 契约纪律：
 *  - 入参形状逐字对齐 apps/api/src/modules/extensions/extensions.dto.ts（CreateExtensionSchema /
 *    UpdateExtensionSchema / InstallSchema，全部是 zod strictObject——多一个字段即 400）；
 *  - manifest 默认按 kind 生成**最小合法模板**（对齐 manifest.ts 的 parseManifest：kind ↔ 定义块一一对应、
 *    必须声明该 kind 的核心权限、tool 名必须是 ext.<slug>.<name> 且 slug 段等于扩展 slug、
 *    provider.baseUrl 必须公网 https、workflow_step(tool) 必须声明 params.toolName）；
 *  - 弹窗由调用方按需挂载（`{open && <CreateDialog/>}`）：每次打开都是全新状态，无跨次残留。
 */

/** 镜像 extensions.dto.ts 的 ExtensionSlugSchema（前端只做即时提示，服务端仍是唯一裁决方） */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,49}$/;

export function formatJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

/** 解析「JSON 对象」文本（数组/标量一律拒绝——manifest 与 install config 都要求对象） */
export function parseJsonObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: '必须是 JSON 对象（{ … }）' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** 按 kind 生成最小合法 manifest 模板（见 manifest.ts 的 parseManifest 与各 Block schema） */
export function buildManifestTemplate(
  kind: ExtensionKind,
  input: { slug: string; name: string; description?: string },
): Record<string, unknown> {
  const slug = SLUG_PATTERN.test(input.slug) ? input.slug : 'demo-ext';
  const label = input.name.trim() || slug;
  const description = input.description?.trim() || `${label}（声明式扩展）`;
  switch (kind) {
    case 'tool':
      return {
        manifestVersion: 1, kind, permissions: ['tool.execute'],
        // 包装一个既有平台工具（只读/写入/生成类；绝不引用 ext.* —— 禁止扩展链）
        tool: { name: `ext.${slug}.wrap`, description, baseTool: 'knowledge.search' },
      };
    case 'agent':
      return {
        manifestVersion: 1, kind, permissions: ['agent.run'],
        agent: { name: 'assistant', description, systemPrompt: `你是 {{extension.name}}（{{extension.slug}}）。`, tools: [] },
      };
    case 'provider':
      return {
        manifestVersion: 1, kind, permissions: ['provider.call'],
        provider: {
          name: label, adapter: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          models: [{ name: 'gpt-4o-mini', apiModelId: 'gpt-4o-mini', type: 'llm' }],
        },
      };
    case 'workflow_step':
      return {
        manifestVersion: 1, kind, permissions: ['workflow.step'],
        workflow_step: { name: 'step', stepType: 'tool', description, params: { toolName: 'knowledge.search' } },
      };
  }
}

/* ------------------------------------------------------------------ *
 * 创建
 * ------------------------------------------------------------------ */
/** 归属 = 平台级（organizationId: null，服务端要求平台管理员） */
const PLATFORM_OWNER = '__platform__';

export interface CreateDialogProps {
  organizations: OrganizationSummary[];
  defaultOrganizationId: string;
  pending: boolean;
  error: ApiError | null;
  onClose: () => void;
  onSubmit: (input: CreateExtensionInput) => void;
}

export function CreateDialog({
  organizations, defaultOrganizationId, pending, error, onClose, onSubmit,
}: CreateDialogProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [kind, setKind] = useState<ExtensionKind>('tool');
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState(defaultOrganizationId || PLATFORM_OWNER);
  const [manifestDraft, setManifestDraft] = useState('');
  const [manifestDirty, setManifestDirty] = useState(false);
  const [localError, setLocalError] = useState('');

  const template = useMemo(
    () => formatJson(buildManifestTemplate(kind, { slug, name, description })),
    [kind, slug, name, description],
  );
  const manifestText = manifestDirty ? manifestDraft : template;

  const submit = () => {
    if (!name.trim()) { setLocalError('扩展名不能为空'); return; }
    if (!SLUG_PATTERN.test(slug)) { setLocalError('slug 只能是小写字母/数字/中划线（2~50 位）'); return; }
    const parsed = parseJsonObject(manifestText);
    if (!parsed.ok) { setLocalError(`manifest 必须是合法 JSON：${parsed.message}`); return; }
    setLocalError('');
    onSubmit({
      name: name.trim(),
      slug,
      kind,
      ...(description.trim() ? { description: description.trim() } : {}),
      organizationId: owner === PLATFORM_OWNER ? null : owner,
      manifest: parsed.value,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <div>
        <DialogHeader>
          <DialogTitle>创建扩展</DialogTitle>
          <DialogDescription>
            创建后落到 draft 状态（首个草稿版本）。扩展不执行任何清单内容；权限由服务端按清单 ∩ 平台白名单 ∩ 组织策略裁定。
          </DialogDescription>
        </DialogHeader>

        <DialogContent className="space-y-3">
          <label className="block text-xs text-zinc-400" htmlFor="ext-create-name">名称</label>
          <Input id="ext-create-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="例如：知识检索包装" />

          <label className="block text-xs text-zinc-400" htmlFor="ext-create-slug">slug（小写字母/数字/中划线，工具的命名空间 ext.&lt;slug&gt;.&lt;name&gt; 依赖它）</label>
          <Input id="ext-create-slug" value={slug} maxLength={50} onChange={(e) => setSlug(e.target.value)} placeholder="例如：knowledge-wrap" />

          <label className="block text-xs text-zinc-400" htmlFor="ext-create-kind">类型</label>
          <Select id="ext-create-kind" value={kind} onChange={(e) => setKind(e.target.value as ExtensionKind)}>
            {EXTENSION_KIND_OPTIONS.map((k) => <option key={k} value={k}>{kindLabel(k)}（{k}）</option>)}
          </Select>

          <label className="block text-xs text-zinc-400" htmlFor="ext-create-desc">描述（可选，≤500）</label>
          <Textarea id="ext-create-desc" value={description} maxLength={500} rows={2} onChange={(e) => setDescription(e.target.value)} />

          <label className="block text-xs text-zinc-400" htmlFor="ext-create-owner">归属</label>
          <Select id="ext-create-owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
            {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}{o.isPersonal ? '（个人）' : ''}</option>)}
            <option value={PLATFORM_OWNER}>平台级（需平台管理员）</option>
          </Select>

          <div className="flex items-center justify-between">
            <label className="text-xs text-zinc-400" htmlFor="ext-create-manifest">manifest（声明式 JSON，默认按类型生成模板）</label>
            <Button size="sm" variant="ghost" onClick={() => { setManifestDirty(false); setManifestDraft(''); }}>重置模板</Button>
          </div>
          <Textarea
            id="ext-create-manifest"
            aria-label="manifest"
            value={manifestText}
            rows={10}
            className="font-mono text-xs"
            onChange={(e) => { setManifestDirty(true); setManifestDraft(e.target.value); }}
          />

          {localError && <p className="text-xs text-amber-300">{localError}</p>}
          {error && <ApiErrorBadge error={error} />}
        </DialogContent>

        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>取消</Button>
          <Button disabled={pending} onClick={submit}>确认创建</Button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ *
 * 更新（PATCH /extensions/:id）：改名/描述；改了 manifest 才会生成新 draft 版本
 * ------------------------------------------------------------------ */
export interface UpdateDialogProps {
  extension: Extension;
  pending: boolean;
  error: ApiError | null;
  onClose: () => void;
  onSubmit: (input: { name?: string; description?: string; manifest?: unknown }) => void;
}

export function UpdateDialog({ extension, pending, error, onClose, onSubmit }: UpdateDialogProps) {
  const latest = extension.versions?.[0] ?? null;
  const [name, setName] = useState(extension.name);
  const [description, setDescription] = useState(extension.description ?? '');
  const [manifestDraft, setManifestDraft] = useState('');
  const [manifestDirty, setManifestDirty] = useState(false);
  const [localError, setLocalError] = useState('');

  const originalManifest = formatJson(latest?.manifest ?? {});
  const manifestText = manifestDirty ? manifestDraft : originalManifest;

  const submit = () => {
    const input: { name?: string; description?: string; manifest?: unknown } = {};
    if (name.trim() && name.trim() !== extension.name) input.name = name.trim();
    if (description !== (extension.description ?? '')) input.description = description;
    if (manifestDirty) {
      const parsed = parseJsonObject(manifestText);
      if (!parsed.ok) { setLocalError(`manifest 必须是合法 JSON：${parsed.message}`); return; }
      input.manifest = parsed.value;
    }
    if (Object.keys(input).length === 0) { setLocalError('没有需要提交的变更'); return; }
    setLocalError('');
    onSubmit(input);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <div>
        <DialogHeader>
          <DialogTitle>更新扩展 · {extension.name}</DialogTitle>
          <DialogDescription>
            {latest ? `当前最新版本 v${latest.version}（${latest.status}）` : '当前没有版本'}；仅当 manifest 有改动才会生成/更新 draft 版本（已发布版本永不修改）。
          </DialogDescription>
        </DialogHeader>

        <DialogContent className="space-y-3">
          <label className="block text-xs text-zinc-400" htmlFor="ext-update-name">名称</label>
          <Input id="ext-update-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />

          <label className="block text-xs text-zinc-400" htmlFor="ext-update-desc">描述（清空后提交即置为空）</label>
          <Textarea id="ext-update-desc" value={description} maxLength={500} rows={2} onChange={(e) => setDescription(e.target.value)} />

          <label className="block text-xs text-zinc-400" htmlFor="ext-update-manifest">manifest（未修改则不发 manifest 字段）</label>
          <Textarea
            id="ext-update-manifest"
            aria-label="manifest"
            value={manifestText}
            rows={10}
            className="font-mono text-xs"
            onChange={(e) => { setManifestDirty(true); setManifestDraft(e.target.value); }}
          />

          {localError && <p className="text-xs text-amber-300">{localError}</p>}
          {error && <ApiErrorBadge error={error} />}
        </DialogContent>

        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>取消</Button>
          <Button disabled={pending} onClick={submit}>保存变更</Button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ *
 * 安装（POST /extensions/:id/install）：版本锁定 + 组织 config（provider 必须给 apiKey）
 * ------------------------------------------------------------------ */
export interface InstallTarget {
  id: string;
  name: string;
  kind: string;
  versions: Array<{ id: string; version: number; status: string }>;
}

/** 扩展（列表/详情行）→ 安装弹窗入参：只暴露已发布版本（未发布版本服务端拒绝安装） */
export function installTargetOf(ext: Pick<Extension, 'id' | 'name' | 'kind' | 'versions'>): InstallTarget {
  return {
    id: ext.id,
    name: ext.name,
    kind: ext.kind,
    versions: (ext.versions ?? []).filter((v) => v.status === 'published').map((v) => ({ id: v.id, version: v.version, status: v.status })),
  };
}

/** 市场目录条目 → 安装弹窗入参（目录只回显已发布版本，故最多一项） */
export function installTargetOfCatalog(entry: Pick<CatalogEntry, 'id' | 'name' | 'kind' | 'publishedVersion'>): InstallTarget {
  const version = entry.publishedVersion;
  return { id: entry.id, name: entry.name, kind: entry.kind, versions: version ? [{ id: version.id, version: version.version, status: version.status }] : [] };
}

export interface InstallDialogProps {
  target: InstallTarget;
  organizationId: string;
  pending: boolean;
  error: ApiError | null;
  onClose: () => void;
  onSubmit: (input: { organizationId: string; versionId?: string; config?: Record<string, unknown> }) => void;
}

export function InstallDialog({ target, organizationId, pending, error, onClose, onSubmit }: InstallDialogProps) {
  const [versionId, setVersionId] = useState('');
  const [configText, setConfigText] = useState('{}');
  const [apiKey, setApiKey] = useState('');
  const [localError, setLocalError] = useState('');
  const isProvider = target.kind === 'provider';

  const submit = () => {
    if (isProvider && !apiKey.trim()) {
      setLocalError('供应商类扩展安装必须提供 apiKey（清单绝不携带密钥，凭证只能来自组织安装配置）');
      return;
    }
    const parsed = parseJsonObject(configText);
    if (!parsed.ok) { setLocalError(`安装配置必须是合法 JSON：${parsed.message}`); return; }
    setLocalError('');
    const config = { ...parsed.value, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
    onSubmit({ organizationId, ...(versionId ? { versionId } : {}), config });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <div>
        <DialogHeader>
          <DialogTitle>安装扩展 · {target.name}</DialogTitle>
          <DialogDescription>
            安装到当前选中组织（{organizationId || '未选择组织'}）。安装行锁定版本；密钥只经安装配置传入，绝不写入清单。
          </DialogDescription>
        </DialogHeader>

        <DialogContent className="space-y-3">
          <label className="block text-xs text-zinc-400" htmlFor="ext-install-version">版本（默认最新已发布）</label>
          <Select id="ext-install-version" value={versionId} onChange={(e) => setVersionId(e.target.value)}>
            <option value="">最新已发布</option>
            {target.versions.map((v) => <option key={v.id} value={v.id}>v{v.version}</option>)}
          </Select>

          {isProvider && (
            <>
              <label className="block text-xs text-zinc-400" htmlFor="ext-install-apikey">apiKey（供应商类必填，落库前加密）</label>
              <Input id="ext-install-apikey" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
            </>
          )}

          <label className="block text-xs text-zinc-400" htmlFor="ext-install-config">安装配置（JSON 对象，可选）</label>
          <Textarea
            id="ext-install-config"
            aria-label="安装配置"
            value={configText}
            rows={5}
            className="font-mono text-xs"
            onChange={(e) => setConfigText(e.target.value)}
          />

          {localError && <p className="text-xs text-amber-300">{localError}</p>}
          {error && <ApiErrorBadge error={error} />}
        </DialogContent>

        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>取消</Button>
          <Button disabled={pending || !organizationId} onClick={submit}>确认安装</Button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}
