/**
 * OperationQueue — 双队列系统
 * 
 * 两条独立队列：
 * - CacheQueue（同步链）：立即执行，用于更新缓存 + 触发 Svelte store 更新
 * - FileQueue（异步链，防抖）：延迟批量执行写磁盘
 * 
 * 操作流程：
 * 用户操作 → CacheQueue（立即更新缓存/UI） → FileQueue（延迟写磁盘） → 写完后 verifyWithDisk()
 */

import { Notice } from 'obsidian';

/** 操作错误回调类型 */
type ErrorHandler = (error: Error, context: string) => void;

export class OperationQueue {
  /** CacheQueue 同步操作队列 */
  private cacheQueue: (() => void)[] = [];
  /** FileQueue 异步操作队列 */
  private fileQueue: (() => Promise<void>)[] = [];
  /** FileQueue 是否正在执行 */
  private fileQueueRunning = false;
  /** FileQueue 防抖定时器 */
  private fileQueueTimer: ReturnType<typeof setTimeout> | null = null;
  /** 防抖时间（毫秒） */
  private debounceTime: number;
  /** 错误处理器 */
  private onError: ErrorHandler;

  /** 文件操作完成后的回调（用于触发 verifyWithDisk） */
  private onFileOpsComplete: (() => void) | null = null;

  constructor(debounceTime = 300) {
    this.debounceTime = debounceTime;
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
   * 更新防抖时间
   */
  setDebounceTime(ms: number): void {
    this.debounceTime = ms;
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
    this.fileQueue.push(op);
    this.scheduleFileQueue();
  }

  /**
   * 将多个文件操作打包入队
   * 用于级联删除等场景，确保所有文件操作在同一防抖批次中
   */
  enqueueFileBatch(ops: (() => Promise<void>)[]): void {
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
