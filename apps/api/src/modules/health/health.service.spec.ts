import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_PROBE_TIMEOUT_MS, ProbeResult, probeDb, probeRedis, probeLocalStorage, withTimeout,
} from './health-probes';
import { HealthService, HealthReport, isReady, evaluateStatus } from './health.service';

/**
 * M8-P9 Health 分级探测单测。
 *
 * **为什么不真停 DB/Redis**：本机 PostgreSQL/Redis 是多个 Phase 共用的基础设施（停掉会破坏
 * 其他套件与并行 Agent）。故障注入用两种**等价的真实手段**：
 *   ① 依赖替身：把探测函数的入参换成 reject/永久挂起的实现——走的是与生产完全相同的代码路径；
 *   ② 可覆写探针：HealthService.runProbes 覆写为返回不可达结果——验证分级裁决本身。
 * e2e 只验证"健康时 /live 与 /ready 真实返回 200"，503 分支由本文件全覆盖（详见 DR 手册）。
 */

function fakePrisma(impl: () => Promise<unknown>) {
  return { $queryRaw: vi.fn().mockImplementation(impl) } as never;
}

const up: ProbeResult = { state: 'up', latencyMs: 1 };
const down: ProbeResult = { state: 'down', latencyMs: 1, detail: 'boom' };

/** 覆写探针结果的 HealthService（不触碰真实依赖） */
class StubHealthService extends HealthService {
  constructor(private readonly stub: { db: ProbeResult; redis: ProbeResult; storage: ProbeResult }) {
    super({} as never, undefined);
  }
  protected override async runProbes(): Promise<{ db: ProbeResult; redis: ProbeResult; storage: ProbeResult }> {
    return this.stub;
  }
}

