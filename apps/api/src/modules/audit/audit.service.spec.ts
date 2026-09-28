import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { AuditService, maskEmail, maskSensitive } from './audit.service';
import { TraceContext } from '../../core/tracing/trace-context';

function makeService() {
  const prisma = { auditLog: { create: vi.fn().mockResolvedValue({ id: 'a1' }), findMany: vi.fn().mockResolvedValue([]) } };
  const svc = new AuditService(prisma as never);
  return { svc, prisma };
}

describe('maskSensitive（M8-P3 递归脱敏）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('嵌套对象：命中键替换为 ***（保留键名）；非敏感键原样', () => {
    const out = maskSensitive({
      provider: 'mock', actionType: 'post',
      oauth: { accessToken: 'at-123', refreshToken: 'rt-456', nested: { passwordHash: 'h', keep: 1 } },
    }) as Record<string, unknown>;
    expect(out.provider).toBe('mock');
    expect(out.actionType).toBe('post');
    const oauth = out.oauth as Record<string, unknown>;
    expect(oauth.accessToken).toBe('***');
    expect(oauth.refreshToken).toBe('***');
    expect((oauth.nested as Record<string, unknown>).passwordHash).toBe('***');
    expect((oauth.nested as Record<string, unknown>).keep).toBe(1);
    expect(JSON.stringify(out)).not.toContain('at-123');
    expect(JSON.stringify(out)).not.toContain('rt-456');
  });

  it('父键命中即整体脱敏（credentials/credential 覆盖整棵子树——宁可多脱绝不漏脱）', () => {
    const out = maskSensitive({ credentials: { accessToken: 'at-123', provider: 'mock' } }) as Record<string, unknown>;
    expect(out.credentials).toBe('***');
    expect(JSON.stringify(out)).not.toContain('at-123');
  });

  it('数组：逐项递归脱敏（对象数组/嵌套数组）', () => {
    const out = maskSensitive([
      { apiKey: 'k1', name: 'a' },
      [{ cookie: 'c1', secret: 's1' }],
    ]) as unknown[];
    expect((out[0] as Record<string, unknown>).apiKey).toBe('***');
    expect((out[0] as Record<string, unknown>).name).toBe('a');
    expect(((out[1] as unknown[])[0] as Record<string, unknown>).cookie).toBe('***');
    expect(((out[1] as unknown[])[0] as Record<string, unknown>).secret).toBe('***');
  });

  it('大小写与分隔符变体：Password/password/API_KEY/access_token/Authorization 全部脱敏', () => {
    const out = maskSensitive({
      Password: 'p', PASSWORD: 'p2', API_KEY: 'k', 'access-token': 'at', access_token: 'at2',
      refreshToken: 'rt', Authorization: 'Bearer x', cookie: 'c', credential: 'cr',
      encryptedValue: 'ev', encrypted: 'ev2', passwd: 'p3', token: 't',
    }) as Record<string, unknown>;
    for (const key of Object.keys(out)) expect(out[key]).toBe('***');
  });

  it('原始值/Date/null 原样保留（不做误伤）；超深截断防环', () => {
    const d = new Date();
    expect(maskSensitive('plain')).toBe('plain');
    expect(maskSensitive(7)).toBe(7);
    expect(maskSensitive(null)).toBeNull();
    expect(maskSensitive(d)).toBe(d);
    expect(maskSensitive({ a: { b: { c: 1 } } })).toEqual({ a: { b: { c: 1 } } });
  });

  it('maskEmail：仅保留 @ 前前缀 + ***（域名丢弃；异常输入不抛错）', () => {
    expect(maskEmail('admin@example.com')).toBe('admin***');
    expect(maskEmail('a.b+tag@corp.io')).toBe('a.b+tag***');
    expect(maskEmail('no-at-sign')).toBe('no-at-sign***');
    expect(maskEmail('@example.com')).toBe('***');
  });
});

