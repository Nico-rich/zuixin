/**
 * M10-P9 运维脚本：备份 manifest（**机器可读的备份事实**）。
 *
 * 为什么要有 manifest：备份的"是否可信"必须能脱离人来回答——
 * 编排/告警只需要读 `<备份>.manifest.json` 里的 `checks[].ok` 与 `stats`，
 * 不必去猜"这个 5MB 的 .sql 到底完不完整"。
 */

import type { BackupCheck, DumpStats } from './dump';
import type { SecretPresence } from './env';

export const MANIFEST_TOOL = 'm10-backup';
export const MANIFEST_VERSION = 1;

export interface BackupManifest {
  tool: string;
  version: number;
  createdAt: string;
  /** 主机名（多实例/多环境时区分备份来源） */
  host: string;
  database: string;
  /** 脱敏后的连接描述（绝不含口令） */
  source: string;
  pgVersion: string;
  /** 备份模式：docker exec 容器内客户端 / 直连 */
  mode: string;
  files: {
    /** 明文 dump（--keep-plain 时保留；否则为 null——已压缩） */
    plain: string | null;
    plainBytes: number;
    gz: string;
    gzBytes: number;
    gzSha256: string;
  };
  stats: DumpStats;
  checks: BackupCheck[];
  /** 关键表行数（点名的几张业务表；便于事后对比"备份时刻的业务规模"） */
  keyTableRows: Record<string, number>;
  /** RPO=0 密钥清单（只报存在性，绝不报值） */
  secrets: Record<string, SecretPresence>;
  durations: { dumpMs: number; statsMs: number; compressMs: number; totalMs: number };
  /** 远端归档结果（未上传时为 null） */
  remote: { kind: 'minio'; target: string; uploaded: string[] } | null;
  /** 保留提示（保留策略是运维约定，脚本只回显） */
  retentionHint: string;
}

export function buildBackupManifest(input: Omit<BackupManifest, 'tool' | 'version' | 'createdAt'> & { createdAt?: string }): BackupManifest {
  return {
    tool: MANIFEST_TOOL,
    version: MANIFEST_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    host: input.host,
    database: input.database,
    source: input.source,
    pgVersion: input.pgVersion,
    mode: input.mode,
    files: input.files,
    stats: input.stats,
    checks: input.checks,
    keyTableRows: input.keyTableRows,
    secrets: input.secrets,
    durations: input.durations,
    remote: input.remote,
    retentionHint: input.retentionHint,
  };
}

/** manifest 的健康结论（编排/告警读这一行即可）。 */
export function manifestVerdict(manifest: BackupManifest): { ok: boolean; failed: string[] } {
  const failed = manifest.checks.filter((c) => !c.ok).map((c) => c.name);
  return { ok: failed.length === 0, failed };
}

/** 人类可读摘要（stdout 打印；字段与 manifest 一一对应，便于对照）。 */
export function manifestSummaryLines(m: BackupManifest): string[] {
  const verdict = manifestVerdict(m);
  const lines: string[] = [];
  lines.push(`备份结论：${verdict.ok ? 'PASS（全部校验通过）' : `FAIL（失败项：${verdict.failed.join(', ')}）`}`);
  lines.push(`数据库：${m.database} @ ${m.source}`);
  lines.push(`客户端：${m.pgVersion}（模式 ${m.mode}）`);
  lines.push(`明文 dump：${m.files.plain ?? '（已压缩后删除）'}  ${m.files.plainBytes} 字节`);
  lines.push(`压缩产物：${m.files.gz}  ${m.files.gzBytes} 字节  sha256=${m.files.gzSha256}`);
  lines.push(`内容统计：表 ${m.stats.tables} / COPY 段 ${m.stats.copySegments} / 数据行 ${m.stats.totalRows} / 扩展 [${m.stats.extensions.join(',')}] / 索引语句 ${m.stats.indexStatements} / 迁移行 ${String(m.stats.migrationsRows)}`);
  lines.push(`关键表行数：${Object.entries(m.keyTableRows).map(([k, v]) => `${k}=${v}`).join('  ') || '（未采集）'}`);
  lines.push(`耗时：dump ${m.durations.dumpMs}ms / 统计 ${m.durations.statsMs}ms / 压缩 ${m.durations.compressMs}ms / 合计 ${m.durations.totalMs}ms`);
  for (const c of m.checks) lines.push(`  [${c.ok ? 'ok' : 'FAIL'}] ${c.name} — ${c.detail}`);
  return lines;
}

/** 备份文件名的规范形式（时间戳 + 可选标签；order 便于 `ls | sort` 取最新）。 */
export function backupFileName(opts: { database: string; stamp: string; label?: string; compressed?: boolean }): string {
  const label = opts.label ? `-${opts.label.replace(/[^A-Za-z0-9._-]/g, '_')}` : '';
  return `${opts.database}${label}-${opts.stamp}.sql${opts.compressed ? '.gz' : ''}`;
}

/** 从备份文件名解析时间戳（保留/清理策略按它排序，而不是按 mtime——拷贝会改动 mtime）。 */
export function stampFromBackupName(name: string): string | null {
  const m = /-(\d{8}-\d{6})(?:\.sql)(?:\.gz)?$/.exec(name);
  return m ? m[1] : null;
}
