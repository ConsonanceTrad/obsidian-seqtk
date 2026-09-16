/**
 * OperationQueue — 双队列系统
 * 
 * 两条独立队列：
 * - CacheQueue（同步链）：立即执行，用于更新缓存 + 触发 Svelte store 更新
 * - FileQueue（异步链，防抖）：延迟批量执行写磁盘
 * 
 * 操作流程：
 * 用户操作 → CacheQueue（立即更新缓存/UI） → FileQueue（延迟写磁盘） → 写完后 onFileOpsComplete
 *
 * 写入闸门（guard）：由装配层注入「缓存已与磁盘对账完成」之类的判定。闸门关闭时
 * 一切写入被拒绝并提示一次。闸门必须装在本层入队口而非缓存层，否则
 * enqueue(cacheOp, fileOp) 会出现「缓存被拒、文件照写」的不一致。
 */

import { Notice } from 'obsidian';

/** 操作错误回调类型 */
type ErrorHandler = (error: Error, context: string) => void;

/**
 * 写回防抖（毫秒）：固定值，不做成配置项
 *
 * 界面读的是缓存、改动立刻可见，这个值只决定「攒多久再一起写回源文件」。
 * 做成配置项的唯一效果是让人把它调到很小、更频繁地碰磁盘 —— 那是行为约定，不是旋钮。
 */
export const FILE_QUEUE_DEBOUNCE_MS = 300;

export class OperationQueue {
  /** CacheQueue 同步操作队列 */
  private cacheQueue: (() => void)[] = [];
  /** FileQueue 异步操作队列 */
  private fileQueue: (() => Promise<void>)[] = [];
  /** FileQueue 是否正在执行 */
  private fileQueueRunning = false;
  /** FileQueue 防抖定时器 */
  private fileQueueTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 写回防抖时间（毫秒）—— 固定值，不是配置项
   *
   * 它是「改动攒多久再一起写回源文件」的行为约定：界面读的是缓存、改动立刻可见，
   * 调小这个值不会让界面更快，只会更频繁地碰磁盘（进而牵动其它插件的文件事件）。
   */
  private readonly debounceTime = FILE_QUEUE_DEBOUNCE_MS;
  /** 错误处理器 */
  private onError: ErrorHandler;

  /** 文件操作完成后的回调（用于触发 verifyWithDisk） */
  private onFileOpsComplete: (() => void) | null = null;

  /** 写入闸门：返回 false 时拒绝一切写入（未设置则不限制） */
  private guard: (() => boolean) | null = null;

  /** 上次闸门提示时间（毫秒），用于合并同一次操作产生的多次提示 */
  private lastBlockedNotice = 0;

  constructor() {
    this.onError = (err, ctx) => {
      console.error(`[SeqTK] ${ctx}:`, err);
      new Notice(`操作失败: ${err.message}`);
    };
  }

  /**
   * 设置文件操作完成后的回调
   */
  setOnFileOpsComplete(callback: () => void): void {
    this.onFileOpsComplete = callback;
  }

  /**
   * 设置写入闸门 — 守卫返回 false 时拒绝一切写入入队
   *
   * 用于「缓存校验完成前不接受写入」：缓存加载后可能落后于磁盘，此时写入会把
   * 落后快照回写到文件；对账完成（或冷启动全量重建完成）后守卫返回 true。
   */
  setGuard(guard: () => boolean): void {
    this.guard = guard;
  }

  /**
   * 闸门检查：被拒时给出一次提示
   *
   * 同一次用户操作可能触发多次入队（如 cacheOp + fileOp），故对提示做 500ms 去重，
   * 避免同一个动作弹出多条通知。
   *
   * @returns true 表示应拒绝本次入队
   */
  private REJECT_IfBlocked(): boolean {
    if (!this.guard || this.guard()) return false;
    const now = Date.now();
    if (now - this.lastBlockedNotice > 500) {
      this.lastBlockedNotice = now;
      this.onError(new Error('缓存校验尚未完成，写操作已暂缓，请稍候重试'), '写操作被拒绝');
    }
    return true;
  }

  // ============================================================
  // CacheQueue — 同步立即执行
  // ============================================================

  /**
   * 将缓存操作入队并立即执行
   * 
   * CacheQueue 用于更新内存缓存和触发 Svelte store 更新，
   * 确保 UI 响应迅速。
   * 
   * @param op 同步操作函数
   */
  enqueueCacheOp(op: () => void): void {
    if (this.REJECT_IfBlocked()) return;
    try {
      op();
    } catch (err) {
      this.onError(err as Error, 'CacheQueue 操作失败');
    }
  }

