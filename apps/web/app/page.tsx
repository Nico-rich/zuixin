'use client';

import Link from 'next/link';
import { ArrowRight, FlaskConical, MessagesSquare, Sparkles, Workflow, type LucideIcon } from 'lucide-react';
import { ApiError, useApiQuery } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import {
  OVERVIEW_PATH, OVERVIEW_RANGE, RECENT_CONVERSATIONS_KEY, RECENT_LIMIT, RECENT_PATH,
  formatDateTime, formatRelativeTime,
} from '@/lib/dashboard';
import { analyticsKeys, type AnalyticsOverview } from '@/lib/services/analytics';
import { type Conversation } from '@/lib/services/conversations';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton, SkeletonLines } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * Dashboard 首页（M13-W8）
 *
 * 本页替换了此前的 `redirect('/chat')`：`/` 现在是真实首页（导航「首页」项 `exact: true` 只命中这里，
 * 「对话」仍指向 /chat —— 对话默认页不变，lib/navigation.ts 无需改动）。
 *
 * 分层纪律（roadmap §4 红线：facts / derived 分离 + lib/services/analytics.ts 口径）：
 *  - 概览卡片**只渲染 analytics overview 的 `facts` 区**（服务端确定性投影，逐字段标注「事实」徽标）；
 *  - `derived`（成本派生、成功率、人均成本等）**不在本页呈现**——它们是服务端算术，不是事实，
 *    要看得去 /analytics（本页只在脚注里给出指路与来源/新鲜度，如实呈现 meta）；
 *  - 会话列表是事务表行（未聚合），单独标注「会话列表」，绝不与聚合事实混为一谈；
 *  - 前端不做任何金额/比率计算，只做展示格式化。
 *
 * 数据面（3 个查询；`/auth/me` 与 AppShell 共用同一 queryKey，全站只有一次请求）：
 *  1. useCurrentUser → 欢迎区姓名（会话失效的兜底在 AppShell，本页不重复跳登录）；
 *  2. GET /analytics/overview?range=day → 概览卡片（organizationId 省略 = 服务端解析的个人组织）；
 *  3. GET /conversations?limit=5 → 最近会话（updatedAt desc，点击进入 /chat/[id]）。
 *
 * 路径/查询键/时间格式化在 `lib/dashboard.ts`：路由文件只能导出页面约定符号（多导出会让
 * `next build` 的类型校验失败），页面与测试因此共用那一份事实源。
 */

/** 卡片数据面状态：加载 / 就绪 / 无数据 / 无权限 / 失败 */
type PanelState = 'loading' | 'ready' | 'empty' | 'forbidden' | 'error';

/** 权限类失败（服务端 RBAC 裁决）→ 空态告知，而不是给一个点了也没用的「重试」 */
function isPermissionError(error: ApiError): boolean {
  return error.code === 'FORBIDDEN' || error.code === 'ORG_DISABLED';
}

function panelState(isPending: boolean, error: ApiError | null, hasData: boolean): PanelState {
  if (isPending) return 'loading';
  if (error) return isPermissionError(error) ? 'forbidden' : 'error';
  return hasData ? 'ready' : 'empty';
}

/** facts 区取值：指标在契约里是 unknown（服务端聚合投影），渲染前必须显式收窄为有限数字 */
function factNumber(facts: Record<string, unknown> | undefined, kind: string, key: string): number | null {
  const bucket = facts?.[kind];
  if (typeof bucket !== 'object' || bucket === null) return null;
  const value = (bucket as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 该 kind 是否真的出现在本次聚合里（缺 = 该维度今天还没有聚合行，不是 0） */
function hasKind(facts: Record<string, unknown> | undefined, kind: string): boolean {
  const bucket = facts?.[kind];
  return typeof bucket === 'object' && bucket !== null;
}

/** 数字展示（缺失显示「—」，绝不把「无数据」伪装成 0） */
function formatNumber(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('zh-CN');
}

/** 指标行（dt/dd 语义；数值用 tabular-nums 对齐） */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="text-sm font-medium tabular-nums text-zinc-100">{value}</dd>
    </div>
  );
}

