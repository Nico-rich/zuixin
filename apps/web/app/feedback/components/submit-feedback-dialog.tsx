'use client';

import { useState, type FormEvent } from 'react';
import { useApiMutation } from '@/lib/api';
import { createFeedback, type Feedback, type FeedbackSubjectType } from '@/lib/services/feedback';
import { Button } from '@/components/ui/button';
import { Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { SUBJECT_TYPES } from './subject-types';

/**
 * 提交反馈（POST /api/v1/feedback，限流 30/min；评分 1–5，comment ≤ 2000）。
 *
 * 口径：该写端点只要登录即可提交（JWT + 限流，无组织 RBAC 面），因此入口对所有用户开放；
 * 反馈是**用户主观评价**（不是事实源）——页面上只作为「反馈」呈现，绝不据此自动提升记忆/改写策略
 * （M12-P3 的来源可信度闸门在服务端）。
 */
export function SubmitFeedbackDialog({
  open, onOpenChange, onSubmitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: (feedback: Feedback) => void;
}) {
  const { toast } = useToast();
  const [subjectType, setSubjectType] = useState<FeedbackSubjectType>('artifact');
  const [subjectId, setSubjectId] = useState('');
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');

  const valid = subjectId.trim().length > 0 && rating >= 1 && rating <= 5;

  const submit = useApiMutation(createFeedback, {
    onSuccess: (response) => {
      toast({ title: '反馈已提交', description: `评分 ${response.data.rating} / 5`, variant: 'success' });
      onSubmitted?.(response.data);
      reset();
      onOpenChange(false);
    },
    onError: (error) => {
      toast({ title: '提交失败', description: error.code === 'TOO_MANY_REQUESTS' ? '提交过于频繁（30/分钟），请稍后再试' : error.message, variant: 'error' });
    },
  });

  function reset() {
    setSubjectType('artifact');
    setSubjectId('');
    setRating(5);
    setComment('');
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!valid || submit.isPending) return;
    submit.mutate({
      subjectType,
      subjectId: subjectId.trim(),
      rating,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <form onSubmit={onSubmit}>
        <DialogHeader>
          <div>
            <DialogTitle>提交反馈</DialogTitle>
            <DialogDescription>对制品/创意/运行结果的主观评价（1–5 分）。反馈是用户评价，不构成事实源或治理判定。</DialogDescription>
          </div>
          <DialogCloseButton onClose={() => onOpenChange(false)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">主体类型</span>
              <Select aria-label="主体类型" value={subjectType} onChange={(event) => setSubjectType(event.target.value as FeedbackSubjectType)}>
                {SUBJECT_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">主体 ID</span>
              <Input aria-label="主体 ID" value={subjectId} onChange={(event) => setSubjectId(event.target.value)} placeholder="如制品 id" />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">评分</span>
            <Select aria-label="评分" value={String(rating)} onChange={(event) => setRating(Number(event.target.value))}>
              {[5, 4, 3, 2, 1].map((value) => (
                <option key={value} value={String(value)}>{value} 分{value >= 4 ? '（好）' : value === 3 ? '（一般）' : '（差）'}</option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">内容（可选，最多 2000 字）</span>
            <Textarea
              aria-label="内容"
              rows={3}
              maxLength={2000}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="具体哪里好 / 哪里需要调整"
            />
          </label>
        </DialogContent>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="submit" disabled={!valid || submit.isPending}>{submit.isPending ? '提交中…' : '提交'}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
