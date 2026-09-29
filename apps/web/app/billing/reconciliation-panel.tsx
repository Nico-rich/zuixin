import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * 对账面板（M13-W5）：UsageRecord ↔ UsageLedgerEntry 诊断结果的**如实呈现**。
 *
 * `lib/services/billing.ts` 把 `GET /billing/reconciliation` 的返回标为 `unknown`
 * （后端类型未进 shared，前端不伪造类型）——这里用 `parseReconciliation()` 做一次
 * **防御式收窄**：只认结构关键位（consistent 布尔 + 数值计数），其余数组逐项挑字段，
 * 结构不认识就整体不渲染（并明确说明），绝不半真半假地展示。
 *
 * 结论语义（服务端口径，前端不重算）：`consistent === true` 仅当
 * missing / duplicates / wrongAmount / orphans / ledgerOnly.duplicateKeys /
 * ledgerOnly.nonPositive / unlinked **全部为空**；`ledgerOnly` 段的 kind 不产生 UsageRecord
 * （agent_run、workflow_run 等），属**预期存在**的账本行而非差异——本面板按原样分段展示，
 * 不把它们折算进「是否一致」的结论里。
 */
export interface ReconciliationIssue { usageRecordId: string; kind: string; expected: number; actual: number }
export interface ReconciliationOrphan { ledgerId: string; usageRecordId: string | null; kind: string }
export interface ReconciliationUnlinked { ledgerId: string; kind: string; idempotencyKey: string }
export interface ReconciliationReport {
  organizationId: string;
  period: string;
  records: number;
  mirrorRows: number;
  missing: ReconciliationIssue[];
  duplicates: ReconciliationIssue[];
  wrongAmount: ReconciliationIssue[];
  orphans: ReconciliationOrphan[];
  ledgerOnly: {
    rows: number;
    kinds: Array<{ kind: string; rows: number; quantity: number }>;
    duplicateKeys: Array<{ idempotencyKey: string; kind: string; count: number }>;
    nonPositive: Array<{ ledgerId: string; kind: string; quantity: number }>;
  };
  unlinked: ReconciliationUnlinked[];
  consistent: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const issues = (v: unknown): ReconciliationIssue[] =>
  Array.isArray(v) ? v.filter(isObj).map((r) => ({
    usageRecordId: str(r.usageRecordId), kind: str(r.kind), expected: num(r.expected), actual: num(r.actual),
  })) : [];

/** 结构化收窄；无法识别的响应返回 null（页面据此明说「不识别」，而不是渲染半截数据） */
export function parseReconciliation(raw: unknown): ReconciliationReport | null {
  if (!isObj(raw) || typeof raw.consistent !== 'boolean') return null;
  const ledger = isObj(raw.ledgerOnly) ? raw.ledgerOnly : {};
  const kindsRaw = isObj(ledger.kinds) ? ledger.kinds : {};
  const kinds = Object.entries(kindsRaw)
    .filter((entry): entry is [string, Record<string, unknown>] => isObj(entry[1]))
    .map(([kind, agg]) => ({ kind, rows: num(agg.rows), quantity: num(agg.quantity) }));
  return {
    organizationId: str(raw.organizationId),
    period: str(raw.period),
    records: num(raw.records),
    mirrorRows: num(raw.mirrorRows),
    missing: issues(raw.missing),
    duplicates: issues(raw.duplicates),
    wrongAmount: issues(raw.wrongAmount),
    orphans: Array.isArray(raw.orphans) ? raw.orphans.filter(isObj).map((r) => ({
      ledgerId: str(r.ledgerId), usageRecordId: r.usageRecordId === null ? null : str(r.usageRecordId), kind: str(r.kind),
    })) : [],
    ledgerOnly: {
      rows: num(ledger.rows),
      kinds,
      duplicateKeys: Array.isArray(ledger.duplicateKeys) ? ledger.duplicateKeys.filter(isObj).map((r) => ({
        idempotencyKey: str(r.idempotencyKey), kind: str(r.kind), count: num(r.count),
      })) : [],
      nonPositive: Array.isArray(ledger.nonPositive) ? ledger.nonPositive.filter(isObj).map((r) => ({
        ledgerId: str(r.ledgerId), kind: str(r.kind), quantity: num(r.quantity),
      })) : [],
    },
    unlinked: Array.isArray(raw.unlinked) ? raw.unlinked.filter(isObj).map((r) => ({
      ledgerId: str(r.ledgerId), kind: str(r.kind), idempotencyKey: str(r.idempotencyKey),
    })) : [],
    consistent: raw.consistent,
  };
}

function Segment({ title, hint, count, children }: { title: string; hint: string; count: number; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <div className="mb-1 flex items-baseline gap-2">
        <h4 className="text-xs font-medium text-zinc-300">{title}</h4>
        <span className="text-xs text-zinc-600">{count} 条 · {hint}</span>
      </div>
      {count === 0 ? <p className="text-xs text-zinc-600">无</p> : children}
    </div>
  );
}

function IssueTable({ rows }: { rows: ReconciliationIssue[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>用量记录</TableHead>
          <TableHead>类型</TableHead>
          <TableHead>期望</TableHead>
          <TableHead>实际</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => (
          <TableRow key={`${row.usageRecordId}-${row.kind}-${i}`}>
            <TableCell className="font-mono text-xs text-zinc-400">{row.usageRecordId}</TableCell>
            <TableCell className="text-zinc-300">{row.kind}</TableCell>
            <TableCell>{row.expected}</TableCell>
            <TableCell>{row.actual}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ReconciliationPanel({ raw }: { raw: unknown }) {
  const report = parseReconciliation(raw);
  if (!report) {
    return <p className="text-xs text-zinc-500">对账响应结构无法识别（前端只按已登记字段渲染，不做猜测）。</p>;
  }

  const diffCount = report.missing.length + report.duplicates.length + report.wrongAmount.length
    + report.orphans.length + report.ledgerOnly.duplicateKeys.length + report.ledgerOnly.nonPositive.length
    + report.unlinked.length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={report.consistent ? 'success' : 'destructive'}>
          {report.consistent ? '一致（consistent）' : '存在差异（inconsistent）'}
        </Badge>
        <span className="text-xs text-zinc-500">
          账期 {report.period || '—'} · 用量记录 {report.records} 条 · 账本镜像行 {report.mirrorRows} 条 · 差异项 {diffCount} 处
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-600">
        结论由服务端给出（consistent=true 当且仅当下列全部差异段为空）；本页只呈现明细，不重算对账。
      </p>

      <Segment title="缺失镜像" hint="用量记录存在但账本无对应行" count={report.missing.length}>
        <IssueTable rows={report.missing} />
      </Segment>

      <Segment title="重复镜像" hint="同一（用量记录，类型）出现多行（actual 为行数）" count={report.duplicates.length}>
        <IssueTable rows={report.duplicates} />
      </Segment>

      <Segment title="金额/数量不符" hint="镜像行数量与用量记录不一致（actual 为数量和）" count={report.wrongAmount.length}>
        <IssueTable rows={report.wrongAmount} />
      </Segment>

      <Segment title="孤儿镜像" hint="镜像行指向的用量记录已不存在" count={report.orphans.length}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>账本行</TableHead>
              <TableHead>用量记录</TableHead>
              <TableHead>类型</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.orphans.map((row, i) => (
              <TableRow key={`${row.ledgerId}-${i}`}>
                <TableCell className="font-mono text-xs text-zinc-400">{row.ledgerId}</TableCell>
                <TableCell className="font-mono text-xs text-zinc-400">{row.usageRecordId ?? '—'}</TableCell>
                <TableCell className="text-zinc-300">{row.kind}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Segment>

      <Segment title="仅账本行（ledgerOnly）" hint="按设计不产生用量记录的类型（agent_run / workflow_run 等），非差异" count={report.ledgerOnly.rows}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>类型</TableHead>
              <TableHead>行数</TableHead>
              <TableHead>数量和</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.ledgerOnly.kinds.length === 0 && <TableEmpty colSpan={3}>该账期无仅账本行</TableEmpty>}
            {report.ledgerOnly.kinds.map((row) => (
              <TableRow key={row.kind}>
                <TableCell className="text-zinc-300">{row.kind}</TableCell>
                <TableCell>{row.rows}</TableCell>
                <TableCell>{row.quantity}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-1 text-xs text-zinc-600">
          重复幂等键 {report.ledgerOnly.duplicateKeys.length} 个 · 非正数量 {report.ledgerOnly.nonPositive.length} 条
        </p>
      </Segment>

      <Segment title="未关联（unlinked）" hint="类型本应镜像用量记录，但 usageRecordId 为空" count={report.unlinked.length}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>账本行</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>幂等键</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.unlinked.map((row, i) => (
              <TableRow key={`${row.ledgerId}-${i}`}>
                <TableCell className="font-mono text-xs text-zinc-400">{row.ledgerId}</TableCell>
                <TableCell className="text-zinc-300">{row.kind}</TableCell>
                <TableCell className="font-mono text-xs text-zinc-400">{row.idempotencyKey}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Segment>
    </div>
  );
}
