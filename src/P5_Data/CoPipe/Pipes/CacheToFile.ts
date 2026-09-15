/**
 * CacheToFile — 写意图的文件侧执行（方向：缓存 → 文件，慢序列）
 *
 * 依据意图生成「文件侧」异步闭包：经 FileManagerModules 原子写回源 md。
 * 由 Pipe 门面放入 OperationQueue 的 FileQueue（防抖批量）执行，
 * 不直接触碰渲染基准。
 */

import type { NodeFileManager } from '../../MdFile/NodeFileManager';
import type { Mutation } from './ViewToCache';

/** 依据意图生成「文件侧」异步闭包（写回源文件） */
export function BUILD_FileSide(m: Mutation): (file: NodeFileManager) => Promise<void> {
    switch (m.op) {
        case 'update':
            return (f) => f.update.UPDATE_Node(m.kind, m.nodeId, m.updates);
        case 'setBody':
            return (f) => f.update.UPDATE_NodeBody(m.kind, m.nodeId, m.body);
        case 'remove':
            return (f) => f.delete.DELETE_Node(m.kind, m.nodeId);
        case 'removeTree':
            return async (f) => { await f.delete.DELETE_NodeTree(m.kind, m.nodeId, m.childrenOf); };
        case 'route-add':
        case 'route-remove':
            // 连线是缓存态关系：本 op 不产生独立的文件侧动作。
            // DataPipe.EXEC_Mutation 对这两种 op 会早返回（只刷缓存、不进慢序列），
            // 此分支保留仅为 switch 穷尽与语义完备。
            return async () => { /* no-op */ };
        default: {
            // 穷尽性校验：Mutation 新增 op 却漏在此实现时，编译期报错
            const unhandled: never = m;
            throw new Error(`[SeqTK] BUILD_FileSide: 未处理的写意图 ${String(unhandled)}`);
        }
    }
}
