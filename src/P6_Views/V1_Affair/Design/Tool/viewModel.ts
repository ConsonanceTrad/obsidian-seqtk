/**
 * design/viewModel — 「节点数据 → 组件视图模型」构建（视图层职责）
 *
 * 视图只做「数据注入」：把节点与树结构算成 P7_Render 组件能直接渲染的
 * `NodeLineData` / `TreeNodeItem`。本文件**不产生任何 DOM 元素**（元素由组件负责），
 * 也不做交互（交互经 DesignActions 回传）—— 即 Views.md 里「视图的职责边界」的第 4、5 条。
 *
 * 数据面（见 P6_Views/Views.md 边界判据）：形参是 **DataPipe 只读门面**，
 * 本模块不接触 fileManager / operationQueue。
 *
 * 左右栏行数据的差异集中在这里：左栏只要框架徽章与选中态，右栏还要事件性质 / 快照时间 /
 * 状态圆点 / 预期属性徽章 / 卡片包裹。
 */

import {
    EVENT_NATURE_LABELS,
    NODE_KIND,
    NODE_KIND_LABELS,
    NODE_STATE_LABELS,
    getCategoryOf,
    isFrameworkKind,
    isTransactionKind,
} from "../../../../P4_Nodes/NodeFacade";
import type { EventNature, SeqtkNode } from "../../../../P4_Nodes/NodeFacade";
import { describeCycleRule } from "../../../../P2_Tools/Time/RuleParse";
import { formatShortDate } from "../../../../P2_Tools/Time/DateFormat";
import { tooltipBodyText } from "../../../../P7_Render/Composition/C4_Tooltip/tooltip";
import type {
    NodeLineBadge,
    NodeLineData,
} from "../../../../P7_Render/Composition/C1_NodeLine/NodeLine";
import type { TreeNodeItem } from "../../../../P7_Render/Composition/C2_Tree/NodeTree";
import { kindUsesState } from "../../../../P7_Render/Structure/S2_Modal/TransactionModals";
import type { DataPipe } from "../../../../P5_Data/CoPipe/DataPipe";
import type { TreeNode } from "./tree";

/** 构建一行时的树形标志（由遍历过程给出） */
export interface LineFlags {
    depth: number;
    /** 父节点 id；顶级为空串 */
    parentId: string;
    hasChildren: boolean;
    expanded: boolean;
    /** 是否处于某展开祖先链内 */
    inExpandedTree: boolean;
    isFirst: boolean;
    isLast: boolean;
}

/** 行内的编辑 / 拖拽附加标志（来自视图状态，与树结构无关） */
export interface LineOverlay {
    /** 该行是否处于重命名态 */
    editing?: boolean;
    /** 该行是否正在被拖拽 */
    dragging?: boolean;
    /** 该行作为落点的提示 */
    dropHint?: NodeLineData["dropHint"];
}

/** 框架行的「预期时间段」徽章（左右栏共用） */
function buildSpanBadge(data: SeqtkNode): NodeLineBadge[] {
    const span = (data as { expectedSpan?: { from?: string; to?: string } }).expectedSpan;
    if (!span?.from && !span?.to) return [];
    return [
        {
            icon: "📅",
            text: `${span.from ? formatShortDate(span.from) : ""} → ${span.to ? formatShortDate(span.to) : ""}`,
            tooltip: `预期时间段: ${span.from || ""} ~ ${span.to || ""}`,
        },
    ];
}

/** 事务行的预期属性徽章（目标时间 / 重复规则） */
function buildTransactionBadges(data: SeqtkNode): NodeLineBadge[] {
    const badges: NodeLineBadge[] = [];
    const time = (data as { expectedTime?: string }).expectedTime;
    const repeat = (data as { expectedRepeat?: string }).expectedRepeat;
    if (time) {
        badges.push({ icon: "🗓", text: formatShortDate(time), tooltip: `预期时间: ${time}` });
    }
    if (repeat) {
        badges.push({ icon: "♺", text: describeCycleRule(repeat), tooltip: `预期重复: ${repeat}` });
    }
    return badges;
}

/**
 * 左栏框架行：徽章固定为「框架」/类型名，行末恒有「在右侧打开」按钮，
 * 选中态由 `selectedFrameworkId` 决定。
 */
export function buildFrameLine(
    pipe: DataPipe,
    node: TreeNode,
    f: LineFlags,
    selected: boolean,
    overlay: LineOverlay = {},
): NodeLineData {
    const data = node.data;
    const kind = data.kind;
    const body = pipe.GET_NodeBody(node.nodeId);
    return {
        nodeId: node.nodeId,
        parentId: f.parentId,
        depth: f.depth,
        kind,
        category: getCategoryOf(kind),
        label: kind === NODE_KIND.TRANS ? "框架" : NODE_KIND_LABELS[kind],
        desc: data.desc,
        bodyPreview: body || undefined,
        bodyPreviewTooltip: body ? tooltipBodyText(body) : undefined,
        badges: isFrameworkKind(kind) ? buildSpanBadge(data) : [],
        hasChildren: f.hasChildren,
        expanded: f.expanded,
        inExpandedTree: f.inExpandedTree,
        selected,
        showsOpenButton: true,
        isFirst: f.isFirst,
        isLast: f.isLast,
        draggable: true,
        dragging: overlay.dragging,
        dropHint: overlay.dropHint ?? null,
        editing: overlay.editing ? { mode: "rename", value: data.desc } : null,
    };
}

