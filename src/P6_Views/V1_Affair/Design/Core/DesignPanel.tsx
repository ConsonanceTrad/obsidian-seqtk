/**
 * DesignPanel — 事务设计视图的渲染件（左右栏装配）
 *
 * 装配层职责（对应 Views.md「视图的职责边界（组件化后）」）：
 * - 把 P7_Render 的组件（NodeTreePanel）按左 / 右栏装配进视图容器，并渲染标题栏与空态
 * - 把视图状态以 props 注入（状态来自 SimpleStore，经 useStore 订阅）
 * - 把「栏」的信息捆到组件回调上：组件只给 `NodeLineCtx`，由本层补 `side` 后转交 DesignView
 * - 空白区交互（右键菜单、右侧空白落点）在本层接住并转交
 *
 * 不做的事：不 import "obsidian"、不碰 NodeCache / DataPipe —— 那两条线是 `DesignActions`
 * 与注入的 host（setTooltip / setIcon）。
 *
 * 行 / 树本身怎么画（元素、class、树标记、引导线、行内编辑覆盖层）全部由 P7_Render 负责，
 * 本层不再手写任何行元素。
 */

import { useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "../../../../P0_UI/useStore";
import type { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";
import {
    LINE_METRICS_LEFT,
    LINE_METRICS_RIGHT,
    type NodeLineCtx,
    type NodeLineHost,
} from "../../../../P7_Render/Composition/C1_NodeLine/NodeLine";
import { NodeTreePanel } from "../../../../P7_Render/Composition/C2_Tree/NodeTreePanel";
import { IconButton } from "../../../../P7_Render/Composition/C1_NodeLine/IconButton";
import type {
    NodeInlineBody,
    NodeInlineCreating,
    NodeTreeActions,
    TreeNodeItem,
} from "../../../../P7_Render/Composition/C2_Tree/NodeTree";
import type { NodeKindValue } from "../../../../P4_Nodes/NodeKind/NodeKind";

/** 栏标识（左栏框架树 / 右栏节点树） */
export type TreeSide = "left" | "right";

/** 行内新建态（附加栏信息：由哪一栏发起） */
export interface DesignInlineCreating extends NodeInlineCreating {
    side: TreeSide;
}

/** 视图状态：DesignView 计算 → SimpleStore → 本层订阅 */
export interface DesignViewState {
    /** 左栏框架树 */
    leftItems: TreeNodeItem[];
    leftEmpty?: string;
    /** 右栏形态 */
    rightMode: "framework" | "overview" | "empty";
    /** 右栏标题（选中框架的「类型 · 名称」） */
    rightTitle?: string;
    /** 选中框架的框架父节点（存在时右栏提供「返回父框架」） */
    parentFramework?: { nodeId: string; title: string };
    /** 右栏节点树（framework 形态） */
    rightItems: TreeNodeItem[];
    rightEmpty?: string;
    /**
     * 右栏根级行的父 id（framework 形态 = 当前框架 id；总览 / 空态缺省为空串）。
     * 行内新建据此判断附加行是否落在这一层 —— 右栏的根级行挂在框架下，不是空串。
     */
    rightRootParentId?: string;
    /** 总览形态的两棵树 */
    overview?: { concept: TreeNodeItem[]; checklist: TreeNodeItem[] };
    /** 瞬时交互态 */
    creating: DesignInlineCreating | null;
    bodyEditing: NodeInlineBody | null;
    /** 右栏空白落点高亮 */
    dropBlank: boolean;
    /** 框架树是否已委托到中控台侧栏 */
    delegated: boolean;
    /** 左栏宽度（记忆于设置；面板内拖动时以本地状态为准，结束时上报） */
    leftPaneWidth: number;
}

/**
 * 交互入口（由 DesignView 实现）。
 *
 * 组件只回传 `NodeLineCtx`（nodeId / parentId / depth）与原生事件，装配层补上 `side` 后
 * 转给这些方法 —— 数据读写、展开状态、菜单构建都在 DesignView 与其切片里。
 */
export interface DesignActions {
    toggle(nodeId: string, side: TreeSide): void;
    select(nodeId: string, side: TreeSide): void;
    contextMenu(nodeId: string, side: TreeSide, event: MouseEvent): void;
    stateClick(nodeId: string, side: TreeSide): void;
    stateContextMenu(nodeId: string, side: TreeSide, event: MouseEvent): void;
    dragStart(ctx: NodeLineCtx, side: TreeSide, event: DragEvent): void;
    dragEnd(side: TreeSide, event: DragEvent): void;
    dragOver(ctx: NodeLineCtx, side: TreeSide, event: DragEvent): void;
    dragLeave(side: TreeSide): void;
    drop(ctx: NodeLineCtx, side: TreeSide, event: DragEvent): void;
    /** 行内重命名 */
    inlineCommit(nodeId: string, side: TreeSide, value: string): void;
    inlineCancel(side: TreeSide): void;
    /** 行内新建 */
    createCommit(parentId: string, kind: NodeKindValue, name: string, side: TreeSide): void;
    createCancel(parentId: string, side: TreeSide): void;
    createKindChange(parentId: string, kind: NodeKindValue, side: TreeSide): void;
    /** 行内新建：切换连续输入 */
    createRepeatChange(parentId: string, repeat: boolean, side: TreeSide): void;
    /** 行内正文编辑 */
    bodyCommit(nodeId: string, body: string): void;
    bodyCancel(nodeId: string): void;
    /** 空白区 */
    blankContextMenu(side: TreeSide, event: MouseEvent): void;
    blankDragOver(event: DragEvent): void;
    blankDragLeave(event: DragEvent): void;
    blankDrop(event: DragEvent): void;
    /** 左栏：进行 / 取消委托 */
    toggleDelegate(): void;
    /** 右栏标题：返回父框架 */
    selectParentFramework(): void;
    /** 行末外部信息源徽章点击 */
    sourcesClick(nodeId: string, side: TreeSide, event: MouseEvent): void;
    /** 左栏宽度变更（拖动结束时上报，由视图防抖写回设置） */
    setLeftWidth(width: number): void;
}

export interface DesignPanelProps {
    store: SimpleStore<DesignViewState>;
    actions: DesignActions;
    host: NodeLineHost;
}

/** 把栏信息捆进组件回调：组件不需要知道自己是哪一栏 */
function bindActions(a: DesignActions, side: TreeSide): NodeTreeActions {
    return {
        onToggle: (ctx) => a.toggle(ctx.nodeId, side),
        onSelect: (ctx) => a.select(ctx.nodeId, side),
        onContextMenu: (ctx, e) => a.contextMenu(ctx.nodeId, side, e),
        onStateClick: (ctx) => a.stateClick(ctx.nodeId, side),
        onStateContextMenu: (ctx, e) => a.stateContextMenu(ctx.nodeId, side, e),
        onDragStart: (ctx, e) => a.dragStart(ctx, side, e),
        onDragEnd: (_ctx, e) => a.dragEnd(side, e),
        onDragOver: (ctx, e) => a.dragOver(ctx, side, e),
        onDragLeave: () => a.dragLeave(side),
        onDrop: (ctx, e) => a.drop(ctx, side, e),
        onSourcesClick: (ctx, e) => a.sourcesClick(ctx.nodeId, side, e),
        onInlineCommit: (ctx, value) => a.inlineCommit(ctx.nodeId, side, value),
        onInlineCancel: () => a.inlineCancel(side),
        onCreateCommit: (parentId, kind, name) => a.createCommit(parentId, kind, name, side),
        onCreateCancel: (parentId) => a.createCancel(parentId, side),
        onCreateKindChange: (parentId, kind) => a.createKindChange(parentId, kind, side),
        onCreateRepeatChange: (parentId, repeat) => a.createRepeatChange(parentId, repeat, side),
        onBodyCommit: (nodeId, body) => a.bodyCommit(nodeId, body),
        onBodyCancel: (nodeId) => a.bodyCancel(nodeId),
    };
}

/** 左栏宽度范围（px）：下限防止拖成 0，上限防止吃掉整个右栏 */
const LEFT_WIDTH_MIN = 160;
const LEFT_WIDTH_MAX = 640;
const LEFT_WIDTH_DEFAULT = 280;

export function DesignPanel({ store, actions, host }: DesignPanelProps) {
    const state = useStore(store);
    const leftActions = useMemo(() => bindActions(actions, "left"), [actions]);
    const rightActions = useMemo(() => bindActions(actions, "right"), [actions]);
    const creating = state.creating;

    /**
     * 双栏比例：会话内状态（不持久化；「记忆窗口布局」属于清单里的另一项）。
     * 用 pointer 事件而非 mouse —— 指针捕获后，拖出视图或经过子元素同样收得到移动事件。
     */
    // 初值取记忆值（0 = 用默认）；拖动期间只更新本地状态，结束后才上报
    const [leftWidth, setLeftWidth] = useState(state.leftPaneWidth || LEFT_WIDTH_DEFAULT);
    const dragRef = useRef<{ startX: number; startW: number } | null>(null);

    const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        dragRef.current = { startX: e.clientX, startW: leftWidth };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d) return;
        const next = Math.min(Math.max(d.startW + (e.clientX - d.startX), LEFT_WIDTH_MIN), LEFT_WIDTH_MAX);
        setLeftWidth(next);
    };
    const onHandleUp = (e: ReactPointerEvent<HTMLDivElement>) => {
        const dragging = dragRef.current !== null;
        dragRef.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
        // 拖动结束才上报 —— 拖动过程中每帧写盘是没有意义的
        if (dragging) actions.setLeftWidth(leftWidth);
    };

    /** 空白区右键：行自身的 contextmenu 已 stopPropagation，能冒泡到这里的就是空白 */
    const onPaneContextMenu = (side: TreeSide, rowSelector: string) => (e: ReactMouseEvent) => {
        if ((e.target as HTMLElement).closest(rowSelector)) return;
        e.preventDefault();
        actions.blankContextMenu(side, e.nativeEvent);
    };

    return (
        <div className={"seqtk-split" + (state.delegated ? " seqtk-split-delegated" : "")}>
            {/* 委托期间左栏与把手不渲染：委托的目的正是把空间让给右栏 */}
            {/* （若只是隐藏仍会占位，那等于没让） */}
            {!state.delegated && (
            <div
                className="seqtk-split-left"
                style={{ width: leftWidth, flexBasis: leftWidth }}
                onContextMenu={onPaneContextMenu("left", ".seqtk-frame-item")}
            >
                <div className="seqtk-split-title">
                    <span className="seqtk-split-title-text">框架</span>
                    {/* 委托开关收在标题末尾：它是这一栏的全局动作，放句末不抢标题的视线 */}
                    <IconButton
                        className={"seqtk-icon-btn seqtk-delegate-btn" + (state.delegated ? " is-active" : "")}
                        // chevrons-left = 把树送到左侧栏；chevrons-right = 收回本栏
                        icon={state.delegated ? "chevrons-right" : "chevrons-left"}
                        tip={state.delegated ? "取消委托（框架树交还此栏）" : "委托到中控台侧栏"}
                        host={host}
                        onClick={() => actions.toggleDelegate()}
                    />
                </div>
                <NodeTreePanel
                    items={state.leftItems}
                    metrics={LINE_METRICS_LEFT}
                    actions={leftActions}
                    host={host}
                    rowClass="seqtk-frame-item"
                    emptyText={state.leftEmpty}
                    creating={creating && creating.side === "left" ? creating : null}
                />
            </div>

            )}

            {/* 双栏比例把手：拖动改变左栏宽度 */}
            {!state.delegated && (
            <div
                className="seqtk-split-handle"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={onHandleDown}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
            />
            )}

            <div
                className={"seqtk-split-right" + (state.dropBlank ? " seqtk-drop-blank" : "")}
                /* 空白判定用行级选择器（与左栏、与 ctxFromEvent 同一套）：
                   右栏的留白也在 .seqtk-tree 容器内，拿容器当判据会让「只有 title 区算空白」。
                   拖拽判定反过来必须用容器（见下），两者判据不同是刻意的。 */
                onContextMenu={onPaneContextMenu("right", ".seqtk-row, .seqtk-frame-item")}
                onDragOver={(e: ReactDragEvent) => {
                    // 只要落点还在树容器里，就都不算「拖进空白」——
                    // 逐个排除行类型不保险（框架卡牌内部、卡牌嵌套处都不是 .seqtk-row），
                    // 反过来限定「在 .seqtk-tree 内即非空白」才覆盖得住。
                    if ((e.target as HTMLElement).closest(".seqtk-tree")) return;
                    actions.blankDragOver(e.nativeEvent);
                }}
                onDragLeave={(e: ReactDragEvent) => actions.blankDragLeave(e.nativeEvent)}
                onDrop={(e: ReactDragEvent) => {
                    if ((e.target as HTMLElement).closest(".seqtk-tree")) return;
                    actions.blankDrop(e.nativeEvent);
                }}
            >
                {state.rightMode === "empty" && (
                    <div className="seqtk-empty">{state.rightEmpty}</div>
                )}

                {state.rightMode === "framework" && (
                    <>
                        <div className="seqtk-title-row">
                            {state.parentFramework && (
                                <button
                                    className="seqtk-btn seqtk-btn-ghost seqtk-parent-btn"
                                    title={`返回父框架：${state.parentFramework.title}`}
                                    onClick={() => actions.selectParentFramework()}
                                >
                                    ↑ 父框架
                                </button>
                            )}
                            <div className="seqtk-split-title">{state.rightTitle}</div>
                        </div>
                        <NodeTreePanel
                            items={state.rightItems}
                            metrics={LINE_METRICS_RIGHT}
                            actions={rightActions}
                            host={host}
                            emptyText={state.rightEmpty}
                            /* 根级行挂在框架下：附加行按这个父 id 判定落在这一层 */
                            rootParentId={state.rightRootParentId ?? ""}
                            creating={creating && creating.side === "right" ? creating : null}
                            bodyEditing={state.bodyEditing}
                        />
                    </>
                )}

                {state.rightMode === "overview" && state.overview && (
                    <>
                        <div className="seqtk-split-title">全部事务</div>
                        {state.overview.concept.length > 0 && (
                            <>
                                <div className="seqtk-section-title">
                                    项目（{state.overview.concept.length}）
                                </div>
                                <NodeTreePanel
                                    items={state.overview.concept}
                                    metrics={LINE_METRICS_RIGHT}
                                    actions={rightActions}
                                    host={host}
                                    creating={creating && creating.side === "right" ? creating : null}
                                    bodyEditing={state.bodyEditing}
                                />
                            </>
                        )}
                        {state.overview.checklist.length > 0 && (
                            <>
                                <div className="seqtk-section-title">
                                    清单（{state.overview.checklist.length}）
                                </div>
                                <NodeTreePanel
                                    items={state.overview.checklist}
                                    metrics={LINE_METRICS_RIGHT}
                                    actions={rightActions}
                                    host={host}
                                    creating={creating && creating.side === "right" ? creating : null}
                                    bodyEditing={state.bodyEditing}
                                />
                            </>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
