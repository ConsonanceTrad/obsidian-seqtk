/**
 * DelegateTreeController — 委托树的状态装配（共用件）
 *
 * 「委托」有两个落点，由设置项 delegateTarget 决定：
 *   - 'hub'  借用中控台侧栏容器（默认）—— 树作为一节渲染在 HubView 里
 *   - 'view' 独立视图 seqtk-delegated-tree
 *
 * 两个落点渲染的是同一棵树、同一份状态，所以状态构建与动作只写一份，放在这里；
 * 视图类只负责把 render() 的结果挂到自己的容器上。
 *
 * 树**来自哪一栏**由注入的 DelegateSource 决定（见 Special/Delegate/DelegateRegistry）：
 * 设计左栏的框架树与模板模式的模板框架树共用这套面板，差异只有三处 ——
 * 标题、就地新建的类型、行右键菜单；其余（展开 / 选中 / 行内新建与重命名 / 缓存订阅）
 * 一律共用。于是「谁在委托」是全局互斥的：本面板永远只渲染当前 active 的来源。
 *
 * 行内新建与重命名**不在这里另写一份**：本类实现 `InlineEditView`（见 design/inlineEdit），
 * 于是那套「附加行 / 行内重命名」的实现与设计视图、模板模式左栏是同一份 ——
 * 三个入口的行为不会各自漂移。本类只把「重绘一次」表达成 recompute()。
 *
 * 右键默认只开三项：新建子节点 / 重命名 / 归档 —— 都作用于**树本身**，不依赖来源视图
 * 右栏的上下文（当前选中框架、正文编辑、状态传播……）。
 * 更重的编辑仍留在各自的来源视图里：两个入口同时改同一棵树，会让「谁在编辑」变得难以预期。
 */

import { App, setIcon, setTooltip } from 'obsidian';
import { SimpleStore } from '../../../P5_Data/Svelte/SimpleStore';
import { BUILD_Menu, type MenuDefinition } from '../../../P7_Render/Composition/C3_RightClickMenu/MenuDefinition';
import { ICON, SECTION } from '../../../P7_Render/Composition/C3_RightClickMenu/MenuAppearance';
import {
    DelegatedTreePanel,
    type DelegatedTreeActions,
    type DelegatedTreeState,
} from './DelegatedTreePanel';
import {
    DELEGATE,
    type DelegateSource,
    type DelegateTreeCtx,
    type DelegateTreeHost,
} from './DelegateRegistry';
import {
    cancelCreate,
    cancelRename,
    commitCreate,
    commitRename,
    setCreateRepeat,
    startCreateBlank,
    startCreateChild,
    startRename,
    type InlineEditView,
} from '../../V1_Affair/Design/Slice/inlineEdit';
import { archiveNode, type NodeEditHost } from '../../V1_Affair/Design/Slice/actions';
import { REVEAL_SourceView } from './delegateTargets';
import { SYNC_FromFiles } from '../../V0_Common/SyncFromFiles';
import type { DataPipe } from '../../../P5_Data/CoPipe/DataPipe';
import type { PluginSettings } from '../../../P3_Settings/Settings';
import type { NodeKindValue } from '../../../P4_Nodes/NodeKind/NodeKind';
import type { NodeLineCtx } from '../../../P7_Render/Composition/C1_NodeLine/NodeLine';
import type { DesignInlineCreating, TreeSide } from '../../V1_Affair/Design/Core/DesignPanel';
import { createElement, type ReactElement } from 'react';

export class DelegateTreeController implements NodeEditHost, DelegateTreeHost, InlineEditView {
    /** 渲染件订阅的唯一状态源 */
    readonly state = new SimpleStore<DelegatedTreeState>({
        items: [],
        title: '',
        selectedId: null,
        creating: null,
        editingNodeId: null,
    });

    private unsub: (() => void) | null = null;
    private unsubData: (() => void) | null = null;

    /** 行内重命名态（InlineEditView 契约：渲染件据它给该行挂输入框覆盖层） */
    rename: { nodeId: string; side: TreeSide } | null = null;
    /** 行内新建态（InlineEditView 契约）；委托树永远是来源左栏那棵，side 恒为 'left' */
    creating: DesignInlineCreating | null = null;
    /** 写盘期间压掉重算（见 design/inlineEdit 的 commitCreate） */
    suppressRefresh = false;
    /** 本控制器不区分左右栏：满足 NodeEditHost 用的占位集合（新建一律按左栏展开） */
    private readonly rightExpanded = new Set<string>();

    constructor(
        /** 归档确认等模态框需要；与 hub / 独立视图共用同一份能力 */
        public app: App,
        public pipe: DataPipe,
        public settings: PluginSettings,
        /** 被委托的来源：树、标题、新建类型与行菜单都由它决定 */
        public source: DelegateSource,
        /** 取消委托时的回调（两个落点的收尾不同：独立视图要关自己，Hub 只是不再显示这一节） */
        private onCancel: () => void,
    ) {}

    // ── NodeEditHost：让 design/actions 的动作能在委托树里直接复用 ──

    get expandedLeft(): Set<string> {
        return this.source.expanded;
    }

    get expandedRight(): Set<string> {
        return this.rightExpanded;
    }

    renderLeft(): void {
        this.recompute();
    }

    renderRight(): void {
        this.recompute();
    }

    // ── InlineEditView：行内新建 / 重命名（本面板的「重绘一次」就是重算） ──

    refresh(): void {
        this.recompute();
    }

    // ── DelegateTreeHost：来源的菜单动作据此复用面板的就地编辑 ──

    get editHost(): NodeEditHost {
        return this;
    }

