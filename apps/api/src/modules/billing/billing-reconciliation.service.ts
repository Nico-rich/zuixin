import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError, ErrorCode } from '../../common/errors/app-error';

/** 单个偏差（对账发现的漂移行） */
export interface ReconciliationIssue {
  usageRecordId: string;
  kind: string;
  expected: number;
  actual: number;
}

/**
 * D1-08：ledger-only 段（无 UsageRecord 事实源、由调用方直接计量的账本行）。
 * 原实现用 `usageRecordId: { not: null }` 把它们**整类过滤**——即"存在账本行，报告里看不见"，
 * 该段补上这条盲区：幂等键唯一性（同键多行 = 结构性重复计量）+ 数量口径（≤0 行不进账，是坏写）。
 */
export interface LedgerOnlySegment {
  /** 本期 ledger-only 行数 */
  rows: number;
  /** kind → 行数与数量和（数量口径复核用） */
  kinds: Record<string, { rows: number; quantity: number }>;
  /** 幂等键重复：同键多行（正常写入绝不产生——唯一约束之外的脏数据） */
  duplicateKeys: Array<{ idempotencyKey: string; kind: string; count: number }>;
  /** 数量口径违例：quantity ≤ 0 的账本行（写入器恒 ≥1；0 行是"计了但没计"） */
  nonPositive: Array<{ ledgerId: string; kind: string; quantity: number }>;
}

export interface ReconciliationReport {
  organizationId: string;
  period: string;
  records: number;
  mirrorRows: number;
  missing: ReconciliationIssue[];   // 有 UsageRecord 但缺对应镜像账本行
  duplicates: ReconciliationIssue[]; // 同 (record, kind) 镜像行多于 1
  wrongAmount: ReconciliationIssue[]; // 镜像行数量与事实不符
  orphans: Array<{ ledgerId: string; usageRecordId: string | null; kind: string }>; // 指向不存在记录的账本行
  /** D1-08：ledger-only kind 独立校验段（无 UsageRecord 的行，参与 consistent 结论） */
  ledgerOnly: LedgerOnlySegment;
  /** 同一条 `usageRecordId: { not: null } 谓词造成的同源盲区：应有记录关联却为空的账本行 */
  unlinked: Array<{ ledgerId: string; kind: string; idempotencyKey: string }>;
  consistent: boolean;
}

/**
 * 镜像 kind：必须由 UsageRecord 派生（usageRecordId 非空）——为空即"投影失去事实链"。
 * 其补集即 ledger-only kind（无事实源的离散事件行，写点：agent_run=run 终态、
 * workflow_run=run 创建、external_api_call=外部动作完成、attachment_upload=对象入库；
 * storage/seat 为 M11 P3 摘除的死配置预留 kind——无写点，历史行仍按本段对账）。
 */
export const MIRROR_LEDGER_KINDS: readonly string[] = [
  'llm_tokens', 'llm_cost', 'image_generation', 'video_seconds',
];

const MIRROR_KIND_SET = new Set(MIRROR_LEDGER_KINDS);

/**
 * Pre-M9 D1：UsageRecord（事实）↔ UsageLedgerEntry（投影）对账。
 * 只读诊断——发现 missing/duplicate/wrongAmount/orphan/ledgerOnly/unlinked 后由运维决策修复
 * （绝不自动改事实）。
 * 镜像期望（与 UsageService.mirrorLedger 同源）：llm_chat → llm_tokens=in+out、llm_cost=estimatedCost；
 * image → image_generation=max(imageCount,1)；video → video_seconds=max(videoSeconds,1)。
 *
 * M11 P3（D2-15）窗口口径：records 与 ledger **同界** [当月首日, 下月首日)——原实现只在当月给
 * records 挂 `lt: new Date()`、历史月无上界，且 ledger 侧完全没有时间/月份谓词（无界全量扫描）。
 * 后果：查历史月时报告里混进**此后所有月份**的记录与账本行，结论不是那个月的结论。
 */
