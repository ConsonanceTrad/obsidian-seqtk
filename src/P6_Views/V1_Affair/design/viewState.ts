/**
 * design/viewState — 设计视图状态构建切片
 *
 * 从 DesignView 拆出的「节点 → 视图状态」计算：左栏框架树、右栏框架内容 / 全部事务总览，
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
    buildChecklistTree,
    buildConceptTree,
    buildFrameworkTree,
    buildNode,
    sortByFollows,
    type TreeNode,
} from './tree';
import { buildFrameLine, buildNodeLine, buildTreeItems, type LineOverlay } from './viewModel';
import { resolveNavBack } from './navigation';
import { NODE_KIND_LABELS } from '../../../P4_Nodes/NodeFacade';
import type { DesignViewState, TreeSide } from '../DesignPanel';
import type { TreeNodeItem } from '../../../P7_Render/Composition/C2_Tree/NodeTree';
import type { DesignView } from '../Design';

/** 组装完整视图状态 */
export function buildState(view: DesignView): DesignViewState {
    const base: DesignViewState = {
        leftItems: [],
        rightItems: [],
        rightMode: 'empty',
        creating: view.creating,
        bodyEditing: view.bodyEditing,
        dropBlank: view.dropBlank,
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

    // 右栏：选中框架的节点树 / 全部事务总览
    if (view.selectedFrameworkId === null) {
        return buildOverviewOrPlaceholder(view, base);
    }
    const framework = view.pipe.GET_Node(view.selectedFrameworkId);
    if (!framework) {
        view.selectedFrameworkId = null;
        return buildOverviewOrPlaceholder(view, base);
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
    base.rightItems = buildItems(
        view,
        sorted.map((c) => buildNode(view.pipe, c.nodeId, c.data!)),
        'right',
        fwId,
    );
    return base;
}

/** 未选中框架：总览（入口开启时）或占位提示 */
function buildOverviewOrPlaceholder(view: DesignView, base: DesignViewState): DesignViewState {
    if (!view.settings.showAllOverview) {
        base.rightEmpty = '在左侧选择框架以查看内容';
        return base;
    }
    const concept = buildConceptTree(view.pipe);
    const checklist = buildChecklistTree(view.pipe);
    if (concept.length === 0 && checklist.length === 0) {
        base.rightEmpty = '暂无事务节点\n在右栏空白处右键新建';
        return base;
    }
    base.rightMode = 'overview';
    base.overview = {
        concept: buildItems(view, concept, 'right'),
        checklist: buildItems(view, checklist, 'right'),
    };
    return base;
}

/**
 * 把（已展开状态过滤后的）树转成组件视图模型
 *
 * `rootParentId`：根级行的父 id —— 左栏与总览传空串（顶级无父），
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

/** 瞬时交互态 → 行覆盖信息（重命名 / 拖拽中 / 落点提示） */
function overlayFor(view: DesignView, nodeId: string): LineOverlay {
    return {
        editing: view.rename?.nodeId === nodeId,
        dragging: view.draggingId === nodeId,
        dropHint: view.dropHint?.nodeId === nodeId ? view.dropHint.hint : null,
    };
}
