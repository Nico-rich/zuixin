'use client';

import { use, useCallback, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogCloseButton, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SkeletonLines } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { useApiMutation, useApiQuery, useApiQueryClient } from '@/lib/api';
import {
  attachHypothesisEvaluation, attachHypothesisExperiment, concludeHypothesis, creativeKeys, deleteHypothesis,
  getHypothesis, getHypothesisRun, getHypothesisStatus, setHypothesisStatus, startHypothesis, updateHypothesis,
  type HypothesisStatus, type HypothesisView, type LoopStatusResult, type SuccessCriteria,
} from '@/lib/services/creative';
import {
  ActionError, EmptyState, FieldRow, GuardedAction, Hint, HypothesisStatusCell, PollingHint, RefLink,
  RunStepsTable, StatusMachine, TextBlock, ValueView, VerdictPanel,
} from '../../components/creative-ui';
import {
  PENDING_LABEL, ROLLBACK_LABEL, asView, canAttachHypothesis, canConcludeHypothesis, canDeleteHypothesis,
  canEditHypothesis, canRejectHypothesis, canStartHypothesis, canSubmitHypothesis, concludeBlockedByRun,
  concludeDecisionOptions, criteriaText, formatDateTime, isTerminalStatus, pollIntervalFor, shortId,
  type HistoryEntryShape, type LoopRefShape, type PendingShape, type RollbackShape, type RunViewShape,
  type VerdictShape,
} from '../../components/creative-view';

/**
 * M13-W4 假设详情（/creative/hypotheses/[id]）
 *
 * 事实与判定（**只读呈现，绝不代做判定**）：
 *  - 状态 / 判据 / loop 引用 / 评测引用 / 实验引用 / verdict / 历史状态链；
 *  - 待办（pending）与回滚（rollback）**原样展示**：rollback=pending/failed 绝不被吞掉
 *    （补偿失败绝不重试，需人工兜底）；
 *  - verdict 由人工/判据/系统收敛产生——LLM 不决定治理判定。
 *
 * 接线纪律：所有写操作按后端状态机与权限语义显隐/禁用，禁用时**常显原因**；
 * 服务端才是裁决方（status CAS + version CAS，非法边 400），前端禁用只防误操作。
 *
 * 轮询：`getStatus`（主状态源，含读路径收敛）+ `getRun`（步骤留痕）在 **running 态每 3 秒**刷新，
 * 终态/未启动一律停止（`pollIntervalFor`）。
 */

const STATEMENT_MIN = 4;
const STATEMENT_MAX = 300;
/** 观察窗（ms）上限：与后端 WorkflowTypes.WAIT_MAX_MS（7 天）一致 */
const WAIT_MIN_MS = 500;
const WAIT_MAX_MS = 7 * 86400_000;
const CRITERIA_METRICS: ReadonlyArray<SuccessCriteria['metric']> = ['avg_score', 'pass_rate', 'roas', 'ctr'];

interface EvalRunRow { id: string; status: string; datasetVersion: number; completedAt: string | null }
interface ExperimentRow { id: string; name: string; status: string; variantCount: number }

