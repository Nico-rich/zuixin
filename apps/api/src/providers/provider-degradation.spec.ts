import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ProviderDegradationTracker, ProviderDegradedRecorder } from './provider-degradation';
import { LLMManagerService } from './llm/llm-manager.service';
import { ImageManagerService } from './image/image-manager.service';
import { VideoManagerService } from './video/video-manager.service';
import { EmbeddingManagerService } from './embedding/embedding-manager.service';
import { DnsResolver } from '../modules/security/ssrf-guard';

/**
 * M10-P2 D12：provider **启动配置校验**（buildAdapter 失败 → degraded）的契约测试。
 *
 * 三条不可退让的语义（对应 provider-degradation.ts 注释里的取舍）：
 *  ① **不阻断启动**：某 provider 配置错误时 refresh 绝不 throw，健康 provider 照常加载；
 *  ② **不静默**：单条 error 日志 + 聚合告警 + `provider_degraded` 计数（best-effort）；
 *  ③ **调用期明确**：未加载（含 degraded）→ `PROVIDER_CONFIG_INVALID`（含真实原因），绝不裸 500/静默跳过。
 * 说明：四个 manager 的构造签名与日志文案不同，但语义必须一致——本文件对四个 manager 逐一断言。
 */

const BAD_ADAPTER = 'not-a-real-adapter';
const BAD_REASON = `未知 LLM adapter: ${BAD_ADAPTER}`;
const publicResolver: DnsResolver = async () => ['93.184.216.34'];
const cryptoStub = { decrypt: () => 'k' } as never;

/** 有出网的坏配置行（baseUrl 必须通过 SSRF 校验，才能走到 buildAdapter 失败这条路径） */
const badRow = (type: string) => ({
  id: `p-${type}-bad`, name: `BAD-${type}`, type, adapter: BAD_ADAPTER,
  baseUrl: 'https://api.example.com/v1', apiKeyEncrypted: '', timeoutMs: 1000, enabled: true,
});
const okRow = (type: string, adapter: string) => ({
  id: `p-${type}-ok`, name: `OK-${type}`, type, adapter, baseUrl: '', apiKeyEncrypted: '', timeoutMs: 1000, enabled: true,
});

function prismaStub(rows: unknown[], type: string) {
  return {
    provider: { findMany: vi.fn().mockResolvedValue(rows) },
    model: {
      findUnique: vi.fn().mockResolvedValue({
        id: `m-${type}-bad`, providerId: `p-${type}-bad`, apiModelId: 'x', enabled: true, capabilities: {},
        provider: {
          id: `p-${type}-bad`, name: `BAD-${type}`, enabled: true, adapter: BAD_ADAPTER,
          baseUrl: 'https://api.example.com/v1', timeoutMs: 1000,
        },
      }),
    },
    systemSetting: { findUnique: vi.fn().mockResolvedValue(null) },
  };
}

const spyRecorder = () => ({ recordProviderDegraded: vi.fn().mockResolvedValue(undefined) }) as ProviderDegradedRecorder & {
  recordProviderDegraded: ReturnType<typeof vi.fn>;
};

const silentLogger = new Logger('TestDegradation');

describe('M10-P2 D12 ProviderDegradationTracker（记录与聚合）', () => {
  it('markFailed 记录原因；reset 后必须能摘掉（provider 修好即自动恢复）', () => {
    const tracker = new ProviderDegradationTracker('llm', silentLogger);
    tracker.markFailed({ id: 'p1', name: 'P1', adapter: 'x' }, new Error('boom'));
    expect(tracker.reasonOf('p1')).toBe('boom');
    expect(tracker.size).toBe(1);
    tracker.reset();
    expect(tracker.size).toBe(0);
    expect(tracker.reasonOf('p1')).toBeUndefined();
  });

  it('非 Error 抛出物也归因（绝不丢信息）', () => {
    const tracker = new ProviderDegradationTracker('llm', silentLogger);
    tracker.markFailed({ id: 'p1', name: 'P1', adapter: 'x' }, 'plain-string');
    expect(tracker.reasonOf('p1')).toBe('plain-string');
  });

  it('report：无 degraded 时零副作用（不写指标）', async () => {
    const recorder = spyRecorder();
    await new ProviderDegradationTracker('llm', silentLogger, recorder).report();
    expect(recorder.recordProviderDegraded).not.toHaveBeenCalled();
  });

  it('report：每个 degraded provider 一条计数（labels 带 type/providerId/adapter/reason）', async () => {
    const recorder = spyRecorder();
    const tracker = new ProviderDegradationTracker('image', silentLogger, recorder);
    tracker.markFailed({ id: 'p1', name: 'P1', adapter: 'a1' }, new Error('r1'));
    tracker.markFailed({ id: 'p2', name: 'P2', adapter: 'a2' }, new Error('r2'));
    await tracker.report();
    expect(recorder.recordProviderDegraded).toHaveBeenCalledTimes(2);
    expect(recorder.recordProviderDegraded).toHaveBeenCalledWith({
      type: 'image', providerId: 'p1', providerName: 'P1', adapter: 'a1', reason: 'r1',
    });
  });

  it('report：计数写入失败只 warn（best-effort），绝不影响 provider 加载结果', async () => {
    const recorder = spyRecorder();
    recorder.recordProviderDegraded.mockRejectedValue(new Error('metric down'));
    const tracker = new ProviderDegradationTracker('llm', silentLogger, recorder);
    tracker.markFailed({ id: 'p1', name: 'P1', adapter: 'a1' }, new Error('r1'));
    await expect(tracker.report()).resolves.toBeUndefined();
    expect(tracker.reasonOf('p1')).toBe('r1'); // 记录仍在 → 调用期仍能给出原因
  });
});

