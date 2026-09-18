/**
 * DelegatedTreePanel — 被委托的框架树面板（渲染件）
 *
 * 委托面板不是 DesignView 的子组件：它由中控台侧栏承载，读的是共享状态源
 * （design/FrameworkTreeShared），因此与设计视图左栏的展开/选中始终一致。
 *
 * 本面板是**只读委托**：只提供展开与选中两个动作 —— 右键菜单、行内新建、拖拽排序等
 * 编辑能力留在设计视图左栏。两个入口同时改同一棵树会让「谁在编辑」变得难以预期。
 *
 * 只接 props、只发回调；不 import "obsidian"、不碰数据层。
 */

import { useStore } from "../../../P0_UI/useStore";
import type { SimpleStore } from "../../../P5_Data/Svelte/SimpleStore";
import { LINE_METRICS_LEFT, type NodeLineCtx, type NodeLineHost } from "../../../P7_Render/Composition/C1_NodeLine/NodeLine";
import { NodeTreePane } from "../../../P7_Render/Composition/C2_Tree/NodeTreePane";
import { IconButton } from "../../../P7_Render/Composition/C1_NodeLine/IconButton";
import type { NodeKindValue } from "../../../P4_Nodes/NodeKind/NodeKind";
import type { NodeInlineCreating, TreeNodeItem } from "../../../P7_Render/Composition/C2_Tree/NodeTree";

export interface DelegatedTreeState {
    items: TreeNodeItem[];
    /** 面板标题（由委托来源给出：「框架」/「模板框架」） */
    title: string;
    emptyText?: string;
    /** 当前选中的框架 nodeId（与设计视图共享） */
    selectedId: string | null;
    /** 行内新建态（右键「新建子框架」后，在父框架的子列表末尾插一行输入） */
    creating?: NodeInlineCreating | null;
    /** 正在行内重命名的节点（其行渲染覆盖层，值由行数据带给行组件） */
    editingNodeId?: string | null;
}

export interface DelegatedTreeActions {
    /** 展开/收起某节点 */
    onToggle(ctx: NodeLineCtx): void;
    /** 点击行末「在右侧打开」→ 与设计视图一致：选中该框架 */
    onSelect(ctx: NodeLineCtx): void;
    /** 取消委托（关闭本面板并把框架树交还设计视图） */
    onCancelDelegate(): void;
    /** 行右键：新建子框架 / 重命名 / 归档（三项都作用于框架树本身） */
    onContextMenu(ctx: NodeLineCtx, event: MouseEvent): void;
    /** 空白处右键：与来源视图左栏的空白菜单同口径（新建根级节点 / 从磁盘刷新） */
    onBlankContextMenu(event: MouseEvent): void;
    /** 行内新建提交 / 取消 */
    onCreateCommit(parentId: string, kind: NodeKindValue, name: string): void;
    onCreateCancel(parentId: string): void;
    /** 行内新建：切换「连续输入」（提交后保留附加行，便于连续录入子框架） */
    onRepeatChange(repeat: boolean): void;
    /** 行内重命名提交 / 取消 */
    onInlineCommit(ctx: NodeLineCtx, value: string): void;
    onInlineCancel(ctx: NodeLineCtx): void;
}

export interface DelegatedTreePanelProps {
    store: SimpleStore<DelegatedTreeState>;
    actions: DelegatedTreeActions;
    host: NodeLineHost;
}

export function DelegatedTreePanel({ store, actions, host }: DelegatedTreePanelProps) {
    const state = useStore(store);

    return (
        <NodeTreePane
            className="seqtk-delegated-tree"
            /* 空白处右键：行自身的 contextmenu 已 stopPropagation，能冒泡到栏的都是空白；
               再按行选择器确认一次（与来源视图左栏同法），随后交给来源的空白菜单 */
            onPaneContextMenu={(e) => {
                if ((e.target as HTMLElement).closest(".seqtk-frame-item")) return;
                e.preventDefault();
                actions.onBlankContextMenu(e.nativeEvent);
            }}
            title={state.title}
            titleExtra={
                /* 与来源视图左栏的委托开关同款：收在标题末尾的图标按钮，方向相反 */
                <IconButton
                    className="seqtk-icon-btn seqtk-delegate-btn is-active"
                    icon="chevrons-right"
                    tip="取消委托（把树交还来源视图）"
                    host={host}
                    onClick={() => actions.onCancelDelegate()}
                />
            }
            items={state.items}
            metrics={LINE_METRICS_LEFT}
            host={host}
            rowClass="seqtk-frame-item"
            emptyText={state.emptyText}
            guides
            creating={state.creating ?? null}
            actions={{
                onToggle: (ctx) => actions.onToggle(ctx),
                onSelect: (ctx) => actions.onSelect(ctx),
                onContextMenu: (ctx, e) => actions.onContextMenu(ctx, e),
                onCreateCommit: (parentId: string, kind: NodeKindValue, name: string) =>
                    actions.onCreateCommit(parentId, kind, name),
                onCreateCancel: (parentId: string) => actions.onCreateCancel(parentId),
                onCreateRepeatChange: (_parentId: string, repeat: boolean) => actions.onRepeatChange(repeat),
                onInlineCommit: (ctx, value) => actions.onInlineCommit(ctx, value),
                onInlineCancel: (ctx) => actions.onInlineCancel(ctx),
            }}
        />
    );
}
