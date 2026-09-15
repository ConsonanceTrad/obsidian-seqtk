/**
 * SimpleStore — 轻量发布订阅 store，替代 svelte/store
 * 
 * 提供与 svelte/store 兼容的 subscribe/set/update/get 接口
 * 支持 derived store（从源 store 派生计算值）
 */

// ============================================================
// SimpleStore 类
// ============================================================

export type Unsubscriber = () => void;
export type Subscriber<T> = (value: T) => void;

/**
 * 可读写 store
 */
export class SimpleStore<T> {
  private value: T;
  private subscribers = new Set<Subscriber<T>>();

  constructor(initialValue: T) {
    this.value = initialValue;
  }

  /**
   * 订阅 store 变更，立即以当前值调用一次 callback
   * @returns 取消订阅函数
   */
  subscribe(cb: Subscriber<T>): Unsubscriber {
    this.subscribers.add(cb);
    cb(this.value);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * 设置新值并通知所有订阅者
   */
  set(value: T): void {
    this.value = value;
    this.notify();
  }

  /**
   * 通过函数更新值并通知所有订阅者
   */
  update(fn: (current: T) => T): void {
    this.value = fn(this.value);
    this.notify();
  }

  /**
   * 同步获取当前值（不订阅）
   */
  get(): T {
    return this.value;
  }

  private notify(): void {
    for (const cb of this.subscribers) {
      cb(this.value);
    }
  }
}

// ============================================================
// DerivedStore 类
// ============================================================

/**
 * 只读派生 store，从一个或多个源 store 计算得出
 */
export class DerivedStore<T> {
  private value: T;
  private subscribers = new Set<Subscriber<T>>();
  private unsubscribers: Unsubscriber[] = [];

  /**
   * @param sources 源 store 数组
   * @param fn 映射函数，接收所有源 store 的当前值，返回派生值
   */
  constructor(
    sources: SimpleStore<any>[],
    fn: (values: any[]) => T
  ) {
    // 初始化：收集所有源当前值
    const currentValues = sources.map(s => s.get());
    this.value = fn(currentValues);

    // 订阅所有源 store
    for (const source of sources) {
      const unsub = source.subscribe(() => {
        const values = sources.map(s => s.get());
        this.value = fn(values);
        this.notify();
      });
      this.unsubscribers.push(unsub);
    }
  }

  /**
   * 订阅派生 store，立即以当前值调用一次 callback
   * @returns 取消订阅函数
   */
  subscribe(cb: Subscriber<T>): Unsubscriber {
    this.subscribers.add(cb);
    cb(this.value);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * 同步获取当前值
   */
  get(): T {
    return this.value;
  }

  /**
   * 销毁派生 store，取消对所有源 store 的订阅
   */
  destroy(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.subscribers.clear();
  }

  private notify(): void {
    for (const cb of this.subscribers) {
      cb(this.value);
    }
  }
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 创建只读派生 store（单源）
 */
export function derived<S, T>(
  source: SimpleStore<S>,
  fn: (value: S) => T
): DerivedStore<T> {
  return new DerivedStore<T>([source], ([value]) => fn(value));
}

/**
 * 创建只读派生 store（多源）
 */
export function derivedMulti<S extends any[], T>(
  sources: { [K in keyof S]: SimpleStore<S[K]> },
  fn: (values: S) => T
): DerivedStore<T> {
  return new DerivedStore<T>(sources, (values) => fn(values as S));
}
