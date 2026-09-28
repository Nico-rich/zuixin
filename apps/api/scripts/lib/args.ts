/**
 * M10-P9 运维脚本：极小参数解析器（零依赖、可单测）。
 *
 * 设计约束（`docs/architecture/m10-implementation-plan.md` §6 A9）：
 * - 纯新文件，不进任何既有模块；不新增 npm 依赖（只用 node: 内置 + api 已有的 devDependency）；
 * - 每个脚本必须支持 `--help` 且**未知参数直接失败**（运维脚本最危险的行为是"静默忽略参数后
 *   按默认值执行"，例如把 `--confirm` 拼错成 `--confrim` 后仍然跑了一次恢复）。
 */

export type FlagType = 'boolean' | 'string' | 'number';

export interface FlagSpec {
  /** 长名，不含 `--`（如 `out-dir`） */
  name: string;
  /** 短名，不含 `-`（如 `o`） */
  alias?: string;
  type: FlagType;
  /** 帮助文本里的取值占位（string/number 用，如 `<dir>`） */
  valueName?: string;
  /** 默认值（帮助文本会标注；boolean 默认 false）。需要"未提供则 undefined"时不要给 default */
  default?: string | number | boolean;
  /** 帮助文本 */
  help: string;
  /** 可重复（收集为数组）——本仓库脚本暂不使用，保留扩展点 */
  repeatable?: boolean;
}

export interface ParsedArgs {
  /** 规范化后的键：长名（kebab-case），布尔缺省为 false（有 default 时用 default） */
  values: Record<string, string | number | boolean>;
  positionals: string[];
  /** 用户是否显式提供了该参数（区分"默认值"与"显式给了默认值"） */
  provided: Set<string>;
}

export type ParseResult =
  | { ok: true; parsed: ParsedArgs; help: false }
  | { ok: true; parsed: null; help: true }
  | { ok: false; error: string };

function findSpec(specs: FlagSpec[], token: string): FlagSpec | undefined {
  return specs.find((s) => s.name === token || (s.alias !== undefined && s.alias === token));
}

function coerce(spec: FlagSpec, raw: string | undefined, flag: string): { ok: true; value: string | number | boolean } | { ok: false; error: string } {
  if (spec.type === 'boolean') {
    // boolean 只接受 --flag / --flag=true|false，绝不接受 `--flag false`（后者会把 false 当位置参数）
    if (raw === undefined) return { ok: true, value: true };
    if (raw === 'true' || raw === '1') return { ok: true, value: true };
    if (raw === 'false' || raw === '0') return { ok: true, value: false };
    return { ok: false, error: `参数 --${flag} 只接受 true/false，收到 "${raw}"` };
  }
  if (raw === undefined || raw === '') return { ok: false, error: `参数 --${flag} 需要一个取值` };
  if (spec.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: `参数 --${flag} 需要一个数字，收到 "${raw}"` };
    return { ok: true, value: n };
  }
  return { ok: true, value: raw };
}

/** 解析 argv（不含 node/script 两项）。`--help`/`-h` 一律返回 help（调用方打印后 exit 0）。 */
export function parseArgs(argv: readonly string[], specs: readonly FlagSpec[]): ParseResult {
  const values: Record<string, string | number | boolean> = {};
  const provided = new Set<string>();
  const positionals: string[] = [];
  for (const spec of specs) {
    if (spec.default !== undefined) values[spec.name] = spec.default;
    else if (spec.type === 'boolean') values[spec.name] = false;
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') return { ok: true, parsed: null, help: true };
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    const isLong = token.startsWith('--');
    const body = isLong ? token.slice(2) : token.slice(1);
    const eq = body.indexOf('=');
    const name = eq >= 0 ? body.slice(0, eq) : body;
    const inlineRaw = eq >= 0 ? body.slice(eq + 1) : undefined;

    const spec = findSpec(specs as FlagSpec[], name);
    if (!spec) return { ok: false, error: `未知参数：${token}（用 --help 查看可用参数）` };

    let raw = inlineRaw;
    if (raw === undefined && spec.type !== 'boolean') {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        return { ok: false, error: `参数 --${spec.name} 缺少取值` };
      }
      raw = next;
      i += 1;
    }
    const coerced = coerce(spec, raw, spec.name);
    if (!coerced.ok) return coerced;
    values[spec.name] = coerced.value;
    provided.add(spec.name);
  }

  return { ok: true, parsed: { values, positionals, provided }, help: false };
}

/** 生成 `--help` 文本（脚本名 + 摘要 + 参数 + 示例 + 退出码）。 */
export function helpText(opts: {
  script: string;
  summary: string;
  usage?: string;
  specs: readonly FlagSpec[];
  examples?: readonly string[];
  exitCodes?: readonly [string, string][];
  notes?: readonly string[];
}): string {
  const lines: string[] = [];
  lines.push(`${opts.script} — ${opts.summary}`);
  lines.push('');
  lines.push(`用法：${opts.usage ?? `npx tsx scripts/${opts.script} [选项]`}`);
  lines.push('');
  lines.push('选项：');
  const rows: [string, string][] = opts.specs.map((s) => {
    const short = s.alias ? `-${s.alias}, ` : '    ';
    const value = s.type === 'boolean' ? '' : ` ${s.valueName ?? '<value>'}`;
    let help = s.help;
    if (s.type === 'boolean') help += '（布尔开关）';
    else if (s.default !== undefined) help += `（默认：${String(s.default)}）`;
    return [`  ${short}--${s.name}${value}`, help];
  });
  rows.push(['  -h, --help', '打印本帮助并退出（不执行任何动作）']);
  const width = Math.max(...rows.map((r) => r[0].length));
  for (const [left, right] of rows) lines.push(`${left.padEnd(width)}  ${right}`);
  if (opts.notes?.length) {
    lines.push('');
    lines.push('说明：');
    for (const n of opts.notes) lines.push(`  - ${n}`);
  }
  if (opts.examples?.length) {
    lines.push('');
    lines.push('示例：');
    for (const e of opts.examples) lines.push(`  ${e}`);
  }
  lines.push('');
  lines.push('退出码：');
  for (const [code, meaning] of opts.exitCodes ?? [['0', '成功'], ['1', '执行失败'], ['2', '参数错误']]) {
    lines.push(`  ${code}  ${meaning}`);
  }
  return lines.join('\n');
}
