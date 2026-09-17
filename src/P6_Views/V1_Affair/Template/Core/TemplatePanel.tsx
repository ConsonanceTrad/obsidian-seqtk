/**
 * TemplatePanel — 模板模式的渲染件（左栏框架树 / 右栏内容文本）
 *
 * 纯渲染：只接 props（两个 store + 动作 + 宿主能力）、只发回调；不 import "obsidian"、
 * 不碰 DataPipe / NodeCache —— 数据读写那条线是 `TemplateActions` 与注入的 host
 * （见 P6_Views/Views.md 的装配层职责）。
 *
 * 布局：左栏 = 模板框架树，与事务设计左栏**同一个** NodeTreePane、同一套行模型
 * （行怎么画由 P7_Render 负责，本层不手写行元素），只用来选框架与增删框架；
 * 栏间与事务设计同款：宽度把手可拖，标题末尾有委托开关，委托期间左栏与把手都不渲染
 * （把空间让给右栏）。
 * 右栏 = 选中框架的内容，**直接由文本表示**（TemplateTextPanel：解析预览 / 合法性校验 /
 * 按差异回写）—— 内容的增删改都在文本里做，因此右栏没有第二棵树。
 *
 * 两个 store 分开订阅：按键只刷 textStore，左栏树不跟着每帧重渲。
 */

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "../../../../P0_UI/useStore";
import type { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";
import { LINE_METRICS_LEFT, type NodeLineHost } from "../../../../P7_Render/Composition/C1_NodeLine/NodeLine";
import { IconButton } from "../../../../P7_Render/Composition/C1_NodeLine/IconButton";
import { NodeTreePane } from "../../../../P7_Render/Composition/C2_Tree/NodeTreePane";
import type { NodeTreeActions, TreeNodeItem } from "../../../../P7_Render/Composition/C2_Tree/NodeTree";
import { TemplateTextPanel, type TemplateTextState } from "./TemplateTextPanel";

/** 文本区状态：定义随文本区渲染件走，这里转出供视图类取用 */
export type { TemplateTextState };

/** 结构态（TemplateView 重算后写入；渲染件只读） */
export interface TemplateState {
    /** 缓存尚未就绪（新建按钮据此禁用） */
    initializing: boolean;
    /** 左栏：全部模板框架（含嵌套的子框架，已按展开状态填好 children） */
    leftItems: TreeNodeItem[];
    /** 左栏空态文案 */
    leftEmpty?: string;
    /** 当前选中的模板框架 nodeId（null = 未选） */
    selectedId: string | null;
    /** 右栏标题（选中框架的「类型 · 名称」） */
    rightTitle?: string;
    /** 左栏是否已委托到侧栏（委托期间左栏与把手都不渲染） */
    delegated: boolean;
    /** 左栏宽度（记忆于设置；面板内拖动时以本地状态为准，结束时上报） */
    leftPaneWidth: number;
}

/**
 * 交互入口（由 TemplateView 实现）
 *
 * 与 DesignPanel 同法：渲染件只回传 `NodeLineCtx` 与原生事件。模板模式只有左栏一棵树，
 * 因此不需要「哪一栏」这个参数。
 *
 * `applyTemplate` / `deleteNode` / `openFile` 由视图的行右键菜单路径消费（渲染件经
 * `contextMenu` 转发，不直接调用）—— 它们与 `createRootFramework` 一样属于视图的写操作
 * 入口，列在这里是为了契约完整。
 */
export interface TemplateActions {
    /** 展开 / 收起左栏某行 */
    toggle(nodeId: string): void;
    /** 选中该模板框架（行末按钮） */
    select(nodeId: string): void;
    /** 行右键（框架的增删与应用） */
    contextMenu(nodeId: string, event: MouseEvent): void;
    /** 新建根级模板框架 */
    createRootFramework(): void;
    /** 应用此模板到目标框架（右键菜单） */
    applyTemplate(nodeId: string): void;
    /** 删除模板框架（含内容，右键菜单） */
    deleteNode(nodeId: string): void;
    /** 打开模板框架正文（右键菜单） */
    openFile(nodeId: string): void;
    /** 文本区：内容变化（只改草稿，不落盘） */
    textChange(value: string): void;
    /** 文本区：回写 */
    textCommit(): void;
    /** 文本区：撤销改动 */
    textReset(): void;
    /** 左栏：进行 / 取消委托（全局互斥，见 Special/Delegate/DelegateRegistry） */
    toggleDelegate(): void;
    /** 左栏宽度变更（拖动结束时上报，由视图防抖写回设置） */
    setLeftWidth(width: number): void;
}

export interface TemplatePanelProps {
    /** 结构态（左栏树 / 选中 / 委托） */
    state: SimpleStore<TemplateState>;
    /** 文本区态（正在编辑的文本及其预览 / 校验） */
    text: SimpleStore<TemplateTextState>;
    actions: TemplateActions;
    host: NodeLineHost;
}

/** 把树组件回调转到视图入口（模板模式只有左栏一棵树，故无需补「哪一栏」） */
function bindTree(a: TemplateActions): NodeTreeActions {
    return {
        onToggle: (ctx) => a.toggle(ctx.nodeId),
        onSelect: (ctx) => a.select(ctx.nodeId),
        onContextMenu: (ctx, e) => a.contextMenu(ctx.nodeId, e),
    };
}

/** 左栏宽度范围（px）：下限防止拖成 0，上限防止吃掉整个右栏（与 DesignPanel 同口径） */
const LEFT_WIDTH_MIN = 160;
const LEFT_WIDTH_MAX = 640;
const LEFT_WIDTH_DEFAULT = 280;

export function TemplatePanel({ state, text, actions, host }: TemplatePanelProps) {
    const s = useStore(state);
    const t = useStore(text);
    const leftActions = useMemo(() => bindTree(actions), [actions]);

    /**
     * 双栏比例：会话内状态（拖动结束后上报，由视图防抖写回设置）。
     * 用 pointer 事件而非 mouse —— 指针捕获后，拖出视图或经过子元素同样收得到移动事件。
     */
    // 初值取记忆值（0 = 用默认）；拖动结束后才上报（拖动期间每帧写盘没有意义）
    const [leftWidth, setLeftWidth] = useState(s.leftPaneWidth || LEFT_WIDTH_DEFAULT);
    const dragRef = useRef<{ startX: number; startW: number } | null>(null);
    /** 左栏元素（拖动期间直接改它的宽度）与拖动期间的权威宽度 */
    const leftPaneRef = useRef<HTMLDivElement | null>(null);
    const widthRef = useRef(leftWidth);

    const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        dragRef.current = { startX: e.clientX, startW: widthRef.current };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    /**
     * 拖动期间**不**写 React 状态，直接改左栏元素的宽度
     *
     * 宽度走 state 会让本组件每帧整棵树重渲（行组件与引导线浮层都在内）：既拖不跟手，
     * 也会把浮层推进「重绘 → 写状态 → 重绘」的自反馈里（React #185，表现为整块视图闪退）。
     * 直接改样式不经过 React，浮层只由它的 ResizeObserver 兜底重画。
     */
    const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d) return;
        const next = Math.min(Math.max(d.startW + (e.clientX - d.startX), LEFT_WIDTH_MIN), LEFT_WIDTH_MAX);
        widthRef.current = next;
        const pane = leftPaneRef.current;
        if (pane) {
            pane.style.width = `${next}px`;
            pane.style.flexBasis = `${next}px`;
        }
    };
    const onHandleUp = (e: ReactPointerEvent<HTMLDivElement>) => {
        const dragging = dragRef.current !== null;
        dragRef.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
        if (!dragging) return;
        // 拖动结束：一次性把 React 状态与命令式改过的样式对齐，并上报给视图（由视图防抖写回设置）
        const next = widthRef.current;
        setLeftWidth(next);
        actions.setLeftWidth(next);
    };

    return (
        <div className={"seqtk-split" + (s.delegated ? " seqtk-split-delegated" : "")}>
            {/* 委托期间左栏与把手不渲染：委托的目的正是把空间让给右栏（只是隐藏仍会占位） */}
            {!s.delegated && (
                <NodeTreePane
                    className="seqtk-split-left seqtk-template-left"
                    paneRef={leftPaneRef}
                    /* 宽度取 ref 而不是 state：拖动期间宽度是命令式改的，
                       重渲时若按旧 state 写回，宽度会跳回去（见 onHandleMove 的说明） */
                    paneStyle={{ width: widthRef.current, flexBasis: widthRef.current }}
                    title="模板框架"
                    titleExtra={
                        <>
                            <button
                                type="button"
                                className="seqtk-btn seqtk-btn-ghost seqtk-title-btn"
                                disabled={s.initializing}
                                onClick={() => actions.createRootFramework()}
                            >
                                新建
                            </button>
                            {/* 委托开关收在标题末尾：与事务设计左栏同款，方向随状态反转 */}
                            <IconButton
                                className={"seqtk-icon-btn seqtk-delegate-btn" + (s.delegated ? " is-active" : "")}
                                icon={s.delegated ? "chevrons-right" : "chevrons-left"}
                                tip={s.delegated ? "取消委托（模板框架树交还此栏）" : "委托到侧栏"}
                                host={host}
                                onClick={() => actions.toggleDelegate()}
                            />
                        </>
                    }
                    items={s.leftItems}
                    metrics={LINE_METRICS_LEFT}
                    actions={leftActions}
                    host={host}
                    rowClass="seqtk-frame-item"
                    emptyText={s.leftEmpty}
                />
            )}

            {/* 双栏比例把手：拖动改变左栏宽度 */}
            {!s.delegated && (
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

            <div className="seqtk-split-right">
                {s.selectedId === null ? (
                    <div className="seqtk-empty">在左侧选择一个模板框架</div>
                ) : (
                    <TemplateTextPanel
                        title={s.rightTitle}
                        text={t}
                        onChange={actions.textChange}
                        onCommit={actions.textCommit}
                        onReset={actions.textReset}
                    />
                )}
            </div>
        </div>
    );
}
