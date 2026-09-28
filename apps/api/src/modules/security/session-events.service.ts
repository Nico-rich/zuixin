import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { boundedRedisOptions, redisCallDeadlineMs, withDeadline } from '../../core/redis/redis-resilience';

/**
 * M10-P1 SA-1 / X-10 / SA-4 / X-20：会话治理的**跨实例**与**token 粒度**两个面。
 *
 * ## 1) 跨实例撤销传播（pub/sub channel 名是跨 Agent 契约，不可改）
 * `AccessGuardService` 的肯定缓存（active / live）只在本进程失效——多实例部署下，
 * A 实例登出后 B 实例仍会在 ≤ TTL 窗口内放行（M8-P8 已知窗口）。
 * 本服务在**会话撤销 / 用户禁用**时向 Redis pub/sub `session-events` 发布事件，
 * 各实例订阅并清自己的肯定缓存 → 撤销**立即**全实例生效，TTL 退化为纯兜底。
 *
 * 契约（M10 计划 §8，A1↔A12）：channel 名 **`session-events`**（A12 多进程 e2e 依赖此名）。
 * 载荷：`{ type, instanceId, at, sessionId?, userId? }`（**绝不含 token/凭证**）。
 *
 * ## 2) jti 黑名单（主动轮换/登出全部）
 * 撤销会话靠 DB 的 `revokedAt` 判定；但 access token 是无状态的，且缓存层可能有陈旧肯定结论。
 * 于是额外维护 **jti 粒度**的第二道闸：签发时把 jti 记入 `auth:jti:{userId}`（ZSET，score = 过期时刻），
 * `revokeAll` 时把仍在有效期内的 jti 批量写入 `auth:jti:blacklist:{jti}`（TTL ≤ 剩余寿命，
 * **绝不**把短命 token 的墓碑留得比 token 本身更久），AccessGuard 校验时先查黑名单。
 *
 * M11-P2（D1-11）两处补强（M10 审计：ZSET 成员无逐条过期 + 逐条 SET 串行）：
 * - **懒触发清理**：`trackJti` 在每次签发顺手 `ZREMRANGEBYSCORE -inf now` 删掉已过期成员。
 *   ZSET 成员没有逐条 TTL，而集合 key 的 TTL 每次签发都被刷新（活跃用户恒不过期）——
 *   不清理则过期成员**永久堆积**；清理后集合规模 = "最近 ACCESS_TTL 窗口内的签发数"（有界），摊还 O(1)。
 * - **批量写入**：`blacklistAllUserJtis` 的 N 条墓碑由"N 次串行 await"改为**单次 pipeline**，
 *   把尾部延迟从 N×RTT 收敛到 1×RTT（pipeline 非事务，故逐条检查返回项、只对成功条目计数）。
 *
 * ## 3) 设备下线原因标记（M11-P2 D1-01，**只用于细化错误码**）
 * 按设备下线时给每个被撤销会话写 `auth:session:device-revoked:{sessionId}`（TTL = access token 上限寿命）。
 * 它的**唯一**用途：`AccessGuardService.isSessionLive(sid) === false` 时把随后的 401 从 UNAUTHORIZED
 * 细化为 `DEVICE_REVOKED`（客户端据此提示"该设备已被下线"，而不是笼统的"登录已过期"）。
 * **它不是鉴权依据**：撤销的权威判定恒为 DB `session.revokedAt`；标记丢失/Redis 故障只降级错误码，
 * 绝不放行（守卫的拒绝结论来自 DB）。
 *
 * ## 降级口径（每条都显式，绝不静默）
 * - **发布失败**：warn。撤销仍在本实例立即生效（本地 dispatch），跨实例退化为 ≤ TTL 窗口。
 * - **订阅失败**：warn + 在连接 `ready` 时自动重订阅（Redis 晚起也能自愈）。
 * - **黑名单查询失败**：**fail-open**（视为未拉黑）+ warn。理由：jti 黑名单是**纵深**层，
 *   撤销的权威判定在 DB 的 `session.revokedAt`（`AccessGuardService.isSessionLive`）——Redis 抖动时
 *   放行一次黑名单查询不会让已撤销会话复活，但 fail-closed 会把全站鉴权打死。
 * - **jti 记账失败**：warn。仅影响"登出全部能覆盖到哪些历史 access token"，会话撤销本身不受影响。
 * - **设备标记读写失败**：warn + fail-open（无标记 = 普通 UNAUTHORIZED）。仅影响 401 的**文案细度**，
 *   不影响放行/拒绝（拒绝由 DB 会话状态决定，与标记是否存在无关）。
 */
