/**
 * CacheToView — 缓存渲染基准订阅（方向：缓存 → 视图）
 *
 * 缓存 kind 视图订阅 SimpleStore 快照（activeStore 活跃 / archiveStore 弃置），
 * 本模块提供类型化订阅封装；取消订阅返回 Unsubscriber。
 */

import type { SimpleStore, Unsubscriber } from '../../Svelte/SimpleStore';
import type { NodeCache } from '../../SQLite/Cache/NodeCache';
import type { SeqtkNode } from '../../../P4_Nodes/Node';

/** 订阅活跃缓存快照（未归档节点，编辑视图默认基准） */
export function SUB_ActiveView(cache: NodeCache, cb: (map: Map<string, SeqtkNode>) => void): Unsubscriber {
    return (cache.activeStore as SimpleStore<Map<string, SeqtkNode>>).subscribe(cb);
}

/** 订阅弃置缓存快照（归档节点，回收视图基准；archive 就绪后才有内容） */
export function SUB_ArchiveView(cache: NodeCache, cb: (map: Map<string, SeqtkNode>) => void): Unsubscriber {
    return (cache.archiveStore as SimpleStore<Map<string, SeqtkNode>>).subscribe(cb);
}
