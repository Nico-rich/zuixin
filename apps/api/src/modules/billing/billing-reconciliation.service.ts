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

export interface ReconciliationReport {
  organizationId: string;
  period: string;
  records: number;
  mirrorRows: number;
  missing: ReconciliationIssue[];   // 有 UsageRecord 但缺对应镜像账本行
  duplicates: ReconciliationIssue[]; // 同 (record, kind) 镜像行多于 1
  wrongAmount: ReconciliationIssue[]; // 镜像行数量与事实不符
  orphans: Array<{ ledgerId: string; usageRecordId: string | null; kind: string }>; // 指向不存在记录的账本行
  consistent: boolean;
}

/**
 * Pre-M9 D1：UsageRecord（事实）↔ UsageLedgerEntry（投影）对账。
 * 只读诊断——发现 missing/duplicate/wrongAmount/orphan 后由运维决策修复（绝不自动改事实）。
 * 镜像期望（与 UsageService.mirrorLedger 同源）：llm_chat → llm_tokens=in+out、llm_cost=estimatedCost；
 * image → image_generation=max(imageCount,1)；video → video_seconds=max(videoSeconds,1)。
 */
@Injectable()
export class BillingReconciliationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 对账指定组织指定月份（period=YYYY-MM，缺省当前 UTC 月） */
  async diagnose(organizationId: string, period?: string): Promise<ReconciliationReport> {
    const month = period ?? this.periodOf();
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError(ErrorCode.VALIDATION_ERROR, 'period 需为 YYYY-MM');
    const start = new Date(`${month}-01T00:00:00.000Z`);

    const [records, mirrorRows] = await Promise.all([
      this.prisma.usageRecord.findMany({
        where: { organizationId, createdAt: { gte: start, ...(month === this.periodOf() ? { lt: new Date() } : {}) } },
        select: { id: true, kind: true, inputTokens: true, outputTokens: true, estimatedCost: true, imageCount: true, videoSeconds: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.usageLedgerEntry.findMany({
        where: { organizationId, usageRecordId: { not: null } },
        select: { id: true, kind: true, quantity: true, usageRecordId: true },
      }),
    ]);
    // 本月记录 id 集合（跨月账本镜像不参与——镜像与记录同事务写入，时刻一致）
    const recordIds = new Set(records.map((r) => r.id));

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

    return {
      organizationId,
      period: month,
      records: records.length,
      mirrorRows: mirrorRows.filter((r) => r.usageRecordId && recordIds.has(r.usageRecordId)).length,
      missing, duplicates, wrongAmount, orphans,
      consistent: missing.length === 0 && duplicates.length === 0 && wrongAmount.length === 0 && orphans.length === 0,
    };
  }

  private periodOf(d = new Date()): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
}
