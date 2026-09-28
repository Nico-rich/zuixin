import { describe, expect, it } from 'vitest';
import { helpText, parseArgs, type FlagSpec } from './args';

const SPECS: readonly FlagSpec[] = [
  { name: 'out-dir', alias: 'o', type: 'string', valueName: '<dir>', help: '输出目录' },
  { name: 'label', type: 'string', valueName: '<tag>', default: 'daily', help: '标签' },
  { name: 'confirm', type: 'boolean', help: '确认执行' },
  { name: 'keep', type: 'number', valueName: '<n>', default: 30, help: '保留份数' },
];

describe('parseArgs（运维脚本的参数闸门）', () => {
  it('长/短/等号/空格四种写法都能解析', () => {
    const a = parseArgs(['--out-dir', '/tmp/b', '-o', '/tmp/c'], SPECS);
    expect(a.ok).toBe(true);
    if (!a.ok || !a.parsed) throw new Error('unreachable');
    expect(a.parsed.values['out-dir']).toBe('/tmp/c'); // 后者覆盖前者（命令行语义）
    const b = parseArgs(['--out-dir=/tmp/d'], SPECS);
    if (!b.ok || !b.parsed) throw new Error('unreachable');
    expect(b.parsed.values['out-dir']).toBe('/tmp/d');
  });

  it('默认值生效，且 provided 能区分"显式给了默认值"', () => {
    const a = parseArgs([], SPECS);
    if (!a.ok || !a.parsed) throw new Error('unreachable');
    expect(a.parsed.values.label).toBe('daily');
    expect(a.parsed.values.keep).toBe(30);
    expect(a.parsed.values.confirm).toBe(false);
    expect(a.parsed.provided.size).toBe(0);

    const b = parseArgs(['--label', 'daily', '--keep', '7'], SPECS);
    if (!b.ok || !b.parsed) throw new Error('unreachable');
    expect(b.parsed.provided.has('label')).toBe(true);
    expect(b.parsed.values.keep).toBe(7);
  });

  it('未知参数直接失败（拼错 --confirm 绝不静默继续）', () => {
    const r = parseArgs(['--confrim'], SPECS);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toContain('未知参数');
  });

  it('缺取值 / 数字非法 / 布尔取值非法 都失败', () => {
    const missing = parseArgs(['--out-dir'], SPECS);
    expect(missing.ok).toBe(false);
    const badNumber = parseArgs(['--keep', 'abc'], SPECS);
    expect(badNumber.ok).toBe(false);
    const badBool = parseArgs(['--confirm=maybe'], SPECS);
    expect(badBool.ok).toBe(false);
    // boolean 不接受 `--confirm false`（那会把 false 当位置参数，静默走错分支）
    const boolSpace = parseArgs(['--confirm', 'false'], SPECS);
    if (!boolSpace.ok || !boolSpace.parsed) throw new Error('unreachable');
    expect(boolSpace.parsed.values.confirm).toBe(true);
    expect(boolSpace.parsed.positionals).toEqual(['false']);
  });

  it('--help / -h 返回 help 标记（调用方必须打印帮助后 exit 0）', () => {
    for (const flag of ['--help', '-h']) {
      const r = parseArgs([flag], SPECS);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      expect(r.help).toBe(true);
      expect(r.parsed).toBeNull();
    }
  });

  it('`--` 之后一律视为位置参数', () => {
    const r = parseArgs(['--', '--confirm', 'x'], SPECS);
    if (!r.ok || !r.parsed) throw new Error('unreachable');
    expect(r.parsed.positionals).toEqual(['--confirm', 'x']);
    expect(r.parsed.values.confirm).toBe(false);
  });

  it('helpText 覆盖全部参数名与退出码（帮助文档不许漂移）', () => {
    const text = helpText({
      script: 'backup.ts',
      summary: '摘要',
      specs: SPECS,
      examples: ['npx tsx scripts/backup.ts'],
      exitCodes: [['0', '成功'], ['2', '参数错误']],
    });
    for (const s of SPECS) expect(text).toContain(`--${s.name}`);
    expect(text).toContain('--help');
    expect(text).toContain('npx tsx scripts/backup.ts');
    expect(text).toContain('参数错误');
    expect(text).toContain('默认：daily');
  });
});
