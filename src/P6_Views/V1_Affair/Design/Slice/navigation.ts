/**
 * design/navigation — 设计视图导航与状态切片
 *
 * 从 DesignView 拆出的「选中 / 展开 / 归属 / 委托 / 状态」这一类操作：
 * - 展开切换（单点 / 整棵子树，左右栏各自独立）
 * - 框架选中与「返回父框架」来路栈
 * - 变更归属（走拖拽同一条执行路径）
 * - 左栏委托到中控台侧栏
 * - 状态圆点左键的规划/完成循环
 *
 * 约定:
 * - 本文件函数以 view(DesignView 实例)为第一参数,只读写 view 上公开的状态
 *   （pipe / app / settings / refresh / selectedFrameworkId / expandedLeft / expandedRight /
 *   frameworkNavStack）
 * - 选中与展开的写盘由 view 的共享状态源负责（design/FrameworkTreeShared + design/session），
 *   本文件只管「改状态 + refresh」
 * - 移动的执行一律复用 design/drag 与 C2_Tree/drag 的判定，不在此另写一套
 *
 * 功能增补指引:
 * - 新增一种「切到某处 / 展开某处」的入口 → 在此追加 export function，并让菜单接线
 */

import { NodePickModal } from '../../../../P7_Render/Structure/S2_Modal/NodePickModal';
import { canBeChildOf } from '../../../../P7_Render/Composition/C2_Tree/drag';
import { NODE_KIND_LABELS, isFrameworkKind } from '../../../../P4_Nodes/NodeFacade';
import { FRAMEWORK_TREE } from './FrameworkTreeShared';
import { DELEGATE } from '../../../Special/Delegate/DelegateRegistry';
import { START_Delegate } from '../../../Special/Delegate/delegateTargets';
import { moveChildAcrossParents } from './drag';
import { setNodeState } from './actions';
import type { TreeNode } from '../Tool/tree';
import type { TreeSide } from '../Core/DesignPanel';
import type { DesignView } from '../Core/Design';

/**
 * 委托左栏框架树到中控台侧栏（进行 / 取消）
 *
 * 委托后两处共用同一状态源（design/FrameworkTreeShared），展开与选中互相同步；
 * 左栏本身**不搬走**，只是多出一个同步的侧栏视图 —— 这样在别的视图工作时也能操作框架树。
 * 用 workspace 的左侧栏 leaf 而非 activateView：本视图没有 plugin 引用，也无需走面板目录。
 */
export function toggleDelegate(view: DesignView): void {
    // 登记的互斥、落点的开合都交给登记处与「发起委托」那条路：
    // 已在委托 → 释放（谁持有就释放谁）；否则让设计来源进入委托。
    // 同来源幂等，因此重开库时被工作区恢复出来的落点不会被误判成「尚未委托」。
    if (FRAMEWORK_TREE.delegated) DELEGATE.release('design');
    else START_Delegate(view.app, view.settings, 'design');
    view.refresh();
}

/** 按栏切换展开/收起（左右栏展开状态相互独立） */
export function toggleExpand(view: DesignView, nodeId: string, side: TreeSide): void {
    const set = side === 'left' ? view.expandedLeft : view.expandedRight;
    if (set.has(nodeId)) set.delete(nodeId);
    else set.add(nodeId);
    view.refresh();
}

/** 按栏展开或收起该节点的全部子孙节点（依据该栏当前展开状态切换） */
export function toggleExpandAll(view: DesignView, node: TreeNode, side: TreeSide): void {
    const set = side === 'left' ? view.expandedLeft : view.expandedRight;
    const ids: string[] = [];
    const collect = (n: TreeNode): void => {
        ids.push(n.nodeId);
        for (const c of n.children) collect(c);
    };
    collect(node);
    if (set.has(node.nodeId)) for (const id of ids) set.delete(id);
    else for (const id of ids) set.add(id);
    view.refresh();
}