    /** 在该节点下新建子节点（类型由来源决定）：转发给共用的行内新建实现 */
    startCreateChild(ctx: NodeLineCtx): void {
        startCreateChild(this, ctx, 'left', [this.source.childKind]);
    }

    /** 在根列表末尾新建（面板空白处右键用）：与来源视图左栏的空白新建同一形态 */
    startCreateRoot(): void {
        startCreateBlank(this, this.source.childKind, 'left');
    }

    /** 进入行内重命名态：同上，一份实现三个入口共用 */
    startRename(nodeId: string): void {
        startRename(this, nodeId, 'left');
    }

    /**
     * 空白处右键：与来源视图左栏的空白菜单**同口径**
     *
     * 来源给了整份菜单就用它的；否则用默认两项 —— 新建根级节点 + 从磁盘刷新，
     * 正是设计与模板左栏空白菜单的那两项（将来别的视图若不同，在来源里给 blankMenu）。
     */
    blankContextMenu(e: MouseEvent): void {
        if (this.source.blankMenu) {
            this.source.blankMenu(this, e);
            return;
        }
        const defs: MenuDefinition[] = [
            {
                name: `新建${this.source.title}`,
                icon: ICON.newFramework,
                section: SECTION.main,
                action: () => this.startCreateRoot(),
            },
            {
                name: '从磁盘刷新',
                icon: ICON.syncFromFiles,
                section: SECTION.refresh,
                action: () => void SYNC_FromFiles(this.pipe),
            },
        ];
        BUILD_Menu(defs, e);
    }

    /** 挂上订阅并首算；重复调用无副作用 */
    start(): void {
        if (this.unsub) return;
        // 本面板存在本身就是「已委托」的证据：工作区恢复出的面板不会经过打开命令，
        // 登记处里还没有记录，这里补上（同来源幂等，不会打断已有的委托）
        if (DELEGATE.active !== this.source) DELEGATE.acquire(this.source);
        // 来源状态（展开 / 选中，本面板或来源视图发起）→ 重算
        this.unsub = this.source.subscribe(() => this.recompute());
        // 活跃缓存（节点新建 / 改名 / 删除）→ 重算；两者分工不同，都要订阅
        this.unsubData = this.pipe.SUB_ActiveView(() => this.recompute());
        this.recompute();
    }

    stop(): void {
        this.unsub?.();
        this.unsub = null;
        this.unsubData?.();
        this.unsubData = null;
    }

    /** 待渲染的 React 树（两个落点共用同一份装配） */
    render(): ReactElement {
        return createElement(DelegatedTreePanel, {
            store: this.state,
            actions: {
                onToggle: (ctx) => this.toggleExpand(ctx),
                onSelect: (ctx) => {
                    this.source.setSelectedId(ctx.nodeId);
                    // 行末「在右侧打开」：把焦点移回来源视图（没开着就打开）——
                    // 面板里这棵树只是它的镜像，用户要看的是那个有两栏的完整视图。
                    // 来源没报 viewType 时退化成只选中（见 DelegateSource.viewType）
                    if (this.source.viewType) REVEAL_SourceView(this.app, this.source.viewType);
                },
                onCancelDelegate: () => this.onCancel(),
                onContextMenu: (ctx, e) => this.showRowMenu(ctx, e),
                // 空白处右键：与来源视图左栏的空白菜单同口径（见 blankContextMenu）
                onBlankContextMenu: (e) => this.blankContextMenu(e),
                onCreateCommit: (parentId: string, kind: NodeKindValue, name: string) =>
                    void commitCreate(this, parentId, kind, name),
                onCreateCancel: () => cancelCreate(this),
                onRepeatChange: (repeat: boolean) => setCreateRepeat(this, repeat),
                onInlineCommit: (ctx, value) => commitRename(this, ctx.nodeId, value),
                onInlineCancel: () => cancelRename(this),
            } satisfies DelegatedTreeActions,
            host: { setTooltip, setIcon },
        });
    }

    /**
     * 行右键
     *
     * 来源给了整份菜单就用它的（如模板那几项）；否则用默认三项 ——
     * 三项都作用于树本身，不依赖来源视图的右栏上下文。
     */
    private showRowMenu(ctx: NodeLineCtx, e: MouseEvent): void {
        if (this.source.rowMenu) {
            this.source.rowMenu(this, ctx, e);
            return;
        }
        const defs: MenuDefinition[] = [
            {
                name: `新建子${this.source.title}`,
                icon: ICON.newFramework,
                section: SECTION.main,
                action: () => this.startCreateChild(ctx),
            },
            {
                name: '重命名',
                icon: ICON.rename,
                section: SECTION.main,
                action: () => this.startRename(ctx.nodeId),
            },
            {
                name: '归档',
                icon: ICON.archive,
                section: SECTION.danger,
                action: () => archiveNode(this, ctx.nodeId),
            },
        ];
        BUILD_Menu(defs, e);
    }

    recompute(): void {
        if (this.suppressRefresh) return;
        const ctx: DelegateTreeCtx = {
            pipe: this.pipe,
            settings: this.settings,
            overlayFor: (nodeId) => ({ editing: this.rename?.nodeId === nodeId }),
        };
        this.state.set({
            items: this.source.buildItems(ctx),
            title: this.source.title,
            emptyText: this.source.emptyText(ctx),
            selectedId: this.source.getSelectedId(),
            creating: this.creating,
            editingNodeId: this.rename?.nodeId ?? null,
        });
    }

    /** 展开/收起（来源的共享集合，来源视图会同步） */
    private toggleExpand(ctx: NodeLineCtx): void {
        const set = this.source.expanded;
        if (set.has(ctx.nodeId)) set.delete(ctx.nodeId);
        else set.add(ctx.nodeId);
        // 广播：本面板与来源视图各自重算
        this.source.markExpandedChanged();
    }
}