  /**
   * 将多个缓存操作打包为一个批次执行
   * 用于级联删除等需要原子更新缓存的场景
   */
  enqueueCacheBatch(ops: (() => void)[]): void {
    if (this.REJECT_IfBlocked()) return;
    for (const op of ops) {
      try {
        op();
      } catch (err) {
        this.onError(err as Error, 'CacheQueue 批次操作失败');
      }
    }
  }

  // ============================================================
  // FileQueue — 异步防抖执行
  // ============================================================

  /**
   * 将文件操作入队
   * 
   * 文件操作会被防抖收集，在 debounceTime 毫秒无新操作后
   * 按入队顺序依次执行。
   * 
   * @param op 异步文件操作函数
   */
  enqueueFileOp(op: () => Promise<void>): void {
    if (this.REJECT_IfBlocked()) return;
    this.fileQueue.push(op);
    this.scheduleFileQueue();
  }

  /**
   * 将多个文件操作打包入队
   * 用于级联删除等场景，确保所有文件操作在同一防抖批次中
   */
  enqueueFileBatch(ops: (() => Promise<void>)[]): void {
    if (this.REJECT_IfBlocked()) return;
    this.fileQueue.push(...ops);
    this.scheduleFileQueue();
  }

  /**
   * 调度 FileQueue 执行（防抖）
   */
  private scheduleFileQueue(): void {
    if (this.fileQueueTimer) {
      clearTimeout(this.fileQueueTimer);
    }

    this.fileQueueTimer = setTimeout(() => {
      this.fileQueueTimer = null;
      this.drainFileQueue();
    }, this.debounceTime);
  }

  /**
   * 执行 FileQueue 中的所有操作
   * 
   * 按入队顺序串行执行，确保不会产生竞态条件。
   * 执行完成后触发 onFileOpsComplete 回调进行缓存校验。
   */
  private async drainFileQueue(): Promise<void> {
    if (this.fileQueueRunning) return;
    if (this.fileQueue.length === 0) return;

    this.fileQueueRunning = true;

    // 取出当前队列中的所有操作
    const ops = this.fileQueue.splice(0);

    try {
      // 串行执行，保证顺序性
      for (const op of ops) {
        try {
          await op();
        } catch (err) {
          this.onError(err as Error, 'FileQueue 操作失败');
        }
      }

      // 所有文件操作完成后，触发缓存校验
      if (this.onFileOpsComplete) {
        try {
          this.onFileOpsComplete();
        } catch (err) {
          this.onError(err as Error, '缓存校验失败');
        }
      }
    } finally {
      this.fileQueueRunning = false;

      // 如果在执行期间又有新操作入队，再次调度
      if (this.fileQueue.length > 0) {
        this.scheduleFileQueue();
      }
    }
  }

  // ============================================================
  // 组合操作
  // ============================================================

  /**
   * 执行一个完整的"更新缓存 + 延迟写磁盘"操作
   * 
   * 这是最常用的操作模式：
   * 1. 立即执行 cacheOp 更新缓存（UI 即时响应）
   * 2. 将 fileOp 入队等待写磁盘
   * 
   * @param cacheOp 同步缓存操作
   * @param fileOp 异步文件操作
   */
  enqueue(cacheOp: () => void, fileOp: () => Promise<void>): void {
    this.enqueueCacheOp(cacheOp);
    this.enqueueFileOp(fileOp);
  }

  /**
   * 执行级联删除的组合操作
   * 
   * @param cacheOps 缓存移除操作列表
   * @param fileOps 文件删除操作列表
   */
  enqueueDeleteTree(
    cacheOps: (() => void)[],
    fileOps: (() => Promise<void>)[]
  ): void {
    this.enqueueCacheBatch(cacheOps);
    this.enqueueFileBatch(fileOps);
  }

  // ============================================================
  // 生命周期
  // ============================================================

  /**
   * 刷新所有待处理的操作
   * 
   * 在插件卸载时调用，确保所有文件操作都已写入磁盘。
   * 注意：这是一个阻塞操作。
   */
  async flush(): Promise<void> {
    // 清除防抖定时器，立即触发
    if (this.fileQueueTimer) {
      clearTimeout(this.fileQueueTimer);
      this.fileQueueTimer = null;
    }

    // 等待 FileQueue 执行完毕
    await this.drainFileQueue();
  }

  /**
   * 获取队列状态（用于调试）
   */
  getStatus(): { cacheQueueLength: number; fileQueueLength: number; fileQueueRunning: boolean } {
    return {
      cacheQueueLength: this.cacheQueue.length,
      fileQueueLength: this.fileQueue.length,
      fileQueueRunning: this.fileQueueRunning,
    };
  }
}
