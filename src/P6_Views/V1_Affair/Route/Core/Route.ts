/**
 * RouteView — 事务设计 · 线路模式
 *
 * 双栏：左栏框架树（与事务设计左栏同一套渲染与交互），右栏「双向追索的关联树」。
 * - 左栏：框架树，点击选中 → 右栏以它为中心追索上下游；宽度可拖、记进设置
 * - 右栏：根是选中框架，向上展开「谁指向它（那一个又指向谁…）」、向下展开
 *   「它指向谁（那一个又指向谁…）」，每个节点带上自己的直接证据。价值正在长链上 ——
 *   根与某个深层节点之间没有直接边，那条路径本身就是那层隐性关联
 *
 * 为什么不是画布：线路的本质是拓扑（From/To + 描述），画布管的是几何（方块放哪儿），
 * 两者本没有关系 —— 维持位置成了纯负担，而描述又是这条功能一半的价值。详见
 * Slice/routeTree 的说明。
 *
 * 左栏与事务设计左栏**共用同一套实现**，不是照着抄一份：
 * - 渲染与数据链：design/Tool/tree 与 viewModel（buildFrameworkTree / buildTreeItems /
 *   buildFrameLine），样式由 NodeTreePane 统一
 * - 交互：本类实现 TreeEditHost（拖拽改归属 / 排序）与 MenuHost（右键菜单、行内新建、
 *   重命名、编辑正文），于是 design/Slice 那几支切片直接作用在这里
 * - 状态：展开与选中都放在本视图自己的共享状态源里（Slice/RouteTreeShared）——
 *   与设计那棵树的**同名但不同实例**，两处的「在看哪一层」互不串味；放模块级是为了
 *   委托出去后能与侧栏面板共用同一份
 *
 * 逻辑与渲染分离：本文件持有数据与操作，RoutePanel.tsx 只负责渲染，不 import obsidian。
 * 数据面（见 P6_Views/Views.md 边界判据）：读写一律经 DataPipe 门面。
 */