/**
 * 变更归属：把节点移到另一个父节点下
 *
 * 移动的**执行**复用拖拽那条路径（design/drag.moveChildAcrossParents），
 * 因此 follows 双向维护与 parent 字段的写法与拖拽完全一致，不存在两套语义。
 * 候选父节点排除自身与全部后代 —— 选了会形成环。
 */
export function changeParent(view: DesignView, nodeId: string): void {
    const node = view.pipe.GET_Node(nodeId);
    if (!node) return;
    const exclude = [
        nodeId,
        ...view.pipe.COLLECT_Descendants(nodeId).map((d) => d.nodeId),
    ];
    new NodePickModal(view.app, view.pipe, {
        title: '变更归属 · 选择目标父节点',
        excludeIds: exclude,
        // 只列「能容纳本节点类型」的父 —— 层级错位的候选不该出现在列表里。
        // 判定与拖拽落点同一条（C2_Tree/drag.canBeChildOf），不会出现「拖不进去却能选出来」
        allow: (_id, kind) => canBeChildOf(kind, node.kind),
        emptyText: '没有能容纳该类型的父节点（自身与后代已排除）',
        onPick: (targetParentId) => {
            moveChildAcrossParents(view, node.parent ?? '', nodeId, targetParentId, '', false);
        },
    }).open();
}

/** 返回父框架（右栏标题栏按钮）：回到下钻前的那个框架 */
export function selectParentFramework(view: DesignView): void {
    // 来源失效（被删 / 不再是框架）就继续往前找，都没有则什么也不做
    while (view.frameworkNavStack.length > 0) {
        const from = view.frameworkNavStack.pop()!;
        const node = view.pipe.GET_Node(from);
        if (node && isFrameworkKind(node.kind)) {
            view.selectedFrameworkId = from;
            view.refresh();
            return;
        }
    }
}

/**
 * 「返回父框架」的目标：来源栈顶那一个框架
 *
 * 来源只在「在右栏卡片里下钻」时记下，因此它必然处在当前框架的祖先链上；
 * 这里再校验一次 —— 用户从左栏 / 侧栏直接切走时入口会随之消失，
 * 不会留下一个指向无关位置的回退按钮。
 *
 * 切片协作可见：design/viewState.buildState 用它算右栏「返回父框架」入口。
 */
export function resolveNavBack(view: DesignView, fwId: string): { nodeId: string; title: string } | undefined {
    const stack = view.frameworkNavStack;
    const from = stack[stack.length - 1];
    if (!from) return undefined;
    const node = view.pipe.GET_Node(from);
    if (!node || !isFrameworkKind(node.kind)) return undefined;
    let cur = view.pipe.GET_Parent(fwId)?.nodeId;
    for (let guard = 0; cur && guard < 64; guard++) {
        if (cur === from) return { nodeId: from, title: `${NODE_KIND_LABELS[node.kind]} · ${node.desc}` };
        cur = view.pipe.GET_Parent(cur)?.nodeId;
    }
    return undefined;
}

/**
 * 选中框架（左栏行末「在右侧打开」/ 右栏框架行 / 右栏卡片内下钻）
 *
 * 只有**右栏内下钻**才记来路（在右栏点框架行 = 进入它的内部，需要能回到原处）；
 * 左栏点选是「直接切过去」，等于重新开始，因此顺带清掉来路。
 */
export function selectFramework(view: DesignView, nodeId: string, side: TreeSide): void {
    const prev = view.selectedFrameworkId;
    if (side === 'right') {
        if (prev && prev !== nodeId) view.frameworkNavStack.push(prev);
    } else {
        view.frameworkNavStack.length = 0;
    }
    view.selectedFrameworkId = nodeId;
    view.refresh();
}

/** 状态圆点左键：规划/进行 → 完成；完成 → 规划（循环切换） */
export function toggleState(view: DesignView, nodeId: string): void {
    const node = view.pipe.GET_Node(nodeId);
    if (!node) return;
    setNodeState(view, nodeId, (node.state ?? 'plan') === 'done' ? 'plan' : 'done');
}
