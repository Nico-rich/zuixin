import { describe, expect, it } from 'vitest';
import { SseConnectionSink, SseRegistryService } from './sse-registry.service';

/** 最小可写 sink（相当于 Express Response 的可测替身） */
function sink(opts: { writableEnded?: boolean; writeThrows?: boolean } = {}) {
  const chunks: string[] = [];
  let ended = 0;
  let destroyed = 0;
  const s: SseConnectionSink = {
    get writableEnded() { return opts.writableEnded ?? false; },
    write(chunk: string) { if (opts.writeThrows) throw new Error('write after end'); chunks.push(chunk); },
    end() { ended++; },
    destroy() { destroyed++; },
  };
  return { s, chunks, ended: () => ended, destroyed: () => destroyed };
}

/** 带请求上下文的 sink（Express Response 暴露 res.req：守卫写入的 user 与已解析的 body） */
function expressLikeSink(req: { user?: { userId: string }; body?: { conversationId?: string | null } }) {
  const base = sink();
  return { ...base, s: Object.assign(base.s, { req }) };
}

describe('SseRegistryService（连接纳管 + M10-P13 owner 路由）', () => {
  it('add 登记连接并返回幂等注销函数（size/snapshot 反映）', () => {
    const sse = new SseRegistryService();
    const a = sink();
    const off = sse.add('chat', a.s, { userId: 'u1' });
    expect(sse.size()).toBe(1);
    expect(sse.snapshot()[0]).toMatchObject({ kind: 'chat', closed: false, userId: 'u1' });
    off();
    off(); // 幂等
    expect(sse.size()).toBe(0);
  });

  it('owner 缺省时从 Express res.req 推导（userId + body.conversationId）——既有控制器无需改动', () => {
    const sse = new SseRegistryService();
    sse.add('chat', expressLikeSink({ user: { userId: 'u-42' }, body: { conversationId: 'c-7' } }).s as SseConnectionSink);
    // agent-runs 的 GET 连接没有 body → conversationId 记为 null（路由时退化为按 user 匹配）
    sse.add('agent-run-events', expressLikeSink({ user: { userId: 'u-42' } }).s as SseConnectionSink);
    // 无 req 的 fake sink → 归属未知（fail-closed：不会被任何任务事件命中）
    sse.add('chat', sink().s);

    const [chat, run, plain] = sse.snapshot();
    expect(chat).toMatchObject({ userId: 'u-42', conversationId: 'c-7' });
    expect(run).toMatchObject({ userId: 'u-42', conversationId: null });
    expect(plain.userId).toBeUndefined();
  });

  it('显式传入的 owner 优先于推导（不会被 res.req 覆盖）', () => {
    const sse = new SseRegistryService();
    sse.add('chat', expressLikeSink({ user: { userId: 'u-legacy' }, body: { conversationId: 'c-legacy' } }).s as SseConnectionSink, { userId: 'u-explicit', conversationId: 'c-explicit' });
    expect(sse.snapshot()[0]).toMatchObject({ userId: 'u-explicit', conversationId: 'c-explicit' });
  });

  it('deliver：只投递匹配连接，帧写入目标 sink，返回投递条数', () => {
    const sse = new SseRegistryService();
    const hit = sink();
    const miss = sink();
    sse.add('chat', hit.s, { userId: 'u1', conversationId: 'c1' });
    sse.add('chat', miss.s, { userId: 'u2' });

    const delivered = sse.deliver(
      (info) => info.userId === 'u1',
      (sink, info) => { sink.write?.(`event: x\ndata: ${JSON.stringify({ id: info.id })}\n\n`); },
    );

    expect(delivered).toBe(1);
    expect(hit.chunks.join('')).toContain('event: x');
    expect(miss.chunks).toEqual([]);
  });

  it('deliver：跳过已结束（writableEnded）与已注销连接', () => {
    const sse = new SseRegistryService();
    const ended = sink({ writableEnded: true });
    const live = sink();
    const off = sse.add('chat', ended.s, { userId: 'u1' });
    sse.add('chat', live.s, { userId: 'u1' });
    expect(sse.deliver(() => true, (s) => s.write?.('x'))).toBe(1);
    off();
    expect(sse.deliver(() => true, (s) => s.write?.('x'))).toBe(1);
    expect(ended.chunks).toEqual([]);
    expect(live.chunks).toEqual(['x', 'x']);
  });

  it('deliver：单个连接写失败不影响其他连接（异常隔离 + 失败连接注销）', () => {
    const sse = new SseRegistryService();
    const broken = sink({ writeThrows: true });
    const ok = sink();
    sse.add('chat', broken.s, { userId: 'u1' });
    sse.add('chat', ok.s, { userId: 'u1' });
    expect(sse.deliver(() => true, (s) => s.write?.('x'))).toBe(1);
    expect(ok.chunks).toEqual(['x']);
    expect(sse.size()).toBe(1); // 失败连接已被注销
    expect(sse.snapshot()[0].closed).toBe(false);
  });

  it('deliver：不可写的 sink（无 write 能力）→ 回调抛错 → 不计投递并注销连接', () => {
    const sse = new SseRegistryService();
    sse.add('chat', { end: () => undefined } as SseConnectionSink, { userId: 'u1' });
    expect(sse.deliver(() => true, (sink) => { if (!sink.write) throw new Error('SSE sink 不支持 write'); sink.write('x'); })).toBe(0);
    expect(sse.size()).toBe(0);
  });
});
