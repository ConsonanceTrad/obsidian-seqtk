/**
 * DesignView — 事务设计（视图层）
 *
 * 本类只做五件事（见 P6_Views/Views.md「视图的职责边界（组件化后）」）：
 * 1. 装配：`renderPanel()` 把渲染件 DesignPanel 放进视图容器
 * 2. 注册：视图类与命令（@AutoView / @AutoRegister / registerCommands）
 * 3. 微调：向渲染件注入左/右栏的视图状态（标题、排序模式、瞬时编辑态…）
 * 4. 数据注入：订阅活跃缓存（经 pipe.SUB_ActiveView）→ 用 design/viewModel 把节点算成视图模型 → 写入 SimpleStore
 * 5. 交互数据传递：接住组件回调（DesignActions），在这里落到数据层（actions / drag 执行 / 菜单）
 *
 * 元素创建、树递归、行内编辑覆盖层、引导线全部在 P7_Render（C1_NodeLine / C2_Tree）——
 * 本文件里**不应再出现** createEl / createDiv / addClass。
 *
 * 数据面（见 P6_Views/Views.md 边界判据）：本类自身的读写一律经 **DataPipe** 门面。
 * 数据面（见 P6_Views/Views.md 边界判据）：读写与订阅一律经 **DataPipe**；
 * design/* 切片同样只通过 `view.pipe` 取用数据面（切片已全部迁移完成）。
 *
 * ── 视图侧切片（都以 `view` 为第一参数协作，故本类多数状态与方法为 public）──
 *   design/tree.ts            树构建纯函数（形参已是 DataPipe）
 *   design/viewModel.ts       节点 → 组件视图模型（形参已是 DataPipe）
 *   design/actions.ts         节点数据写：创建 / 时间规则 / 状态 / 归档 / 级联删除 / 保存 / 打开文件
 *   getXxxMenuDefinitions     全部右键 / 空白 / 状态菜单（装配在 P7_Render/Composition/C3_RightClickMenu）
 *   design/templateActions.ts 右键「存为模板 / 使用模板」编排
 *   design/drag.ts            拖拽「执行」（判定在 P7_Render/Composition/C2_Tree/drag.ts）
 */

