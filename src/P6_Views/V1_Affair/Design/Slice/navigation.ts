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
import { EVIDENCE_KINDS, canBeChildOf } from '../../../../P7_Render/Composition/C2_Tree/drag';
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
 * 右栏整栏展开 / 收起（右栏空白菜单用）
 *
 * 与行上的「展开子项」分工：那条只管该行的子树，这条针对整个右栏 —— 层次深时
 * 不必逐行点开，也便于一键回到折叠态。收起就是清空展开集合（根级行恒可见）。
 *
 * 展开时把框架的**全部后代**塞进集合：叶子进了集合没有副作用（它们本来就没有
 * 折叠箭头），换来的是不必先判断「谁有子节点」，且整个过程只触发一次 refresh。
 */
export function setRightExpandAll(view: DesignView, expand: boolean): void {
    const fwId = view.selectedFrameworkId;
    if (!fwId) return;
    view.expandedRight.clear();
    if (expand) {
        for (const d of view.pipe.COLLECT_Descendants(fwId)) view.expandedRight.add(d.nodeId);
    }
    view.refresh();
}

/**
 * 右栏是否已**全部收起**（该框架下没有任何一行处于展开态）
 *
 * 决定空白菜单里那一条显示哪个动作：已全部收起 → 「全部展开」，否则 → 「全部收起」。
 * 判据取「有没有任一后代在展开集合里」，而不是「集合是否为空」—— 集合里可能残留着
 * 别的框架（或已删除节点）的 id，那时视图上其实仍是全收起。
 */
export function IS_RightCollapsed(view: DesignView): boolean {
    const fwId = view.selectedFrameworkId;
    if (!fwId) return true;
    const set = view.expandedRight;
    return !view.pipe.COLLECT_Descendants(fwId).some((d) => set.has(d.nodeId));
}

/**
 * 变更归属：把节点移到另一个父节点下
 *
 * 移动的**执行**复用拖拽那条路径（design/drag.moveChildAcrossParents），
 * 因此 follows 的维护方式与拖拽完全一致，不存在两套语义。
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
            // 源父从 follows 入边反查（归属只由父侧记录）；多归属时取第一个，变更归属只动这一个
            const currentParentId = view.pipe.GET_Parent(nodeId)?.nodeId ?? '';
            moveChildAcrossParents(view, currentParentId, nodeId, targetParentId, '', false);
        },
    }).open();
}

/**
 * 断连：把**证据节点**从指定的那个上级那里摘下来，节点自身不删
 *
 * 多归属下「归档」太重了 —— 有时只是不想让它再挂在这个上级下，内容本身还要留着。
 * 摘的是「父 → 子」这条边：只改那个上级的文件，节点自己的文件不碰。
 *
 * 证据类型专属（菜单项同样只在证据行上出现）：只有证据会被引用到多处，结构节点该用
 * 「变更归属」移动、用「归档」下架。这里再判一次类型，是为了不让别的调用路径绕过菜单
 * 把结构节点摘成游离节点 —— 那种状态在视图里没有回头的入口。
 *
 * `parentId` 必须由调用方给出**上下文中的那个父**（行渲染时就知道的 ctx.parentId），
 * 不能在这里拿 nodeId 反查 —— 多归属时查到的「第一个上级」可能完全是另一条链：
 * 实际出现过的偏差是「证据同时挂在框架与内部节点下，对内部节点断连却摘掉了框架那条」。
 * 也不弹框：要摘的就是用户正在看的那一行所属的链，想摘别的上级换到那处再断一次即可。
 */
export function detachFromParent(view: DesignView, nodeId: string, parentId: string): void {
    if (!parentId) return;
    const node = view.pipe.GET_Node(nodeId);
    if (!node || !EVIDENCE_KINDS.includes(node.kind)) return;
    REMOVE_FromParent(view, parentId, nodeId);
}

/** 从指定上级的 follows 里摘掉一个子节点（本来就不在其中时什么也不做） */
function REMOVE_FromParent(view: DesignView, parentId: string, childId: string): void {
    const parent = view.pipe.GET_Node(parentId);
    if (!parent) return;
    const follows = parent.follows ?? [];
    if (!follows.includes(childId)) return;
    view.pipe.EXEC_Mutation({
        op: 'update',
        kind: parent.kind,
        nodeId: parentId,
        updates: { follows: follows.filter((id) => id !== childId), modify: new Date().toISOString() },
    });
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
