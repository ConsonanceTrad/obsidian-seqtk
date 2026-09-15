/**
 * RouteView — 事务设计 · 线路模式
 *
 * 双栏：左栏框架选择区，右栏线路图白板。
 * - 左栏：事务框架/信息框架列表；点击选中 → 右栏显示选中框架 + 已建立
 *   route 线路关联的其他框架树；右键非选中框架 → 临时渲染到画布（本次打开中）
 *   以便手动关系连线；左栏空白右键 → 新建框架
 * - 右栏：白板显示选中/关联/临时框架及其事务树（follows 树边只读）+
 *   route 线路关联（From/To + 描述，连线模式可编辑）
 * - 布局：层级方块（子孙紧邻父级）+ 拖动父节点子树跟随
 * - 复合信息：面板侧边展示选中框架子树状态聚合
 *
 * 逻辑与渲染分离：本文件持有 CanvasBoard、订阅活跃缓存、全部数据与画布操作；
 * RoutePanel.tsx 只负责左栏列表与右栏外壳，不 import obsidian、不碰数据层。
 *
 * 数据面（见 P6_Views/Views.md 边界判据）：读写一律经 **DataPipe** 门面
 * （`GET_*` / `EXEC_Mutation` / `EXEC_Create` / `SUB_ActiveView` / `READ_DataFile`），
 * 视图不再直连 nodeCache / fileManager / operationQueue。
 */

import { createElement, type ReactNode } from "react";
import { App, Menu, Modal, Notice, Setting, type WorkspaceLeaf } from "obsidian";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";
import { IS_KindOfCategory, NODE_KIND } from "../../P4_Nodes/NodeKind/NodeKind";
import { NODE_KIND_LABELS } from "../../P4_Nodes/NodeKind/NodeLabel";
import { CanvasBoard, type BoardEdge, type BoardLayout, type BoardPositions } from "../../P7_Render/Structure/S3_Board/CanvasBoard";
import { TransactionCreateModal } from "../../P7_Render/Structure/S2_Modal/TransactionModals";
import { TextPromptModal } from "../../P7_Render/Structure/S2_Modal/TextPromptModal";
import { GET_FileByPath } from "../../P5_Data/MdFile/PathTools/PathParse";
import { RoutePanel, type RouteFrameRow, type RouteState } from "./RoutePanel";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { DataPipe } from "../../P5_Data/CoPipe/DataPipe";
import type { PluginSettings } from "../../P3_Settings/Settings";
import type { NodeKindValue } from "../../P4_Nodes/NodeKind/NodeKind";
import type { SeqtkNode } from "../../P4_Nodes/Node";

export const VIEW_TYPE_ROUTE = 'seqtk-route';

/** 事务类型（树中展示） */
const TXN_KINDS: NodeKindValue[] = [
    NODE_KIND.CONCEPT, NODE_KIND.CHECK, NODE_KIND.ITEM, NODE_KIND.EVENT,
];

/** 布局缓存文件（存放于插件用户数据文件夹 rootFolder 下） */
const LAYOUT_CACHE_FILE = 'layout-cache.json';

/** 框架类节点判定 */
function isFrameworkKind(kind: NodeKindValue): boolean {
    return IS_KindOfCategory(kind, 'FRAMEWORK');
}

