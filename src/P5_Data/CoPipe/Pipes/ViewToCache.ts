/**
 * ViewToCache — 写意图的缓存侧执行（方向：视图 → 缓存）
 *
 * 定义统一「写意图 Mutation」；缓存 kind 的 Mutation 由本模块生成
 * 「缓存侧闭包」：立即更新 NodeCache（两库同步 + store 刷新），
 * 保证渲染基准即时生效。文件写回（慢序列）见 CacheToFile.ts。
 */

import type { NodeCache } from '../../SQLite/Cache/NodeCache';
import type { GetChildrenFn } from '../../MdFile/FileManagerModules/FileDelete';
import type { NodeKindValue } from '../../../P4_Nodes/NodeKind/NodeKind';
import type { SeqtkNode } from '../../../P4_Nodes/Node';

/**
 * 视图写意图（统一负载）
 *
 * - update    字段部分更新（archive=置 open:false、restore=置 open:true 亦经此）
 * - setBody   正文替换
 * - remove    单节点移除（含文件删除）
 * - removeTree 级联移除子树（文件侧按 childrenOf 递归）
 *
 * 其余写操作（create / route / Trash 归档移动等）为扩展点：
 * 由对应操作口业务层先完成文件/缓存动作，再经 Pipe 补通道。
 */
export type Mutation =
    | { op: 'update'; kind: NodeKindValue; nodeId: string; updates: Partial<SeqtkNode> }
    | { op: 'setBody'; kind: NodeKindValue; nodeId: string; body: string }
    | { op: 'remove'; kind: NodeKindValue; nodeId: string }
    // removeTree：**预留未接线**（当前无视图构造者）。级联删除经 DataPipe.EXEC_RemoveTree 直接走
    // 缓存侧 REMOVE_NodeTree，以保证 active + archive 两库都清理且只刷一次快照。保留此分支以便
    // 将来需要经统一写意图表达时直接接线。
    | { op: 'removeTree'; kind: NodeKindValue; nodeId: string; childrenOf: GetChildrenFn }
    // route 增删：连线目前**只存在于缓存**（源文件侧暂无对应字段，故不落盘、重启后不保留）。
    // 本 op 只同步缓存内存关系，文件侧是显式 no-op（见 CacheToFile 对应分支）；
    // 若日后要把关系持久化，应给节点加 route 字段并改走 update。
    | { op: 'route-add'; kind: NodeKindValue; nodeId: string; toId: string; description: string }
    | { op: 'route-remove'; kind: NodeKindValue; nodeId: string; toId: string };

/** 依据意图生成「缓存侧」立即执行闭包 */
export function BUILD_CacheSide(m: Mutation): (cache: NodeCache) => void {
    switch (m.op) {
        case 'update':
            return (c) => c.UPDATE_Node(m.nodeId, m.updates);
        case 'setBody':
            return (c) => c.SET_NodeBody(m.nodeId, m.body);
        case 'remove':
            return (c) => c.REMOVE_Node(m.nodeId);
        case 'removeTree':
            return (c) => { c.REMOVE_NodeTree(m.nodeId); };
        case 'route-add':
            return (c) => { c.ADD_Route(m.nodeId, m.toId, m.description); };
        case 'route-remove':
            return (c) => { c.REMOVE_Route(m.nodeId, m.toId); };
        default: {
            // 穷尽性校验：Mutation 新增 op 却漏在此实现时，编译期报错
            const unhandled: never = m;
            throw new Error(`[SeqTK] BUILD_CacheSide: 未处理的写意图 ${String(unhandled)}`);
        }
    }
}
