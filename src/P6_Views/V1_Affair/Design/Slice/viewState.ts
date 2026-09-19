/**
 * design/viewState — 设计视图状态构建切片
 *
 * 从 DesignView 拆出的「节点 → 视图状态」计算：左栏框架树、右栏框架内容，
 * 以及行覆盖信息（重命名 / 拖拽中 / 落点提示）。纯读，不写任何数据面。
 *
 * 约定:
 * - 本文件函数以 view(DesignView 实例)为第一参数,只读 view 上公开的状态
 *   （pipe / settings / topOrder / selectedFrameworkId / expandedLeft / expandedRight /
 *   leftWidth / 瞬时交互态）
 * - 对外只导出 buildState —— refresh() 的唯一状态来源；其余为本文件内部步骤
 * - 树构建与行模型分别复用 design/tree 与 design/viewModel，本文件不做递归、不碰 DOM
 *
 * 功能增补指引:
 * - 新增一栏 / 新的一种右栏形态 → 在此扩展 buildState，并在 DesignPanel 里加对应渲染分支
 */

import { FRAMEWORK_TREE } from './FrameworkTreeShared';
import {
    buildFrameworkTree,
    buildNode,
    sortByFollows,
    type TreeNode,
} from '../Tool/tree';
import { buildFrameLine, buildNodeLine, buildTreeItems, type LineOverlay } from '../Tool/viewModel';
import { resolveNavBack } from './navigation';
import { HAS_ActiveFilter, MATCH_Conditions } from './filter';
import { NODE_KIND_LABELS } from '../../../../P4_Nodes/NodeFacade';
import type { DesignViewState, TreeSide } from '../Core/DesignPanel';
import type { TreeNodeItem } from '../../../../P7_Render/Composition/C2_Tree/NodeTree';
import type { DesignView } from '../Core/Design';

/** 组装完整视图状态 */
export function buildState(view: DesignView): DesignViewState {
    const base: DesignViewState = {
        leftItems: [],
        rightItems: [],
        rightMode: 'empty',
        // 筛选条件住在 view 上，这里只做透传（界面要在标题栏渲染它）
        filter: view.filter,
        creating: view.creating,
        bodyEditing: view.bodyEditing,
        // 委托开关来自共享状态源：委托面板被关闭时也会复位
        delegated: FRAMEWORK_TREE.delegated,
        leftPaneWidth: view.leftWidth,
    };

    if (!view.pipe.isInitialized) {
        base.leftEmpty = '正在加载缓存…';
        base.rightEmpty = '正在加载缓存…';
        return base;
    }

    // 左栏：框架树
    const roots = buildFrameworkTree(view.pipe, view.topOrder);
    base.leftEmpty = roots.length === 0 ? '暂无框架，右键空白处新建' : undefined;
    base.leftItems = buildItems(view, roots, 'left');

    // 右栏：选中框架的节点树；没选中（或选中框架已消失）就只给一句提示
    if (view.selectedFrameworkId === null) {
        return buildPlaceholder(base);
    }
    const framework = view.pipe.GET_Node(view.selectedFrameworkId);
    if (!framework) {
        view.selectedFrameworkId = null;
        return buildPlaceholder(base);
    }

    base.rightMode = 'framework';
    base.rightTitle = `${NODE_KIND_LABELS[framework.kind]} · ${framework.desc}`;

    const fwId = view.selectedFrameworkId;
    // 右栏根级行挂在框架下 —— 行内新建要按它判断附加行属于哪一层
    base.rightRootParentId = fwId;

    // 「返回父框架」= 回到下钻前的那个框架，因此只在**右栏卡片里下钻**进来时提供；
    // 左栏直接点选没有来路，自然不给这个入口（判定见 resolveNavBack）
    base.parentFramework = resolveNavBack(view, fwId);

    const direct = view.pipe.GET_Children(fwId).filter((c) => !!c.data);
    const sorted = sortByFollows(framework, direct);
    if (sorted.length === 0) {
        base.rightEmpty = '该框架暂无内部节点\n在右栏空白处右键可创建子节点';
        return base;
    }
    const rightRoots = sorted.map((c) => buildNode(view.pipe, c.nodeId, c.data!));
    const visible = HAS_ActiveFilter(view.filter) ? PRUNE_ByFilter(view, rightRoots) : rightRoots;
    if (visible.length === 0) {
        base.rightEmpty = '没有符合筛选条件的节点\n在标题栏右侧调整或清空筛选';
        return base;
    }
    base.rightItems = buildItems(view, visible, 'right', fwId);
    return base;
}

/**
 * 按筛选条件裁剪右栏树：命中行保留，**不命中的祖先只要在命中行的路径上也留下**
 *
 * 保留父链是必须的 —— 树按 follows 层级渲染，把祖先摘掉会让命中行无处安放。
 * 于是判据是「自己命中 **或** 子孙里有命中」，一次后序遍历即可。
 * 正文走 pipe 现取（它缓存在数据层），不额外构造行模型。
 */
function PRUNE_ByFilter(view: DesignView, nodes: TreeNode[]): TreeNode[] {
    const kept: TreeNode[] = [];
    for (const node of nodes) {
        const children = PRUNE_ByFilter(view, node.children);
        const hit = children.length > 0
            || MATCH_Conditions(node.data, view.pipe.GET_NodeBody(node.nodeId), view.filter);
        if (hit) kept.push({ ...node, children });
    }
    return kept;
}

/** 未选中框架：只看提示语，右栏没有别的内容可展示 */
function buildPlaceholder(base: DesignViewState): DesignViewState {
    base.rightEmpty = '在左侧选择框架以查看内容';
    return base;
}

/**
 * 把（已展开状态过滤后的）树转成组件视图模型
 *
 * `rootParentId`：根级行的父 id —— 左栏传空串（顶级无父），
 * 右栏选中框架的树必须传该框架 id，否则根级行被当成无父节点（不可拖、落点判定失效）。
 */
function buildItems(view: DesignView, roots: TreeNode[], side: TreeSide, rootParentId = ''): TreeNodeItem[] {
    const expanded = side === 'left' ? view.expandedLeft : view.expandedRight;
    return buildTreeItems(view.pipe, rootParentId, roots, expanded, (node, flags) =>
        side === 'left'
            ? buildFrameLine(
                  view.pipe,
                  node,
                  flags,
                  view.selectedFrameworkId === node.nodeId,
                  overlayFor(view, node.nodeId),
              )
            : buildNodeLine(view.pipe, node, flags, overlayFor(view, node.nodeId)),
    );
}

/** 瞬时交互态 → 行覆盖信息（重命名 / 拖拽中）
 *
 * 落点提示不在这里：它由 design/dragHandlers 直接切行上的 class 表达，
 * 不进视图状态，也就不会让整棵树为「提示变了一格」而重渲（见该切片文件头的说明）。
 */
function overlayFor(view: DesignView, nodeId: string): LineOverlay {
    return {
        editing: view.rename?.nodeId === nodeId,
        dragging: view.draggingId === nodeId,
    };
}
