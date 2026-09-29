import { describe, expect, it } from 'vitest';
import { assessPlaintextUpload, isLoopbackEndpoint, type PlaintextUploadInput } from './upload-gate';

/** 判定输入的便捷构造：默认"会上传 + 未加密 + 非本机远端 + 未给开关"——正是闸门必须拦住的形态。 */
function input(over: Partial<PlaintextUploadInput> = {}): PlaintextUploadInput {
  return { upload: true, encryption: 'none', endpoint: 'minio.example.com', allowPlaintextUpload: false, ...over };
}

describe('loopback 端点识别（决定"要不要显式确认"的唯一前提）', () => {
  it('本机形态一律判 true（含 scheme-less、端口、带路径与首尾空白）', () => {
    const locals = [
      'http://localhost:9000',
      'https://LOCALHOST:9000', // 主机名大小写不敏感（URL 会归一化）
      'localhost:9000', // scheme-less：编排/环境变量里最常见的写法
      'localhost',
      '  localhost:9000  ', // 首尾空白先被 trim
      'http://127.0.0.1:9000/path?x=1',
      '127.0.0.1:9000',
      '127.9.9.9', // 127.0.0.0/8 整段都是 loopback，不是只有 .0.1
      '127.1', // WHATWG 规范化 ⇒ 127.0.0.1
      '0x7f.0.0.1', // 十六进制写法同样被规范化成 127.0.0.1
      'foo.localhost', // *.localhost 整个域都解析到本机
      '0.0.0.0', // "本机的任意地址"：客户端连它即连本机
      '[::1]',
      '[::1]:9000', // URL authority 里 IPv6 的合法写法（必须带方括号）
    ];
    for (const endpoint of locals) {
      expect(isLoopbackEndpoint(endpoint), `期望判为本机：${endpoint}`).toBe(true);
    }
  });

  it('非本机形态一律判 false（容器服务名照样算非本机：不猜网络拓扑）', () => {
    const remotes = [
      'minio.example.com',
      'https://s3.us-east-1.amazonaws.com',
      'minio:9000', // docker service name：看着像"内网"，但同样可能被其它容器/宿主机抓到
      'minio',
      '10.0.0.5',
      '172.17.0.2',
      '192.168.1.10',
      '8.8.8.8',
      'localhost.evil.com', // 后缀陷阱：域名里含 localhost ≠ 本机
      'notlocalhost',
    ];
    for (const endpoint of remotes) {
      expect(isLoopbackEndpoint(endpoint), `期望判为非本机：${endpoint}`).toBe(false);
    }
  });

  it('空串 / 空白 / 不可解析的端点 ⇒ false（保守方向：宁可多要一次许可，也不默默放行）', () => {
    const unparsable = ['', '   ', 'http://', 'http://:9000', 'not a url', 'http://a b c'];
    for (const endpoint of unparsable) {
      expect(isLoopbackEndpoint(endpoint), `期望按保守方向判为非本机：${JSON.stringify(endpoint)}`).toBe(false);
    }
  });

  it('越界的八位组 ⇒ false（127.0.0.999 不是 127.0.0.0/8 里的合法地址）', () => {
    const invalid = ['127.0.0.999', '127.0.0.256', '999.0.0.1', '127.0.0.1.5'];
    for (const endpoint of invalid) {
      expect(isLoopbackEndpoint(endpoint), `期望拒绝非法地址：${endpoint}`).toBe(false);
    }
  });

  it('IPv6 loopback：带方括号与**裸写**都判 true（裸写需补方括号后二次解析）', () => {
    // 裸 IPv6 字面量（`::1`）不加方括号时 WHATWG URL 抛 Invalid URL ⇒ 源码第二步补 `[::1]` 重试。
    // 少了这一步，`::1` 会静默落进"解析失败 ⇒ false"的保守分支（多要一次 --allow-plaintext-upload，
    // 不致命但错）：M12-P5 复审时修掉，这里按修好后的行为断言。
    expect(isLoopbackEndpoint('[::1]')).toBe(true);
    expect(isLoopbackEndpoint('[::1]:9000')).toBe(true);
    expect(isLoopbackEndpoint('::1')).toBe(true);
    expect(isLoopbackEndpoint('0:0:0:0:0:0:0:1')).toBe(true);
  });

  it('IPv6 边界：IPv4-mapped loopback 与"看着像 IPv6 的坏值"一律判非本机（保守方向：多要一次许可）', () => {
    // URL 会把 `::ffff:127.0.0.1` 规范化为 `::ffff:7f00:1`，与源码里的 `::1` 字面量对不上 ⇒ 判非本机。
    // 这是**有意**的诚实边界（宁可多要一次 `--allow-plaintext-upload`，也不猜地址族语义）。
    expect(isLoopbackEndpoint('::ffff:127.0.0.1')).toBe(false);
    expect(isLoopbackEndpoint('[::ffff:127.0.0.1]')).toBe(false);
    expect(isLoopbackEndpoint(':::1')).toBe(false); // 畸形：不是合法 IPv6
  });
});