@Injectable()
export class BillingReconciliationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 对账指定组织指定月份（period=YYYY-MM，缺省当前 UTC 月） */
  async diagnose(organizationId: string, period?: string): Promise<ReconciliationReport> {
    const month = period ?? this.periodOf();
    if (!/^\d{4}-\d{2}$/.test(month) || Number(month.slice(5)) < 1 || Number(month.slice(5)) > 12) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'period 需为 YYYY-MM');
    }
    const start = new Date(`${month}-01T00:00:00.000Z`);
    // 下月首日（**无条件**上界；当月同样成立——未来的行本就不该计入本期）
    const end = new Date(`${this.nextPeriodOf(month)}-01T00:00:00.000Z`);

    // 两个查询同界 [start, end)：镜像是记录的派生行（同事务语义——写点在记录之后几毫秒内），
    // 故同窗口比对成立；跨月边界的毫秒级错位（记录 23:59:59.9xx + 镜像 00:00:00.0xx）属已知
    // 理论窗口，误差自愈（幂等键 ur:{recordId}:{kind} 使补写不产生重复计量）。
    const [records, ledgerRows] = await Promise.all([
      this.prisma.usageRecord.findMany({
        where: { organizationId, createdAt: { gte: start, lt: end } },
        select: { id: true, kind: true, inputTokens: true, outputTokens: true, estimatedCost: true, imageCount: true, videoSeconds: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.usageLedgerEntry.findMany({
        where: { organizationId, createdAt: { gte: start, lt: end } },
        select: { id: true, kind: true, quantity: true, usageRecordId: true, idempotencyKey: true },
      }),
    ]);
    // 本期记录 id 集合（跨期账本镜像不参与——镜像与记录同事务写入，时刻一致）
    const recordIds = new Set(records.map((r) => r.id));

    const mirrorRows = ledgerRows.filter((row) => row.usageRecordId !== null);
    const nullLinkRows = ledgerRows.filter((row) => row.usageRecordId === null);
    // 应有事实链却断链（镜像 kind 的 usageRecordId 为空）——与 missing 互补：缺行 vs 断链
    const unlinked = nullLinkRows
      .filter((row) => MIRROR_KIND_SET.has(row.kind))
      .map((row) => ({ ledgerId: row.id, kind: row.kind, idempotencyKey: row.idempotencyKey }));
    // ledger-only 行：无 UsageRecord 事实源（含 storage/seat 等预留 kind 与任何未知 kind——一律纳入校验）
    const ledgerOnlyRows = nullLinkRows.filter((row) => !MIRROR_KIND_SET.has(row.kind));

    const expectedOf = (r: (typeof records)[number]): Array<{ kind: string; value: number }> => {
      if (r.kind === 'llm_chat') {
        return [
          { kind: 'llm_tokens', value: r.inputTokens + r.outputTokens },
          { kind: 'llm_cost', value: r.estimatedCost },
        ];
      }
      if (r.kind === 'image') return [{ kind: 'image_generation', value: Math.max(r.imageCount, 1) }];
      if (r.kind === 'video') return [{ kind: 'video_seconds', value: Math.max(r.videoSeconds, 1) }];
      return [];
    };

    // 按 (usageRecordId, kind) 聚合镜像
    const byKey = new Map<string, { ledgerId: string; quantity: number; count: number }>();
    for (const row of mirrorRows) {
      if (!row.usageRecordId) continue;
      const key = `${row.usageRecordId}:${row.kind}`;
      const cur = byKey.get(key) ?? { ledgerId: row.id, quantity: 0, count: 0 };
      cur.quantity += row.quantity;
      cur.count += 1;
      byKey.set(key, cur);
    }

    const missing: ReconciliationIssue[] = [];
    const duplicates: ReconciliationIssue[] = [];
    const wrongAmount: ReconciliationIssue[] = [];
    for (const r of records) {
      for (const exp of expectedOf(r)) {
        const key = `${r.id}:${exp.kind}`;
        const got = byKey.get(key);
        if (!got || got.count === 0) {
          // 零量行不镜像（失败调用无 token/成本）——期望值 0 时缺行不算漂移
          if (exp.value > 0) missing.push({ usageRecordId: r.id, kind: exp.kind, expected: exp.value, actual: 0 });
          continue;
        }
        if (got.count > 1) duplicates.push({ usageRecordId: r.id, kind: exp.kind, expected: exp.value, actual: got.count });
        if (Math.abs(got.quantity - exp.value) > 1e-9) {
          wrongAmount.push({ usageRecordId: r.id, kind: exp.kind, expected: exp.value, actual: got.quantity });
        }
      }
    }

    const orphans = mirrorRows
      .filter((row) => row.usageRecordId && !recordIds.has(row.usageRecordId))
      .map((row) => ({ ledgerId: row.id, usageRecordId: row.usageRecordId, kind: row.kind }));

    // D1-08：ledger-only 段（幂等键唯一性 + 数量口径）
    const kinds: Record<string, { rows: number; quantity: number }> = {};
    const keyCounts = new Map<string, { kind: string; count: number }>();
    const nonPositive: LedgerOnlySegment['nonPositive'] = [];
    for (const row of ledgerOnlyRows) {
      const agg = kinds[row.kind] ?? { rows: 0, quantity: 0 };
      agg.rows += 1;
      agg.quantity += row.quantity;
      kinds[row.kind] = agg;
      const seen = keyCounts.get(row.idempotencyKey) ?? { kind: row.kind, count: 0 };
      seen.count += 1;
      keyCounts.set(row.idempotencyKey, seen);
      if (!(row.quantity > 0)) nonPositive.push({ ledgerId: row.id, kind: row.kind, quantity: row.quantity });
    }
    const duplicateKeys = [...keyCounts.entries()]
      .filter(([, v]) => v.count > 1)
      .map(([idempotencyKey, v]) => ({ idempotencyKey, kind: v.kind, count: v.count }));
    const ledgerOnly: LedgerOnlySegment = { rows: ledgerOnlyRows.length, kinds, duplicateKeys, nonPositive };

    return {
      organizationId,
      period: month,
      records: records.length,
      mirrorRows: mirrorRows.filter((r) => r.usageRecordId && recordIds.has(r.usageRecordId)).length,
      missing, duplicates, wrongAmount, orphans,
      ledgerOnly, unlinked,
      consistent:
        missing.length === 0 && duplicates.length === 0 && wrongAmount.length === 0 && orphans.length === 0
        && ledgerOnly.duplicateKeys.length === 0 && ledgerOnly.nonPositive.length === 0 && unlinked.length === 0,
    };
  }

  private periodOf(d = new Date()): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /** 下一个月键（12 月 → 次年 01）——历史月与当月同一套上界口径 */
  private nextPeriodOf(month: string): string {
    const year = Number(month.slice(0, 4));
    const m = Number(month.slice(5));
    return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
  }
}
