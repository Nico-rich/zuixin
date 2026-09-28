import { Logger } from '@nestjs/common';
import type { Job, JobsOptions, Queue } from 'bullmq';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { isRedisTimeoutError, withDeadline } from '../redis/redis-resilience';

/**
 * Pre-M9 G4：BullMQ 投递的调用面上界（`queue.add` 有界 + 显式失败）。
 *
 * 为什么不能靠客户端选项：BullMQ 的 Worker 连接**必须** `maxRetriesPerRequest: null`
 * （Worker 用阻塞命令取作业，BullMQ 会对有界重试直接抛错），该连接与 Queue 生产者共用
 * `BullModule.forRoot({ connection })`。因此 `queue.add` 的"绝不无限挂起"只能在**调用面**保证。
 *
 * 语义：投递超过 QUEUE_ADD_TIMEOUT_MS 未返回 → 抛显式 `AppError(INTERNAL, '任务队列投递超时…')`
 * （HTTP 层转 500 + 明确文案，绝不无声挂起）；其它 BullMQ 错误原样透传（保持既有语义）。
 * 调用点可按自身语义选择是否降级（best-effort 唤醒可 catch+log；用户请求路径应显式失败）。
 */
const logger = new Logger('QueueAdd');

/** 单次投递上界（默认 2000ms；env QUEUE_ADD_TIMEOUT_MS 可覆盖，测试可调小） */
export const QUEUE_ADD_TIMEOUT_MS = (() => {
  const raw = Number(process.env.QUEUE_ADD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 2_000;
})();

/**
 * 有界投递：`queue.add` 的包装（返回 Job，兼容 `return queue.add(...)` 的既有写法）。
 * @param label 观测用标签（默认 job name）
 */
export async function addJobBounded<T>(
  queue: Queue,
  name: string,
  data: T,
  opts?: JobsOptions,
  label = name,
): Promise<Job<T, unknown, string> | unknown> {
  try {
    return await withDeadline(
      queue.add(name, data as never, opts) as unknown as Promise<Job<T, unknown, string>>,
      QUEUE_ADD_TIMEOUT_MS,
      `queue.add:${queue.name}:${label}`,
    );
  } catch (err) {
    if (isRedisTimeoutError(err)) {
      const msg = `任务队列投递超时（${queue.name}/${label}，>${QUEUE_ADD_TIMEOUT_MS}ms）：队列后端不可达或过载`;
      logger.error(msg);
      throw new AppError(ErrorCode.INTERNAL, msg, undefined, err);
    }
    throw err;
  }
}

/**
 * best-effort 投递（唤醒/重投等"尽力而为"路径）：超时或失败只记录日志，绝不冒泡。
 * 理由：这类投递的目标行已有独立兜底（如 recoverStale 巡检、行状态仍为 scheduled 可人工触发），
 * 让 Redis 抖动冒泡成业务失败反而更糟。
 */
export async function addJobBestEffort<T>(
  queue: Queue,
  name: string,
  data: T,
  opts?: JobsOptions,
  label = name,
): Promise<boolean> {
  try {
    await addJobBounded(queue, name, data, opts, label);
    return true;
  } catch (err) {
    logger.warn(`队列投递失败（best-effort，${queue.name}/${label}）: ${(err as Error).message}`);
    return false;
  }
}