describe('明文外发闸门（backup --upload 的强制确认）', () => {
  it('未上传 ⇒ 与本闸门无关（无论加密形态与端点在哪）', () => {
    const remote = assessPlaintextUpload(input({ upload: false }));
    expect(remote).toEqual({ ok: true, local: false, acknowledgementRequired: false, notice: null, reason: null });

    const local = assessPlaintextUpload(input({ upload: false, endpoint: 'http://localhost:9000' }));
    expect(local).toEqual({ ok: true, local: true, acknowledgementRequired: false, notice: null, reason: null });
  });

  it("encryption='gpg' ⇒ 与本闸门无关（推荐形态：推到远端也放行，且不需要任何确认）", () => {
    const remote = assessPlaintextUpload(input({ encryption: 'gpg' }));
    expect(remote).toEqual({ ok: true, local: false, acknowledgementRequired: false, notice: null, reason: null });

    const explicit = assessPlaintextUpload(input({ encryption: 'gpg', endpoint: 'minio:9000' }));
    expect(explicit.ok).toBe(true);
    expect(explicit.reason).toBeNull();
    expect(explicit.notice).toBeNull();
    expect(explicit.acknowledgementRequired).toBe(false);
  });

  it('上传 + 未加密 + 本机端点 ⇒ 放行，但留一条"仅限开发环境"的提醒（不要求确认）', () => {
    const v = assessPlaintextUpload(input({ endpoint: 'http://localhost:9000' }));
    expect(v.ok).toBe(true);
    expect(v.local).toBe(true);
    expect(v.acknowledgementRequired).toBe(false);
    expect(v.reason).toBeNull();
    expect(v.notice).toContain('本机');
    expect(v.notice).toContain('开发');
    expect(v.notice).toContain('http://localhost:9000'); // 提醒里点明打到了哪个端点
    expect(v.notice).toContain('--encrypt gpg'); // 提醒也要给出正路
  });

  it('上传 + 未加密 + 非本机端点 + 无开关 ⇒ 拒绝，且原因里两条逃生口都可执行', () => {
    const v = assessPlaintextUpload(input({ endpoint: 'minio.example.com' }));
    expect(v.ok).toBe(false);
    expect(v.local).toBe(false);
    expect(v.notice).toBeNull();
    expect(v.reason).not.toBeNull();

    const reason = v.reason as string;
    expect(reason).toContain('未加密');
    expect(reason).toContain('minio.example.com'); // 说清是往哪儿发
    expect(reason).toContain('--encrypt gpg'); // 正路①：加密
    expect(reason).toContain('--allow-plaintext-upload'); // 正路②：显式承认风险
    // 两条"正路"必须是可照抄的开关写法，而不是只有一句"请自行加密"
    expect(reason).toMatch(/①[^\n]*--encrypt gpg/);
    expect(reason).toMatch(/②[^\n]*--allow-plaintext-upload/);
  });

  it('上传 + 未加密 + 非本机 + 已给 --allow-plaintext-upload ⇒ 放行，但标注"需要确认"并留痕', () => {
    const v = assessPlaintextUpload(input({ endpoint: 'minio.example.com', allowPlaintextUpload: true }));
    expect(v.ok).toBe(true);
    expect(v.local).toBe(false);
    expect(v.acknowledgementRequired).toBe(true); // 这是"运维已显式承认风险"的事实，必须能被上报
    expect(v.reason).toBeNull();
    expect(v.notice).toContain('--allow-plaintext-upload');
    expect(v.notice).toContain('minio.example.com');
  });

  it('端点未配置（空串）⇒ 按非本机处理：要显式许可，绝不默默放行', () => {
    const v = assessPlaintextUpload(input({ endpoint: '' }));
    expect(v.local).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('（未配置端点）');

    // 未配置端点 + 显式许可 ⇒ 放行（不因端点拼不出来而卡死运维）
    const allowed = assessPlaintextUpload(input({ endpoint: '  ', allowPlaintextUpload: true }));
    expect(allowed.ok).toBe(true);
    expect(allowed.acknowledgementRequired).toBe(true);
  });

  it('acknowledgementRequired 真值表：只有"上传 + 未加密 + 非本机"才要确认', () => {
    const rows: Array<[string, PlaintextUploadInput, boolean]> = [
      ['未上传 + 未加密 + 非本机', input({ upload: false }), false],
      ['未上传 + 未加密 + 本机', input({ upload: false, endpoint: 'http://localhost:9000' }), false],
      ['已加密 + 非本机', input({ encryption: 'gpg' }), false],
      ['已加密 + 本机', input({ encryption: 'gpg', endpoint: 'http://localhost:9000' }), false],
      ['未加密 + 本机', input({ endpoint: 'http://localhost:9000' }), false],
      ['未加密 + 非本机 + 未给开关（拒绝）', input(), true],
      ['未加密 + 非本机 + 已给开关', input({ allowPlaintextUpload: true }), true],
    ];
    for (const [label, given, expected] of rows) {
      expect(assessPlaintextUpload(given).acknowledgementRequired, label).toBe(expected);
    }
  });
});