import { createElement, type ReactNode } from "react";
import { App, Menu, Modal, Notice, Setting, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import { AutoView } from "../../../../P1_Register/View";
import { AutoRegister } from "../../../../P1_Register/Comd";
import { ReactViewBase } from "../../../../P0_UI/ViewBase";
import { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";
import { NODE_KIND } from "../../../../P4_Nodes/NodeKind/NodeKind";
import { NODE_KIND_LABELS } from "../../../../P4_Nodes/NodeKind/NodeLabel";
import { NodePickModal } from "../../../../P7_Render/Structure/S2_Modal/NodePickModal";
import { TransactionCreateModal } from "../../../../P7_Render/Structure/S2_Modal/TransactionModals";
import { buildFrameworkTree } from "../../Design/Tool/tree";
import { buildFrameLine, buildTreeItems } from "../../Design/Tool/viewModel";
import { onDragEnd, onDragLeave, onDragOver, onDragStart, onDrop } from "../../Design/Slice/dragHandlers";
import { showRowContextMenu } from "../../Design/Slice/menuDefinitions";
import {
    cancelBody,
    cancelCreate,
    cancelRename,
    commitBody,
    commitCreate,
    commitRename,
    setCreateKind,
    setCreateRepeat,
} from "../../Design/Slice/inlineEdit";
import { DELEGATE } from "../../../Special/Delegate/DelegateRegistry";
import { START_Delegate } from "../../../Special/Delegate/delegateTargets";
import { SET_RowMenu } from "../../../Special/Delegate/rowMenuRegistry";
import { ROUTE_DELEGATE, ROUTE_TREE } from "../Slice/RouteTreeShared";
import { BUILD_RouteTree, COLLECT_TreeIds } from "../Slice/routeTree";
import { RoutePanel, type RouteState } from "./RoutePanel";
import { Save_Setting } from "../../../../P3_Settings/Settings";
import type SeqtkPlugin from "../../../../main";
import type { PanelEntry } from "../../../panelRegistry";
import type { DataPipe } from "../../../../P5_Data/CoPipe/DataPipe";
import type { PluginSettings } from "../../../../P3_Settings/Settings";
import type { NodeKindValue } from "../../../../P4_Nodes/NodeKind/NodeKind";
import type { SeqtkNode } from "../../../../P4_Nodes/Node";
import type { DragSource } from "../../../../P7_Render/Composition/C2_Tree/drag";
import type { NodeLineCtx } from "../../../../P7_Render/Composition/C1_NodeLine/NodeLine";
import type { DesignInlineCreating } from "../../Design/Core/DesignPanel";
import type { MenuHost } from "../../Design/Slice/menuHost";

export const VIEW_TYPE_ROUTE = 'seqtk-route';

/** 左栏宽度范围（px）：与事务设计左栏同一组取值，两处手感才一致 */
export const ROUTE_LEFT_WIDTH_MIN = 160;
export const ROUTE_LEFT_WIDTH_MAX = 640;
export const ROUTE_LEFT_WIDTH_DEFAULT = 280;

/** 会话状态（宽度 / 展开 / 选中）写回的防抖等待；与设计视图的取值取齐 */
const PERSIST_DEBOUNCE_MS = 600;

/** route 关联描述输入弹窗（本视图专用） */
class RouteDescModal extends Modal {
    constructor(
        app: App,
        private opts: {
            title: string;
            fromDesc: string;
            toDesc: string;
            /** 已有描述（改描述时带入；新建时省略） */
            initial?: string;
            onConfirm: (desc: string) => void;
        },
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.setTitle(this.opts.title);
        contentEl.createEl('div', { cls: 'seqtk-empty', text: `${this.opts.fromDesc} → ${this.opts.toDesc}` });
        const ta = contentEl.createEl('textarea', {
            cls: 'seqtk-body-input',
            attr: { rows: '3', placeholder: '关联描述…' },
        });
        ta.value = this.opts.initial ?? '';
        new Setting(contentEl).addButton((b) => {
            b.setButtonText('确认').setCta().onClick(() => {
                // 描述允许留空 —— 强制写一句会逼人造字，而「还没想好」是常见状态
                this.opts.onConfirm(ta.value.trim());
                this.close();
            });
        }).addButton((b) => {
            b.setButtonText('取消').onClick(() => this.close());
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/** 确认弹窗（本视图专用） */
class RouteConfirmModal extends Modal {
    constructor(
        app: App,
        private opts: { title: string; message: string; onConfirm: () => void },
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.setTitle(this.opts.title);
        contentEl.createEl('p', { text: this.opts.message });
        new Setting(contentEl).addButton((b) => {
            b.setButtonText('确认').setCta().onClick(() => {
                this.opts.onConfirm();
                this.close();
            });
        }).addButton((b) => {
            b.setButtonText('取消').onClick(() => this.close());
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

@AutoView()
@AutoRegister()
export class RouteView extends ReactViewBase implements MenuHost {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_ROUTE, title: '线路模式', icon: 'route', description: '项目线路图：框架间隐性关联（From/To + 描述）与复合进度信息输出。', category: '事务设计'},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): RouteView {
        return new RouteView(
            leaf,
            plugin.allDeps.dataPipe,
            plugin.allDeps.settings,
            // 写盘回调：视图类不直接依赖插件实例（与模板视图同一写法）
            () => void Save_Setting(plugin),
        );
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-route',
            name: '打开线路模式',
            callback: () => plugin.activateView(VIEW_TYPE_ROUTE),
        });
    }

    private unsub: (() => void) | null = null;
    private unsubShared: (() => void) | null = null;
    /**
     * 左栏展开集合 —— 指向共享状态源（Slice/RouteTreeShared）
     *
     * 与设计视图左栏**各自一份实例**：两处的树虽然同源，但「在看哪一层」是各自的观察状态，
     * 共用会让在一个视图里展开的枝干莫名其妙地出现在另一个视图里。
     * 之所以仍放模块级，是为了委托出去后与侧栏面板共用（那才是同一处观察）。
     */
    public readonly expandedLeft = ROUTE_TREE.expandedLeft;
    /**
     * 右栏展开集合 —— 本视图没有右栏树，给一个占位集合满足 NodeEditHost
     *
     * 跨父移动后 drag.ts 会往它里面 add 新父；这里收下即可，没有渲染消费它。
     */
    public readonly expandedRight = new Set<string>();
    /** 左栏宽度（px） */
    private leftWidth = ROUTE_LEFT_WIDTH_DEFAULT;

    // ── NodeEditHost / TreeEditHost / MenuHost（见 Design/Slice 下的 actions /
    //    inlineEdit / treeEditHost / menuHost）──
    // 实现这些成员，design 那几支切片就能直接作用在本视图左栏上，不必另写一份 ——
    // 那是「仿照事务设计」最省、也最不容易走样的做法。

    /** 顶级顺序的读写走设置（视图侧不自己存） */
    public get topOrder(): string[] {
        return this.settings.topFrameworkOrder ?? [];
    }

    public set topOrder(order: string[]) {
        this.settings.topFrameworkOrder = order;
    }

    /** 顶级顺序变更 → 落盘（与设计视图同一个回调位） */
    public onTopOrderChange = (order: string[]): void => {
        this.settings.topFrameworkOrder = order;
        this.persistSettings?.();
    };

    /** 拖拽源（dragstart 写入、dragend 清空） */
    public dragSource: DragSource | null = null;
    /** 正在拖拽的行 */
    public draggingId: string | null = null;

    /** 本视图只有左栏（右栏是只读的追索树），两栏重渲是同一件事 */
    public renderLeft = (): void => this.recompute();
    public renderRight = (): void => this.recompute();
    public refresh = (): void => this.recompute();

    // ── 行内编辑态（InlineEditView / BodyEditHost 要求，由 design/inlineEdit 读写）──

    /** 行内重命名态（哪一行正在改名）；side 恒为 'left' —— 本视图只有一棵树 */
    public rename: { nodeId: string; side: 'left' } | null = null;
    /** 行内新建态（附加行插在哪个父节点下） */
    public creating: DesignInlineCreating | null = null;
    /** 行内正文编辑态（哪一行正在改正文） */
    public bodyEditing: { nodeId: string; value: string } | null = null;
    /** 写盘期间压掉重绘（见 design/inlineEdit 的 commitCreate） */
    public suppressRefresh = false;

    /**
     * 右栏内下钻的来路栈 —— 本视图的右栏是追索树、没有「下钻」，故恒为空
     *
     * 由 MenuHost 要求（design/navigation 会读它）。给空数组而不是省略：省略就不满足接口，
     * 而那会让本视图连菜单都挂不上；空栈的语义是准确的 —— 这里确实没有来路可回。
     */
    public frameworkNavStack: string[] = [];

    /** NodeEditHost / MenuHost 要的选中框架 —— 本视图的选中就是追索树的根（存于共享状态源） */
    public get selectedFrameworkId(): string | null {
        return ROUTE_TREE.selectedId;
    }

    public set selectedFrameworkId(v: string | null) {
        ROUTE_TREE.selectedId = v;
    }

    /** 宽度写回的防抖计时器 */
    private persistTimer: number | null = null;
    /** 渲染件订阅的唯一状态源 */
    private readonly state = new SimpleStore<RouteState>({
        initializing: true,
        leftItems: [],
        leftWidth: ROUTE_LEFT_WIDTH_DEFAULT,
        selectedId: null,
        delegated: false,
        creating: null,
        bodyEditing: null,
        tree: null,
    });

    constructor(
        leaf: WorkspaceLeaf,
        // public：NodeEditHost 要求（见 Design/Slice/actions）—— 复用的那套动作要读它
        public pipe: DataPipe,
        public settings: PluginSettings,
        /** 把设置写回磁盘（由装配层注入，视图类不直接依赖插件实例） */
        private persistSettings?: () => void,
    ) {
        super(leaf);
        this.leftWidth = this.settings.routeLeftPaneWidth || ROUTE_LEFT_WIDTH_DEFAULT;
    }

    getViewType(): string {
        return VIEW_TYPE_ROUTE;
    }

    getDisplayText(): string {
        return '线路模式';
    }

    getIcon(): string {
        return 'route';
    }

    /** 渲染件在 RoutePanel.tsx；视图类不写 JSX 字面量（见 P6_Views/Views.md 契约） */
    protected renderPanel(): ReactNode {
        return createElement(RoutePanel, {
            state: this.state,
            // 行组件靠它画图标与 tooltip（与设计视图同一个注入点）
            host: { setTooltip, setIcon },
            /**
             * 左栏行行为
             *
             * 拖拽与行内编辑那一组直接转交 design 的切片（本视图实现了 TreeEditHost /
             * MenuHost，所以能复用）—— 不在这里另写一份判定与落盘，「仿照事务设计」靠的
             * 就是共用同一套实现。
             */
            leftActions: {
                onToggle: (ctx) => {
                    if (this.expandedLeft.has(ctx.nodeId)) this.expandedLeft.delete(ctx.nodeId);
                    else this.expandedLeft.add(ctx.nodeId);
                    ROUTE_TREE.markExpandedChanged();
                    this.recompute();
                },
                // 行末按钮在事务设计里是「在右侧打开」；本视图的右栏就是追索树，语义正好相接
                onSelect: (ctx) => {
                    ROUTE_TREE.selectedId = ctx.nodeId;
                    this.recompute();
                },
                onContextMenu: (ctx, e) => this.showRowContextMenu(ctx, e),
                // 状态圆点不接动作：本视图关心的是框架之间的线路拓扑，状态在事务设计那边改。
                // 圆点本身仍会显示（行组件按 state 画），只是点它不响应。
                // 行内重命名
                onInlineCommit: (ctx, value) => commitRename(this, ctx.nodeId, value),
                onInlineCancel: () => cancelRename(this),
                // 行内新建（附加行）
                onCreateCommit: (parentId, kind, name) => void commitCreate(this, parentId, kind, name),
                onCreateCancel: () => cancelCreate(this),
                onCreateKindChange: (_parentId, kind) => setCreateKind(this, kind),
                onCreateRepeatChange: (_parentId, repeat) => setCreateRepeat(this, repeat),
                // 行内正文编辑
                onBodyCommit: (nodeId, body) => commitBody(this, nodeId, body),
                onBodyCancel: () => cancelBody(this),
                // 拖拽改归属 / 排序
                onDragStart: (ctx, e) => onDragStart(this, ctx, e),
                onDragEnd: (_ctx, _e) => onDragEnd(this),
                onDragOver: (ctx, e) => onDragOver(this, ctx, 'left', e),
                onDragLeave: (_ctx, e) => onDragLeave(this, e),
                onDrop: (ctx, e) => onDrop(this, ctx, 'left', e),
            },
            onFrameAreaContextMenu: (e: globalThis.MouseEvent) => this.showFrameBlankMenu(e),
            onToggleDelegate: () => this.toggleDelegate(),
            onAddUpstream: () => this.addUpstream(),
            onAddDownstream: () => this.addDownstream(),
            onEditRoute: (fromId: string, toId: string) => this.editRoute(fromId, toId),
            onRemoveRoute: (fromId: string, toId: string) => this.removeRoute(fromId, toId),
            onWidthChange: (width: number) => this.setLeftWidth(width),
        });
    }

    protected onMounted(): void {
        // 缓存一变就重算：树上任何一环都可能因别处的改动而变（改名、删除、新建线路）
        this.unsub = this.pipe.SUB_ActiveView(() => this.recompute());
        // 告知线路来源「本视图是哪个 viewType」：委托面板里点行末的「在右侧打开」
        // 靠它把焦点移回本视图（见 DelegateSource.viewType 与 REVEAL_SourceView）
        ROUTE_DELEGATE.viewType = VIEW_TYPE_ROUTE;
        // 恢复上次的打开位置：选中的框架、左栏展开集合（宽度在构造里已恢复）。
        // 与设计 / 模板视图同一套做法 —— 位置是会话状态，重开库应回到关库前看到的地方。
        // 放在订阅之前：先摆好位置，第一次算视图状态时就已经是恢复后的样子
        // 共享源里已有选中时不覆盖 —— 同 Design.ts 该处的说明（从委托面板跳过来时会用到）
        if (!ROUTE_TREE.selectedId && this.settings.routeSelectedId) {
            ROUTE_TREE.selectedId = this.settings.routeSelectedId;
        }
        this.expandedLeft.clear();
        for (const id of this.settings.routeExpandedIds ?? []) this.expandedLeft.add(id);
        ROUTE_TREE.markExpandedChanged();
        // 「上次的委托意图」交给共享状态源：启动瞬间登记处还是空的，只看它左栏会先按
        // 未委托铺出来、随后才跳到委托态。`!settled` 不可省 —— 恢复一旦落定，settings 里
        // 那个来源就已经是「上次的历史」，再拿它当意图会把已取消的委托又假装成待恢复
        this.syncPendingDelegated();
        // 行菜单的装配器登记到 rowMenuRegistry（按来源分槽）：委托后这棵树渲染在中控台里，
        // 那边没有本视图实例，靠它才能用上与左栏**同一套**菜单
        SET_RowMenu('route', (ctx, e) => this.showRowContextMenu(ctx, e));
        // 共享状态变了要重算，**并顺手把位置落盘**（展开 / 选中都是会话状态）：
        // 从委托面板那侧取消委托时，本视图的 stateStore 不会变，左栏与把手就一直不回来
        // （开关藏在共享状态里）。顺带把意图**重新同步**一次 —— 共享状态变化也可能是
        // main 作废了上次的意图；漏掉这一步，左栏会一直让着位，表现就是「委托恢复不回来」
        this.unsubShared = ROUTE_TREE.store.subscribe(() => {
            this.syncPendingDelegated();
            this.schedulePersist();
            this.recompute();
        });
        this.recompute();
    }

    /**
     * 把「上次的委托意图」同步给共享状态源
     *
     * 两处调用：挂载时、以及共享状态每次变化时（后者见 onMounted 的说明）。
     * 抽成一个方法，是为了让这两处**必然**用同一套判据 —— 先前正是漏掉了其中一处。
     */
    private syncPendingDelegated(): void {
        ROUTE_TREE.SET_PendingDelegated(
            this.settings.delegatedOwner === 'route' && !DELEGATE.settled,
        );
    }

    protected onBeforeUnmount(): void {
        this.unsub?.();
        this.unsub = null;
        this.unsubShared?.();
        this.unsubShared = null;
        // 摘掉本视图那一槽的菜单装配器：本视图已不在，委托面板若还挂着就退回默认三项，
        // 而不是去调用一个指向已关闭视图的装配器（只影响 route 那一槽）
        SET_RowMenu('route', null);
        // 关视图前把最后一次会话变更落盘（防抖可能还没到点）
        this.FLUSH_Session();
    }

    /**
     * 防抖写回会话状态
     *
     * 展开与选中会连着变（铺开一枝、逐层下钻），每次都落盘没有必要；
     * 关库那一次由 FLUSH_Session 兜底（见 main.onunload）。
     */
    private schedulePersist(): void {
        if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
        this.persistTimer = window.setTimeout(() => {
            this.persistTimer = null;
            this.FLUSH_Session();
        }, PERSIST_DEBOUNCE_MS);
    }

    /**
     * 立刻把会话状态写回设置（不防抖）—— 供插件卸载时调用
     *
     * 三项都在这里：左栏宽度、左栏展开集合、选中的框架。它们的写回有防抖，而关库时
     * Obsidian 直接卸载插件，onBeforeUnmount 未必被调用，最后一次变更就可能丢掉，
     * 所以 main.onunload 会显式喊一声（与设计 / 模板视图同一做法）。
     * 委托状态**不在这里** —— 它是全局的，由 Special/Delegate/DelegateSession 统一落盘。
     */
    public FLUSH_Session(): void {
        if (this.persistTimer !== null) {
            window.clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
        this.settings.routeLeftPaneWidth = this.leftWidth;
        this.settings.routeExpandedIds = [...this.expandedLeft];
        this.settings.routeSelectedId = ROUTE_TREE.selectedId;
        this.persistSettings?.();
    }

    // ============================================================
    // 状态重算（左栏框架树 + 右栏追索树）
    // ============================================================

    private recompute(): void {
        // 写盘期间压掉重绘：行内新建提交后由 design/inlineEdit 统一刷一次 ——
        // 附加行原地变成新节点、与缓存变更落在同一次重绘里（见 commitCreate 的说明）
        if (this.suppressRefresh) return;
        const fwId = ROUTE_TREE.selectedId;
        const ready = this.pipe.isInitialized;
        const renamingId = this.rename?.nodeId;

        // 左栏与事务设计左栏走同一条渲染链，样式与行为因此天然一致
        const roots = buildFrameworkTree(this.pipe, this.settings.topFrameworkOrder ?? []);
        const leftItems = buildTreeItems(this.pipe, '', roots, this.expandedLeft, (node, flags) =>
            buildFrameLine(
                this.pipe,
                node,
                flags,
                fwId === node.nodeId,
                // 行覆盖信息：正在改名的那一行换成输入框；拖拽态由 draggingId 表达
                { editing: renamingId === node.nodeId, dragging: this.draggingId === node.nodeId },
            ),
        );

        this.state.set({
            initializing: !ready,
            leftItems,
            leftEmpty: roots.length === 0 ? '暂无框架，右键空白处新建' : undefined,
            leftWidth: this.leftWidth,
            selectedId: fwId,
            delegated: ROUTE_TREE.delegated,
            // 行内编辑的两个态透传给 NodeTreePane —— 它据此渲染附加行与正文浮层
            creating: this.creating,
            bodyEditing: this.bodyEditing,
            rightEmpty: ready && !fwId ? '请在左侧选择框架' : undefined,
            tree: ready && fwId ? BUILD_RouteTree(this.pipe, fwId) : null,
        });
    }

    /**
     * 左栏宽度变更
     *
     * 拖动期间先只改内存与视图（每帧落盘会拖慢手感），停手后再走统一的防抖写回。
     */
    private setLeftWidth(width: number): void {
        this.leftWidth = Math.min(Math.max(width, ROUTE_LEFT_WIDTH_MIN), ROUTE_LEFT_WIDTH_MAX);
        this.state.set({ ...this.state.get(), leftWidth: this.leftWidth });
        this.schedulePersist();
    }

    // ============================================================
    // 左栏：框架区
    // ============================================================

    /**
     * 委托左栏框架树到中控台侧栏（进行 / 取消）
     *
     * 与 design/navigation.toggleDelegate 同名同语义，只有来源不同 —— 那边硬编码 'design'，
     * 而这里要的是 'route'、且判定走 ROUTE_TREE 而不是 FRAMEWORK_TREE。所以本视图自己写
     * 这三行，而不是去改那个共用函数（它服务于设计视图的语义，加参数只会让两边都变模糊）。
     */
    private toggleDelegate(): void {
        if (ROUTE_TREE.delegated) DELEGATE.release('route');
        else START_Delegate(this.app, this.settings, 'route');
        this.recompute();
    }

    /**
     * 行右键菜单
     *
     * 复用事务设计那套声明（design/menuDefinitions）—— 本视图的菜单**就是**那一套。
     * side 传 'left'：本视图只有左栏是可编辑的树，右栏是只读的追索树，
     * 按左栏取才能拿到「展开/收起 + 追加子框架 + 重命名 + 属性更改 + 批量编辑 + 模板 + 归档」。
     */
    private showRowContextMenu(ctx: NodeLineCtx, e: MouseEvent): void {
        showRowContextMenu(this, ctx, 'left', e);
    }

    private showFrameBlankMenu(e: MouseEvent): void {
        const menu = new Menu();
        menu.addItem((item) =>
            item.setTitle('新建事务框架').setIcon('folder-plus')
                .onClick(() => this.createFramework(NODE_KIND.TRANS)));
        menu.addItem((item) =>
            item.setTitle('新建信息框架').setIcon('folder-plus')
                .onClick(() => this.createFramework(NODE_KIND.INFO)));
        menu.showAtMouseEvent(e);
    }

    private createFramework(kind: NodeKindValue): void {
        new TransactionCreateModal(this.app, {
            kinds: [kind],
            onSubmit: (input) => {
                const now = new Date().toISOString();
                const data = {
                    kind: input.kind,
                    desc: input.desc,
                    open: true,
                    state: 'plan',
                    create: now,
                    modify: now,
                } as SeqtkNode;
                void this.pipe.EXEC_Create({ kind: input.kind, data })
                    .catch((err) => {
                        console.error('[SeqTK] 新建框架失败:', err);
                        new Notice('新建框架失败，请查看控制台');
                    });
            },
        }).open();
    }

    // ============================================================
    // 线路的增 / 改 / 删
    // ============================================================

    /**
     * 挑一个框架，然后在这两个框架之间建（或改）一条线路
     *
     * 两个方向的入口只差「本框架站在边的哪一端」，所以选择逻辑合成一处 ——
     * 候选范围与排除项都相同，只是 onPick 里组出 (from, to) 的方向不同。
     */
    private pickRoutePeer(selfId: string, selfIsTo: boolean): void {
        // 排除**整棵链路上**的框架，而不只是直接相连的那些：链路深处的框架同样已经在这张图里，
        // 再连一条只会把链条绕回自身。根也在集合内，所以自身顺带被排除。
        const tree = BUILD_RouteTree(this.pipe, selfId);
        const onChain = tree ? COLLECT_TreeIds(tree) : new Set<string>([selfId]);

        new NodePickModal(this.app, this.pipe, {
            title: selfIsTo ? '新建上游线路 · 选择来源框架' : '新建下游线路 · 选择目标框架',
            excludeIds: [...onChain],
            // 候选只留事务框架：线路图描述的是框架之间的关联，信息框架与模板框架不参与
            allow: (_id, kind) => kind === NODE_KIND.TRANS,
            emptyText: selfIsTo
                ? '没有可作为来源的框架（已在链路上的已排除）'
                : '没有可作为目标的框架（已在链路上的已排除）',
            onPick: (peerId: string) =>
                this.editRoute(selfIsTo ? peerId : selfId, selfIsTo ? selfId : peerId),
        }).open();
    }

    /** 新建上游线路：别的框架 → 本框架 */
    private addUpstream(): void {
        const selfId = ROUTE_TREE.selectedId;
        if (selfId) this.pickRoutePeer(selfId, true);
    }

    /** 新建下游线路：本框架 → 别的框架 */
    private addDownstream(): void {
        const selfId = ROUTE_TREE.selectedId;
        if (selfId) this.pickRoutePeer(selfId, false);
    }

    /** 改（或首次填写）一条线路的描述 */
    private editRoute(fromId: string, toId: string): void {
        const from = this.pipe.GET_Node(fromId);
        const to = this.pipe.GET_Node(toId);
        if (!from || !to) return;
        const initial = from.routes?.find((r) => r.toId === toId)?.desc ?? '';
        new RouteDescModal(this.app, {
            title: initial ? '修改线路描述' : '建立线路关联',
            fromDesc: from.desc,
            toDesc: to.desc,
            initial,
            onConfirm: (desc) => this.setRoute(fromId, toId, desc),
        }).open();
    }

    /**
     * 写一条线路关联（新建或改描述）
     *
     * 走**普通字段更新**而不是专门的 route 写意图：routes 是源框架 frontmatter 里的一个字段
     * （见 AttriGroup/Route），于是它自动获得 update 的全部能力 —— 落盘、防回环登记、
     * 缓存与文件两侧一致，不必再开一条只走缓存的通道。
     *
     * 读-改-写在这里是安全的：JS 单线程，两次读取之间不会有别的改这条 routes 的机会。
     * 描述留空时省掉 desc 键（而不是写空串），frontmatter 里更干净。
     */
    private setRoute(fromId: string, toId: string, desc: string): void {
        const from = this.pipe.GET_Node(fromId);
        if (!from) return;
        const routes = [...(from.routes ?? [])];
        const next = desc ? { toId, desc } : { toId };
        const i = routes.findIndex((r) => r.toId === toId);
        if (i >= 0) routes[i] = next;
        else routes.push(next);
        this.pipe.EXEC_Mutation({
            op: 'update',
            kind: from.kind,
            nodeId: fromId,
            updates: { routes, modify: new Date().toISOString() },
        });
    }

    /** 删一条线路关联：把目标从源框架的 routes 里摘掉 */
    private removeRoute(fromId: string, toId: string): void {
        const from = this.pipe.GET_Node(fromId);
        if (!from) return;
        const toDesc = this.pipe.GET_Node(toId)?.desc ?? toId;
        new RouteConfirmModal(this.app, {
            title: '删除线路关联',
            message: `确认删除「${from.desc}」到「${toDesc}」的线路关联？`,
            onConfirm: () => {
                this.pipe.EXEC_Mutation({
                    op: 'update',
                    kind: from.kind,
                    nodeId: fromId,
                    updates: {
                        routes: (from.routes ?? []).filter((r) => r.toId !== toId),
                        modify: new Date().toISOString(),
                    },
                });
            },
        }).open();
    }
}
