/**
 * Route/Slice/routeTree — 线路模式的右栏模型：双向追索的关联树
 *
 * 线路模式回答的是「这个框架被什么牵着、又牵着什么」：以它为根沿 route 边向两侧追索 ——
 * 上游是「谁指向它（那一个又指向谁…）」，下游是「它指向谁（那一个又指向谁…）」。
 * 价值正在长链上：根与某个深层节点之间没有直接边，但那条路径本身就是那层隐性关联。
 *
 * 关键取舍：**每一支只沿自己那个方向继续**（上游枝只走上游、下游枝只走下游），只有根
 * 同时展开两侧。否则上游枝会再往下游绕回根，树立刻爆炸 —— 那种折返也读不出新信息。
 *
 * 每个节点带上它**自己的直接证据**（对象 / 条件 / 信息 / 状态）：证据既不参与 route
 * 也不参与 follows，从任何一条链路都收不到，但它们是理解「这条链为什么成立」的材料。
 *
 * 环路按**路径**判断，不是全局 seen：菱形（A→B→D 与 A→C→D 汇到同一个 D）是线路的
 * 正常形态，两条都该画出来；只有真回到路径上已有的节点才算环，那一支不再展开。
 *
 * 本文件只做「查 → 组装」，不碰 DOM、不认识 React。
 *
 * 功能增补指引:
 * - 想只追一侧 → 把 BUILD_RouteTree 里根的那一侧循环去掉即可，结构与防环都不用动
 */

import { IS_KindOfCategory, NODE_KIND } from '../../../../P4_Nodes/NodeKind/NodeKind';
import { NODE_KIND_LABELS } from '../../../../P4_Nodes/NodeKind/NodeLabel';
import { EVIDENCE_KINDS } from '../../../../P7_Render/Composition/C2_Tree/drag';
import type { NodeKindValue } from '../../../../P4_Nodes/NodeKind/NodeKind';
import type { DataPipe } from '../../../../P5_Data/CoPipe/DataPipe';

/** 事务类型：与框架一起参与子树遍历（证据类不计入进度分母，见 FORMAT_SubtreeProgress） */
export const ROUTE_TXN_KINDS: NodeKindValue[] = [
    NODE_KIND.CONCEPT, NODE_KIND.CHECK, NODE_KIND.ITEM, NODE_KIND.EVENT,
];

/**
 * 单支追索的最大层数
 *
 * 两侧都可能很深且会分叉，不设上限时一次展开可能拉出整张图。被截断的那一支会在界面上
 * 标注出来，所以这不是静默截断。
 */
const MAX_DEPTH = 8;

/** 一个框架的直接证据 */
export interface RouteEvidence {
    nodeId: string;
    desc: string;
    kindLabel: string;
}

/** 追索方向：根同时展开两侧，其余各沿本方向继续 */
type RouteSide = 'root' | 'up' | 'down';

/** 树上的一节：一个框架 + 把它接到父节点的那条 route 边 */
export interface RouteTreeNode {
    nodeId: string;
    desc: string;
    kindLabel: string;
    /** 本框架子树的进度聚合 */
    progress: string;
    /** 直接挂在本框架下的证据 */
    evidence: RouteEvidence[];
    /**
     * 与父节点相连的那条 route 边的两端（根为 null）
     *
     * 直接给出 from / to，而不是让界面按方向去推：改描述与删线路都要这一对，而
     * 「本节点在边的哪一端」取决于它在哪一支上 —— 推错了就会删掉反向的那条。
     */
    edgeFrom: string | null;
    edgeTo: string | null;
    /** 那条 route 边的描述（根为空串） */
    description: string;
    /** 上游：谁指向本节点（只在上游支与根上有内容） */
    upstream: RouteTreeNode[];
    /** 下游：本节点指向谁（只在下游支与根上有内容） */
    downstream: RouteTreeNode[];
    /** 上游是否还有更深的一层但已达层数上限 */
    upstreamTruncated: boolean;
    /** 下游是否还有更深的一层但已达层数上限 */
    downstreamTruncated: boolean;
}

/**
 * 组装以 rootId 为根的双向追索树
 *
 * 根节点不存在（已被删 / 尚未载入）时返回 null，调用方据此显示空态。
 */
export function BUILD_RouteTree(pipe: DataPipe, rootId: string): RouteTreeNode | null {
    return TO_Node(pipe, rootId, 'root', null, null, '', new Set<string>(), 0);
}

