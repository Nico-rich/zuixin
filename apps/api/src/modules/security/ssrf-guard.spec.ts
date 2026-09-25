import { describe, it, expect } from 'vitest';
import {
  DnsResolver, assertSafeUrl, checkUrlSync, classifyIp, expandIpv6, isInternalHostname,
  nodeDnsResolver, normalizeHostname,
} from './ssrf-guard';

/** 可控解析器（DNS 边界替换点；不依赖外网） */
const resolverOf = (map: Record<string, string[]>): DnsResolver =>
  async (host) => {
    const hit = map[host];
    if (!hit) throw new Error(`ENOTFOUND ${host}`);
    return hit;
  };

const PUBLIC = ['93.184.216.34'];

describe('ssrf-guard / classifyIp（IPv4 私网与保留段）', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255',
    '169.254.169.254', '169.254.0.1', '0.0.0.0', '100.64.0.1', '100.127.255.255',
    '192.0.0.1', '192.0.2.5', '198.18.0.1', '198.51.100.9', '203.0.113.9',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  ])('拒绝 %s', (ip) => {
    const r = classifyIp(ip);
    expect(r.unsafe).toBe(true);
    expect(r.category).toBeTruthy();
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255', '11.0.0.1', '100.63.255.255', '100.128.0.1', '196.0.0.1'])('放行公网 %s', (ip) => {
    expect(classifyIp(ip).unsafe).toBe(false);
  });
});

describe('ssrf-guard / classifyIp（IPv6 形态，含绕过形态）', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fd00::1', 'ULA'],
    ['fcff::1', 'ULA'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'TEST-NET'],
    ['2001::1', 'Teredo'],
    ['3fff::1', 'TEST-NET'],
  ])('拒绝 %s（%s）', (ip) => {
    expect(classifyIp(ip).unsafe).toBe(true);
  });

  it('IPv4-mapped ::ffff:10.0.0.5 必须解出内嵌私网 IPv4（经典绕过形态）', () => {
    const r = classifyIp('::ffff:10.0.0.5');
    expect(r.unsafe).toBe(true);
    expect(r.category).toBe('ipv4-mapped:RFC1918');
  });

  it('IPv4-mapped 公网 ::ffff:8.8.8.8 放行（归一化为内嵌 IPv4）', () => {
    const r = classifyIp('::ffff:8.8.8.8');
    expect(r.unsafe).toBe(false);
    expect(r.normalized).toBe('8.8.8.8');
  });

  it('IPv4-compatible ::127.0.0.1 同样拒绝（废弃形态不得成为绕过路径）', () => {
    expect(classifyIp('::127.0.0.1').unsafe).toBe(true);
  });

  it('IPv6 十六进制 mapped 形态 ::ffff:7f00:1 = 127.0.0.1 拒绝', () => {
    expect(classifyIp('::ffff:7f00:1').unsafe).toBe(true);
  });

  it('NAT64 64:ff9b::10.0.0.5 解出内嵌私网 → 拒绝', () => {
    expect(classifyIp('64:ff9b::10.0.0.5').unsafe).toBe(true);
  });

  it('6to4 2002:0a00:0001:: 内嵌 10.0.0.1 → 拒绝', () => {
    expect(classifyIp('2002:0a00:0001::').unsafe).toBe(true);
  });

  it('公网 IPv6 2001:4860:4860::8888 放行', () => {
    expect(classifyIp('2001:4860:4860::8888').unsafe).toBe(false);
  });

  it('非 IP 输入按不安全处理（绝不"无法判定即放行"）', () => {
    expect(classifyIp('not-an-ip').unsafe).toBe(true);
    expect(classifyIp('10.0.0.256').unsafe).toBe(true);
  });

  it('expandIpv6 处理压缩/内嵌/非法形态', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(expandIpv6('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('[::1]')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('1::2::3')).toBeNull();
    expect(expandIpv6('1:2:3')).toBeNull();
    expect(expandIpv6('gggg::1')).toBeNull();
  });
});