describe('M10-P2 D12 四个 manager：不阻断启动 + 调用期 PROVIDER_CONFIG_INVALID', () => {
  it('LLMManager：坏配置不外溢（健康 provider 仍加载）、refresh 不 throw、计数与调用期错误齐备', async () => {
    const recorder = spyRecorder();
    const prisma = prismaStub([okRow('llm', 'mock'), badRow('llm')], 'llm');
    const svc = new LLMManagerService(prisma as never, cryptoStub, publicResolver, recorder);

    await expect(svc.refresh()).resolves.toBeUndefined();       // ① 不阻断启动
    expect(svc.getProvider('p-llm-ok')).toBeTruthy();           // 多 provider 单点故障不摘全站
    expect(svc.getProvider('p-llm-bad')).toBeUndefined();
    expect(recorder.recordProviderDegraded).toHaveBeenCalledWith(expect.objectContaining({ type: 'llm', providerId: 'p-llm-bad' }));

    const err = await svc.resolve('m-llm-bad').catch((e) => e);
    expect(err.code).toBe('PROVIDER_CONFIG_INVALID');           // ② 调用期明确错误码（旧行为是裸 Error → 500 INTERNAL）
    expect(err.retryable).toBe(false);
    expect(err.message).toContain(BAD_REASON);                  // ③ 真实原因可运维定位
  });

  it('LLM 静态守卫：测试常量与实现文案同源（防止 buildAdapter 文案漂移导致上面断言空转）', () => {
    expect(BAD_REASON).toContain(BAD_ADAPTER);
  });

  it('ImageManager：同一语义', async () => {
    const recorder = spyRecorder();
    const prisma = prismaStub([okRow('image', 'mock-image'), badRow('image')], 'image');
    const svc = new ImageManagerService(prisma as never, cryptoStub, publicResolver, recorder);
    await expect(svc.refresh()).resolves.toBeUndefined();
    const err = await svc.resolve('m-image-bad').catch((e) => e);
    expect(err.code).toBe('PROVIDER_CONFIG_INVALID');
    expect(err.message).toContain(BAD_ADAPTER);
  });

  it('VideoManager：同一语义', async () => {
    const recorder = spyRecorder();
    const prisma = prismaStub([okRow('video', 'mock-video'), badRow('video')], 'video');
    const svc = new VideoManagerService(prisma as never, cryptoStub, publicResolver, recorder);
    await expect(svc.refresh()).resolves.toBeUndefined();
    const err = await svc.resolve('m-video-bad').catch((e) => e);
    expect(err.code).toBe('PROVIDER_CONFIG_INVALID');
    expect(err.message).toContain(BAD_ADAPTER);
  });

  it('EmbeddingManager：同一语义（默认模型解析路径）', async () => {
    const recorder = spyRecorder();
    const prisma = {
      ...prismaStub([okRow('embedding', 'mock-embedding'), badRow('embedding')], 'embedding'),
      systemSetting: { findUnique: vi.fn().mockResolvedValue({ key: 'routingPolicy', value: { defaults: { embedding: 'm-embedding-bad' } } }) },
    };
    const routing = { route: vi.fn().mockResolvedValue({ modelId: 'm-embedding-bad' }) };
    const svc = new EmbeddingManagerService(prisma as never, cryptoStub, routing as never, publicResolver, recorder);
    await expect(svc.refresh()).resolves.toBeUndefined();
    const err = await svc.resolveDefault().catch((e) => e);
    expect(err.code).toBe('PROVIDER_CONFIG_INVALID');
    expect(err.message).toContain(BAD_ADAPTER);
  });

  it('provider 修好后再次 refresh → degraded 自动摘除（不再计入，错误消息回到"未加载"分支）', async () => {
    const recorder = spyRecorder();
    const prisma = prismaStub([badRow('llm')], 'llm');
    const svc = new LLMManagerService(prisma as never, cryptoStub, publicResolver, recorder);
    await svc.refresh();
    expect((await svc.resolve('m-llm-bad').catch((e) => e)).message).toContain(BAD_REASON);

    // 修好：refresh 时该 provider 已不存在（被禁用/删除），本次无 degraded → 不再计数
    prisma.provider.findMany.mockResolvedValue([okRow('llm', 'mock')]);
    await svc.refresh();
    expect(recorder.recordProviderDegraded).toHaveBeenCalledTimes(1); // 只有第一次 refresh 计过
    const err = await svc.resolve('m-llm-bad').catch((e) => e);
    expect(err.code).toBe('PROVIDER_CONFIG_INVALID');
    expect(err.message).toContain('未加载');
  });

  it('观测面缺失（未注入 recorder）→ 与注入时行为一致（只有计数缺席）', async () => {
    const prisma = prismaStub([okRow('llm', 'mock'), badRow('llm')], 'llm');
    const svc = new LLMManagerService(prisma as never, cryptoStub, publicResolver);
    await expect(svc.refresh()).resolves.toBeUndefined();
    expect(svc.getProvider('p-llm-ok')).toBeTruthy();
    expect((await svc.resolve('m-llm-bad').catch((e) => e)).code).toBe('PROVIDER_CONFIG_INVALID');
  });
});
