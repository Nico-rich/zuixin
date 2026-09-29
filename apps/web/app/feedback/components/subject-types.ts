import type { FeedbackSubjectType } from '@/lib/services/feedback';

/**
 * 反馈主体类型（与后端 zod `SubmitFeedbackSchema.subjectType` 枚举逐字对齐——这是服务端的**白名单**，
 * 页面只做中文标签映射，绝不新增/放宽取值）。
 */
export const SUBJECT_TYPES: ReadonlyArray<{ value: FeedbackSubjectType; label: string }> = [
  { value: 'artifact', label: '制品（artifact）' },
  { value: 'creativeBrief', label: '创意简报（creativeBrief）' },
  { value: 'product', label: '产品（product）' },
  { value: 'campaign', label: '投放活动（campaign）' },
  { value: 'ad', label: '广告（ad）' },
  { value: 'generationTask', label: '生成任务（generationTask）' },
  { value: 'agentRun', label: 'Agent 运行（agentRun）' },
  { value: 'analysis', label: '分析（analysis）' },
];

export function subjectTypeLabel(value: string): string {
  return SUBJECT_TYPES.find((item) => item.value === value)?.label ?? value;
}