describe('M8-P9 health-probes：硬超时 + 异常折叠（依赖挂起绝不拖垮 health 请求）', () => {
  it('withTimeout：底层永不 settle 时按超时 reject（1s 内一定有结论）', async () => {
    const t0 = Date.now();
    await expect(withTimeout(new Promise(() => undefined), 120, 'db')).rejects.toThrow(/探测超时/);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('withTimeout：超时后底层 promise 的 reject 不会变成 unhandled rejection', async () => {
    let rejectLate: (e: Error) => void = () => undefined;
    const late = new Promise<never>((_res, rej) => { rejectLate = rej; });
    await expect(withTimeout(late, 50, 'redis')).rejects.toThrow(/超时/);
    rejectLate(new Error('late failure'));
    await new Promise((r) => setTimeout(r, 20)); // 若未吞掉，vitest 会在此报 unhandled rejection
    expect(true).toBe(true);
  });

  it('probeDb：SELECT 1 成功 → up；查询抛错 → down（含原因）', async () => {
    const ok = await probeDb(fakePrisma(() => Promise.resolve([{ '?column?': 1 }])));
    expect(ok.state).toBe('up');
    expect(ok.latencyMs).toBeGreaterThanOrEqual(0);

    const bad = await probeDb(fakePrisma(() => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:5433'))));
    expect(bad.state).toBe('down');
    expect(bad.detail).toContain('ECONNREFUSED');
  });

  it('probeDb：连接永久挂起 → 1s 硬超时内判 down（不挂住调用方）', async () => {
    const t0 = Date.now();
    const res = await probeDb(fakePrisma(() => new Promise(() => undefined)), 150);
    expect(res.state).toBe('down');
    expect(res.detail).toContain('超时');
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('probeRedis：PONG → up；连接拒绝 → down；挂起 → 超时 down', async () => {
    expect((await probeRedis({ ping: async () => 'PONG' })).state).toBe('up');
    expect((await probeRedis({ ping: async () => 'pong' })).state).toBe('up');
    const wrong = await probeRedis({ ping: async () => 'LOADING' });
    expect(wrong.state).toBe('down');
    expect(wrong.detail).toContain('PING 返回异常');

    const refused = await probeRedis({ ping: async () => { throw new Error('connect ECONNREFUSED'); } });
    expect(refused.state).toBe('down');

    const hung = await probeRedis({ ping: () => new Promise(() => undefined) }, 120);
    expect(hung.state).toBe('down');
    expect(hung.detail).toContain('超时');
  });

  it('probeLocalStorage：存在目录 up / 不存在目录 down（非关键依赖也只报字段）', async () => {
    const ok = await probeLocalStorage(process.cwd());
    expect(ok.state).toBe('up');
    const bad = await probeLocalStorage('Z:/definitely/not/here/m8-p9');
    expect(bad.state).toBe('down');
  });

  it('默认探测超时 = 1s（可用 HEALTH_PROBE_TIMEOUT_MS 覆盖）', () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(1_000);
  });
});

describe('M8-P9 就绪裁决（分级：critical 决定 503，非关键依赖只降级）', () => {
  it('isReady：DB + Redis 全 up → true；任一 down → false', () => {
    expect(isReady(up, up)).toBe(true);
    expect(isReady(down, up)).toBe(false);
    expect(isReady(up, down)).toBe(false);
    expect(isReady(down, down)).toBe(false);
  });

  it('evaluateStatus：全 up → ok；仅存储 down → degraded；critical down → unavailable', () => {
    expect(evaluateStatus(up, up, 'up')).toBe('ok');
    expect(evaluateStatus(up, up, 'down')).toBe('degraded');
    expect(evaluateStatus(down, up, 'up')).toBe('unavailable');
    expect(evaluateStatus(up, down, 'up')).toBe('unavailable');
  });

  it('check()：DB 不可达 → ready=false + status=unavailable（/ready 应 503）', async () => {
    const svc = new StubHealthService({ db: down, redis: up, storage: up });
    const report = await svc.check();
    expect(report.ready).toBe(false);
    expect(report.status).toBe('unavailable');
    expect(report.checks.find((c) => c.name === 'db')).toMatchObject({ critical: true, state: 'down' });
  });

  it('check()：Redis 不可达 → ready=false + 队列结论复用 Redis 探测（不重复打网络）', async () => {
    const svc = new StubHealthService({ db: up, redis: down, storage: up });
    const report = await svc.check();
    expect(report.ready).toBe(false);
    expect(report.queue.state).toBe('down');
    expect(report.queue.detail).toBe('Redis 不可达');
  });

  it('check()：仅对象存储不可达 → ready=true + status=degraded（绝不 503）', async () => {
    const svc = new StubHealthService({ db: up, redis: up, storage: down });
    const report = await svc.check();
    expect(report.ready).toBe(true);
    expect(report.status).toBe('degraded');
    expect(report.checks.find((c) => c.name === 'storage')).toMatchObject({ critical: false, state: 'down' });
  });

  it('check()：队列计数进入报告（depth = waiting + active；未装配队列不影响 readiness）', async () => {
    const queue = { getJobCounts: vi.fn().mockResolvedValue({ waiting: 7, active: 3, delayed: 2, failed: 4 }) };
    const svc = new StubHealthService({ db: up, redis: up, storage: up });
    // 直接替换私有队列（@Optional 注入的 provider；未装配时报告 detail 但绝不改 readiness）
    (svc as unknown as { agentRunQueue?: unknown }).agentRunQueue = queue;
    const report = await svc.check();
    expect(report.queue).toMatchObject({ state: 'up', waiting: 7, active: 3, delayed: 2, failed: 4, depth: 10 });
    expect(report.ready).toBe(true);
  });

  it('check()：未装配队列 provider → queue.state=down 但 ready 仍 true（可选依赖绝不降级 readiness）', async () => {
    const svc = new StubHealthService({ db: up, redis: up, storage: up });
    const report = await svc.check();
    expect(report.queue.state).toBe('down');
    expect(report.queue.detail).toContain('未注册');
    expect(report.ready).toBe(true);
  });

  it('live()：不触发任何 I/O（依赖全挂也恒定 ok）', () => {
    const svc = new StubHealthService({ db: down, redis: down, storage: down });
    const body = svc.live();
    expect(body.status).toBe('ok');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('报告形状：db/redis/storage/queue/checks 齐全（/health 契约）', async () => {
    const svc = new StubHealthService({ db: up, redis: up, storage: up });
    const report: HealthReport = await svc.check();
    expect(Object.keys(report).sort()).toEqual(
      ['checks', 'db', 'queue', 'ready', 'redis', 'status', 'storage', 'timestamp', 'uptimeMs'].sort(),
    );
    expect(report.checks.map((c) => c.name)).toEqual(['db', 'redis', 'storage']);
  });
});
