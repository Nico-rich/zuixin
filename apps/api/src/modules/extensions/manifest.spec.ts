import { describe, it, expect } from 'vitest';
import {
  checkParamConstraints, checksumOf, parseManifest, renderAgentPrompt, signChecksum, stableStringify, verifySignature,
} from './manifest';

const KEY = 'dGVzdC1rZXktMzItYnl0ZXMtbG9uZy1hYmNkZWZnaGk=';

function toolManifest(block: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    kind: 'tool',
    permissions: ['tool.execute'],
    tool: {
      name: 'ext.demo-ext.search',
      description: '搜索封装',
      baseTool: 'knowledge.search',
      paramConstraints: { topK: { min: 1, max: 5 } },
      ...block,
    },
    ...top,
  };
}

function agentManifest(over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    kind: 'agent',
    permissions: ['agent.run'],
    agent: {
      name: 'brand-writer',
      description: '品牌文案助手',
      systemPrompt: '你是 {{extension.name}} 助手（组织 {{organization.id}}）。',
      tools: ['knowledge.search'],
      ...over,
    },
    ...top,
  };
}

function providerManifest(over: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    kind: 'provider',
    permissions: ['provider.call'],
    provider: {
      name: '第三方推理',
      adapter: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      models: [{ name: 'gpt-x', apiModelId: 'gpt-x-0613', type: 'llm' }],
      ...over,
    },
  };
}

function stepManifest(over: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    kind: 'workflow_step',
    permissions: ['workflow.step'],
    workflow_step: { name: 'search-step', stepType: 'tool', params: { toolName: 'knowledge.search' }, ...over },
  };
}

