import { describe, it, expect } from 'vitest';
import { TraceContext, newTraceId } from './trace-context';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('TraceContext（M8-P3 AsyncLocalStorage 全链路上下文）', () => {
  it('无活动上下文：current() 为 undefined（读取方必须能降级）；newTraceId 为唯一 uuid', () => {
    expect(TraceContext.current()).toBeUndefined();
    const a = newTraceId();
    const b = TraceContext.newTraceId();
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(a).not.toBe(b);
  });

  it('字段传播：runWithContext 内 current() 可见全部字段；跨 await 保持', async () => {
    await TraceContext.runWithContext(
      { requestId: 'req-1', traceId: 'trace-1', userId: 'u1', organizationId: 'org-1', runId: 'run-1', toolCallId: 'tc-1', taskId: 't-1', workflowRunId: 'wf-1', provider: 'mock', projectId: 'p-1' },
      async () => {
        expect(TraceContext.current()).toMatchObject({ requestId: 'req-1', traceId: 'trace-1', userId: 'u1', organizationId: 'org-1', runId: 'run-1', toolCallId: 'tc-1', taskId: 't-1', workflowRunId: 'wf-1', provider: 'mock', projectId: 'p-1' });
        await new Promise((r) => setTimeout(r, 1));
        expect(TraceContext.current()?.traceId).toBe('trace-1');
      },
    );
  });

  it('嵌套：子上下文继承父未覆盖字段 + traceId；覆盖字段不回写父作用域', () => {
    TraceContext.runWithContext({ requestId: 'req-parent', traceId: 'trace-parent', userId: 'u1', organizationId: 'org-1' }, () => {
      TraceContext.runWithContext({ runId: 'run-child' }, () => {
        expect(TraceContext.current()).toMatchObject({
          requestId: 'req-parent', traceId: 'trace-parent', userId: 'u1', organizationId: 'org-1', runId: 'run-child',
        });
      });
      TraceContext.runWithContext({ requestId: 'req-child' }, () => {
        expect(TraceContext.current()?.requestId).toBe('req-child');
        expect(TraceContext.current()?.traceId).toBe('trace-parent'); // 未指定 traceId → 继承父
      });
      // 父作用域未被污染
      expect(TraceContext.current()?.requestId).toBe('req-parent');
      expect(TraceContext.current()?.runId).toBeUndefined();
    });
  });

  it('隔离：并发上下文互不串扰（各自读到自己的 store）', async () => {
    const results = await Promise.all([
      TraceContext.runWithContext({ traceId: 'trace-A', userId: 'A' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return TraceContext.current()?.userId;
      }),
      TraceContext.runWithContext({ traceId: 'trace-B', userId: 'B' }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return TraceContext.current()?.userId;
      }),
    ]);
    expect(results).toEqual(['A', 'B']);
  });

  it('patch：活动上下文内回填字段（不含 undefined）；无上下文时静默忽略', () => {
    TraceContext.runWithContext({ traceId: 'trace-1' }, () => {
      TraceContext.patch({ userId: 'u9', organizationId: 'org-9', provider: undefined });
      expect(TraceContext.current()).toMatchObject({ userId: 'u9', organizationId: 'org-9' });
      expect('provider' in (TraceContext.current() ?? {})).toBe(false);
    });
    TraceContext.patch({ userId: 'u-outside' }); // 无活动上下文：不抛错、不创建
    expect(TraceContext.current()).toBeUndefined();
  });

  it('snapshot：返回副本（改写副本不污染内部 store）', () => {
    TraceContext.runWithContext({ traceId: 'trace-1', userId: 'u1' }, () => {
      const snap = TraceContext.snapshot()!;
      snap.userId = 'hacked';
      expect(TraceContext.current()?.userId).toBe('u1');
    });
  });

  it('缺省 traceId：不传则自动生成；异常原样透传且上下文不泄漏', () => {
    const generated = TraceContext.runWithContext({}, () => TraceContext.current()!.traceId);
    expect(generated).toMatch(UUID_RE);
    expect(TraceContext.current()).toBeUndefined();
    expect(() => TraceContext.runWithContext({ traceId: 'trace-err' }, () => { throw new Error('boom'); })).toThrow('boom');
    expect(TraceContext.current()).toBeUndefined();
  });
});