describe('AuditService（M8-P3 增强：trace 自动注入 + 强制脱敏）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('write：TraceContext 内自动注入 requestId/traceId（显式传入优先）', async () => {
    const { svc, prisma } = makeService();
    await TraceContext.runWithContext({ requestId: 'req-ctx', traceId: 'trace-ctx' }, async () => {
      await svc.write({ userId: 'u1', action: 'approval.decided' });
    });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ requestId: 'req-ctx', traceId: 'trace-ctx', actorId: 'u1' });

    await TraceContext.runWithContext({ requestId: 'req-ctx', traceId: 'trace-ctx' }, async () => {
      await svc.write({ userId: 'u1', action: 'approval.decided', requestId: 'req-explicit', traceId: 'trace-explicit', actorId: 'service-account', organizationId: 'org-x', result: 'denied', reason: '无权限' });
    });
    expect(prisma.auditLog.create.mock.calls[1][0].data).toMatchObject({
      requestId: 'req-explicit', traceId: 'trace-explicit', actorId: 'service-account', organizationId: 'org-x', result: 'denied', reason: '无权限',
    });
  });

  it('write：无上下文 → requestId/traceId 为 null（不伪造）；metadata 强制脱敏', async () => {
    const { svc, prisma } = makeService();
    await svc.write({ userId: 'u2', action: 'connection.established', metadata: { provider: 'mock', accessToken: 'secret-token', nested: { password: 'p' } } });
    const data = prisma.auditLog.create.mock.calls[0][0].data as { requestId: string | null; traceId: string | null; metadata: Record<string, unknown> };
    expect(data.requestId).toBeNull();
    expect(data.traceId).toBeNull();
    expect(data.metadata).toMatchObject({ provider: 'mock', accessToken: '***', nested: { password: '***' } });
    expect(JSON.stringify(data.metadata)).not.toContain('secret-token');
  });

  it('write：run 上下文补充 agentRunId/toolCallId/workflowRunId（显式优先）；写入失败不抛错（best-effort）', async () => {
    const { svc, prisma } = makeService();
    await TraceContext.runWithContext({ runId: 'run-9', toolCallId: 'tc-9', workflowRunId: 'wf-9' }, async () => {
      await svc.write({ userId: 'u3', action: 'external_action.executed' });
      await svc.write({ userId: 'u3', action: 'external_action.executed', agentRunId: 'run-explicit' });
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ agentRunId: 'run-9', toolCallId: 'tc-9', workflowRunId: 'wf-9' });
    expect(prisma.auditLog.create.mock.calls[1][0].data).toMatchObject({ agentRunId: 'run-explicit' });

    prisma.auditLog.create.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.write({ userId: 'u3', action: 'auth.login' })).resolves.toBeUndefined();
  });

  describe('M10-P1 D13：审计写失败必须可见（best-effort ≠ 静默）', () => {
    it('写失败 → warn 带 action + 错误消息（此前是 .catch(() => undefined) 完全吞掉）', async () => {
      const { svc, prisma } = makeService();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        prisma.auditLog.create.mockRejectedValueOnce(new Error('db down'));
        await svc.write({ userId: 'u3', action: 'connection.established' });

        expect(warn).toHaveBeenCalledTimes(1);
        const msg = String(warn.mock.calls[0][0]);
        expect(msg).toContain('connection.established'); // 知道是哪条审计丢了
        expect(msg).toContain('db down'); // 知道为什么丢
        expect(msg).toContain('降级'); // 明确这是降级而非正常路径
      } finally {
        warn.mockRestore();
      }
    });

    it('告警**绝不复述 metadata**（可能含尚未脱敏的输入——脱敏只发生在落库前）', async () => {
      const { svc, prisma } = makeService();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        prisma.auditLog.create.mockRejectedValueOnce(new Error('db down'));
        await svc.write({ userId: 'u3', action: 'auth.login', metadata: { accessToken: 'raw-token-in-metadata' } });
        expect(String(warn.mock.calls[0][0])).not.toContain('raw-token-in-metadata');
      } finally {
        warn.mockRestore();
      }
    });

    it('写成功 → 不产生告警（告警只表示真降级，不被正常路径淹没）', async () => {
      const { svc } = makeService();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        await svc.write({ userId: 'u3', action: 'auth.login' });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});