describe('M8-P6 manifest 严格校验（声明式；非法/越权一律拒绝）', () => {
  it('合法 tool manifest：归一化权限 + checksum 确定（键序无关）', () => {
    const a = parseManifest(toolManifest({ permissions: ['tool.execute'] }), { slug: 'demo-ext' });
    expect(a.permissions).toEqual(['tool.execute']);
    expect(a.manifest.tool!.baseTool).toBe('knowledge.search');
    const b = parseManifest({
      tool: { paramConstraints: { topK: { min: 1, max: 5 } }, baseTool: 'knowledge.search', description: '搜索封装', name: 'ext.demo-ext.search' },
      kind: 'tool', manifestVersion: 1, permissions: ['tool.execute'],
    } as unknown, { slug: 'demo-ext' });
    expect(b.checksum).toBe(a.checksum);
    expect(checksumOf({ a: 1, b: 2 })).toBe(checksumOf({ b: 2, a: 1 }));
  });

  it('非法 kind / kind 与定义块不匹配 → VALIDATION_ERROR', () => {
    expect(() => parseManifest({ manifestVersion: 1, kind: 'plugin', tool: {} })).toThrowError(/manifest 非法/);
    // kind=tool 但没有 tool 块
    expect(() => parseManifest({ manifestVersion: 1, kind: 'tool', permissions: ['tool.execute'] })).toThrowError(/一一对应/);
    // kind=tool 同时给 agent 块
    expect(() => parseManifest({ manifestVersion: 1, kind: 'tool', tool: toolManifest().tool, agent: agentManifest().agent })).toThrowError(/一一对应/);
    // 未知字段（strict）
    expect(() => parseManifest({ manifestVersion: 1, kind: 'tool', tool: { ...toolManifest().tool, code: 'process.exit(1)' } })).toThrowError(/manifest 非法/);
  });

  it('越权权限声明：非白名单 / 跨 kind 能力域 / 缺必需权限 → 拒绝', () => {
    expect(() => parseManifest(toolManifest({}, { permissions: ['provider.call'] }), { slug: 'demo-ext' })).toThrowError(/越权声明/);
    expect(() => parseManifest(toolManifest({}, { permissions: ['filesystem.write'] }), { slug: 'demo-ext' })).toThrowError(/manifest 非法/);
    // 完全没有权限声明 → 拒绝
    const noPerms: Record<string, unknown> = toolManifest();
    delete noPerms.permissions;
    expect(() => parseManifest(noPerms, { slug: 'demo-ext' })).toThrowError(/必须声明 permissions/);
    expect(() => parseManifest(toolManifest({ permissions: [] }), { slug: 'demo-ext' })).toThrowError(/manifest 非法/);
    // agent 类不得声明 tool.execute
    expect(() => parseManifest(agentManifest({}, { permissions: ['tool.execute'] }), { slug: 'a-ext' })).toThrowError(/越权声明/);
    // 顶层与块内声明不一致
    const m = { ...toolManifest({ permissions: ['tool.execute'] }), permissions: ['config.read'] };
    expect(() => parseManifest(m, { slug: 'demo-ext' })).toThrowError(/不一致/);
  });

  it('工具名必须 ext.<slug>.<name> 前缀且命名空间与扩展 slug 一致', () => {
    expect(() => parseManifest(toolManifest({ name: 'search' }), { slug: 'demo-ext' })).toThrowError(/manifest 非法/);
    expect(() => parseManifest(toolManifest({ name: 'other.search' }), { slug: 'demo-ext' })).toThrowError(/manifest 非法/);
    // 冒用他人命名空间
    expect(() => parseManifest(toolManifest(), { slug: 'another-ext' })).toThrowError(/命名空间必须与扩展 slug 一致/);
    // 禁止扩展链（baseTool 形态在 zod 层就被拒；服务层 requirePlatformTool 亦有 ext. 守卫）
    expect(() => parseManifest(toolManifest({ baseTool: 'ext.other.tool' }), { slug: 'demo-ext' })).toThrowError(/manifest 非法/);
  });

  it('manifest 绝不携带密钥：字段名/字面量/连接串 → 拒绝', () => {
    expect(() => parseManifest(toolManifest({ apiKey: 'whatever' }), { slug: 'demo-ext' })).toThrowError(/不得携带密钥/);
    expect(() => parseManifest(toolManifest({ description: '使用 sk-abcdefgh12345678 调用' }), { slug: 'demo-ext' })).toThrowError(/不得携带密钥/);
    expect(() => parseManifest(providerManifest({ vault: { uri: 'postgresql://user:pw@db:5432/x' } }), { slug: 'p-ext' })).toThrowError(/不得携带密钥/);
  });

  it('非声明式内容（函数/类实例）→ 拒绝', () => {
    expect(() => parseManifest(toolManifest({ description: () => 'x' }), { slug: 'demo-ext' })).toThrowError(/声明式 JSON/);
    expect(() => parseManifest(new Date() as unknown)).toThrowError(/manifest 非法/);
  });

  it('provider：仅 openai-compatible + https 公网（禁 SSRF）', () => {
    expect(parseManifest(providerManifest(), { slug: 'p-ext' }).manifest.provider!.adapter).toBe('openai-compatible');
    expect(() => parseManifest(providerManifest({ adapter: 'raw-grpc' }), { slug: 'p-ext' })).toThrowError(/manifest 非法/);
    expect(() => parseManifest(providerManifest({ baseUrl: 'http://api.example.com' }), { slug: 'p-ext' })).toThrowError(/https/);
    expect(() => parseManifest(providerManifest({ baseUrl: 'https://localhost:8080/v1' }), { slug: 'p-ext' })).toThrowError(/本机|内网/);
    expect(() => parseManifest(providerManifest({ baseUrl: 'https://127.0.0.1/v1' }), { slug: 'p-ext' })).toThrowError(/私网/);
    expect(() => parseManifest(providerManifest({ baseUrl: 'https://10.0.0.5/v1' }), { slug: 'p-ext' })).toThrowError(/私网/);
    expect(() => parseManifest(providerManifest({ baseUrl: 'https://192.168.1.10/v1' }), { slug: 'p-ext' })).toThrowError(/私网/);
    expect(() => parseManifest(providerManifest({ baseUrl: 'https://user:pw@api.example.com/v1' }), { slug: 'p-ext' })).toThrowError(/凭证/);
  });

  it('agent：systemPrompt 模板变量白名单 + 禁扩展链工具', () => {
    const ok = parseManifest(agentManifest(), { slug: 'a-ext' });
    expect(ok.manifest.agent!.tools).toEqual(['knowledge.search']);
    expect(renderAgentPrompt(ok.manifest.agent!.systemPrompt, { 'extension.name': '品牌', 'organization.id': 'org-1' }))
      .toBe('你是 品牌 助手（组织 org-1）。');
    // 未知占位符拒绝（绝不执行模板代码）
    expect(() => parseManifest(agentManifest({ systemPrompt: '执行 {{process.env.SECRET}}' }), { slug: 'a-ext' }))
      .toThrowError(/模板变量不在白名单/);
    expect(() => parseManifest(agentManifest({ tools: ['ext.other.tool'] }), { slug: 'a-ext' })).toThrowError(/禁止扩展链/);
  });

  it('workflow_step：按 stepType 声明必需参数', () => {
    expect(parseManifest(stepManifest(), { slug: 's-ext' }).manifest.workflow_step!.params).toEqual({ toolName: 'knowledge.search' });
    expect(() => parseManifest(stepManifest({ params: {} }), { slug: 's-ext' })).toThrowError(/params.toolName/);
    expect(() => parseManifest(stepManifest({ stepType: 'agent', params: {} }), { slug: 's-ext' })).toThrowError(/params.message/);
    expect(parseManifest(stepManifest({ stepType: 'output', params: { format: 'json' } }), { slug: 's-ext' }).manifest.workflow_step!.stepType).toBe('output');
  });

  it('paramConstraints：声明期非法组合拒绝（enum+min / min>max / 空规则）', () => {
    expect(() => parseManifest(toolManifest({ paramConstraints: { topK: { enum: [1, 2], min: 1 } } }), { slug: 'demo-ext' }))
      .toThrowError(/manifest 非法/);
    expect(() => parseManifest(toolManifest({ paramConstraints: { topK: { min: 9, max: 1 } } }), { slug: 'demo-ext' }))
      .toThrowError(/min 不得大于 max/);
    expect(() => parseManifest(toolManifest({ paramConstraints: { topK: {} } }), { slug: 'demo-ext' }))
      .toThrowError(/至少声明/);
  });
});