/** route 关联描述输入弹窗（本视图专用） */
class RouteDescModal extends Modal {
    constructor(
        app: App,
        private opts: { fromDesc: string; toDesc: string; onConfirm: (desc: string) => void },
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.setTitle('建立线路关联');
        contentEl.createEl('div', { cls: 'seqtk-empty', text: `${this.opts.fromDesc} → ${this.opts.toDesc}` });
        const ta = contentEl.createEl('textarea', { cls: 'seqtk-body-input', attr: { rows: '3', placeholder: '关联描述…' } });
        new Setting(contentEl).addButton((b) => {
            b.setButtonText('确认').setCta().onClick(() => {
                this.opts.onConfirm(ta.value.trim() || '关联');
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
export class RouteView extends ReactViewBase {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_ROUTE, title: '线路模式', icon: 'route', description: '项目线路图：框架间隐性关联（From/To + 描述）与复合进度信息输出。', category: '事务设计'},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): RouteView {
        return new RouteView(leaf, plugin.allDeps.dataPipe, plugin.allDeps.settings);
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-route',
            name: '打开线路模式',
            callback: () => plugin.activateView(VIEW_TYPE_ROUTE),
        });
    }

    private board: CanvasBoard | null = null;
    private unsub: (() => void) | null = null;
    private refreshing = false;
    private refreshQueued = false;
    /** 当前选中的框架 */
    private selectedFwId: string | null = null;
    /** 临时渲染到画布的框架（本次打开中，右键加入） */
    private readonly renderSet = new Set<string>();
    /** 白板当前数据 key（选中+临时集合变化时重建） */
    private boardKey = '';
    /** 渲染件订阅的唯一状态源 */
    private readonly state = new SimpleStore<RouteState>({
        initializing: true,
        frameworks: [],
        selectedId: null,
        tempIds: [],
        linkingMode: false,
        infoText: '',
    });

    constructor(
        leaf: WorkspaceLeaf,
        private pipe: DataPipe,
        private settings: PluginSettings,
    ) {
        super(leaf);
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
            onSelect: (nodeId: string) => { this.selectedFwId = nodeId; this.recompute(); void this.refreshBoard(); },
            onToggleTemp: (nodeId: string) => {
                if (this.renderSet.has(nodeId)) this.renderSet.delete(nodeId);
                else this.renderSet.add(nodeId);
                this.recompute();
                void this.refreshBoard();
            },
            onToggleLinking: () => this.toggleLinking(),
            onFrameAreaContextMenu: (e: globalThis.MouseEvent) => this.showFrameBlankMenu(e),
            onBoardContextMenu: (e: globalThis.MouseEvent) => this.showBlankMenu(e),
            onContainerReady: (container: HTMLDivElement) => void this.attachBoard(container),
            onContainerDispose: () => this.detachBoard(),
        });
    }

    protected onMounted(): void {
        this.recompute();
        void this.refreshBoard();
    }

    // ============================================================
    // 画布挂载 / 卸载
    // ============================================================

    private async attachBoard(container: HTMLDivElement): Promise<void> {
        await this.rebuildBoard(container);
    }

    private detachBoard(): void {
        this.unsub?.();
        this.unsub = null;
        this.board?.destroy();
        this.board = null;
        this.boardKey = '';
    }

    private toggleLinking(): void {
        const board = this.board;
        if (!board) return;
        const next = !board.isLinkingMode;
        board.setLinkingMode(next);
        this.recompute();
    }

    // ============================================================
    // 状态重算（左栏 + 复合信息）
    // ============================================================

    private recompute(): void {
        const frameworks: RouteFrameRow[] = [
            ...this.pipe.GET_ByKind(NODE_KIND.TRANS),
            ...this.pipe.GET_ByKind(NODE_KIND.INFO),
        ].map(({ nodeId, data }) => ({ nodeId, desc: data.desc, kindLabel: NODE_KIND_LABELS[data.kind] }));

        this.state.set({
            initializing: !this.pipe.isInitialized,
            frameworks,
            selectedId: this.selectedFwId,
            tempIds: [...this.renderSet],
            linkingMode: this.board?.isLinkingMode ?? false,
            rightEmpty: (this.selectedFwId === null && this.renderSet.size === 0)
                ? '请在左侧选择框架'
                : undefined,
            infoText: this.composeInfoText(),
        });
    }

    /** 复合信息：选中框架子树状态聚合 */
    private composeInfoText(): string {
        if (!this.selectedFwId) return '';
        const counts: Record<string, number> = {};
        let total = 0;
        const walk = (id: string) => {
            const node = this.pipe.GET_Node(id);
            if (!node) return;
            total++;
            const st = node.state ?? 'plan';
            counts[st] = (counts[st] ?? 0) + 1;
            for (const child of this.pipe.GET_Children(id)) {
                if (child.data && (isFrameworkKind(child.data.kind) || TXN_KINDS.includes(child.data.kind))) {
                    walk(child.nodeId);
                }
            }
        };
        walk(this.selectedFwId);

        const done = counts['done'] ?? 0;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return `复合进度：${done}/${total} 完成（${pct}%）`;
    }

