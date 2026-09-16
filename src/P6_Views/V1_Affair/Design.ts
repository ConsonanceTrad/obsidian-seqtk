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
import {
    GET_SourceLabel,
    GET_SourceTarget,
    type ExternalSource,
} from '../../P4_Nodes/NodeField/AttriGroup/External';
import { ExternalSourcesModal } from '../../P7_Render/Structure/S2_Modal/ExternalSourcesModal';
import { TextPromptModal } from '../../P7_Render/Structure/S2_Modal/TextPromptModal';
import {
    copySubtreeAsText,
    editFrameworkContentAsText,
    editSubtreeAsText,
    openTextTreeImport,
} from './design/textEdit';
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
import { VIEW_TYPE_DELEGATED_TREE } from './DelegatedTree';
import { VIEW_TYPE_HUB_SIDE } from '../V0_Common/Hub';
import { NodePickModal } from '../../P7_Render/Structure/S2_Modal/NodePickModal';
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
     * 左栏点选会清空它 —— 见 selectFramework。栈空时框架不提供「返回父框架」入口。
     */
    private frameworkNavStack: string[] = [];
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
     */
    private suppressRefresh = false;

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
            toggle: (nodeId, side) => this.toggleExpand(nodeId, side),
            select: (nodeId, side) => this.selectFramework(nodeId, side),
            contextMenu: (nodeId, side, e) => this.showRowContextMenu(nodeId, side, e),
            stateClick: (nodeId) => this.toggleState(nodeId),
            stateContextMenu: (nodeId, _side, e) => this.showRowStateMenu(nodeId, e),
            dragStart: (ctx, _side, e) => this.onDragStart(ctx, e),
            dragEnd: () => this.onDragEnd(),
            dragOver: (ctx, side, e) => this.onDragOver(ctx, side, e),
            dragLeave: () => this.clearDropHint(),
            drop: (ctx, side, e) => this.onDrop(ctx, side, e),
            inlineCommit: (nodeId, _side, value) => this.commitRename(nodeId, value),
            inlineCancel: () => this.cancelRename(),
            createCommit: (parentId, kind, name) => void this.commitCreate(parentId, kind, name),
            createCancel: () => this.cancelCreate(),
            createKindChange: (_parentId, kind) => this.setCreateKind(kind),
            createRepeatChange: (_parentId, repeat) => this.setCreateRepeat(repeat),
            bodyCommit: (nodeId, body) => this.commitBody(nodeId, body),
            bodyCancel: () => this.cancelBody(),
            blankContextMenu: (side, e) =>
                BUILD_Menu(
                    side === 'left' ? this.getLeftBlankMenuDefinitions() : this.getRightBlankMenuDefinitions(),
                    e,
                ),
            blankDragOver: (e) => this.onBlankDragOver(e),
            blankDragLeave: (e) => this.onBlankDragLeave(e),
            blankDrop: (e) => this.onBlankDrop(e),
            toggleDelegate: () => this.toggleDelegate(),
            selectParentFramework: () => this.selectParentFramework(),
            sourcesClick: (nodeId, _side, e) => this.showSourcesMenu(nodeId, e),
            setLeftWidth: (width) => setLeftWidth(this, width),
        };
    }

    /**
     * 委托左栏框架树到中控台侧栏（进行 / 取消）
     *
     * 委托后两处共用同一状态源（design/FrameworkTreeShared），展开与选中互相同步；
     * 左栏本身**不搬走**，只是多出一个同步的侧栏视图 —— 这样在别的视图工作时也能操作框架树。
     * 用 workspace 的左侧栏 leaf 而非 activateView：本视图没有 plugin 引用，也无需走面板目录。
     */
    private toggleDelegate(): void {
        // 先看侧栏是否已经有委托面板。重开库时工作区会把它恢复出来，而内存里的
        // delegated 开关是新的（false）—— 此时若按「未委托」处理，就会再开一个，
        // 侧栏里出现两个框架树。所以以实际存在的 leaf 为准，只同步开关。
        // 落点：默认借用中控台容器，也可配成独立视图（见设置 delegateTarget）
        const target = this.settings.delegateTarget ?? 'hub';
        const viewType = target === 'view' ? VIEW_TYPE_DELEGATED_TREE : VIEW_TYPE_HUB_SIDE;

        // 先看侧栏是否已经有落点。重开库时工作区会把它恢复出来，而内存里的
        // delegated 开关是新的（false）—— 此时若按「未委托」处理，就会再开一个，
        // 侧栏里出现两份框架树。所以以实际存在的 leaf 为准，只同步开关。
        const opened = this.app.workspace.getLeavesOfType(viewType);
        if (opened.length > 0) {
            FRAMEWORK_TREE.delegated = true;
            this.refresh();
            return;
        }

        if (FRAMEWORK_TREE.delegated) {
            FRAMEWORK_TREE.delegated = false;
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DELEGATED_TREE)) leaf.detach();
            this.refresh();
            return;
        }
        FRAMEWORK_TREE.delegated = true;
        const leaf = this.app.workspace.getLeftLeaf(false);
        if (leaf) {
            void leaf.setViewState({ type: VIEW_TYPE_DELEGATED_TREE, active: true });
            this.app.workspace.revealLeaf(leaf);
        }
        this.refresh();
    }

    /** 按栏切换展开/收起（左右栏展开状态相互独立） */
    public toggleExpand(nodeId: string, side: TreeSide): void {
        const set = side === 'left' ? this.expandedLeft : this.expandedRight;
        if (set.has(nodeId)) set.delete(nodeId);
        else set.add(nodeId);
        this.refresh();
    }

    /** 按栏展开或收起该节点的全部子孙节点（依据该栏当前展开状态切换） */
    public toggleExpandAll(node: TreeNode, side: TreeSide): void {
        const set = side === 'left' ? this.expandedLeft : this.expandedRight;
        const ids: string[] = [];
        const collect = (n: TreeNode): void => {
            ids.push(n.nodeId);
            for (const c of n.children) collect(c);
        };
        collect(node);
        if (set.has(node.nodeId)) for (const id of ids) set.delete(id);
        else for (const id of ids) set.add(id);
        this.refresh();
    }

    /**
     * 变更归属：把节点移到另一个父节点下
     *
     * 移动的**执行**复用拖拽那条路径（design/drag.moveChildAcrossParents），
     * 因此 follows 双向维护与 parent 字段的写法与拖拽完全一致，不存在两套语义。
     * 候选父节点排除自身与全部后代 —— 选了会形成环。
     */
    public changeParent(nodeId: string): void {
        const node = this.pipe.GET_Node(nodeId);
        if (!node) return;
        const exclude = [
            nodeId,
            ...this.pipe.COLLECT_Descendants(nodeId).map((d) => d.nodeId),
        ];
        new NodePickModal(this.app, this.pipe, {
            title: '变更归属 · 选择目标父节点',
            excludeIds: exclude,
            // 只列「能容纳本节点类型」的父 —— 层级错位的候选不该出现在列表里。
            // 判定与拖拽落点同一条（C2_Tree/drag.canBeChildOf），不会出现「拖不进去却能选出来」
            allow: (_id, kind) => canBeChildOf(kind, node.kind),
            emptyText: '没有能容纳该类型的父节点（自身与后代已排除）',
            onPick: (targetParentId) => {
                moveChildAcrossParents(this, node.parent ?? '', nodeId, targetParentId, '', false);
            },
        }).open();
    }

    /**
     * 添加一条外部信息源（链接或库内文件路径）
     *
     * 「外部信息源」是独立列表字段，不与 follows / parent 那一簇混用 ——
     * 前者描述节点之间的关系，后者描述节点与节点体系之外材料的关联。
     */
    public addExternalSource(nodeId: string): void {
        if (!this.pipe.GET_Node(nodeId)) return;
        new TextPromptModal(this.app, {
            title: '添加外部信息源',
            desc: '链接与库内文件路径二选一填写；名称留空时显示地址或文件名。库内文件可用右侧按钮搜索选择，也可直接粘贴路径。',
            fields: [
                { key: 'label', label: '名称', placeholder: '可留空' },
                { key: 'url', label: '链接', placeholder: 'https://…' },
                // type: 'file' → 该行右侧多一个「在库内选择文件」的搜索按钮
                { key: 'path', label: '库内文件', placeholder: 'docs/某文件.md', type: 'file' },
            ],
            onConfirm: ({ label, url, path }) => {
                if (!url && !path) {
                    new Notice('请填写链接或库内文件路径');
                    return;
                }
                this.appendSource(nodeId, {
                    label: label || url || path,
                    ...(url ? { url } : {}),
                    ...(path ? { path } : {}),
                    added: new Date().toISOString(),
                });
            },
        }).open();
    }

    /**
     * 用核心插件创建时间戳文档并挂为信息源
     *
     * 优先借用核心插件「唯一笔记」（zk-prefixer）的创建命令（即「借助核心插件」）；
     * 未启用该插件时回退为按 ISO 时间戳自建文件，功能不至于因此中断。
     */
    public async createTimestampDoc(nodeId: string): Promise<void> {
        if (!this.pipe.GET_Node(nodeId)) return;

        // App 类型未公开 commands（核心插件命令注册在此），按其运行时形态断言后调用
        const commands = (this.app as unknown as {
            commands?: {
                commands?: Record<string, unknown>;
                executeCommandById(id: string): unknown;
            };
        }).commands;
        for (const cmd of ['zk-prefixer:create-new-unique-note', 'zk-prefixer:create-new-zettelkasten-note']) {
            if (!commands?.commands?.[cmd] || typeof commands.executeCommandById !== 'function') continue;
            commands.executeCommandById(cmd);
            const file = this.app.workspace.getActiveFile();
            if (file) {
                this.appendSource(nodeId, { label: file.basename, path: file.path, added: new Date().toISOString() });
                return;
            }
        }

        // 回退：自建时间戳命名的空文档
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const folder = this.settings.rootFolder || '';
        const path = `${folder ? `${folder}/` : ''}${stamp}.md`;
        try {
            const file = await this.app.vault.create(path, '');
            this.appendSource(nodeId, { label: file.basename, path: file.path, added: new Date().toISOString() });
            new Notice('已创建时间戳文档（未检测到核心插件「唯一笔记」，改用时间戳命名）');
        } catch (err) {
            console.error('[SeqTK] 创建时间戳文档失败:', err);
            new Notice('创建时间戳文档失败，请查看控制台');
        }
    }

    /** 追加一条外部信息源（写意图与其它字段更新同构） */
    private appendSource(nodeId: string, source: ExternalSource): void {
        const node = this.pipe.GET_Node(nodeId);
        if (!node) return;
        this.pipe.EXEC_Mutation({
            op: 'update',
            kind: node.kind,
            nodeId,
            updates: { sources: [...(node.sources ?? []), source], modify: new Date().toISOString() },
        });
        new Notice('已添加外部信息源');
    }

    /** 写回整份外部信息源列表（顺序调整与删除都走这里，仍是一次字段更新） */
    private saveSources(nodeId: string, sources: ExternalSource[]): void {
        const node = this.pipe.GET_Node(nodeId);
        if (!node) return;
        this.pipe.EXEC_Mutation({
            op: 'update',
            kind: node.kind,
            nodeId,
            updates: { sources, modify: new Date().toISOString() },
        });
    }

    /**
     * 管理外部信息源：调整顺序、删掉过时或引入错误的条目
     *
     * 弹窗里每次操作即时写盘（没有「保存」按钮）—— 这类小改动即时生效比先攒后存更符合预期，
     * 改错了再改回来也不比按保存麻烦。
     */
    public manageExternalSources(nodeId: string): void {
        const node = this.pipe.GET_Node(nodeId);
        if (!node) return;
        new ExternalSourcesModal(this.app, node.sources ?? [], {
            onChange: (next) => {
                this.saveSources(nodeId, next);
                this.refresh();
            },
        }).open();
    }

    /**
     * 列出某节点的外部信息源并跳转
     *
     * 行内只出一个链接图标，条目名在这里展开（只显示末段名，见 GET_SourceLabel）；
     * url 交给系统浏览器，path 交给 workspace 打开（库内文件）。
     */
    private showSourcesMenu(nodeId: string, e: MouseEvent): void {
        const sources = this.pipe.GET_Node(nodeId)?.sources ?? [];
        if (sources.length === 0) return;

        // 一律弹列表（哪怕只有一条）：列表里能看清是哪个文件，也避免"一点就跳走"不可预期
        const menu = new Menu();
        for (const s of sources) {
            const target = GET_SourceTarget(s);
            menu.addItem((item) =>
                item
                    .setTitle(GET_SourceLabel(s))
                    .setIcon(target?.kind === 'path' ? 'file-text' : 'external-link')
                    .onClick(() => this.openSource(target)),
            );
        }
        menu.showAtMouseEvent(e);
    }

    /** 打开一条信息源（url → 系统浏览器；path → 库内文件） */
    private openSource(target: { kind: 'url' | 'path'; value: string } | null): void {
        if (!target) return;
        if (target.kind === 'url') {
            window.open(target.value, '_blank');
            return;
        }
        const file = this.app.vault.getFileByPath(target.value);
        if (file) void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
        else new Notice(`未找到文件：${target.value}`);
    }

    /** 返回父框架（右栏标题栏按钮）：回到下钻前的那个框架 */
    private selectParentFramework(): void {
        // 来源失效（被删 / 不再是框架）就继续往前找，都没有则什么也不做
        while (this.frameworkNavStack.length > 0) {
            const from = this.frameworkNavStack.pop()!;
            const node = this.pipe.GET_Node(from);
            if (node && isFrameworkKind(node.kind)) {
                this.selectedFrameworkId = from;
                this.refresh();
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
    public resolveNavBack(fwId: string): { nodeId: string; title: string } | undefined {
        const from = this.frameworkNavStack[this.frameworkNavStack.length - 1];
        if (!from) return undefined;
        const node = this.pipe.GET_Node(from);
        if (!node || !isFrameworkKind(node.kind)) return undefined;
        let cur = this.pipe.GET_Parent(fwId)?.nodeId;
        for (let guard = 0; cur && guard < 64; guard++) {
            if (cur === from) return { nodeId: from, title: `${NODE_KIND_LABELS[node.kind]} · ${node.desc}` };
            cur = this.pipe.GET_Parent(cur)?.nodeId;
        }
        return undefined;
    }

    /**
     * 选中框架（左栏行末「在右侧打开」/ 右栏框架行 / 右栏卡片内下钻）
     *
     * 只有**右栏内下钻**才记来路（在右栏点框架行 = 进入它的内部，需要能回到原处）；
     * 左栏点选是「直接切过去」，等于重新开始，因此顺带清掉来路。
     */
    private selectFramework(nodeId: string, side: TreeSide): void {
        const prev = this.selectedFrameworkId;
        if (side === 'right') {
            if (prev && prev !== nodeId) this.frameworkNavStack.push(prev);
        } else {
            this.frameworkNavStack.length = 0;
        }
        this.selectedFrameworkId = nodeId;
        this.refresh();
    }

    /** 状态圆点左键：规划/进行 → 完成；完成 → 规划（循环切换） */
    private toggleState(nodeId: string): void {
        const node = this.pipe.GET_Node(nodeId);
        if (!node) return;
        setNodeState(this, nodeId, (node.state ?? 'plan') === 'done' ? 'plan' : 'done');
    }

    /** 状态圆点右键：完整状态菜单 */
    private showRowStateMenu(nodeId: string, e: MouseEvent): void {
        const data = this.pipe.GET_Node(nodeId);
        if (!data) return;
        BUILD_Menu(this.getStateMenuDefinitions(buildNode(this.pipe, nodeId, data)), e);
    }

    /** 行右键：左栏用框架菜单；右栏框架行用右向框架菜单，其余用节点行菜单 */
    private showRowContextMenu(nodeId: string, side: TreeSide, e: MouseEvent): void {
        const data = this.pipe.GET_Node(nodeId);
        if (!data) return;
        if (side === 'left') {
            BUILD_Menu(this.getFrameMenuDefinitions(buildFrameworkNode(this.pipe, nodeId, data), e, 'left'), e);
            return;
        }
        const node = buildNode(this.pipe, nodeId, data);
        if (isFrameworkKind(data.kind)) BUILD_Menu(this.getFrameMenuDefinitions(node, e, 'right'), e);
        else BUILD_Menu(this.getRowMenuDefinitions(node, e, 'right'), e);
    }

    // ============================================================
    // 右键菜单声明：本类只回答「长什么样、点了做什么」，装配交给 BUILD_Menu
    // ============================================================

    /** 行内交互上下文（层级取自行上的 data-depth：行内新建据此落到正确父级） */
    private ctxFromEvent(e: MouseEvent, node: TreeNode): NodeLineCtx {
        const row = (e.target as HTMLElement).closest<HTMLElement>('.seqtk-row, .seqtk-frame-item');
        return {
            nodeId: node.nodeId,
            parentId: node.data.parent ?? '',
            depth: Number(row?.dataset.depth ?? '0'),
        };
    }

    /** 追加信息子菜单（对象 / 条件 / 信息 / 状态）：空白菜单与行菜单共用，只是落点不同 */
    private evidenceSubmenuDefs(onPick: (kind: NodeKindValue) => void): MenuDefinition[] {
        return [
            {
                name: '追加信息',
                icon: ICON.evidence,
                section: SECTION.main,
                items: EVIDENCE_KINDS.map((kind) => ({
                    name: NODE_KIND_LABELS[kind],
                    icon: EVIDENCE_ICONS[kind],
                    action: () => onPick(kind),
                })),
            },
        ];
    }

    /** 从磁盘刷新（左右栏空白菜单共用） */
    private async syncFromFiles(): Promise<void> {
        if (!this.pipe.isInitialized) {
            new Notice('查询缓存尚未就绪，请稍候');
            return;
        }
        await this.pipe.SYNC_FromFiles();
        new Notice('已从磁盘刷新');
    }

    /** 展开 / 收起：标题与图标随即将执行的行为变化（无子项的行不出现） */
    private expandDefs(node: TreeNode, side: TreeSide): MenuDefinition[] {
        if (node.children.length === 0) return [];
        const expanded = (side === 'right' ? this.expandedRight : this.expandedLeft).has(node.nodeId);
        return [
            {
                ...(expanded ? COLLAPSE_ITEM : EXPAND_ITEM),
                section: SECTION.main,
                action: () => this.toggleExpandAll(node, side),
            },
        ];
    }

    /** 行内追加子项：左栏是子框架；右栏按该行允许的子类型（目标固定为工序） */
    private newChildDefs(node: TreeNode, e: MouseEvent, side: TreeSide): MenuDefinition[] {
        const kind = node.data.kind;
        const kinds = side === 'left' ? [NODE_KIND.TRANS] : getAllowedChildKinds(kind);
        if (kinds.length === 0) return [];
        const allowed = kind === NODE_KIND.TARGET ? [NODE_KIND.PROCESS] : kinds;
        return [
            {
                name: side === 'right' ? '追加子项' : '追加子框架',
                icon: ICON.newChild,
                section: SECTION.main,
                action: () => this.startCreateChild(this.ctxFromEvent(e, node), side, allowed),
            },
        ];
    }

    /** 右栏框架行的行内新建入口（不开模态框） */
    private rightCreateDefs(node: TreeNode, e: MouseEvent): MenuDefinition[] {
        const create = (name: string, icon: string, kind: NodeKindValue): MenuDefinition => ({
            name,
            icon,
            section: SECTION.main,
            action: () => this.startCreateChild(this.ctxFromEvent(e, node), 'right', [kind]),
        });
        return [
            create('新建构思', ICON.newConcept, NODE_KIND.CONCEPT),
            create('新建清单', ICON.newCheck, NODE_KIND.CHECK),
            create('新建事件', ICON.newEvent, NODE_KIND.EVENT),
        ];
    }

    /** 模板操作组：存为模板 / 使用模板 */
    private templateDefs(node: TreeNode): MenuDefinition[] {
        return [
            {
                name: '存为模板',
                icon: ICON.saveAsTemplate,
                section: SECTION.template,
                action: () => void saveAsTemplate(this, node.nodeId),
            },
            {
                name: '使用模板',
                icon: ICON.useTemplate,
                section: SECTION.template,
                action: () => useTemplate(this, node.nodeId),
            },
        ];
    }

    /** 左栏空白右键：新建框架 + 从磁盘刷新 */
    private getLeftBlankMenuDefinitions(): MenuDefinitions {
        return [
            {
                name: '新建框架',
                icon: ICON.newFramework,
                section: SECTION.main,
                action: () => this.startCreateBlank(NODE_KIND.TRANS, 'left'),
            },
            {
                name: '从磁盘刷新',
                icon: ICON.syncFromFiles,
                section: SECTION.refresh,
                action: () => void this.syncFromFiles(),
            },
        ];
    }

    /** 右栏空白右键：新建三类 + 追加信息 + 批量编辑 + 从磁盘刷新 */
    private getRightBlankMenuDefinitions(): MenuDefinitions {
        const parentId = this.selectedFrameworkId ?? undefined;
        return [
            {
                name: '新建构思',
                icon: ICON.newConcept,
                section: SECTION.main,
                action: () => this.startCreateBlank(NODE_KIND.CONCEPT, 'right', parentId),
            },
            {
                name: '新建清单',
                icon: ICON.newCheck,
                section: SECTION.main,
                action: () => this.startCreateBlank(NODE_KIND.CHECK, 'right', parentId),
            },
            {
                name: '新建事件',
                icon: ICON.newEvent,
                section: SECTION.main,
                action: () => this.startCreateBlank(NODE_KIND.EVENT, 'right', parentId),
            },
            ...this.evidenceSubmenuDefs((kind) => this.startCreateBlank(kind, 'right', parentId)),
            // 根可多个（框架自身那行藏起来），应对框架内元素较多的情况
            ...(parentId
                ? [
                      {
                          name: '批量编辑',
                          icon: ICON.editFrameworkContent,
                          section: SECTION.framework,
                          action: () => editFrameworkContentAsText(this, parentId),
                      },
                  ]
                : []),
            {
                name: '从磁盘刷新',
                icon: ICON.syncFromFiles,
                section: SECTION.refresh,
                action: () => void this.syncFromFiles(),
            },
        ];
    }

    /** 框架行右键：展开/收起 + 行内新建 + 重命名 + 时间规则 + 模板 + 归档 */
    private getFrameMenuDefinitions(node: TreeNode, e: MouseEvent, side: TreeSide): MenuDefinitions {
        const addEvidence = (kind: NodeKindValue): void =>
            this.startCreateChild(this.ctxFromEvent(e, node), side, [kind]);
        return [
            ...this.expandDefs(node, side),
            ...this.newChildDefs(node, e, side),
            ...(side === 'right' ? this.rightCreateDefs(node, e) : []),
            ...(side === 'right' ? this.evidenceSubmenuDefs(addEvidence) : []),
            {
                name: '重命名',
                icon: ICON.rename,
                section: SECTION.main,
                action: () => this.startRename(node.nodeId, side),
            },
            {
                name: '时间规则',
                icon: ICON.editAttrs,
                section: SECTION.main,
                action: () => openEdit(this, node.nodeId),
            },
            {
                // 框架卡片这一项编辑的是它的**内容**（框架自身那行不出现、根可多个），
                // 与右栏空白处那条「批量编辑」是同一个入口
                name: '批量编辑',
                icon: ICON.batchEdit,
                section: SECTION.main,
                action: () => editFrameworkContentAsText(this, node.nodeId),
            },
            ...this.templateDefs(node),
            {
                name: '归档',
                icon: ICON.archive,
                section: SECTION.danger,
                action: () => archiveNode(this, node.nodeId),
            },
        ];
    }

    /**
     * 普通节点行右键：分四组 —— 结构 + 编辑 / 归属 · 命名 · 复制 · 打开 / 工具（模板、外部信息）/ 归档
     *
     * 组与组之间由装配器按 section 变化插分隔符，声明里不写分隔标记。
     * 归档独立成组：它是破坏性操作，单独隔一道线与上面的日常项分开，免得手滑点到。
     */
    private getRowMenuDefinitions(node: TreeNode, e: MouseEvent, side: TreeSide): MenuDefinitions {
        const addEvidence = (kind: NodeKindValue): void =>
            this.startCreateChild(this.ctxFromEvent(e, node), side, [kind]);
        return [
            // ── 第一组：结构 + 编辑 ──
            ...this.expandDefs(node, side),
            ...this.newChildDefs(node, e, side),
            ...this.evidenceSubmenuDefs(addEvidence),
            ...this.stateDefs(node),
            {
                name: '编辑描述',
                icon: ICON.editDesc,
                section: SECTION.main,
                action: () => this.openBodyEdit(node.nodeId),
            },
            {
                name: '时间规则',
                icon: ICON.editAttrs,
                section: SECTION.main,
                action: () => openEdit(this, node.nodeId),
            },
            {
                name: '批量编辑',
                icon: ICON.batchEdit,
                section: SECTION.main,
                action: () => editSubtreeAsText(this, node.nodeId),
            },

            // ── 第二组：归属 · 命名 · 复制 · 打开 ──
            {
                name: '变更归属',
                icon: ICON.changeParent,
                section: SECTION.meta,
                action: () => this.changeParent(node.nodeId),
            },
            {
                name: '重命名',
                icon: ICON.rename,
                section: SECTION.meta,
                action: () => this.startRename(node.nodeId, side),
            },
            {
                name: '复制子树',
                icon: ICON.copyText,
                section: SECTION.meta,
                action: () => void copySubtreeAsText(this, node.nodeId),
            },
            {
                name: '打开文件',
                icon: ICON.openFile,
                section: SECTION.meta,
                action: () => void openNodeFile(this, node.nodeId),
            },

            // ── 第三组：工具（模板与外部信息各收成一个子菜单）──
            ...this.templateGroupDefs(node),
            ...this.externalInfoDefs(node),

            // ── 第四组：归档（破坏性操作，靠上一道分隔线隔开）──
            {
                name: '归档',
                icon: ICON.archive,
                section: SECTION.danger,
                warning: true,
                action: () => archiveNode(this, node.nodeId),
            },
        ];
    }

    /** 模板组：两个模板动作用一个子菜单收拢，少占一行 */
    private templateGroupDefs(node: TreeNode): MenuDefinition[] {
        return [
            {
                name: '模板使用',
                icon: ICON.templateGroup,
                section: SECTION.tools,
                items: this.templateDefs(node),
            },
        ];
    }

    /** 外部信息组：挂一条外部链接、创建关联时间戳文档，或整理已有条目 */
    private externalInfoDefs(node: TreeNode): MenuDefinition[] {
        return [
            {
                name: '外部信息',
                icon: ICON.externalGroup,
                section: SECTION.tools,
                items: [
                    {
                        name: '添加外部信息源',
                        icon: ICON.externalGroup,
                        action: () => this.addExternalSource(node.nodeId),
                    },
                    {
                        name: '创建关联时间戳',
                        icon: 'file-plus',
                        action: () => void this.createTimestampDoc(node.nodeId),
                    },
                    {
                        name: '管理外部信息源',
                        icon: 'list-ordered',
                        action: () => this.manageExternalSources(node.nodeId),
                    },
                ],
            },
        ];
    }

    /** 状态更改子菜单：每态一个图标 + 当前状态打勾（该类型不带状态时整项不出） */
    private stateDefs(node: TreeNode): MenuDefinition[] {
        if (!kindUsesState(node.data.kind)) return [];
        const current = node.data.state ?? 'plan';
        return [
            {
                name: '状态更改',
                icon: ICON.changeState,
                section: SECTION.main,
                items: [...STATE_VALUES].map((s) => ({
                    name: NODE_STATE_LABELS[s],
                    icon: STATE_ICON[s],
                    checked: current === s,
                    action: () => setNodeState(this, node.nodeId, s),
                })),
            },
        ];
    }

    /** 状态圆点右键：完整状态菜单（单击状态圆点本身是循环切换，不经过此菜单） */
    private getStateMenuDefinitions(node: TreeNode): MenuDefinitions {
        const current = node.data.state ?? 'plan';
        return [...STATE_VALUES].map((s) => ({
            name: NODE_STATE_LABELS[s],
            icon: STATE_ICON[s],
            checked: current === s,
            section: SECTION.main,
            action: () => setNodeState(this, node.nodeId, s),
        }));
    }

    // ============================================================
    // 行内：重命名 / 新建 / 正文编辑
    // ============================================================

    /** 进入行内重命名态（由菜单「重命名」触发） */
    public startRename(nodeId: string, side: TreeSide): void {
        const data = this.pipe.GET_Node(nodeId);
        if (!data) return;
        this.rename = { nodeId, side };
        this.refresh();
    }

    private commitRename(nodeId: string, value: string): void {
        const data = this.pipe.GET_Node(nodeId);
        this.rename = null;
        if (data && value && value !== data.desc) {
            saveNodeDesc(this, buildNode(this.pipe, nodeId, data), value);
        }
        this.refresh();
    }

    private cancelRename(): void {
        this.rename = null;
        this.refresh();
    }

    /** 空白处新建（左栏空白 → 顶级框架；右栏空白 → 选中框架的直属子节点） */
    public startCreateBlank(kind: NodeKindValue, side: TreeSide, parentId?: string): void {
        const parent = parentId ?? '';
        this.creating = { parentId: parent, kinds: [kind], kind, depth: 0, side };
        this.refresh();
    }

    /** 在某个子节点的子列表末尾新建（未展开则先展开） */
    public startCreateChild(ctx: NodeLineCtx, side: TreeSide, kindsOverride?: NodeKindValue[]): void {
        const data = this.pipe.GET_Node(ctx.nodeId);
        if (!data) return;
        const kinds = kindsOverride ?? getAllowedChildKinds(data.kind);
        if (kinds.length === 0) return;
        const set = side === 'left' ? this.expandedLeft : this.expandedRight;
        set.add(ctx.nodeId);
        this.creating = { parentId: ctx.nodeId, kinds: [...kinds], kind: kinds[0], depth: ctx.depth + 1, side };
        this.refresh();
    }

    private setCreateKind(kind: NodeKindValue): void {
        if (!this.creating) return;
        this.creating = { ...this.creating, kind };
        this.refresh();
    }

    /** 行内新建：切换「连续输入」（提交后保留附加行） */
    private setCreateRepeat(repeat: boolean): void {
        if (!this.creating) return;
        this.creating = { ...this.creating, repeat };
        this.refresh();
    }

    private cancelCreate(): void {
        this.creating = null;
        this.refresh();
    }

    /** 落盘新节点（数据写在 design/actions，本类只转交意图） */
    private async commitCreate(parentId: string, kind: NodeKindValue, name: string): Promise<void> {
        const prev = this.creating;
        // 写盘期间保持画面不动：附加行不撤、缓存订阅也刷不进来（见 suppressRefresh）。
        // 数据一到就"附加行原地变成新节点"——输入行消失与新行出现落在同一次重绘里。
        this.suppressRefresh = true;
        try {
            await createNode(
                this,
                { kind, desc: name, state: 'plan', afterCreate: 'direct' },
                parentId || undefined,
                // 本类下面自己刷新一次就够；createNode 内部那两栏重绘与它重复，跳过
                { skipRender: true, side: prev?.side },
            );
        } finally {
            this.suppressRefresh = false;
        }
        this.creating = null;
        // 连续输入：按同一父级/层级/栏恢复附加行，便于逐条录入（类型以本次实际提交者为准）
        if (prev?.repeat) {
            // seq 递增 → 附加行换 key 重建：上一轮的「提交已完成」保护位与残留输入随之清掉，
            // 否则第二次回车会被组件自己拦下（附加行不再卸载，保护位不会自然失效）
            this.creating = { ...prev, kind, repeat: true, seq: (prev.seq ?? 0) + 1 };
        }
        this.refresh();
    }

    /**
     * 编辑描述：走模态框（菜单「编辑描述」的入口）
     *
     * 描述是整段 Markdown，弹窗里改比行内浮层从容；行内浮层那条链（startBodyEdit）
     * 留给行上的直接编辑入口。
     */
    private openBodyEdit(nodeId: string): void {
        const data = this.pipe.GET_Node(nodeId);
        if (!data) return;
        new TextPromptModal(this.app, {
            title: `编辑描述 · ${data.desc}`,
            desc: '节点的正文（Markdown）。留空即清空。',
            fields: [
                {
                    key: 'body',
                    label: '描述',
                    type: 'textarea',
                    value: this.pipe.GET_NodeBody(nodeId) ?? '',
                },
            ],
            confirmText: '保存',
            onConfirm: (values) => {
                saveNodeBody(this, buildNode(this.pipe, nodeId, data), values.body ?? '');
                this.refresh();
            },
        }).open();
    }

    /** 进入正文编辑态（行内浮层，见 openBodyEdit 的说明） */
    public startBodyEdit(nodeId: string): void {
        this.bodyEditing = { nodeId, value: this.pipe.GET_NodeBody(nodeId) ?? '' };
        this.refresh();
    }

    private commitBody(nodeId: string, body: string): void {
        const prev = this.bodyEditing?.value ?? '';
        const data = this.pipe.GET_Node(nodeId);
        this.bodyEditing = null;
        if (data && body !== prev) {
            saveNodeBody(this, buildNode(this.pipe, nodeId, data), body);
        }
        this.refresh();
    }

    private cancelBody(): void {
        this.bodyEditing = null;
        this.refresh();
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