describe('M8-P6 checksum 与发布签名（HMAC）', () => {
  it('checksum：同内容同摘要、改内容变摘要（稳定序列化）', () => {
    const c1 = checksumOf({ b: [1, 2], a: 'x' });
    const c2 = checksumOf({ a: 'x', b: [1, 2] });
    const c3 = checksumOf({ a: 'x', b: [1, 3] });
    expect(c1).toBe(c2);
    expect(c1).not.toBe(c3);
    expect(c1).toMatch(/^[0-9a-f]{64}$/);
    expect(stableStringify({ z: 1, a: undefined })).toBe('{"z":1}');
  });

  it('签名：正确密钥可验证；篡改 checksum / 错误密钥 / 缺失签名 → false', () => {
    const checksum = checksumOf(toolManifest());
    const sig = signChecksum(checksum, KEY);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySignature(checksum, sig, KEY)).toBe(true);
    expect(verifySignature(checksumOf({ other: true }), sig, KEY)).toBe(false);
    expect(verifySignature(checksum, signChecksum(checksum, 'b3RoZXIta2V5LTMyLWJ5dGVzLWxvbmctYWJjZGVmZ2g='), KEY)).toBe(false);
    expect(verifySignature(checksum, null, KEY)).toBe(false);
    expect(verifySignature(checksum, sig, '')).toBe(false);
  });

  it('platformKey 缺失时签名拒绝（绝不产生无签名发布）', () => {
    expect(() => signChecksum('abc', '')).toThrowError(/平台签名密钥缺失/);
  });
});

describe('M8-P6 checkParamConstraints（执行期只拒绝、绝不改写输入）', () => {
  it('enum / min-max / pattern / required 全部生效', () => {
    const c = {
      category: { enum: ['preference', 'other'] },
      topK: { min: 1, max: 5 },
      query: { pattern: '^[\\w\\u4e00-\\u9fa5 ]+$', required: true },
    };
    expect(checkParamConstraints(c, { category: 'preference', topK: 3, query: '品牌 主图' })).toBeNull();
    expect(checkParamConstraints(c, { category: 'hack', topK: 3, query: 'x' })).toMatch(/不在允许取值范围/);
    expect(checkParamConstraints(c, { category: 'other', topK: 99, query: 'x' })).toMatch(/大于上界/);
    expect(checkParamConstraints(c, { category: 'other', topK: 0, query: 'x' })).toMatch(/小于下界/);
    expect(checkParamConstraints(c, { category: 'other', topK: 3, query: '<script>' })).toMatch(/不匹配约束 pattern/);
    expect(checkParamConstraints(c, { category: 'other', topK: 3 })).toMatch(/缺少必需参数/);
    expect(checkParamConstraints(c, { category: 'other', topK: 3, query: 'x'.repeat(5001) })).toMatch(/超长/);
    expect(checkParamConstraints(undefined, { anything: 1 })).toBeNull();
  });
});
