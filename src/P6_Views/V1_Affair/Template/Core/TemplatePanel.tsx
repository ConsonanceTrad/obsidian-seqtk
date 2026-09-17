/**
 * TemplatePanel — 模板模式的渲染件（左栏框架树 / 右栏内容文本）
 *
 * 纯渲染：只接 props（两个 store + 动作 + 宿主能力）、只发回调；不 import "obsidian"、
 * 不碰 DataPipe / NodeCache —— 数据读写那条线是 `TemplateActions` 与注入的 host
 * （见 P6_Views/Views.md 的装配层职责）。
 *
 * 布局：左栏 = 模板框架树，与事务设计左栏**同一个** NodeTreePane、同一套行模型
 * （行怎么画由 P7_Render 负责，本层不手写行元素），只用来选框架与增删框架；
 * 右栏 = 选中框架的内容，**直接由文本表示**（TemplateTextPanel：解析预览 / 合法性校验 /
 * 按差异回写）—— 内容的增删改都在文本里做，因此右栏没有第二棵树。
 *
 * 两个 store 分开订阅：按键只刷 textStore，左栏树不跟着每帧重渲。
 */

import { useMemo } from "react";
import { useStore } from "../../../../P0_UI/useStore";
import type { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";
import { LINE_METRICS_LEFT, type NodeLineHost } from "../../../../P7_Render/Composition/C1_NodeLine/NodeLine";
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
}

export interface TemplatePanelProps {
    /** 结构态（左栏树 / 选中） */
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

export function TemplatePanel({ state, text, actions, host }: TemplatePanelProps) {
    const s = useStore(state);
    const t = useStore(text);
    const leftActions = useMemo(() => bindTree(actions), [actions]);

    return (
        <div className="seqtk-split">
            <NodeTreePane
                /* seqtk-template-left 只补栏宽（模板左栏没有宽度把手），外观仍由 seqtk-split-left 承担 */
                className="seqtk-split-left seqtk-template-left"
                title="模板框架"
                titleExtra={
                    <button
                        type="button"
                        className="seqtk-btn seqtk-btn-ghost seqtk-title-btn"
                        disabled={s.initializing}
                        onClick={() => actions.createRootFramework()}
                    >
                        新建
                    </button>
                }
                items={s.leftItems}
                metrics={LINE_METRICS_LEFT}
                actions={leftActions}
                host={host}
                rowClass="seqtk-frame-item"
                emptyText={s.leftEmpty}
            />

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