import {AutoView} from "../../P1_Register/View";
import {AutoRegister} from "../../P1_Register/Comd";
import type SeqtkPlugin from "../../main";
import type {PanelEntry} from "../panelRegistry";
import { createElement, type ReactNode } from 'react';
import { Menu, Notice, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import { ReactViewBase } from '../../P0_UI/ViewBase';
import {
    DesignPanel,
    type DesignActions,
    type DesignInlineCreating,
    type DesignViewState,
    type TreeSide,
} from './DesignPanel';
import { SimpleStore } from '../../P5_Data/Svelte/SimpleStore';
import { Save_Setting } from '../../P3_Settings/Settings';
import { showSourcesMenu } from './design/externalInfo';
import { openTextTreeImport } from './design/textEdit';
import {
    selectFramework,
    selectParentFramework,
    toggleDelegate,
    toggleExpand,
    toggleState,
} from './design/navigation';
import {
    cancelBody,
    cancelCreate,
    cancelRename,
    commitBody,
    commitCreate,
    commitRename,
    setCreateKind,
    setCreateRepeat,
} from './design/inlineEdit';
import {
    getLeftBlankMenuDefinitions,
    getRightBlankMenuDefinitions,
    showRowContextMenu,
    showRowStateMenu,
} from './design/menuDefinitions';
import { FRAMEWORK_TREE } from './design/FrameworkTreeShared';
import {
    LEFT_PANE_DEFAULT,
    bindTreeScroll,
    persistNow,
    restoreTreeScroll,
    schedulePersist,
    setLeftWidth,
} from './design/session';
import { buildState } from './design/viewState';
import type { PluginSettings } from '../../P3_Settings/Settings';
import type { NodeKindValue } from '../../P4_Nodes/NodeKind/NodeKind';
import {
    NODE_KIND,
    NODE_KIND_LABELS,
    NODE_STATE_LABELS,
    STATE_VALUES,
    getAllowedChildKinds,
    isFrameworkKind,
} from '../../P4_Nodes/NodeFacade';
import type { DataPipe } from '../../P5_Data/CoPipe/DataPipe';
import {
    buildFrameworkTree,
    buildConceptTree,
    buildChecklistTree,
    buildFrameworkNode,
    buildNode,
    sortByFollows,
    type TreeNode,
} from './design/tree';
import {
    buildFrameLine,
    buildNodeLine,
    buildTreeItems,
    type LineOverlay,
} from './design/viewModel';
import {
    BUILD_Menu,
    type MenuDefinition,
    type MenuDefinitions,
} from '../../P7_Render/Composition/C3_RightClickMenu/MenuDefinition';
import {
    COLLAPSE_ITEM,
    EVIDENCE_ICONS,
    EXPAND_ITEM,
    ICON,
    SECTION,
    STATE_ICON,
} from '../../P7_Render/Composition/C3_RightClickMenu/MenuAppearance';
import { EVIDENCE_KINDS } from '../../P7_Render/Composition/C2_Tree/drag';
import { kindUsesState } from '../../P7_Render/Structure/S2_Modal/TransactionModals';
import { moveChildInFollows, moveTopInOrder, moveChildAcrossParents } from './design/drag';
import {
    archiveNode,
    createNode,
    openEdit,
    openNodeFile,
    saveNodeBody,
    saveNodeDesc,
    setNodeState,
} from './design/actions';
import { saveAsTemplate, useTemplate } from './design/templateActions';
import {
    canBeChildOf,
    canDrop as canDropByTarget,
    canDropToFrameworkBlank,
    resolveDropTarget,
    type DragQuery,
    type DragSource,
} from '../../P7_Render/Composition/C2_Tree/drag';
import type { NodeLineCtx, NodeLineDropHint } from '../../P7_Render/Composition/C1_NodeLine/NodeLine';
import type { TreeNodeItem } from '../../P7_Render/Composition/C2_Tree/NodeTree';

export const VIEW_TYPE_DESIGN = 'seqtk-design';

/** 初始视图状态（未初始化时的空壳）；左栏宽度的常量与读写见 design/session */
const EMPTY_VIEW_STATE: DesignViewState = {
    leftItems: [],
    rightItems: [],
    rightMode: 'empty',
    creating: null,
    bodyEditing: null,
    dropBlank: false,
    delegated: false,
    leftPaneWidth: LEFT_PANE_DEFAULT,
};

@AutoView()
@AutoRegister()
export class DesignView extends ReactViewBase {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_DESIGN, title: '事务设计', icon: 'layout-grid', description: '设计模式：框架-子框架总览，统一编辑框架内的事务与证据；含全部事务总览。', category: '事务设计'},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): DesignView {
        return new DesignView(
            leaf,
            plugin.allDeps.dataPipe,
            plugin.allDeps.settings,
            //
            // 两个回调位置**不能省**：构造函数里 onTopOrderChange 是第 4 个参数，
            // persistSettings 才是第 5 个。此前只传了一个写盘回调，它落到了
            // onTopOrderChange 上，persistSettings 始终是 undefined ——
            // 而调用处写的是 this.persistSettings?.()，可选调用把这个问题静默吞掉了，
            // 结果就是设置从来没有写回过磁盘（data.json 里连新字段都没有）。
            //
            // 顶级框架排序变化（drag.ts 拖拽排序后调用）：既要更新 settings 也要落盘
            (order) => {
                plugin.settings.topFrameworkOrder = order;
                void Save_Setting(plugin);
            },
            // 常规写盘回调：视图类不直接依赖插件实例
            () => void Save_Setting(plugin),
        );
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-design',
            name: '打开事务设计',
            callback: () => plugin.activateView(VIEW_TYPE_DESIGN),
        });

        // 从选中的文本提取节点组（在编辑器里选中一段缩进列表后用）
        plugin.addCommand({
            id: 'seqtk-extract-text-tree',
            name: '从选中文本提取节点组',
            editorCallback: (editor) => openTextTreeImport(plugin, editor.getSelection()),
        });

        // 编辑器右键：有选中内容时才出现，避免菜单里常驻一个点了没反应的项
        plugin.registerEvent(
            plugin.app.workspace.on('editor-menu', (menu, editor) => {
                const selected = editor.getSelection();
                if (!selected.trim()) return;
                menu.addItem((item) =>
                    item
                        .setTitle('提取为 SeqTK 节点组')
                        .setIcon('list-tree')
                        .onClick(() => openTextTreeImport(plugin, selected)),
                );
            }),
        );
    }

    /** 视图容器附加类（基座 addClass 用） */
    protected cssClass = 'seqtk-design-view';

    /** 视图状态载体（渲染件经 useStore 订阅） */
    private stateStore = new SimpleStore<DesignViewState>(EMPTY_VIEW_STATE);

    /**
     * 左栏展开状态 —— 指向共享状态源（见 design/FrameworkTreeShared）。
     * 左栏可被「委托」到中控台侧栏显示，两处必须同源，故不放视图实例；
     * 这里保持 `view.expandedLeft` 的既有写法不变。
     */
    public expandedLeft = FRAMEWORK_TREE.expandedLeft;
    /** 右栏展开状态（nodeId 集合，与左栏独立；右栏不参与委托） */
    public expandedRight = new Set<string>();
    /** 当前选中的框架 nodeId；null 表示「全部事务总览」（与委托面板共享） */
    public get selectedFrameworkId(): string | null {
        return FRAMEWORK_TREE.selectedId;
    }
    public set selectedFrameworkId(v: string | null) {
        FRAMEWORK_TREE.selectedId = v;
    }
    /** 顶级框架排序（nodeId 顺序，持久化于 settings.topFrameworkOrder） */
    public topOrder: string[] = [];
    /**
     * 右栏内下钻的来路栈（来源在栈顶）：只有「在右栏点框架行进它的内部」才记来源，
     * 左栏点选会清空它 —— 见 design/navigation.selectFramework。栈空时框架不提供「返回父框架」入口。
     *
     * 切片协作可见：选中 / 返回父框架 / 判定入口都在 design/navigation。
     */
    public frameworkNavStack: string[] = [];
    /** 当前拖拽源（dragstart 写入，dragover/drop 读取，dragend 清空） */
    public dragSource: DragSource | null = null;
    /** 左栏宽度（记忆于 settings.leftPaneWidth；拖动结束后才写回）；切片协作可见 */
    public leftWidth = LEFT_PANE_DEFAULT;
    /** 设置写回的防抖计时器；切片协作可见 */
    public persistTimer: number | null = null;

    /** 瞬时交互态（只影响渲染）；切片协作可见 */
    public rename: { nodeId: string; side: TreeSide } | null = null;
    public creating: DesignInlineCreating | null = null;
    public bodyEditing: { nodeId: string; value: string } | null = null;
    public dropHint: { nodeId: string; hint: NodeLineDropHint } | null = null;
    public draggingId: string | null = null;
    public dropBlank = false;

    private unsub: (() => void) | null = null;
    private unsubShared: (() => void) | null = null;
    /** refresh() 执行中：防止共享状态回调与 refresh 互相触发 */
    private refreshing = false;

    /**
     * 立即把会话状态写回设置（不防抖）
     *
     * 供插件卸载时调用：schedulePersist 有 600ms 防抖，而关库时 Obsidian 直接卸载
     * 插件，onBeforeUnmount 未必会被调用，最后一次变更就可能丢掉。
     */
    public FLUSH_Session(): void {
        persistNow(this);
    }

    /**
     * 记录树容器的滚动位置
     *
     * 用事件委托（捕获阶段）而不是给每棵树挂监听：树容器由 P7_Render 渲染，
     * 视图层不该去它内部找元素、更不该在重渲后重挂。判断是哪一栏靠 closest，
     * 与 DesignPanel 里其它“按栏分派”的写法一致。
     *
     * 实现与绑定工厂在 design/session —— 字段初始化器先于 constructor 体执行，
     * 故工厂内只捕获 view 引用，字段要等事件触发时再读。
     */
    public onTreeScroll = bindTreeScroll(this);

    constructor(
        leaf: WorkspaceLeaf,
        /** 数据面唯一入口（读写与订阅一律经它） */
        public pipe: DataPipe,
        public settings: PluginSettings,
        public onTopOrderChange?: (order: string[]) => void,
        /** 把设置写回磁盘（由装配层注入，视图类不直接依赖插件实例）；切片协作可见 */
        public persistSettings?: () => void,
    ) {
        super(leaf);
        this.topOrder = [...(this.settings.topFrameworkOrder ?? [])];
        // 恢复记忆的展开状态（写回见 schedulePersist）
        for (const id of this.settings.expandedFrameworkIds ?? []) {
            FRAMEWORK_TREE.expandedLeft.add(id);
        }
        this.leftWidth = this.settings.leftPaneWidth || LEFT_PANE_DEFAULT;
    }

    getViewType(): string {
        return VIEW_TYPE_DESIGN;
    }

    getDisplayText(): string {
        return '事务设计';
    }

    getIcon(): string {
        return 'layout-grid';
    }

    // ============================================================
    // 装配：渲染件 + 注入的交互入口
    // ============================================================

    /** 渲染件在 DesignPanel.tsx：左右栏装配在这里完成，本类只注入状态与交互入口 */
    protected renderPanel(): ReactNode {
        return createElement(DesignPanel, {
            store: this.stateStore,
            actions: this.buildActions(),
            host: { setTooltip, setIcon },
        });
    }

    protected onMounted(): void {
        document.addEventListener('contextmenu', this.onDocumentContextMenu, true);
        this.unsub = this.pipe.SUB_ActiveView(() => this.refresh());
        // 共享状态变化（本视图或委托面板发起）→ 安排一次写回，用不着重绘（本视图自己的变更已 refresh 过）
        // 共享状态变了：既持久化，也**刷新视图**。
        // 只持久化是不够的 —— 从委托面板那侧关掉委托时，本视图的 stateStore 不会变，
        // 左栏与把手就一直不回来（委托开关就藏在共享状态里）。
        this.unsubShared = FRAMEWORK_TREE.store.subscribe(() => {
            schedulePersist(this);
            this.onSharedChanged();
        });
        // 恢复会话状态：上次打开的是哪个框架（选中 = 右栏打开它）、两栏各自的展开集合。
        // 展开是两栏分开记的 —— 左栏看框架层级、右栏看节点树，混用会让展开形态串味。
        if (this.settings.selectedFrameworkId) {
            FRAMEWORK_TREE.selectedId = this.settings.selectedFrameworkId;
        }
        this.expandedRight.clear();
        for (const id of this.settings.expandedRightIds ?? []) this.expandedRight.add(id);
        // 滚动位置：捕获阶段，容器由 P7_Render 渲染，不必去它内部挂监听
        this.containerEl.addEventListener('scroll', this.onTreeScroll, true);
        this.refresh();
        restoreTreeScroll(this);
    }

    protected onBeforeUnmount(): void {
        this.containerEl.removeEventListener('scroll', this.onTreeScroll, true);
        // 关视图前把当前滚动位置落盘（防抖可能还没到点）
        persistNow(this);
        document.removeEventListener('contextmenu', this.onDocumentContextMenu, true);
        this.unsub?.();
        this.unsub = null;
        this.unsubShared?.();
        this.unsubShared = null;
        if (this.persistTimer !== null) {
            window.clearTimeout(this.persistTimer);
            this.persistTimer = null;
            persistNow(this);   // 关闭视图前把最后一次状态落盘，避免丢掉
        }
    }

    /** 设置变更后刷新视图 */
    public refreshSettings(): void {
        this.refresh();
    }

    // ============================================================
    // 数据注入：状态重建
    // ============================================================

    /**
     * 写盘期间压掉一切刷新
     *
     * 新建节点时，数据写入会连带触发缓存订阅的回调；若不压掉，画面会走成
     * 「输入行消失 → 新行单独出现」两步，中间还夹着一次「输入行与新行并存」——
     * 那正是肉眼看到的闪烁。提交方在写盘前置位、写完后自己刷新一次，
     * 于是附加行原地变成新节点，全程只有一次重绘。
     *
     * 切片协作可见：design/inlineEdit.commitCreate 在写盘期间置位。
     */
    public suppressRefresh = false;

    /**
     * 重建视图状态并推给渲染件。
     *
     * `renderLeft` / `renderRight` 保留为它的别名 —— `design/*` 切片（actions / templateActions /
     * drag 执行）一直用「重绘某一栏」表达「数据变了，刷新」，语义等价。
     */
    public refresh(): void {
        if (this.suppressRefresh) return;
        // 置位期间不响应共享状态的回调：本方法末尾会反手通知共享状态，
        // 若订阅回调直接再调 refresh，就成了一来一回的死循环。
        this.refreshing = true;
        try {
            this.stateStore.set(buildState(this));
            // 通知共享 store：展开集合可能刚被改动，委托面板据此重算（若未委托则无人订阅，开销可忽略）
            FRAMEWORK_TREE.markExpandedChanged();
        } finally {
            this.refreshing = false;
        }
    }

    /** 共享状态（委托开关 / 展开集合 / 选中框架）变化的统一入口 */
    private onSharedChanged(): void {
        if (this.refreshing) return;
        this.refresh();
    }

    public renderLeft(): void {
        this.refresh();
    }

    public renderRight(): void {
        this.refresh();
    }

    // 视图状态构建（buildState / 总览 / 行模型 / 覆盖信息）见 design/viewState

    // ============================================================
    // 交互数据传递：DesignActions 的实现
    // ============================================================

    private buildActions(): DesignActions {
        return {
            toggle: (nodeId, side) => toggleExpand(this, nodeId, side),
            select: (nodeId, side) => selectFramework(this, nodeId, side),
            contextMenu: (nodeId, side, e) => showRowContextMenu(this, nodeId, side, e),
            stateClick: (nodeId) => toggleState(this, nodeId),
            stateContextMenu: (nodeId, _side, e) => showRowStateMenu(this, nodeId, e),
            dragStart: (ctx, _side, e) => this.onDragStart(ctx, e),
            dragEnd: () => this.onDragEnd(),
            dragOver: (ctx, side, e) => this.onDragOver(ctx, side, e),
            dragLeave: () => this.clearDropHint(),
            drop: (ctx, side, e) => this.onDrop(ctx, side, e),
            inlineCommit: (nodeId, _side, value) => commitRename(this, nodeId, value),
            inlineCancel: () => cancelRename(this),
            createCommit: (parentId, kind, name) => void commitCreate(this, parentId, kind, name),
            createCancel: () => cancelCreate(this),
            createKindChange: (_parentId, kind) => setCreateKind(this, kind),
            createRepeatChange: (_parentId, repeat) => setCreateRepeat(this, repeat),
            bodyCommit: (nodeId, body) => commitBody(this, nodeId, body),
            bodyCancel: () => cancelBody(this),
            blankContextMenu: (side, e) =>
                BUILD_Menu(
                    side === 'left' ? getLeftBlankMenuDefinitions(this) : getRightBlankMenuDefinitions(this),
                    e,
                ),
            blankDragOver: (e) => this.onBlankDragOver(e),
            blankDragLeave: (e) => this.onBlankDragLeave(e),
            blankDrop: (e) => this.onBlankDrop(e),
            toggleDelegate: () => toggleDelegate(this),
            selectParentFramework: () => selectParentFramework(this),
            sourcesClick: (nodeId, _side, e) => showSourcesMenu(this, nodeId, e),
            setLeftWidth: (width) => setLeftWidth(this, width),
        };
    }

    // ============================================================
    // 拖拽：判定用 C2_Tree/drag（纯逻辑），执行交 design/drag（写数据）
    // ============================================================

    /** 判定所需的最小查询能力（注入给 C2_Tree/drag） */
    private get dragQuery(): DragQuery {
        return {
            kindOf: (nodeId) => this.pipe.GET_Node(nodeId)?.kind,
            selectedFrameworkId: () => this.selectedFrameworkId,
        };
    }

    private onDragStart(ctx: NodeLineCtx, e: DragEvent): void {
        this.dragSource = { sourceId: ctx.nodeId, parentId: ctx.parentId, kind: this.pipe.GET_Node(ctx.nodeId)?.kind };
        const dt = e.dataTransfer;
        if (dt) {
            dt.setData('text/plain', JSON.stringify(this.dragSource));
            dt.effectAllowed = 'move';
        }
        this.draggingId = ctx.nodeId;
        this.refresh();
    }

    private onDragEnd(): void {
        this.dragSource = null;
        this.draggingId = null;
        this.clearDropHint();
    }

    private onDragOver(ctx: NodeLineCtx, side: TreeSide, e: DragEvent): void {
        const source = this.dragSource;
        if (!source) return;
        e.preventDefault();
        const target = resolveDropTarget(e);
        if (!target) return;
        let hint: NodeLineDropHint | null = null;
        if (side === 'left') {
            // 左栏仅同父同级排序：上方→目标前、下方→目标后；中心（子级）与跨父/跨级驳回
            const ok = target.parentId === source.parentId && target.nodeId !== source.sourceId && target.zone !== 'middle';
            hint = ok ? (target.zone === 'above' ? 'before' : 'after') : 'invalid';
        } else if (canDropByTarget(this.dragQuery, source, target)) {
            hint = target.zone === 'above' ? 'before' : target.zone === 'below' ? 'after' : 'child';
        } else {
            hint = 'invalid';
        }
        if (e.dataTransfer) e.dataTransfer.dropEffect = hint === 'invalid' ? 'none' : 'move';
        this.setDropHint(target.nodeId, hint);
        void ctx;
    }

    private onDrop(ctx: NodeLineCtx, side: TreeSide, e: DragEvent): void {
        const source = this.dragSource;
        void ctx;
        this.clearDropHint();
        if (!source) return;
        e.preventDefault();
        const target = resolveDropTarget(e);
        if (!target) return;

        if (side === 'left') {
            if (target.zone !== 'middle' && target.parentId === source.parentId && target.nodeId !== source.sourceId) {
                const before = target.zone === 'above';
                if (source.parentId) moveChildInFollows(this, source.parentId, source.sourceId, target.nodeId, before);
                else moveTopInOrder(this, source.sourceId, target.nodeId, before);
            }
        } else if (canDropByTarget(this.dragQuery, source, target)) {
            if (target.zone === 'middle') {
                moveChildAcrossParents(this, source.parentId, source.sourceId, target.nodeId, '', false);
            } else {
                const before = target.zone === 'above';
                if (target.parentId === source.parentId) {
                    moveChildInFollows(this, source.parentId, source.sourceId, target.nodeId, before);
                } else {
                    moveChildAcrossParents(this, source.parentId, source.sourceId, target.parentId, target.nodeId, before);
                }
            }
        }
        this.dragSource = null;
        this.draggingId = null;
        this.refresh();
    }

    /** 拖到右栏空白：改为选中框架的直属子节点 */
    private onBlankDragOver(e: DragEvent): void {
        const source = this.dragSource;
        if (!source || !canDropToFrameworkBlank(this.dragQuery, source)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        this.clearDropHint();
        if (!this.dropBlank) {
            this.dropBlank = true;
            this.refresh();
        }
    }

    private onBlankDragLeave(e: DragEvent): void {
        // 只有真正离开窗口（relatedTarget 为空）才清理，避免在栏内子元素间移动时闪烁
        if (e.relatedTarget) return;
        if (!this.dropBlank) return;
        this.dropBlank = false;
        this.refresh();
    }

    private onBlankDrop(e: DragEvent): void {
        const source = this.dragSource;
        if (!source || !canDropToFrameworkBlank(this.dragQuery, source)) return;
        e.preventDefault();
        this.dropBlank = false;
        moveChildAcrossParents(this, source.parentId, source.sourceId, this.selectedFrameworkId!, '', false);
        this.dragSource = null;
        this.draggingId = null;
        this.refresh();
    }

    private setDropHint(nodeId: string, hint: NodeLineDropHint | null): void {
        if (!hint) return this.clearDropHint();
        if (this.dropHint?.nodeId === nodeId && this.dropHint.hint === hint) return;
        this.dropHint = { nodeId, hint };
        this.refresh();
    }

    private clearDropHint(): void {
        if (!this.dropHint) return;
        this.dropHint = null;
        this.refresh();
    }

    /** 拖拽进行中右键：取消本次拖拽并清理指示（原 installDragCancelHandler 的等价实现） */
    private onDocumentContextMenu = (e: MouseEvent): void => {
        if (!this.dragSource) return;
        e.preventDefault();
        e.stopPropagation();
        this.dragSource = null;
        this.draggingId = null;
        this.dropBlank = false;
        this.clearDropHint();
    };
}