export const SESSION_EVENTS_CHANNEL = 'session-events';

/** 事件类型（新增类型时必须同步 A12 多进程 e2e 的断言矩阵） */
export type SessionEventType = 'session.revoked' | 'user.sessions_revoked' | 'user.disabled';

export interface SessionEvent {
  type: SessionEventType;
  /** 发布者实例 id（诊断用；便于在日志里区分"谁撤销的"） */
  instanceId: string;
  /** 发布时刻（epoch ms） */
  at: number;
  sessionId?: string;
  /** 受影响用户（用户级事件必填；用于清该用户的 access 判定缓存） */
  userId?: string;
}

export type SessionEventListener = (event: SessionEvent) => void;

/** jti 记账 key（ZSET：member = jti，score = 该 token 的过期时刻 epoch 秒） */
function userJtiKey(userId: string): string { return `auth:jti:${userId}`; }
/** jti 墓碑 key（值无意义；存在即已撤销） */
function jtiBlacklistKey(jti: string): string { return `auth:jti:blacklist:${jti}`; }
/** M11-P2：设备下线原因标记 key（值无意义；**只用于把 401 细化为 DEVICE_REVOKED**，不是鉴权依据） */
function deviceRevokedKey(sessionId: string): string { return `auth:session:device-revoked:${sessionId}`; }

