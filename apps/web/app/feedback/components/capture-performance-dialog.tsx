'use client';

import { useState, type FormEvent } from 'react';
import { useApiMutation } from '@/lib/api';
import { capturePerformance, type CapturePerformanceResult } from '@/lib/services/feedback';
import { Button } from '@/components/ui/button';
import { Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';

/**
 * 外部绩效数据录入（POST /api/v1/feedback/performance，限流 30/min）。
 *
 * 权限如实呈现：该端点是 **JWT + 归属校验即可写**（无组织 RBAC 面）——
 *  - 只要登录就能上报（artifactId 必须属于当前用户；projectId 必须属于当前用户），
 *  - 但入口语义是「**外部上报事实**」：正文一律 UNTRUSTED（`layering.facts = reported`），
 *    服务端只据此计算 ctr/cvr/roas/cpc（`service-computed`），并**不**据此自证创意效果
 *    （M12-P1 的来源判别：Agent 无法用这条路径伪造绩效自证假设）。
 * 页面把这一口径写在表单上，不含糊其辞。
 */

/** 指标字段（与后端 CapturePerformanceSchema.metrics 严格对齐；顺序即表单顺序） */
const METRIC_FIELDS: ReadonlyArray<{ key: MetricKey; label: string; integer: boolean }> = [
  { key: 'impressions', label: '展示量 impressions', integer: true },
  { key: 'clicks', label: '点击量 clicks', integer: true },
  { key: 'spend', label: '花费 spend', integer: false },
  { key: 'conversions', label: '转化数 conversions', integer: true },
  { key: 'revenue', label: '收入 revenue', integer: false },
  { key: 'orders', label: '订单数 orders', integer: true },
];

type MetricKey = 'impressions' | 'clicks' | 'spend' | 'conversions' | 'revenue' | 'orders';
type MetricInput = Record<MetricKey, string>;

const INITIAL_METRICS: MetricInput = { impressions: '0', clicks: '0', spend: '0', conversions: '0', revenue: '0', orders: '0' };

/** 非负数字解析：空串/非法 → null（整数字段拒绝小数，与后端 z.number().int() 对齐） */
function parseMetric(raw: string, integer: boolean): number | null {
  const text = raw.trim();
  if (text === '') return null;
  if (integer ? !/^\d+$/.test(text) : !/^\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function CapturePerformanceDialog({
  open, onOpenChange, onCaptured,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCaptured?: (result: CapturePerformanceResult) => void;
}) {
  const { toast } = useToast();
  const [metrics, setMetrics] = useState<MetricInput>({ ...INITIAL_METRICS });
  const [platform, setPlatform] = useState('');
  const [artifactId, setArtifactId] = useState('');
  const [campaignId, setCampaignId] = useState('');

  const parsed = METRIC_FIELDS.map((field) => parseMetric(metrics[field.key], field.integer));
  const valid = parsed.every((value) => value !== null);

  const capture = useApiMutation(capturePerformance, {
    onSuccess: (response) => {
      toast({ title: '绩效事实已录入', description: `performanceId ${response.data.performanceId}`, variant: 'success' });
      onCaptured?.(response.data);
      setMetrics({ ...INITIAL_METRICS });
      setPlatform('');
      setArtifactId('');
      setCampaignId('');
      onOpenChange(false);
    },
    onError: (error) => {
      toast({
        title: '录入失败',
        description: error.code === 'TOO_MANY_REQUESTS' ? '录入过于频繁（30/分钟），请稍后再试' : error.message,
        variant: 'error',
      });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!valid || capture.isPending) return;
    const [impressions, clicks, spend, conversions, revenue, orders] = parsed as number[];
    capture.mutate({
      metrics: { impressions, clicks, spend, conversions, revenue, orders },
      ...(platform.trim() ? { platform: platform.trim() } : {}),
      ...(artifactId.trim() ? { artifactId: artifactId.trim() } : {}),
      ...(campaignId.trim() ? { campaignId: campaignId.trim() } : {}),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <form onSubmit={onSubmit}>
        <DialogHeader>
          <div>
            <DialogTitle>录入手工绩效数据</DialogTitle>
            <DialogDescription>
              外部绩效「事实」入口（任何登录用户皆可写：仅校验制品/项目归属，限流 30/分钟）。
              上报数据一律视为外部不可信（UNTRUSTED），只做事实展示；ctr/cvr/roas/cpc 由服务端计算，不参与策略判定。
            </DialogDescription>
          </div>
          <DialogCloseButton onClose={() => onOpenChange(false)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {METRIC_FIELDS.map((field) => (
              <label key={field.key} className="block">
                <span className="mb-1 block text-xs text-zinc-400">{field.label}</span>
                <Input
                  aria-label={field.label}
                  inputMode="decimal"
                  value={metrics[field.key]}
                  onChange={(event) => setMetrics((prev) => ({ ...prev, [field.key]: event.target.value }))}
                />
              </label>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">平台（可选）</span>
              <Input aria-label="平台" value={platform} onChange={(event) => setPlatform(event.target.value)} placeholder="如 mock / 投手后台名" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">制品 ID（可选）</span>
              <Input aria-label="制品 ID" value={artifactId} onChange={(event) => setArtifactId(event.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">活动 ID（可选）</span>
              <Input aria-label="活动 ID" value={campaignId} onChange={(event) => setCampaignId(event.target.value)} />
            </label>
          </div>
          <p className="text-[11px] text-zinc-600">
            周期未填时服务端按「最近 30 天」落库；数字一律按非负值校验（展示/点击/转化/订单为整数）。
          </p>
        </DialogContent>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="submit" disabled={!valid || capture.isPending}>{capture.isPending ? '录入中…' : '录入绩效'}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