/** 卡片数据面（加载骨架 / 空态 / 无权限 / 失败重试 / 内容）——三张概览卡共用同一状态语义 */
function CardBody({
  state, emptyText, errorText, forbiddenText, onRetry, children,
}: {
  state: PanelState;
  emptyText: string;
  errorText: string;
  forbiddenText: string;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  if (state === 'loading') return <SkeletonLines lines={3} />;
  if (state === 'forbidden') return <p className="py-2 text-xs text-zinc-500">{forbiddenText}</p>;
  if (state === 'empty') return <p className="py-2 text-xs text-zinc-500">{emptyText}</p>;
  if (state === 'error') {
    return (
      <div className="space-y-2 py-1">
        <p className="text-xs text-red-400">{errorText}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>重试</Button>
      </div>
    );
  }
  return <>{children}</>;
}

const QUICK_LINKS: ReadonlyArray<{ href: string; label: string; description: string; icon: LucideIcon }> = [
  { href: '/chat', label: '新建对话', description: '流式对话、图片/视频任务与运行时间线', icon: MessagesSquare },
  { href: '/workflows', label: '工作流', description: '确定性编排与版本锁定执行', icon: Workflow },
  { href: '/evaluation', label: '评测', description: '数据集、评测运行与实验对照', icon: FlaskConical },
  { href: '/creative', label: '创意工作台', description: '创意项目与素材生成', icon: Sparkles },
];

export default function DashboardPage() {
  const { data: me, isPending: mePending } = useCurrentUser();
  const user = me?.data.user;

  const overview = useApiQuery<{ data: AnalyticsOverview }>({
    queryKey: analyticsKeys.overview(undefined, OVERVIEW_RANGE),
    path: OVERVIEW_PATH,
  });
  const recent = useApiQuery<{ data: Conversation[] }>({
    queryKey: RECENT_CONVERSATIONS_KEY,
    path: RECENT_PATH,
  });

  const analytics = overview.data?.data;
  const facts = analytics?.facts;
  const meta = analytics?.meta;
  const conversations = recent.data?.data ?? [];

  const usageFactsPresent = hasKind(facts, 'usage');
  const activityFactsPresent = hasKind(facts, 'agent') || hasKind(facts, 'workflow');

  const usageState = panelState(overview.isPending, overview.error, usageFactsPresent);
  const activityState = panelState(overview.isPending, overview.error, activityFactsPresent);
  const recentState = panelState(recent.isPending, recent.error, conversations.length > 0);

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
        {/* 欢迎区：姓名来自 /auth/me（与 AppShell 共享缓存，加载态只占位不写死文案） */}
        <header>
          <h1 className="text-xl font-semibold text-zinc-100">
            {mePending ? (
              <Skeleton className="inline-block h-6 w-40 align-middle" />
            ) : (
              <>你好{user ? `，${user.displayName ?? user.email}` : '，欢迎回来'}</>
            )}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            AI Agent 智能创作平台 · 今日的组织用量、最近会话与常用入口一览
          </p>
        </header>

        {/* 概览卡片行：只呈现 facts 区（每张卡带「事实」/「会话列表」徽标 + 来源说明） */}
        <section aria-labelledby="dashboard-overview-heading" className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="dashboard-overview-heading" className="text-sm font-semibold text-zinc-200">概览</h2>
            <Link href="/analytics" className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300">
              查看分析 <ArrowRight className="size-3" aria-hidden />
            </Link>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {/* 组织用量（facts.usage = usage_ledger 投影） */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>组织用量</CardTitle>
                  <Badge variant="info" title="分析 overview 的 facts 区（服务端确定性投影，非派生计算）">事实</Badge>
                </div>
                <CardDescription>今日 · facts.usage（计量台账）</CardDescription>
              </CardHeader>
              <CardContent>
                <CardBody
                  state={usageState}
                  emptyText="今日暂无用量事实（聚合行尚未生成）"
                  errorText="组织用量加载失败"
                  forbiddenText="无权查看组织用量（分析读面要求组织成员权限）"
                  onRetry={() => void overview.refetch()}
                >
                  <dl className="space-y-2">
                    <Metric label="LLM Tokens" value={formatNumber(factNumber(facts, 'usage', 'llm_tokens'))} />
                    <Metric label="LLM 成本（账本）" value={formatNumber(factNumber(facts, 'usage', 'llm_cost'))} />
                    <Metric label="生成图片" value={formatNumber(factNumber(facts, 'usage', 'image_generation'))} />
                    <Metric label="视频秒数" value={formatNumber(factNumber(facts, 'usage', 'video_seconds'))} />
                  </dl>
                </CardBody>
              </CardContent>
            </Card>

            {/* 活跃会话（会话列表 = 事务表行，未聚合 → 不冒充聚合事实） */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>活跃会话</CardTitle>
                  <Badge variant="outline" title="来自 /conversations 列表接口（事务表行，非聚合事实）">会话列表</Badge>
                </div>
                <CardDescription>最近会话（首屏 {RECENT_LIMIT} 条，按更新时间倒序）</CardDescription>
              </CardHeader>
              <CardContent>
                <CardBody
                  state={recentState}
                  emptyText="还没有会话"
                  errorText="最近会话加载失败"
                  forbiddenText="无权查看会话列表"
                  onRetry={() => void recent.refetch()}
                >
                  <dl className="space-y-2">
                    <Metric label="最近会话" value={`${conversations.length} 条`} />
                    <Metric
                      label="最近更新"
                      value={conversations[0] ? formatRelativeTime(conversations[0].updatedAt) : '—'}
                    />
                  </dl>
                </CardBody>
              </CardContent>
            </Card>

            {/* 近期活动（facts.agent / facts.workflow = 运行表投影） */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>近期活动</CardTitle>
                  <Badge variant="info" title="分析 overview 的 facts 区（服务端确定性投影，非派生计算）">事实</Badge>
                </div>
                <CardDescription>今日 · facts.agent / facts.workflow</CardDescription>
              </CardHeader>
              <CardContent>
                <CardBody
                  state={activityState}
                  emptyText="今日暂无运行活动（聚合行尚未生成）"
                  errorText="近期活动加载失败"
                  forbiddenText="无权查看运行活动（分析读面要求组织成员权限）"
                  onRetry={() => void overview.refetch()}
                >
                  <dl className="space-y-2">
                    <Metric label="Agent 运行" value={formatNumber(factNumber(facts, 'agent', 'runs'))} />
                    <Metric label="完成 / 失败" value={`${formatNumber(factNumber(facts, 'agent', 'completed'))} / ${formatNumber(factNumber(facts, 'agent', 'failed'))}`} />
                    <Metric label="工作流运行" value={formatNumber(factNumber(facts, 'workflow', 'runs'))} />
                  </dl>
                </CardBody>
              </CardContent>
            </Card>
          </div>

          {/* 分层如实呈现：来源 + 新鲜度 + 派生值去向（analytics.ts 契约要求） */}
          <p className="text-xs text-zinc-600">
            事实来源：{meta?.source.length ? meta.source.join('、') : '—'} · 刷新于 {formatDateTime(meta?.refreshedAt)} ·
            成本倍率/成功率等派生值不是事实源，请在
            <Link href="/analytics" className="mx-1 text-zinc-400 underline-offset-2 hover:underline">分析</Link>
            页查看
          </p>
        </section>

        {/* 最近会话：点击进入 /chat/[id] */}
        <section aria-labelledby="dashboard-recent-heading" className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="dashboard-recent-heading" className="text-sm font-semibold text-zinc-200">最近会话</h2>
            <Link href="/chat" className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300">
              全部会话 <ArrowRight className="size-3" aria-hidden />
            </Link>
          </div>

          <Card>
            <CardContent className="px-0 py-0">
              {recent.isPending ? (
                <div className="px-4 py-4"><SkeletonLines lines={3} /></div>
              ) : recent.error && !isPermissionError(recent.error) ? (
                // 重试入口只保留一个（「活跃会话」卡片里的那个），这里不再重复一枚按钮
                <div className="px-4 py-4"><p className="text-xs text-red-400">会话列表加载失败</p></div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>会话</TableHead>
                      <TableHead className="w-32 text-right">更新于</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {conversations.length === 0 ? (
                      <TableEmpty colSpan={2}>
                        {recent.error
                          ? '会话列表不可见'
                          : <>还没有会话，去<Link href="/chat" className="mx-1 text-zinc-300 underline-offset-2 hover:underline">新建对话</Link>开始第一次创作</>}
                      </TableEmpty>
                    ) : (
                      conversations.map((conversation) => (
                        <TableRow key={conversation.id}>
                          <TableCell>
                            <Link
                              href={`/chat/${conversation.id}`}
                              className="block truncate text-zinc-200 hover:text-zinc-50"
                              title={conversation.title}
                            >
                              {conversation.title}
                            </Link>
                          </TableCell>
                          <TableCell className="text-right text-xs text-zinc-500">
                            {formatRelativeTime(conversation.updatedAt)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </section>

        {/* 快速入口 */}
        <section aria-labelledby="dashboard-quick-heading" className="space-y-3">
          <h2 id="dashboard-quick-heading" className="text-sm font-semibold text-zinc-200">快速入口</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {QUICK_LINKS.map(({ href, label, description, icon: Icon }) => (
              <Link key={href} href={href} className="group">
                <Card className="h-full transition-colors group-hover:border-zinc-700">
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <Icon className="size-4 text-zinc-400" aria-hidden />
                      <CardTitle>{label}</CardTitle>
                    </div>
                    <CardDescription>{description}</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