@Injectable()
export class SessionEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SessionEvents');
  /** 本实例标识（每个 Nest 容器一个；同进程双实例 e2e 也各自独立） */
  readonly instanceId = randomUUID();
  private readonly listeners = new Set<SessionEventListener>();
  private readonly command: Redis;
  private readonly subscriber: Redis;
  private readonly deadlineMs = redisCallDeadlineMs();
  private subscribed = false;

  /**
   * @Optional 客户端注入：单测直接给假实现（无参时按 REDIS_URL 建真实连接）。
   * 两条连接是必须的：Redis 连接一旦进入 subscribe 模式就不能再跑普通命令。
   */
  constructor(@Optional() command?: Redis, @Optional() subscriber?: Redis) {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.command = command ?? new Redis(url, boundedRedisOptions());
    // 订阅连接禁用离线队列：Redis 不可达时 subscribe 立即失败并告警，绝不在离线队列里静默滞留
    this.subscriber = subscriber ?? new Redis(url, boundedRedisOptions({ enableOfflineQueue: false }));
  }

  onModuleInit(): void {
    // 订阅是**启动期非阻塞**动作：Redis 晚起不能拖死 API（ready 时自动补订阅）
    this.subscriber.on('message', (channel: string, message: string) => {
      if (channel !== SESSION_EVENTS_CHANNEL) return;
      const event = this.parse(message);
      if (event) this.dispatch(event);
    });
    this.subscriber.on('ready', () => {
      this.subscribed = false; // 重连后需要重新订阅
      void this.subscribe();
    });
    this.subscriber.on('error', (err: Error) => this.logger.warn(`session-events 订阅连接错误（跨实例撤销传播降级为 TTL 窗口）: ${err.message}`));
    void this.subscribe();
  }

  onModuleDestroy(): void {
    this.subscriber.disconnect();
    this.command.disconnect();
  }

  /** 注册监听者（AccessGuardService 用它清肯定缓存）；返回注销函数 */
  registerListener(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 发布会话事件。**尽力而为**：Redis 故障只 warn，不影响撤销本身的正确性——
   * 本实例无论如何都会立刻本地生效（见下方 dispatch）。
   */
  async publish(input: Omit<SessionEvent, 'instanceId' | 'at'>): Promise<void> {
    const event: SessionEvent = { ...input, instanceId: this.instanceId, at: Date.now() };
    try {
      await withDeadline(
        this.command.publish(SESSION_EVENTS_CHANNEL, JSON.stringify(event)),
        this.deadlineMs,
        'session-events:publish',
      );
    } catch (err) {
      this.logger.warn(`session-events 发布失败（本实例已生效；其他实例降级为 ≤ TTL 窗口）: ${(err as Error).message}`);
    }
    // 本地立即生效：不等 pub/sub 回环（Redis 回投自身订阅时也只是重复一次幂等的缓存清理）
    this.dispatch(event);
  }

  /**
   * M10-P1 SA-4：记账——签发 access token 时登记 jti（ZSET score = 过期时刻，秒）。
   * M11-P2（D1-11）：ZADD + **过期成员清理** + TTL 合并为一次 pipeline（1 个 RTT）；
   * 清理是懒触发的（每次签发顺手做，摊还 O(1)），把集合规模钉在"最近 ACCESS_TTL 内签发数"。
   */
  async trackJti(userId: string, jti: string, expEpochSec: number): Promise<void> {
    try {
      const key = userJtiKey(userId);
      const nowSec = Math.floor(Date.now() / 1000);
      // 集合整体 TTL = 最晚 token 过期 + 60s 余量（逐条成员无 TTL，故必须配合上面的 zremrangebyscore）
      const ttl = Math.max(1, expEpochSec - nowSec + 60);
      const pipe = this.command.pipeline();
      pipe.zadd(key, expEpochSec, jti);
      pipe.zremrangebyscore(key, '-inf', nowSec); // score ≤ now = 已过期 token：无需再计入"待拉黑"集合
      pipe.expire(key, ttl);
      await withDeadline(pipe.exec(), this.deadlineMs, 'session-events:track-jti');
    } catch (err) {
      // 记账失败只影响"登出全部"能覆盖到的历史 token 范围；会话撤销（DB）不受影响
      this.logger.warn(`jti 记账失败（登出全部将无法覆盖该 token；会话撤销仍生效）: ${(err as Error).message}`);
    }
  }

  /** 写单个 jti 墓碑（TTL ≤ 剩余寿命；已过期则无需写） */
  async blacklistJti(jti: string, ttlSec: number): Promise<void> {
    const ttl = Math.floor(ttlSec);
    if (!Number.isFinite(ttl) || ttl <= 0) return; // token 已过期：墓碑没有意义
    try {
      await withDeadline(this.command.set(jtiBlacklistKey(jti), '1', 'EX', ttl), this.deadlineMs, 'session-events:blacklist');
    } catch (err) {
      this.logger.warn(`jti 黑名单写入失败（会话撤销仍生效）: ${(err as Error).message}`);
    }
  }

  /**
   * 拉黑某用户**当前仍在有效期内**的全部 jti（登出全部/管理员踢出），并清空记账集合。
   * M11-P2（D1-11）：墓碑写入由"N 次串行 await"改为**单次 pipeline**（尾部延迟 N×RTT → 1×RTT）。
   * pipeline 不是事务（连接中断可部分应用），因此**逐条核对返回项**、只对成功条目计数 —— 绝不乐观上报。
   * @returns 实际拉黑条数（0 也正常：可能从未签发过 access token 或 Redis 故障降级）
   */
  async blacklistAllUserJtis(userId: string): Promise<number> {
    const nowSec = Math.floor(Date.now() / 1000);
    const key = userJtiKey(userId);
    try {
      // 只取 score > now 的 member（已过期的 token 本就无效，无需墓碑）
      const live = await withDeadline(
        this.command.zrangebyscore(key, `(${nowSec}`, '+inf', 'WITHSCORES'),
        this.deadlineMs,
        'session-events:zrange',
      );
      const entries: Array<{ jti: string; ttl: number }> = [];
      for (let i = 0; i + 1 < live.length; i += 2) {
        entries.push({ jti: live[i], ttl: Number(live[i + 1]) - nowSec });
      }
      if (entries.length === 0) {
        await withDeadline(this.command.del(key), this.deadlineMs, 'session-events:del');
        return 0;
      }
      const pipe = this.command.pipeline();
      for (const e of entries) pipe.set(jtiBlacklistKey(e.jti), '1', 'EX', e.ttl); // TTL = 剩余寿命
      pipe.del(key);
      const results = await withDeadline(pipe.exec(), this.deadlineMs, 'session-events:blacklist-all');
      let count = 0;
      for (let i = 0; i < entries.length; i += 1) {
        const r = results?.[i];
        if (!r) continue;
        if (r[0]) this.logger.warn(`jti 墓碑写入失败（该 token 仅剩 DB 会话层防线）: ${String(r[0])}`);
        else count += 1;
      }
      return count;
    } catch (err) {
      this.logger.warn(`用户全部 jti 拉黑失败（尽力而为，会话撤销仍生效）: ${(err as Error).message}`);
      return 0;
    }
  }

  /** jti 是否已拉黑。Redis 故障 → fail-open（false）+ warn：权威判定在 DB 会话状态。 */
  async isJtiBlacklisted(jti: string): Promise<boolean> {
    try {
      return (await withDeadline(this.command.exists(jtiBlacklistKey(jti)), this.deadlineMs, 'session-events:exists')) > 0;
    } catch (err) {
      this.logger.warn(`jti 黑名单查询失败（降级放行，交由 DB 会话状态裁决）: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * M11-P2：标记"这些会话是被**设备下线**撤销的"（TTL = 调用方给出的 access token 上限寿命）。
   * 单次 pipeline 批量写入；失败只 warn —— 标记仅决定 401 的**错误码细度**，不参与放行/拒绝裁决。
   */
  async markDeviceRevoked(sessionIds: string[], ttlSec: number): Promise<void> {
    const ttl = Math.floor(ttlSec);
    if (!Number.isFinite(ttl) || ttl <= 0 || sessionIds.length === 0) return;
    try {
      const pipe = this.command.pipeline();
      for (const id of sessionIds) pipe.set(deviceRevokedKey(id), '1', 'EX', ttl);
      await withDeadline(pipe.exec(), this.deadlineMs, 'session-events:mark-device-revoked');
    } catch (err) {
      this.logger.warn(`设备下线标记写入失败（撤销仍生效；随后 401 将显示为通用"登录已失效"）: ${(err as Error).message}`);
    }
  }

  /**
   * M11-P2：该会话是否由"设备下线"撤销（仅用于把 401 细化为 DEVICE_REVOKED）。
   * Redis 故障/无标记 → false（退化回 UNAUTHORIZED）：**绝不**因为查不到标记而改变放行/拒绝结论。
   */
  async isSessionDeviceRevoked(sessionId: string): Promise<boolean> {
    try {
      return (await withDeadline(this.command.exists(deviceRevokedKey(sessionId)), this.deadlineMs, 'session-events:exists-device-revoked')) > 0;
    } catch (err) {
      this.logger.warn(`设备下线标记查询失败（降级为通用 401 文案）: ${(err as Error).message}`);
      return false;
    }
  }

  /** 测试/诊断：当前监听者数量 */
  listenerCount(): number { return this.listeners.size; }

  /**
   * 测试/诊断：**本实例**的订阅是否已在 Redis 服务端生效（SUBSCRIBE 已确认）。
   *
   * 为什么不能用 `PUBSUB NUMSUB session-events` 判断就绪：通道是**实例全局**的（不同 Redis DB 的客户端
   * 在同一 channel 上互相可见——DB 号只隔离 keyspace），因此 NUMSUB 会把**其他进程/其他 Agent 的订阅者**
   * 一起数进来，用它做就绪判定会得出"我已订阅"的假阳性 → 早发的事件丢失 → 测试变成时序碰运气。
   * 本标记是进程内事实（subscribe promise 的解析即服务端已登记），与外部订阅者无关。
   */
  isSubscribed(): boolean { return this.subscribed; }

  private async subscribe(): Promise<void> {
    if (this.subscribed) return;
    try {
      await withDeadline(this.subscriber.subscribe(SESSION_EVENTS_CHANNEL), this.deadlineMs, 'session-events:subscribe');
      this.subscribed = true;
      this.logger.log(`已订阅 session-events（跨实例会话撤销传播启用，实例 ${this.instanceId.slice(0, 8)}）`);
    } catch (err) {
      this.logger.warn(`session-events 订阅失败（跨实例撤销传播降级为 ≤ TTL 窗口；连接恢复后自动重订阅）: ${(err as Error).message}`);
    }
  }

  private dispatch(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.warn(`session-events 监听者异常（不影响其他监听者）: ${(err as Error).message}`);
      }
    }
  }

  /** 反序列化：非法载荷只 warn 并丢弃（绝不因一条坏消息打断订阅循环） */
  private parse(message: string): SessionEvent | null {
    try {
      const parsed = JSON.parse(message) as Partial<SessionEvent>;
      if (typeof parsed?.type !== 'string') return null;
      return {
        type: parsed.type as SessionEventType,
        instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : 'unknown',
        at: typeof parsed.at === 'number' ? parsed.at : Date.now(),
        ...(typeof parsed.sessionId === 'string' ? { sessionId: parsed.sessionId } : {}),
        ...(typeof parsed.userId === 'string' ? { userId: parsed.userId } : {}),
      };
    } catch {
      this.logger.warn('session-events 收到无法解析的消息（已丢弃）');
      return null;
    }
  }
}