    // ============================================================
    // 左栏：框架区
    // ============================================================

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
                    .then(() => { void this.refreshBoard(); })
                    .catch((err) => {
                        console.error('[SeqTK] 新建框架失败:', err);
                        new Notice('新建框架失败，请查看控制台');
                    });
            },
        }).open();
    }

    // ============================================================
    // 右栏数据收集
    // ============================================================

    /** 收集白板数据：选中框架 + route 关联框架 + 临时框架 及其事务树 */
    private collectData(): {
        nodes: { id: string; kind: NodeKindValue; desc: string }[];
        edges: BoardEdge[];
        roots: string[];
    } {
        const nodeSet = new Map<string, SeqtkNode>();
        const followsEdges: BoardEdge[] = [];
        const routeEdges: BoardEdge[] = [];
        const rootFwIds: string[] = [];

        // 纳入框架：选中 + 临时
        const frameIds = new Set<string>();
        if (this.selectedFwId) frameIds.add(this.selectedFwId);
        for (const id of this.renderSet) frameIds.add(id);

        // route 关联：选中框架的出/入边关联节点
        if (this.selectedFwId) {
            const routeOut = this.pipe.GET_RouteOutgoing(this.selectedFwId);
            const routeIn = this.pipe.GET_RouteIncoming(this.selectedFwId);
            for (const r of routeOut) frameIds.add(r.nodeId);
            for (const r of routeIn) frameIds.add(r.nodeId);
        }

        // 树收集：框架/事务类 follows 后代
        const collect = (id: string, parentId: string | null) => {
            const node = this.pipe.GET_Node(id);
            if (!node || nodeSet.has(id)) return;
            nodeSet.set(id, node);
            if (parentId) followsEdges.push({ source: parentId, target: id, directed: true, rel: 'follows' });
            for (const child of this.pipe.GET_Children(id)) {
                if (!child.data) continue;
                if (isFrameworkKind(child.data.kind) || TXN_KINDS.includes(child.data.kind)) {
                    collect(child.nodeId, id);
                }
            }
        };

        for (const fwId of frameIds) {
            collect(fwId, null);
            rootFwIds.push(fwId);
        }

        // route 边（两端都在集合内，含描述）
        const allIds = new Set(nodeSet.keys());
        for (const id of allIds) {
            for (const r of this.pipe.GET_RouteOutgoing(id)) {
                if (!allIds.has(r.nodeId)) continue;
                routeEdges.push({ source: id, target: r.nodeId, directed: true, rel: 'route', label: r.desc });
            }
        }

        const nodes = Array.from(nodeSet, ([id, d]) => ({ id, kind: d.kind, desc: d.desc }));
        return { nodes, edges: [...followsEdges, ...routeEdges], roots: rootFwIds };
    }

    /**
     * 过滤嵌套 root：若某 root 是另一 root 的 follows 后代，则不作为独立根，
     * 避免层级方块布局将其子树重复放置（先随祖先整树放置，又独立放置一遍）。
     */
    private filterRoots(roots: string[], edges: BoardEdge[]): string[] {
        const childMap = new Map<string, string[]>();
        for (const e of edges) {
            if (e.rel === 'follows' && e.directed) {
                const list = childMap.get(e.source as string) ?? [];
                list.push(e.target as string);
                childMap.set(e.source as string, list);
            }
        }
        const isDescendant = (id: string, ancestor: string): boolean => {
            const stack = [...(childMap.get(ancestor) ?? [])];
            while (stack.length > 0) {
                const cur = stack.pop()!;
                if (cur === id) return true;
                stack.push(...(childMap.get(cur) ?? []));
            }
            return false;
        };
        return roots.filter((r) => !roots.some((o) => o !== r && isDescendant(r, o)));
    }

    /** 白板重建（选中/临时集合变化时调用；容器由 CanvasBoardHost 提供） */
    private async rebuildBoard(container: HTMLDivElement): Promise<void> {
        if (!this.unsub) {
            this.unsub = this.pipe.SUB_ActiveView(() => { this.recompute(); void this.refreshBoard(); });
        }
        this.boardContainerEl = container;
        await this.refreshBoard();
    }

    /** CanvasBoardHost 提供的容器（rebuild 时复用） */
    private boardContainerEl: HTMLDivElement | null = null;

    private async refreshBoard(): Promise<void> {
        if (this.refreshing) {
            this.refreshQueued = true;
            return;
        }
        this.refreshing = true;
        try {
            if (!this.pipe.isInitialized) return;
            if (this.selectedFwId === null && this.renderSet.size === 0) {
                this.recompute();
                return;
            }
            const { nodes, edges, roots } = this.collectData();
            const key = `${this.selectedFwId ?? ''}|${[...this.renderSet].sort().join(',')}`;

            if (this.board && this.boardKey === key) {
                await this.board.update(nodes, edges);
            } else {
                const container = this.boardContainerEl;
                if (!container) return;
                // 重建：销毁旧实例，新建白板（层级方块布局 + 子树跟随拖动）
                this.board?.destroy();
                this.board = null;
                this.boardKey = key;
                container.empty();
                this.board = new CanvasBoard(container, {
                    // 布局缓存按选中框架隔离，避免不同框架互相覆盖位置/视口
                    cacheKey: this.selectedFwId ? `route-${this.selectedFwId}` : 'route-blank',
                    loadLayout: (k) => this.loadLayout(k),
                    saveLayout: (k, l) => this.saveLayout(k, l),
                    onEdgeAdd: (s, t) => this.handleEdgeAdd(s, t),
                    onEdgeRemove: (s, t, directed, rel) => this.handleEdgeRemove(s, t, directed, rel),
                    onNodeDblClick: (id) => this.openNodeFile(id),
                    onNodeContextMenu: (id, ev) => this.showNodeMenu(id, ev),
                    followChildrenOnDrag: true,
                });
                const hasLayout = await this.board.init(nodes, edges);
                // 仅无布局缓存时执行层级方块布局；有缓存则保持用户调整后的位置
                if (!hasLayout) {
                    this.board.layoutTree(this.filterRoots(roots, edges), edges);
                }
            }
        } finally {
            this.refreshing = false;
            if (this.refreshQueued) {
                this.refreshQueued = false;
                void this.refreshBoard();
            }
            this.recompute();
        }
    }

    // ============================================================
    // 连线编辑（route）
    // ============================================================

    private handleEdgeAdd(s: string, t: string): void {
        const a = this.pipe.GET_Node(s);
        const b = this.pipe.GET_Node(t);
        if (!a || !b) return;
        new RouteDescModal(this.app, {
            fromDesc: a.desc,
            toDesc: b.desc,
            onConfirm: (desc) => {
                this.pipe.EXEC_Mutation({ op: 'route-add', kind: a.kind, nodeId: s, toId: t, description: desc });
                void this.refreshBoard();
            },
        }).open();
    }

    private handleEdgeRemove(s: string, t: string, directed: boolean, rel: string): void {
        if (rel !== 'route') {
            new Notice('从属树边为只读');
            return;
        }
        const a = this.pipe.GET_Node(s);
        new RouteConfirmModal(this.app, {
            title: '删除线路关联',
            message: `确认删除「${a?.desc ?? s}」到「${this.pipe.GET_Node(t)?.desc ?? t}」的线路关联？`,
            onConfirm: () => {
                if (a) this.pipe.EXEC_Mutation({ op: 'route-remove', kind: a.kind, nodeId: s, toId: t });
                void this.refreshBoard();
            },
        }).open();
    }

    // ============================================================
    // 右键菜单
    // ============================================================

    private showNodeMenu(nodeId: string, e: MouseEvent): void {
        const node = this.pipe.GET_Node(nodeId);
        if (!node) return;
        const menu = new Menu();
        const childKinds: NodeKindValue[] = isFrameworkKind(node.kind)
            ? [NODE_KIND.TRANS, NODE_KIND.CONCEPT, NODE_KIND.CHECK, NODE_KIND.EVENT]
            : (node.kind === NODE_KIND.CHECK ? [NODE_KIND.ITEM] : []);
        if (childKinds.length > 0) {
            menu.addItem((item) =>
                item.setTitle('新建子节点').setIcon('plus')
                    .onClick(() => this.createChild(nodeId, node.kind, childKinds)));
        }
        menu.addItem((item) =>
            item.setTitle('重命名').setIcon('pencil')
                .onClick(() => this.openEdit(nodeId, node)));
        menu.addItem((item) =>
            item.setTitle('打开文件').setIcon('file-text')
                .onClick(() => this.openNodeFile(nodeId)));
        menu.addItem((item) =>
            item.setTitle('归档').setIcon('archive')
                .onClick(() => {
                    this.pipe.EXEC_Mutation({
                        op: 'update',
                        kind: node.kind,
                        nodeId,
                        updates: { open: false, modify: new Date().toISOString() },
                    });
                    new Notice('已归档');
                }));
        menu.addSeparator();
        menu.addItem((item) =>
            item.setTitle('删除').setIcon('trash')
                .onClick(() => {
                    this.pipe.EXEC_Mutation({ op: 'remove', kind: node.kind, nodeId });
                }));
        menu.showAtMouseEvent(e);
    }

    private createChild(parentId: string, parentKind: NodeKindValue, kinds: NodeKindValue[]): void {
        new TransactionCreateModal(this.app, {
            kinds,
            onSubmit: (input) => {
                const now = new Date().toISOString();
                const data = {
                    kind: input.kind,
                    desc: input.desc,
                    open: true,
                    state: 'plan',
                    create: now,
                    modify: now,
                    parent: parentId,
                } as SeqtkNode;
                void this.pipe.EXEC_Create({
                    kind: input.kind,
                    data,
                    parentId: parentId || undefined,
                }).then(() => {
                    void this.refreshBoard();
                }).catch((err) => {
                    console.error('[SeqTK] 新建子节点失败:', err);
                    new Notice('新建子节点失败，请查看控制台');
                });
            },
        }).open();
    }

    /** 重命名：只改名称（时间相关字段在「时间规则」模态框里改） */
    private openEdit(nodeId: string, node: SeqtkNode): void {
        new TextPromptModal(this.app, {
            title: '重命名',
            fields: [{ key: 'desc', label: '名称', value: node.desc }],
            onConfirm: (values) => {
                const desc = (values.desc ?? '').trim();
                if (!desc || desc === node.desc) return;
                this.pipe.EXEC_Mutation({
                    op: 'update',
                    kind: node.kind,
                    nodeId,
                    updates: { desc, modify: new Date().toISOString() },
                });
            },
        }).open();
    }

    private openNodeFile(nodeId: string): void {
        const node = this.pipe.GET_Node(nodeId);
        if (!node) return;
        const filePath = GET_FileByPath(node.kind, nodeId, this.settings);
        const file = this.app.vault.getFileByPath(filePath);
        if (file) void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
    }

    /** 白板空白右键：新建顶层事务（挂到当前选中框架下） */
    private showBlankMenu(e: MouseEvent): void {
        const menu = new Menu();
        for (const k of [NODE_KIND.CONCEPT, NODE_KIND.CHECK, NODE_KIND.EVENT]) {
            menu.addItem((item) =>
                item.setTitle(`新建${NODE_KIND_LABELS[k]}`).setIcon('plus')
                    .onClick(() => this.createChild(this.selectedFwId ?? '', NODE_KIND.TRANS, [k])));
        }
        menu.showAtMouseEvent(e);
    }

    // ============================================================
    // 布局缓存（插件数据目录 JSON，与其他白板视图共用文件）
    // ============================================================

    private async loadLayout(key: string): Promise<BoardLayout | null> {
        const raw = await this.pipe.READ_DataFile(LAYOUT_CACHE_FILE);
        if (!raw) return null;
        try {
            const all = JSON.parse(raw) as Record<string, unknown>;
            const entry = all[key];
            if (!entry) return null;
            if (typeof entry === 'object' && entry !== null && !('positions' in entry)) {
                return { positions: entry as BoardPositions };
            }
            return entry as BoardLayout;
        } catch {
            return null;
        }
    }

    private async saveLayout(key: string, layout: BoardLayout): Promise<void> {
        try {
            const raw = await this.pipe.READ_DataFile(LAYOUT_CACHE_FILE);
            let all: Record<string, unknown> = {};
            if (raw) {
                try {
                    all = JSON.parse(raw);
                } catch { /* 损坏则重建 */ }
            }
            all[key] = layout;
            await this.pipe.WRITE_DataFile(LAYOUT_CACHE_FILE, JSON.stringify(all));
        } catch (err) {
            console.warn('[SeqTK] 写入布局缓存失败:', err);
        }
    }
}