/**
 * 右栏节点行：徽章按类型细分（事件性质 / 快照时间点 / 框架 / 类型名），
 * 状态圆点由 `kindUsesState` 决定，框架节点用卡片容器包裹。
 */
export function buildNodeLine(
    pipe: DataPipe,
    node: TreeNode,
    f: LineFlags,
    overlay: LineOverlay = {},
): NodeLineData {
    const data = node.data;
    const kind = data.kind;

    let label: string = NODE_KIND_LABELS[kind];
    if (kind === NODE_KIND.TRANS) {
        label = "框架";
    } else if (kind === NODE_KIND.EVENT) {
        label = EVENT_NATURE_LABELS[(data as { nature?: EventNature }).nature ?? "temp"];
    } else if (kind === NODE_KIND.SNAPSHOT && (data as { at?: string }).at) {
        label = `${label}·${String((data as { at?: string }).at).slice(5, 16)}`;
    }

    // 节点行悬浮：仅显示目标时间点与重复规则（都无则不显示）
    const txn = data as { expectedTime?: string; expectedRepeat?: string };
    const hints: string[] = [];
    if (txn.expectedTime) hints.push(`目标时间: ${txn.expectedTime}`);
    if (txn.expectedRepeat) hints.push(`重复规则: ${txn.expectedRepeat}`);

    const body = pipe.GET_NodeBody(node.nodeId);
    const isFramework = isFrameworkKind(kind);

    return {
        nodeId: node.nodeId,
        parentId: f.parentId,
        depth: f.depth,
        kind,
        category: getCategoryOf(kind),
        label,
        desc: data.desc,
        descTooltip: hints.length > 0 ? hints.join(" · ") : undefined,
        bodyPreview: body || undefined,
        bodyPreviewTooltip: body ? tooltipBodyText(body) : undefined,
        badges: isTransactionKind(kind)
            ? buildTransactionBadges(data)
            : isFramework
              ? buildSpanBadge(data)
              : [],
        sources: data.sources,
        state: data.state ?? "plan",
        showsState: kindUsesState(kind),
        stateTooltip: NODE_STATE_LABELS[data.state ?? "plan"],
        hasChildren: f.hasChildren,
        expanded: f.expanded,
        inExpandedTree: f.inExpandedTree,
        showsOpenButton: isFramework,
        isFirst: f.isFirst,
        isLast: f.isLast,
        // 右栏有父节点即可拖（拖拽常驻，不再需要先开启「顺序更改模式」）
        draggable: !!f.parentId,
        carded: isFramework,
        dragging: overlay.dragging,
        dropHint: overlay.dropHint ?? null,
        editing: overlay.editing ? { mode: "rename", value: data.desc } : null,
    };
}

/**
 * 构建一棵树：递归把 TreeNode 转成 TreeNodeItem（子节点仅在展开时填充）
 *
 * `rootParentId` 是**根级行**的父节点 id，必须由调用方按栏给出：
 * - 左栏框架树：顶级框架无父 → `""`
 * - 右栏选中框架的树：根级行的父是**当前选中框架**（不是无父）→ 传框架 nodeId
 * - 右栏总览（构想 / 清单全局列表）：无父 → `""`
 *
 * 传错会让根级行拿到错的 parentId，直接影响 draggable 判定（`!!parentId`）、
 * 拖拽落点解析，以及「添加到同级 / 子级」的写入目标。
 */
export function buildTreeItems(
    pipe: DataPipe,
    rootParentId: string,
    roots: TreeNode[],
    expanded: Set<string>,
    buildLine: (node: TreeNode, f: LineFlags) => NodeLineData,
): TreeNodeItem[] {
    void pipe;
    const visit = (node: TreeNode, depth: number, parentId: string, inExpandedTree: boolean, isFirst: boolean, isLast: boolean): TreeNodeItem => {
        const hasChildren = node.children.length > 0;
        const isExpanded = expanded.has(node.nodeId);
        const f: LineFlags = { depth, parentId, hasChildren, expanded: isExpanded, inExpandedTree, isFirst, isLast };
        const children =
            hasChildren && isExpanded
                ? node.children.map((c, i, arr) =>
                      visit(c, depth + 1, node.nodeId, true, i === 0, i === arr.length - 1),
                  )
                : [];
        return { line: buildLine(node, f), children };
    };
    return roots.map((r, i, arr) => visit(r, 0, rootParentId, false, i === 0, i === arr.length - 1));
}