export default function HypothesisDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const queryClient = useApiQueryClient();
  const { toast } = useToast();

  const [dialog, setDialog] = useState<
    'edit' | 'reject' | 'start' | 'conclude' | 'attach-eval' | 'attach-exp' | 'delete' | null
  >(null);
  const [actionError, setActionError] = useState('');
  const [formError, setFormError] = useState('');

  // 编辑表单
  const [editStatement, setEditStatement] = useState('');
  const [editRationale, setEditRationale] = useState('');
  const [editTarget, setEditTarget] = useState('');
  const [editPlatform, setEditPlatform] = useState('');
  const [editInsightId, setEditInsightId] = useState('');
  const [editUseCriteria, setEditUseCriteria] = useState(false);
  const [editMetric, setEditMetric] = useState<SuccessCriteria['metric']>('avg_score');
  const [editOp, setEditOp] = useState<SuccessCriteria['op']>('gte');
  const [editValue, setEditValue] = useState('0.8');
  // 启动 / 放弃 / 判定 / 挂接表单
  const [startForm, setStartForm] = useState({ platform: '', target: '', riskLevel: '', waitMs: '', approvalReason: '' });
  const [rejectReason, setRejectReason] = useState('');
  const [concludeDecision, setConcludeDecision] = useState<'validated' | 'rejected' | 'criteria'>('validated');
  const [concludeReason, setConcludeReason] = useState('');
  const [attachEvalId, setAttachEvalId] = useState('');
  const [attachExpId, setAttachExpId] = useState('');

  /* ------------------------------- 读路径 ------------------------------- */

  // 文档（假设详情）：首屏与静态部分；运行期以 getStatus 返回的同一行为准（读路径会顺带做收敛投影）
  const docQuery = useApiQuery<{ data: HypothesisView }>({
    queryKey: creativeKeys.hypothesis(id),
    path: `/api/v1/creative-loop/hypotheses/${id}`,
  });
  // 主状态源 + 轮询（running 态 3s；终态停止）
  const statusQuery = useApiQuery<{ data: LoopStatusResult }>({
    queryKey: creativeKeys.status(id),
    path: `/api/v1/creative-loop/hypotheses/${id}/status`,
    refetchInterval: (query) => pollIntervalFor(query.state.data?.data.hypothesis.status),
  });
  // 运行明细（步骤留痕；run 生命周期归 M7-P6）
  const runQuery = useApiQuery<{
    data: { hypothesis: HypothesisView; run: RunViewShape | null; pending: PendingShape; rollback: RollbackShape };
  }>({
    queryKey: ['creative-hypothesis-run', id],
    path: `/api/v1/creative-loop/hypotheses/${id}/run`,
    enabled: Boolean(docQuery.data?.data.loop),
    refetchInterval: (query) => pollIntervalFor(query.state.data?.data.hypothesis.status),
  });
  // 挂接弹窗的可选项（仅打开时请求——最小读）
  const evalRunsQuery = useApiQuery<{ data: { runs: EvalRunRow[] } }>({
    queryKey: ['evaluation-runs', 'attach-picker'],
    path: '/api/v1/evaluation/runs?limit=50',
    enabled: dialog === 'attach-eval',
  });
  const experimentsQuery = useApiQuery<{ data: { experiments: ExperimentRow[] } }>({
    queryKey: ['evaluation-experiments', 'attach-picker'],
    path: '/api/v1/evaluation/experiments?limit=50',
    enabled: dialog === 'attach-exp',
  });

  const hypothesis = statusQuery.data?.data.hypothesis ?? docQuery.data?.data ?? null;
  const status: HypothesisStatus | null = hypothesis?.status ?? null;
  const run = statusQuery.data?.data.run ?? null;
  const runStatus = run?.status ?? null;
  const pending: PendingShape | null = statusQuery.data?.data.pending ?? null;
  const rollback: RollbackShape | null = statusQuery.data?.data.rollback ?? null;
  const runDetail = asView<RunViewShape | null>(runQuery.data?.data.run);
  const loopRef = asView<LoopRefShape | null>(hypothesis?.loop);
  const verdict = asView<VerdictShape | null>(hypothesis?.verdict);
  const history = asView<HistoryEntryShape[]>(hypothesis?.history ?? []);
  const criteria = criteriaText(hypothesis?.successCriteria);
  /** loop 引用存在性（`loop` 在 F1 契约中是 unknown，需显式布尔化才能在 JSX 条件中使用） */
  const hasLoop = Boolean(hypothesis?.loop);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: creativeKeys.hypothesis(id) });
    void queryClient.invalidateQueries({ queryKey: creativeKeys.status(id) });
    void queryClient.invalidateQueries({ queryKey: ['creative-hypothesis-run', id] });
    void queryClient.invalidateQueries({ queryKey: ['creative-hypotheses'] });
    setActionError('');
  }, [id, queryClient]);

  const closeAndRefresh = (title: string, description?: string) => () => {
    setDialog(null);
    setFormError('');
    refresh();
    toast({ title, description, variant: 'success' });
  };

  /* ------------------------------- 写路径 ------------------------------- */

  const updateMutation = useApiMutation(
    (input: Parameters<typeof updateHypothesis>[1]) => updateHypothesis(id, input),
    { onSuccess: closeAndRefresh('假设已更新', '仅 draft/ready 可编辑；loop 启动后陈述锁定'), onError: (e) => setFormError(e.message) },
  );
  const readyMutation = useApiMutation(
    () => setHypothesisStatus(id, { status: 'ready' }),
    { onSuccess: closeAndRefresh('已提交就绪', '现在可以启动 loop'), onError: (e) => setActionError(e.message) },
  );
  const rejectMutation = useApiMutation(
    (reason: string) => setHypothesisStatus(id, reason.trim() ? { status: 'rejected', reason: reason.trim() } : { status: 'rejected' }),
    { onSuccess: closeAndRefresh('假设已驳回', '驳回判定（decidedBy=manual）已留痕'), onError: (e) => setFormError(e.message) },
  );
  const startMutation = useApiMutation(
    (input: Parameters<typeof startHypothesis>[1]) => startHypothesis(id, input),
    { onSuccess: closeAndRefresh('loop 已启动', 'ready → running；外部副作用走审批 + 补偿链'), onError: (e) => setFormError(e.message) },
  );
  const concludeMutation = useApiMutation(
    (input: { decision?: 'validated' | 'rejected'; reason?: string }) => concludeHypothesis(id, input),
    { onSuccess: closeAndRefresh('判定已落地', '终态只读；重跑请新建假设行'), onError: (e) => setFormError(e.message) },
  );
  const attachEvalMutation = useApiMutation(
    (evaluationRunId: string) => attachHypothesisEvaluation(id, evaluationRunId),
    { onSuccess: closeAndRefresh('已挂接评测运行', '分数事实由评测模块独家提供（绝不在本页重算）'), onError: (e) => setFormError(e.message) },
  );
  const attachExpMutation = useApiMutation(
    (experimentId: string) => attachHypothesisExperiment(id, experimentId),
    { onSuccess: closeAndRefresh('已挂接实验', '实验只做评测对照，绝不下发线上流量'), onError: (e) => setFormError(e.message) },
  );
  const deleteMutation = useApiMutation(
    () => deleteHypothesis(id),
    {
      onSuccess: () => {
        setDialog(null);
        toast({ title: '假设已删除', variant: 'success' });
        void queryClient.invalidateQueries({ queryKey: ['creative-hypotheses'] });
        router.push('/creative/hypotheses');
      },
      onError: (e) => setFormError(e.message),
    },
  );

  /* ------------------------------- 表单动作 ------------------------------- */

  const openEdit = () => {
    if (!hypothesis) return;
    setEditStatement(hypothesis.statement);
    setEditRationale(hypothesis.rationale ?? '');
    setEditTarget(hypothesis.target ?? '');
    setEditPlatform(hypothesis.platform ?? '');
    setEditInsightId(hypothesis.insightId ?? '');
    setEditUseCriteria(Boolean(hypothesis.successCriteria));
    if (hypothesis.successCriteria) {
      setEditMetric(hypothesis.successCriteria.metric);
      setEditOp(hypothesis.successCriteria.op);
      setEditValue(String(hypothesis.successCriteria.value));
    }
    setFormError('');
    setDialog('edit');
  };

  const openStart = () => {
    setStartForm({
      platform: hypothesis?.platform ?? '',
      target: hypothesis?.target ?? '',
      riskLevel: '',
      waitMs: '',
      approvalReason: '',
    });
    setFormError('');
    setDialog('start');
  };

  const submitEdit = () => {
    const text = editStatement.trim();
    if (text.length < STATEMENT_MIN || text.length > STATEMENT_MAX) {
      setFormError(`假设陈述需 ${STATEMENT_MIN}~${STATEMENT_MAX} 字`);
      return;
    }
    let successCriteria: SuccessCriteria | null = null;
    if (editUseCriteria) {
      const parsed = Number(editValue);
      if (!Number.isFinite(parsed)) {
        setFormError('成功判据的阈值必须是数字');
        return;
      }
      successCriteria = { metric: editMetric, op: editOp, value: parsed };
    }
    setFormError('');
    // PATCH 语义：可编辑字段以表单为准（空值即清空 → null；strictObject 不接受多余键）。
    // 后端 UpdateHypothesisSchema 允许 successCriteria=null（清空判据），但 F1 service 的交叉类型
    // （`Partial<CreateHypothesisInput> & { successCriteria?: SuccessCriteria | null }`）把 null 收窄掉了——
    // 这里按契约真实形状显式放宽（不改 service 文件本身）。
    updateMutation.mutate({
      statement: text,
      rationale: editRationale.trim() || null,
      target: editTarget.trim() || null,
      platform: editPlatform.trim() || null,
      insightId: editInsightId.trim() || null,
      successCriteria,
    } as unknown as Parameters<typeof updateHypothesis>[1]);
  };

  const submitStart = () => {
    const waitRaw = startForm.waitMs.trim();
    let waitMs: number | undefined;
    if (waitRaw) {
      const parsed = Number(waitRaw);
      if (!Number.isInteger(parsed) || parsed < WAIT_MIN_MS || parsed > WAIT_MAX_MS) {
        setFormError(`观察窗必须是 ${WAIT_MIN_MS}~${WAIT_MAX_MS} 之间的整数毫秒`);
        return;
      }
      waitMs = parsed;
    }
    setFormError('');
    startMutation.mutate({
      ...(startForm.platform.trim() ? { platform: startForm.platform.trim() } : {}),
      ...(startForm.target.trim() ? { target: startForm.target.trim() } : {}),
      ...(startForm.riskLevel ? { riskLevel: startForm.riskLevel as 'low' | 'medium' | 'high' } : {}),
      ...(waitMs !== undefined ? { waitMs } : {}),
      ...(startForm.approvalReason.trim() ? { approvalReason: startForm.approvalReason.trim() } : {}),
    });
  };

  const submitConclude = () => {
    const reason = concludeReason.trim();
    setFormError('');
    if (concludeDecision === 'criteria') {
      // 无 decision = 服务端按假设判据 + 服务端事实判定（无判据/事实不足 → 400，页面已前置禁用）
      concludeMutation.mutate(reason ? { reason } : {});
      return;
    }
    concludeMutation.mutate({ decision: concludeDecision, ...(reason ? { reason } : {}) });
  };

  /* ------------------------------- 渲染 ------------------------------- */

  if (docQuery.isLoading && statusQuery.isLoading) {
    return <div className="mx-auto max-w-4xl px-4 py-8"><SkeletonLines lines={5} /></div>;
  }
  if (!hypothesis) {
    const message = statusQuery.error?.message ?? docQuery.error?.message ?? '假设不存在或无权访问';
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <p className="text-sm text-red-400">假设加载失败：{message}</p>
        <Link href="/creative/hypotheses" className="mt-4 inline-block text-xs text-zinc-400 hover:text-zinc-100">← 假设列表</Link>
      </div>
    );
  }

  const terminal = isTerminalStatus(hypothesis.status);
  const blockedByRun = concludeBlockedByRun(hypothesis.status, runStatus);
  const statusText = hypothesis.status;
  /** 判定方式（按状态机可达边过滤：draft/ready 只能 rejected，validated 仅执行中可达） */
  const concludeOptions = concludeDecisionOptions(statusText, Boolean(hypothesis.successCriteria));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/creative/hypotheses" className="text-xs text-zinc-500 hover:text-zinc-300">← 假设列表</Link>

      <div className="mt-4 mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-zinc-100">{hypothesis.statement}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <HypothesisStatusCell status={statusText} />
            {terminal && <Badge variant="outline">终态只读（重跑走新假设行）</Badge>}
            <PollingHint active={statusText === 'running'} />
          </div>
        </div>
        {hypothesis.insightId
          ? <RefLink href={`/creative/insights/${hypothesis.insightId}`}>来源洞察 →</RefLink>
          : <span className="text-xs text-zinc-600">无来源洞察</span>}
      </div>

      <div className="mb-4 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
        <StatusMachine current={statusText} />
      </div>

      <section className="mb-6 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-300">操作（按状态机语义：不可用即禁用并给出原因；服务端仍为裁决方）</h2>
        <div className="flex flex-wrap gap-4">
          <GuardedAction
            label="编辑假设"
            enabled={canEditHypothesis(statusText)}
            hint={terminal ? `假设已终态（${statusText}），不可再变更` : '仅草稿/就绪可编辑——loop 启动后假设陈述已固化进定义与审批理由'}
            onClick={openEdit}
          />
          <GuardedAction
            label="提交就绪"
            enabled={canSubmitHypothesis(statusText)}
            hint={`仅草稿可提交就绪（当前 ${statusText}）`}
            onClick={() => readyMutation.mutate()}
            busy={readyMutation.isPending}
          />
          <GuardedAction
            label="放弃假设"
            enabled={canRejectHypothesis(statusText)}
            hint={terminal ? `假设已终态（${statusText}），不可再变更` : '仅草稿/就绪可放弃——执行中需等 run 结束或由运维取消 run'}
            onClick={() => { setRejectReason(''); setFormError(''); setDialog('reject'); }}
          />
          <GuardedAction
            label="启动 loop"
            enabled={canStartHypothesis(statusText)}
            hint={statusText === 'running'
              ? 'loop 已在执行（重复启动是幂等的，后端直接返回现状）'
              : `仅就绪（ready）可启动（当前 ${statusText}）；外部副作用走审批 + 补偿链`}
            onClick={openStart}
          />
          <GuardedAction
            label="判定"
            enabled={canConcludeHypothesis(statusText) && !blockedByRun && !terminal}
            hint={terminal ? `终态只读（${statusText}）`
              : blockedByRun ? `loop 仍在执行（run=${runStatus}），待运行结束后判定`
                : `当前状态不可判定（${statusText}）`}
            onClick={() => {
              const options = concludeDecisionOptions(statusText, Boolean(hypothesis.successCriteria));
              setConcludeDecision(options[0] ?? 'rejected');
              setConcludeReason('');
              setFormError('');
              setDialog('conclude');
            }}
          />
          <GuardedAction
            label="挂接评测"
            enabled={canAttachHypothesis(statusText)}
            hint={`仅就绪/执行中可挂接（当前 ${statusText}）——评测与流量选路严格分离`}
            onClick={() => { setAttachEvalId(hypothesis.evaluationRunId ?? ''); setFormError(''); setDialog('attach-eval'); }}
          />
          <GuardedAction
            label="挂接实验"
            enabled={canAttachHypothesis(statusText)}
            hint={`仅就绪/执行中可挂接（当前 ${statusText}）——实验只做评测对照`}
            onClick={() => { setAttachExpId(hypothesis.experimentId ?? ''); setFormError(''); setDialog('attach-exp'); }}
          />
          <GuardedAction
            label="删除假设"
            variant="destructive"
            enabled={canDeleteHypothesis(statusText)}
            hint={`仅 draft/rejected 可删除（当前 ${statusText}；后端保留已启动/已验证的假设行作为历史事实）`}
            onClick={() => { setFormError(''); setDialog('delete'); }}
          />
        </div>
        <ActionError message={actionError} />
      </section>

      <section className="mb-6 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
        <h2 className="mb-2 text-sm font-medium text-zinc-300">假设定义</h2>
        <FieldRow label="陈述"><TextBlock>{hypothesis.statement}</TextBlock></FieldRow>
        <FieldRow label="rationale">{hypothesis.rationale ? <TextBlock>{hypothesis.rationale}</TextBlock> : '—'}</FieldRow>
        <FieldRow label="target / platform">
          {hypothesis.target ?? '—'} <span className="text-zinc-600">/</span> {hypothesis.platform ?? '—'}
        </FieldRow>
        <FieldRow label="成功判据">
          {criteria ?? '未声明判据（判定必须显式给出 decision）'}
        </FieldRow>
        <FieldRow label="来源洞察">
          {hypothesis.insightId ? <RefLink href={`/creative/insights/${hypothesis.insightId}`}>{hypothesis.insightId}</RefLink> : '—'}
        </FieldRow>
        <FieldRow label="创建 / 更新">{formatDateTime(hypothesis.createdAt)} / {formatDateTime(hypothesis.updatedAt)}</FieldRow>
      </section>

      <section className="mb-6 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
        <h2 className="mb-2 text-sm font-medium text-zinc-300">执行引用（只引用，绝不代管生命周期）</h2>
        <FieldRow label="loop 引用">
          {loopRef?.runId ? (
            <>
              <RefLink href={`/workflows/${loopRef.workflowId ?? ''}`}>workflow {shortId(loopRef.workflowId)}</RefLink>
              <span className="mx-2 text-zinc-600">·</span>
              <RefLink href={`/workflows/runs/${loopRef.runId}`}>run {shortId(loopRef.runId)}</RefLink>
              <span className="ml-2 text-[11px] text-zinc-500">第 {loopRef.attempts ?? 1} 次 · {formatDateTime(loopRef.startedAt)}</span>
            </>
          ) : '未启动（无 loop 引用）'}
        </FieldRow>
        <FieldRow label="评测运行">
          {hypothesis.evaluationRunId ? <RefLink href={`/evaluation/runs/${hypothesis.evaluationRunId}`}>{hypothesis.evaluationRunId}</RefLink> : '未挂接'}
          {hypothesis.baselineRunId && (
            <>
              <span className="mx-2 text-zinc-600">· 基线</span>
              <RefLink href={`/evaluation/runs/${hypothesis.baselineRunId}`}>{shortId(hypothesis.baselineRunId)}</RefLink>
            </>
          )}
        </FieldRow>
        <FieldRow label="实验">
          {hypothesis.experimentId
            ? <code className="break-all font-mono text-[11px]">{hypothesis.experimentId}</code>
            : '未挂接（实验只做评测对照，绝不下发线上流量）'}
        </FieldRow>
      </section>

      <section className="mb-6 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
        <h2 className="mb-2 text-sm font-medium text-zinc-300">待办与回滚（run 终态时的只读投影，原样呈现）</h2>
        <FieldRow label="待办">
          {pending?.reason
            ? <>{PENDING_LABEL[pending.reason] ?? pending.reason}<span className="ml-2 font-mono text-[11px] text-zinc-500">{pending.reason}</span></>
            : (pending?.detail ?? '—')}
        </FieldRow>
        {pending?.detail && pending.reason && <FieldRow label="待办明细">{pending.detail}</FieldRow>}
        <FieldRow label="回滚状态">
          <Badge variant={rollback?.status === 'failed' ? 'destructive' : rollback?.status === 'pending' ? 'warning' : 'outline'}>
            {rollback ? (ROLLBACK_LABEL[rollback.status ?? 'not-required'] ?? rollback.status) : '—'}
          </Badge>
          {rollback?.detail && <span className="ml-2 text-[11px] text-zinc-500">{rollback.detail}</span>}
        </FieldRow>
        {rollback?.publishActionId && (
          <FieldRow label="发布动作"><code className="break-all font-mono text-[11px]">{rollback.publishActionId}</code></FieldRow>
        )}
        {(rollback?.compensateStepId || rollback?.errorCode) && (
          <FieldRow label="补偿留痕">
            {rollback?.compensateStepId ?? '—'}
            {rollback?.errorCode && <span className="ml-2 font-mono text-[11px] text-red-300">{rollback.errorCode}</span>}
          </FieldRow>
        )}
      </section>

      <section className="mb-6 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-zinc-300">运行明细（只读；run 生命周期归工作流模块）</h2>
          <PollingHint active={statusText === 'running'} />
        </div>
        {!hasLoop && <Hint>尚未启动 loop（启动后此处显示 run 状态与步骤留痕）</Hint>}
        {runDetail && (
          <div className="mb-3 space-y-1">
            <FieldRow label="run">
              <span className="font-mono text-xs">{runDetail.runId ?? shortId(loopRef?.runId)}</span>
              <span className="ml-2 font-mono text-[11px] text-zinc-400">{runDetail.status ?? '—'}</span>
              {runDetail.errorCode && <span className="ml-2 font-mono text-[11px] text-red-300">{runDetail.errorCode}</span>}
            </FieldRow>
            <FieldRow label="进度">
              步骤 {runDetail.currentStep ?? '—'} · attempt {runDetail.attempt ?? '—'}
              {runDetail.waitingOnApprovalId && <span className="ml-2 text-[11px] text-amber-300">待审批 {runDetail.waitingOnApprovalId}</span>}
            </FieldRow>
            {runDetail.runId && (
              <FieldRow label="完整 timeline">
                <RefLink href={`/workflows/runs/${runDetail.runId}`}>/workflows/runs/{shortId(runDetail.runId)}</RefLink>
              </FieldRow>
            )}
          </div>
        )}
        {hasLoop && (
          <>
            {runQuery.error && <p className="py-2 text-xs text-red-400">运行明细加载失败：{runQuery.error.message}</p>}
            {!runQuery.error && <RunStepsTable steps={runDetail?.steps} />}
          </>
        )}
      </section>

      <section className="mb-6 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
        <h2 className="mb-2 text-sm font-medium text-zinc-300">判定（verdict）</h2>
        <VerdictPanel verdict={verdict} />
        {verdict?.facts && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-zinc-500">判定依据事实（原始 JSON）</summary>
            <div className="mt-2"><ValueView value={verdict.facts} /></div>
          </details>
        )}
      </section>

      <section className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
        <h2 className="mb-2 text-sm font-medium text-zinc-300">历史状态链（CAS 落库的每次推进）</h2>
        {history.length === 0 && <EmptyState>尚无状态推进记录（仍为初始 draft）</EmptyState>}
        <ul className="space-y-1">
          {history.map((entry, index) => (
            <li key={`${entry.at ?? index}-${index}`} className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              <span className="font-mono">{entry.from ?? '—'} → {entry.to ?? '—'}</span>
              <Badge variant="outline">{entry.by ?? '—'}</Badge>
              <span className="text-zinc-600">{entry.at ? new Date(entry.at).toLocaleString() : '—'}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ------------------------------ 弹窗 ------------------------------ */}

      <Dialog open={dialog === 'edit'} onOpenChange={(next) => { if (!next) { setDialog(null); setFormError(''); } }}>
        <DialogHeader>
          <div>
            <DialogTitle>编辑假设</DialogTitle>
            <DialogDescription>仅草稿/就绪可编辑；表单为全量覆盖语义，空值即清空（服务端 version CAS 防丢失更新）。</DialogDescription>
          </div>
          <DialogCloseButton onClose={() => setDialog(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">假设陈述（{STATEMENT_MIN}~{STATEMENT_MAX} 字）</span>
            <Textarea aria-label="假设陈述" rows={3} value={editStatement} onChange={(e) => setEditStatement(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">rationale（清空即置 null）</span>
            <Textarea aria-label="rationale" rows={2} value={editRationale} onChange={(e) => setEditRationale(e.target.value)} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">target</span>
              <Input aria-label="target" value={editTarget} onChange={(e) => setEditTarget(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">platform</span>
              <Input aria-label="platform" value={editPlatform} onChange={(e) => setEditPlatform(e.target.value)} />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">来源洞察 ID（清空即置 null）</span>
            <Input aria-label="来源洞察 ID" value={editInsightId} onChange={(e) => setEditInsightId(e.target.value)} />
          </label>
          <div className="rounded-lg border border-zinc-800/80 p-3">
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input type="checkbox" checked={editUseCriteria} onChange={(e) => setEditUseCriteria(e.target.checked)} />
              声明成功判据（取消勾选 = 置 null，判定将必须显式给出）
            </label>
            {editUseCriteria && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Select aria-label="判据指标" className="h-8 w-36" value={editMetric} onChange={(e) => setEditMetric(e.target.value as SuccessCriteria['metric'])}>
                  {CRITERIA_METRICS.map((metric) => <option key={metric} value={metric}>{metric}</option>)}
                </Select>
                <Select aria-label="判据比较" className="h-8 w-24" value={editOp} onChange={(e) => setEditOp(e.target.value as SuccessCriteria['op'])}>
                  <option value="gte">≥</option>
                  <option value="lte">≤</option>
                </Select>
                <Input aria-label="判据阈值" className="h-8 w-28" value={editValue} onChange={(e) => setEditValue(e.target.value)} />
              </div>
            )}
          </div>
          <ActionError message={formError} />
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setDialog(null)}>取消</Button>
          <Button size="sm" disabled={updateMutation.isPending} onClick={submitEdit}>
            {updateMutation.isPending ? '保存中…' : '保存修改'}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={dialog === 'reject'} onOpenChange={(next) => { if (!next) { setDialog(null); setFormError(''); } }}>
        <DialogHeader>
          <div>
            <DialogTitle>放弃假设（人工驳回）</DialogTitle>
            <DialogDescription>draft/ready → rejected：judgment 以 decidedBy=manual 留痕；终态只读，重跑请新建假设行。</DialogDescription>
          </div>
          <DialogCloseButton onClose={() => setDialog(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">理由（可选，≤500 字）</span>
            <Textarea aria-label="驳回理由" rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
          </label>
          <ActionError message={formError} />
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setDialog(null)}>取消</Button>
          <Button size="sm" variant="destructive" disabled={rejectMutation.isPending} onClick={() => rejectMutation.mutate(rejectReason)}>
            {rejectMutation.isPending ? '提交中…' : '确认驳回'}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={dialog === 'start'} onOpenChange={(next) => { if (!next) { setDialog(null); setFormError(''); } }}>
        <DialogHeader>
          <div>
            <DialogTitle>启动 loop</DialogTitle>
            <DialogDescription>
              ready → running：建/复用 loop workflow（版本锁定）并创建 run。仅首次启动生效——定义一经固化即版本锁定。
              外部写操作走审批 + 补偿链，回滚状态在详情页原样可见。
            </DialogDescription>
          </div>
          <DialogCloseButton onClose={() => setDialog(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">platform（覆盖假设默认，可选）</span>
              <Input aria-label="platform" value={startForm.platform} onChange={(e) => setStartForm({ ...startForm, platform: e.target.value })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">target（覆盖假设默认，可选）</span>
              <Input aria-label="target" value={startForm.target} onChange={(e) => setStartForm({ ...startForm, target: e.target.value })} />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">风险级别（影响审批口径）</span>
              <Select aria-label="风险级别" value={startForm.riskLevel} onChange={(e) => setStartForm({ ...startForm, riskLevel: e.target.value })}>
                <option value="">不指定（服务端默认）</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-400">观察窗（毫秒，{WAIT_MIN_MS}~{WAIT_MAX_MS}）</span>
              <Input aria-label="观察窗" value={startForm.waitMs} placeholder="留空 = 模板默认 1 小时" onChange={(e) => setStartForm({ ...startForm, waitMs: e.target.value })} />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">审批理由（可选，≤500 字）</span>
            <Textarea aria-label="审批理由" rows={2} value={startForm.approvalReason} onChange={(e) => setStartForm({ ...startForm, approvalReason: e.target.value })} />
          </label>
          <Hint>connectionId / agentId 缺省由平台默认链决定（如需指定请在 API 侧传参）。</Hint>
          <ActionError message={formError} />
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setDialog(null)}>取消</Button>
          <Button size="sm" disabled={startMutation.isPending} onClick={submitStart}>
            {startMutation.isPending ? '启动中…' : '确认启动'}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={dialog === 'conclude'} onOpenChange={(next) => { if (!next) { setDialog(null); setFormError(''); } }}>
        <DialogHeader>
          <div>
            <DialogTitle>判定假设</DialogTitle>
            <DialogDescription>
              终态判定：validated（成立）/ rejected（不成立）。判定由人工/判据/系统收敛给出——LLM 不决定治理判定。
            </DialogDescription>
          </div>
          <DialogCloseButton onClose={() => setDialog(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">判定方式（仅列出当前状态可达的判定）</span>
            <Select
              aria-label="判定方式"
              value={concludeDecision}
              onChange={(e) => setConcludeDecision(e.target.value as 'validated' | 'rejected' | 'criteria')}
            >
              {concludeOptions.includes('criteria') && (
                <option value="criteria">按假设判据 + 服务端事实判定（{criteria ?? '未声明判据'}）</option>
              )}
              {concludeOptions.includes('validated') && <option value="validated">人工判定：成立（validated）</option>}
              {concludeOptions.includes('rejected') && <option value="rejected">人工判定：不成立（rejected）</option>}
            </Select>
          </label>
          {(statusText === 'draft' || statusText === 'ready') && (
            <Hint>当前为 {statusText}：状态机无 {statusText} → validated 边，故只能驳回（放弃）或启动 loop 后再判定。</Hint>
          )}
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">理由（可选，≤500 字）</span>
            <Textarea aria-label="判定理由" rows={3} value={concludeReason} onChange={(e) => setConcludeReason(e.target.value)} />
          </label>
          <ActionError message={formError} />
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setDialog(null)}>取消</Button>
          <Button size="sm" disabled={concludeMutation.isPending || concludeOptions.length === 0} onClick={submitConclude}>
            {concludeMutation.isPending ? '判定中…' : '确认判定'}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={dialog === 'attach-eval'} onOpenChange={(next) => { if (!next) { setDialog(null); setFormError(''); } }}>
        <DialogHeader>
          <div>
            <DialogTitle>挂接评测运行</DialogTitle>
            <DialogDescription>只引用评测运行（分数事实由评测模块独家提供，本页绝不重算）；仅就绪/执行中可挂接。</DialogDescription>
          </div>
          <DialogCloseButton onClose={() => setDialog(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">从组织评测运行中选择</span>
            <Select
              aria-label="评测运行"
              value={attachEvalId}
              onChange={(e) => setAttachEvalId(e.target.value)}
            >
              <option value="">请选择…</option>
              {(evalRunsQuery.data?.data.runs ?? []).map((row) => (
                <option key={row.id} value={row.id}>{`${row.status} · v${row.datasetVersion} · ${row.id.slice(0, 8)}`}</option>
              ))}
            </Select>
          </label>
          {evalRunsQuery.isLoading && <Hint>评测运行加载中…</Hint>}
          {evalRunsQuery.error && <Hint>评测运行加载失败：{evalRunsQuery.error.message}</Hint>}
          {!evalRunsQuery.isLoading && !evalRunsQuery.error && (evalRunsQuery.data?.data.runs ?? []).length === 0 && (
            <Hint>该组织暂无评测运行——可先在评测页创建，或直接手填 ID。</Hint>
          )}
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">评测运行 ID（可手填，至少 8 位）</span>
            <Input aria-label="评测运行 ID" value={attachEvalId} onChange={(e) => setAttachEvalId(e.target.value)} />
          </label>
          <ActionError message={formError} />
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setDialog(null)}>取消</Button>
          <Button
            size="sm"
            disabled={attachEvalMutation.isPending || attachEvalId.trim().length < 8}
            onClick={() => { setFormError(''); attachEvalMutation.mutate(attachEvalId.trim()); }}
          >
            {attachEvalMutation.isPending ? '挂接中…' : '确认挂接'}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={dialog === 'attach-exp'} onOpenChange={(next) => { if (!next) { setDialog(null); setFormError(''); } }}>
        <DialogHeader>
          <div>
            <DialogTitle>挂接实验</DialogTitle>
            <DialogDescription>只引用实验（仅评测对照，绝不下发线上流量——与 Provider Routing 严格分离）。</DialogDescription>
          </div>
          <DialogCloseButton onClose={() => setDialog(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">从组织实验中选择</span>
            <Select aria-label="实验" value={attachExpId} onChange={(e) => setAttachExpId(e.target.value)}>
              <option value="">请选择…</option>
              {(experimentsQuery.data?.data.experiments ?? []).map((row) => (
                <option key={row.id} value={row.id}>{`${row.name}（${row.status} · ${row.variantCount} 变体）`}</option>
              ))}
            </Select>
          </label>
          {experimentsQuery.isLoading && <Hint>实验加载中…</Hint>}
          {experimentsQuery.error && <Hint>实验加载失败：{experimentsQuery.error.message}</Hint>}
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">实验 ID（可手填，至少 8 位）</span>
            <Input aria-label="实验 ID" value={attachExpId} onChange={(e) => setAttachExpId(e.target.value)} />
          </label>
          <ActionError message={formError} />
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setDialog(null)}>取消</Button>
          <Button
            size="sm"
            disabled={attachExpMutation.isPending || attachExpId.trim().length < 8}
            onClick={() => { setFormError(''); attachExpMutation.mutate(attachExpId.trim()); }}
          >
            {attachExpMutation.isPending ? '挂接中…' : '确认挂接'}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={dialog === 'delete'} onOpenChange={(next) => { if (!next) { setDialog(null); setFormError(''); } }}>
        <DialogHeader>
          <div>
            <DialogTitle>删除假设</DialogTitle>
            <DialogDescription>
              仅 draft/rejected 可删除（服务端裁决）：已启动/已验证的假设行是历史事实，删除一律被拒。
            </DialogDescription>
          </div>
          <DialogCloseButton onClose={() => setDialog(null)} />
        </DialogHeader>
        <DialogContent className="space-y-3">
          <TextBlock>确认删除该假设？删除后不可恢复。</TextBlock>
          <ActionError message={formError} />
        </DialogContent>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setDialog(null)}>取消</Button>
          <Button size="sm" variant="destructive" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
            {deleteMutation.isPending ? '删除中…' : '确认删除'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
