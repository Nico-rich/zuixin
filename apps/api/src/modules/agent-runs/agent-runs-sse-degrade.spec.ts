import { describe, expect, it, vi } from 'vitest';
import { Request, Response } from 'express';
import { AgentRunsController } from './agent-runs.controller';
import { AgentRunsService } from './agent-runs.service';
import { AgentRunTimelineService } from './agent-run-timeline.service';
import { EventBusService } from '../../core/events/event-bus.service';
import { SseRegistryService } from '../../core/sse/sse-registry.service';
import { AuthedUser } from '../auth/jwt-auth.guard';

/**
 * M10-P13（审计 D11）：agent-runs SSE 的 **Redis 降级信号对客户端可见**。
 * 订阅建立失败时，连接的既有权衡（fail-open：降级为仅快照，绝不 5xx / 绝不无限等待）保持不变，
 * 但必须显式告知客户端——收流前补发一条 shared/events.ts 既有的 `status` 帧（stage=sse.degraded）。
 */
function fakeRes() {
  const chunks: string[] = [];
  const closeHandlers: Array<() => void> = [];
  let ended = 0;
  const res = {
    writableEnded: false,
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: (chunk: string) => { chunks.push(chunk); return true; },
    end: (chunk?: string) => { if (chunk) chunks.push(chunk); ended++; (res as { writableEnded: boolean }).writableEnded = true; },
    on: (event: string, cb: () => void) => { if (event === 'close') closeHandlers.push(cb); },
    off: () => undefined,
  };
  return { res, chunks, frames: () => chunks.join(''), ended: () => ended, close: () => closeHandlers.forEach((cb) => cb()) };
}

function make(opts: { subscribeFails: boolean; draining?: boolean }) {
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  const eventBus = {
    subscribe: async (channel: string) => { subscribed.push(channel); if (opts.subscribeFails) throw new Error('redis 不可用'); },
    unsubscribe: (channel: string) => { unsubscribed.push(channel); },
  } as unknown as EventBusService;
  const runs = { getStatus: async () => ({ id: 'run-1', status: 'running' }) } as unknown as AgentRunsService;
  const timeline = {
    build: async () => ({
      runId: 'run-1', agentId: 'a-1', agentName: '助手', agentVersion: 1, status: 'running',
      startedAt: '2026-09-28T00:00:00.000Z', completedAt: null, items: [], usage: null,
    }),
  } as unknown as AgentRunTimelineService;
  const sse = {
    isDraining: () => opts.draining ?? false,
    add: () => () => undefined,
  } as unknown as SseRegistryService;
  return { controller: new AgentRunsController(runs, timeline, eventBus, sse), subscribed, unsubscribed };
}

const req = { user: { userId: 'u-1', role: 'user' } } as unknown as Request & { user: AuthedUser };

describe('agent-runs SSE 降级信号（D11）', () => {
  it('订阅失败（Redis 不可用）→ 快照后补发 status 帧（stage=sse.degraded），流干净结束且不 5xx', async () => {
    const { controller, subscribed } = make({ subscribeFails: true });
    const res = fakeRes();
    await controller.events(req, res.res as unknown as Response, 'run-1');

    const frames = res.frames();
    expect(frames).toContain('event: timeline.snapshot');
    expect(frames).toContain('event: status');
    const statusFrame = res.chunks.filter((c) => c.startsWith('data:')).find((c) => c.includes('sse.degraded'));
    expect(JSON.parse(statusFrame!.slice(6))).toEqual({
      type: 'status',
      stage: 'sse.degraded',
      message: expect.stringContaining('降级'),
    });
    expect(subscribed).toEqual(['agent-run:run-1']); // 仍尝试订阅，只是失败
    expect(res.ended()).toBe(1); // 干净 EOF（客户端不会看到连接被重置）
  });

  it('订阅成功 → 不发降级帧（客户端只在真降级时看到提示）', async () => {
    const { controller, subscribed, unsubscribed } = make({ subscribeFails: false });
    const res = fakeRes();
    const running = controller.events(req, res.res as unknown as Response, 'run-1');
    await new Promise((r) => setTimeout(r, 0)); // 等快照写出 + 订阅登记
    expect(res.frames()).toContain('event: timeline.snapshot');
    expect(res.frames()).not.toContain('sse.degraded');
    expect(subscribed).toEqual(['agent-run:run-1']);
    res.close(); // 客户端断开 → 收流
    await running;
    expect(unsubscribed).toEqual(['agent-run:run-1']);
    expect(res.ended()).toBe(1);
  });

  it('停机排空期：仍以 503 拒绝新订阅（降级信号不改变排空契约）', async () => {
    const { controller } = make({ subscribeFails: false, draining: true });
    const res = fakeRes();
    await controller.events(req, res.res as unknown as Response, 'run-1');
    expect(res.res.writeHead).toHaveBeenCalledWith(503, expect.objectContaining({ 'Content-Type': expect.stringContaining('json') }));
    expect(res.frames()).not.toContain('event: timeline.snapshot');
  });
});