function TO_Node(
    pipe: DataPipe,
    nodeId: string,
    side: RouteSide,
    edgeFrom: string | null,
    edgeTo: string | null,
    description: string,
    /** 从根到本节点的路径（含本节点之前的全部节点），用来判环 */
    path: ReadonlySet<string>,
    depth: number,
): RouteTreeNode | null {
    const node = pipe.GET_Node(nodeId);
    if (!node) return null;

    const nextPath = new Set(path);
    nextPath.add(nodeId);
    const atLimit = depth + 1 >= MAX_DEPTH;

    // 上游：谁指向本节点 —— 那条边是 (up.nodeId → nodeId)
    const upstream: RouteTreeNode[] = [];
    let upstreamTruncated = false;
    if (side !== 'down') {
        for (const up of pipe.GET_RouteIncoming(nodeId)) {
            if (nextPath.has(up.nodeId)) continue;      // 环：已在路径上，再走就绕回去
            if (atLimit) { upstreamTruncated = true; continue; }
            const child = TO_Node(pipe, up.nodeId, 'up', up.nodeId, nodeId, up.desc ?? '', nextPath, depth + 1);
            if (child) upstream.push(child);
        }
    }

    // 下游：本节点指向谁 —— 那条边是 (nodeId → down.nodeId)
    const downstream: RouteTreeNode[] = [];
    let downstreamTruncated = false;
    if (side !== 'up') {
        for (const down of pipe.GET_RouteOutgoing(nodeId)) {
            if (nextPath.has(down.nodeId)) continue;
            if (atLimit) { downstreamTruncated = true; continue; }
            const child = TO_Node(pipe, down.nodeId, 'down', nodeId, down.nodeId, down.desc ?? '', nextPath, depth + 1);
            if (child) downstream.push(child);
        }
    }

    return {
        nodeId,
        desc: node.desc,
        kindLabel: NODE_KIND_LABELS[node.kind],
        progress: FORMAT_SubtreeProgress(pipe, nodeId),
        evidence: COLLECT_Evidence(pipe, nodeId),
        edgeFrom,
        edgeTo,
        description,
        upstream,
        downstream,
        upstreamTruncated,
        downstreamTruncated,
    };
}

/**
 * 树里出现过的全部框架 nodeId（含根）
 *
 * 「新建线路」的候选据此排除**已在链路上**的框架 —— 只在直接相连的那一层排除是不够的：
 * 链路深处的框架同样已经在这张图里，再连一条只会把链条绕回自身。
 */
export function COLLECT_TreeIds(root: RouteTreeNode): Set<string> {
    const ids = new Set<string>();
    const walk = (n: RouteTreeNode): void => {
        // 同一个框架可能出现多次（菱形），已收集过就不再往下走
        if (ids.has(n.nodeId)) return;
        ids.add(n.nodeId);
        for (const c of n.upstream) walk(c);
        for (const c of n.downstream) walk(c);
    };
    walk(root);
    return ids;
}

/** 直接挂在本框架下的证据（对象 / 条件 / 信息 / 状态） */
function COLLECT_Evidence(pipe: DataPipe, fwId: string): RouteEvidence[] {
    const out: RouteEvidence[] = [];
    for (const child of pipe.GET_Children(fwId)) {
        const data = child.data;
        if (!data || !EVIDENCE_KINDS.includes(data.kind)) continue;
        out.push({ nodeId: child.nodeId, desc: data.desc, kindLabel: NODE_KIND_LABELS[data.kind] });
    }
    return out;
}

/**
 * 子树的进度聚合：`done/total 完成（pct%）`
 *
 * 遍历范围与线路模式一贯的口径一致 —— 框架与事务类计入，证据类不计
 * （它们是附属信息，混进分母会让百分比失真）。根节点自身也算一项。
 */
export function FORMAT_SubtreeProgress(pipe: DataPipe, rootId: string): string {
    let total = 0;
    let done = 0;
    const walk = (id: string): void => {
        const node = pipe.GET_Node(id);
        if (!node) return;
        total++;
        if ((node.state ?? 'plan') === 'done') done++;
        for (const child of pipe.GET_Children(id)) {
            const kind = child.data?.kind;
            if (kind && (IS_KindOfCategory(kind, 'FRAMEWORK') || ROUTE_TXN_KINDS.includes(kind))) {
                walk(child.nodeId);
            }
        }
    };
    walk(rootId);
    if (total === 0) return '—';
    return `${done}/${total} 完成（${Math.round((done / total) * 100)}%）`;
}
