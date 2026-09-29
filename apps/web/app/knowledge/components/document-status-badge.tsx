import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { DocumentStatus, KnowledgeDocument } from '@/lib/services/knowledge';

/**
 * 知识文档状态/来源的**展示映射**（M13-W3）
 *
 * 状态字面量来自后端（`KnowledgeDocument.status`），这里只做「字面量 → 徽标/中文」的投影，
 * **不做任何业务判定**（能否检索、能否重建索引一律以后端为准）。
 * `failed` 必须可见：失败文档的出路是重建索引或删除，藏起来会让用户卡死。
 */
const STATUS: Record<DocumentStatus, { label: string; variant: BadgeProps['variant'] }> = {
  pending: { label: '待处理', variant: 'secondary' },
  processing: { label: '处理中', variant: 'warning' },
  ready: { label: '已就绪', variant: 'success' },
  failed: { label: '失败', variant: 'destructive' },
};

export function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  // 后端新增状态字面量时不崩：回落为原样展示（前端不做枚举硬校验）
  const meta = STATUS[status] ?? { label: String(status), variant: 'default' as const };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

export const SOURCE_TYPE_LABEL: Record<KnowledgeDocument['sourceType'], string> = {
  text: '文本',
  file: '文件',
};

export function sourceTypeLabel(sourceType: KnowledgeDocument['sourceType']): string {
  return SOURCE_TYPE_LABEL[sourceType] ?? String(sourceType);
}

/** 字节数 → 可读大小（仅展示投影；无值显示破折号） */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