describe('ssrf-guard / 主机名与同步校验', () => {
  it.each(['localhost', 'LOCALHOST', 'localhost.', 'api.local', 'metadata.google.internal', 'db.internal', 'x.home.arpa', 'box.lan', 'a.corp', 'svc.intranet'])(
    '内网主机名拒绝：%s', (host) => {
      expect(isInternalHostname(host)).toBe(true);
      expect(checkUrlSync(`https://${host}/v1`).ok).toBe(false);
    });

  it('公网主机名/带尾点不误伤', () => {
    expect(isInternalHostname('api.example.com')).toBe(false);
    expect(isInternalHostname('api.example.com.')).toBe(false);
    expect(checkUrlSync('https://api.example.com/v1').ok).toBe(true);
  });

  it('协议 allowlist：默认只允许 https，显式 allowHttp 才放行 http', () => {
    expect(checkUrlSync('http://api.example.com').reason).toBe('protocol_not_allowed');
    expect(checkUrlSync('http://api.example.com', { allowHttp: true }).ok).toBe(true);
    expect(checkUrlSync('ftp://api.example.com').reason).toBe('protocol_not_allowed');
    expect(checkUrlSync('file:///etc/passwd').reason).toBe('protocol_not_allowed');
    expect(checkUrlSync('gopher://api.example.com').reason).toBe('protocol_not_allowed');
  });

  it('URL 内凭证拒绝', () => {
    expect(checkUrlSync('https://user:pw@api.example.com').reason).toBe('credentials_in_url');
    expect(checkUrlSync('https://user@api.example.com').reason).toBe('credentials_in_url');
  });

  it.each(['https://127.0.0.1/', 'https://[::1]/', 'https://[::ffff:10.0.0.5]/', 'https://169.254.169.254/latest/meta-data/', 'https://10.0.0.5/', 'https://192.168.1.1/'])(
    'IP 字面量同步拒绝：%s', (url) => {
      const v = checkUrlSync(url);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('private_ip');
    });

  it('畸形 URL / 空值拒绝', () => {
    expect(checkUrlSync('').reason).toBe('invalid_url');
    expect(checkUrlSync('not a url').reason).toBe('invalid_url');
    expect(checkUrlSync('//api.example.com').reason).toBe('invalid_url');
    expect(checkUrlSync(undefined as unknown as string).reason).toBe('invalid_url');
  });

  it('normalizeHostname 去方括号与尾点', () => {
    expect(normalizeHostname('[::1]')).toBe('::1');
    expect(normalizeHostname('API.Example.com.')).toBe('api.example.com');
  });
});

describe('ssrf-guard / assertSafeUrl（DNS 解析层）', () => {
  it('解析到公网地址 → 通过，并返回地址供连接固定', async () => {
    const r = await assertSafeUrl('https://api.example.com/v1', { resolve: resolverOf({ 'api.example.com': PUBLIC }) });
    expect(r.url.href).toBe('https://api.example.com/v1');
    expect(r.addresses).toEqual(PUBLIC);
  });

  it('解析到私网/回环/link-local/metadata → 拒绝（公网域名也不能指向内网）', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      await expect(assertSafeUrl('https://evil.example.com/', { resolve: resolverOf({ 'evil.example.com': [ip] }) }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/私网/) });
    }
  });

  it('多地址中任一为私网即拒绝（不取"第一个看似公网"的地址）', async () => {
    await expect(assertSafeUrl('https://multi.example.com/', { resolve: resolverOf({ 'multi.example.com': ['93.184.216.34', '10.0.0.1'] }) }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('解析失败 → 拒绝（fail-closed，绝不"解析不了就放行"）', async () => {
    await expect(assertSafeUrl('https://nx.example.com/', { resolve: resolverOf({}) }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/无法解析/) });
  });

  it('空解析结果 → 拒绝', async () => {
    await expect(assertSafeUrl('https://empty.example.com/', { resolve: async () => [] }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('同步层不通过时不触发解析器（IP 字面量直接拒绝）', async () => {
    let called = false;
    const spy: DnsResolver = async () => { called = true; return PUBLIC; };
    await expect(assertSafeUrl('https://10.0.0.5/', { resolve: spy })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toBe(false);
  });

  it('allowPrivate 显式开启才放行私网（内部工具场景；业务路径不得使用）', async () => {
    const r = await assertSafeUrl('https://10.0.0.5/', { allowPrivate: true });
    expect(r.url.hostname).toBe('10.0.0.5');
  });

  it('真实 node:dns 解析器接线正确（localhost 无需外网即可解析）', async () => {
    const addresses = await nodeDnsResolver('localhost');
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.some((a) => classifyIp(a).unsafe)).toBe(true);
  });
});
