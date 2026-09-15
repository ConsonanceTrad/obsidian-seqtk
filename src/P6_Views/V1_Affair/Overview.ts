/**
 * OverviewView — 证据管理 · 总览模式
 *
 * 不聚焦事务，单栏白板阅览全局证据的相互关系：
 * - 数据：活跃缓存中全部未归档证据（对象/条件/信息/状态）+ 全局 links 无向边
 * - 可连接跨事务的证据（连线模式任意两证据建 links）
 * - 可建立无指向的证据（右键空白新建，不挂任何事务；右键证据添加关联证据）
 * - 布局缓存 key「overview」（位置 + 视口持久化）
 *
 * 逻辑与渲染分离：
 * - 本文件（逻辑）：持有 CanvasBoard、订阅活跃缓存、收集图数据、全部画布操作与右键菜单；
 * - OverviewPanel.tsx（渲染）：只提供标题栏与容器，不 import obsidian、不碰数据层。
 *
 * 数据面（见 P6_Views/Views.md 边界判据）：读写一律经 **DataPipe** 门面
 * （`GET_ActiveView` / `EXEC_Mutation` / `EXEC_Create` / `SUB_ActiveView` / `READ_DataFile`），
 * 视图不再直连 nodeCache / fileManager / operationQueue。
 */

import { createElement, type ReactNode } from "react";
import { Menu, Notice, type WorkspaceLeaf } from "obsidian";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";
import { NODE_KIND } from "../../P4_Nodes/NodeKind/NodeKind";
import { NODE_KIND_LABELS } from "../../P4_Nodes/NodeKind/NodeLabel";
import { CanvasBoard, type BoardLayout, type BoardPositions } from "../../P7_Render/Structure/S3_Board/CanvasBoard";
import { TransactionCreateModal } from "../../P7_Render/Structure/S2_Modal/TransactionModals";
import { TextPromptModal } from "../../P7_Render/Structure/S2_Modal/TextPromptModal";
import { GET_FileByPath } from "../../P5_Data/MdFile/PathTools/PathParse";
import { OverviewPanel, type OverviewState } from "./OverviewPanel";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { DataPipe } from "../../P5_Data/CoPipe/DataPipe";
import type { PluginSettings } from "../../P3_Settings/Settings";
import type { NodeKindValue } from "../../P4_Nodes/NodeKind/NodeKind";
import type { SeqtkNode } from "../../P4_Nodes/Node";

export const VIEW_TYPE_OVERVIEW = 'seqtk-overview';

/** 证据类型 */
const EVIDENCE_KINDS: NodeKindValue[] = [
    NODE_KIND.FACTOR, NODE_KIND.REQUEST, NODE_KIND.CLUE, NODE_KIND.SNAPSHOT,
];

/** 布局缓存文件（存放于插件用户数据文件夹 rootFolder 下） */
const LAYOUT_CACHE_FILE = 'layout-cache.json';

@AutoView()
@AutoRegister()
export class OverviewView extends ReactViewBase {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_OVERVIEW, title: '证据总览', icon: 'network', description: '不聚焦事务，白板阅览全局证据关系，可连接跨事务证据、建立无指向证据。', category: '事务设计'},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): OverviewView {
        return new OverviewView(leaf, plugin.allDeps.dataPipe, plugin.allDeps.settings);
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-overview',
            name: '打开证据总览',
            callback: () => plugin.activateView(VIEW_TYPE_OVERVIEW),
        });
    }

    private board: CanvasBoard | null = null;
    private unsub: (() => void) | null = null;
    private refreshing = false;
    private refreshQueued = false;
    /** 最近一次节点右键菜单触发时间（用于区分节点右键与画布空白右键） */
    private nodeMenuAt = 0;
    /** 空白右键处的模型坐标：新创建的无指向证据落位到该处（null = 无待落位） */
    private pendingCreatePos: { x: number; y: number } | null = null;
    /** 渲染件订阅的唯一状态源 */
    private readonly state = new SimpleStore<OverviewState>({ linkingMode: false });

    constructor(
        leaf: WorkspaceLeaf,
        private pipe: DataPipe,
        private settings: PluginSettings,
    ) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_OVERVIEW;
    }

    getDisplayText(): string {
        return '证据总览';
    }

    getIcon(): string {
        return 'network';
    }

    /** 渲染件在 OverviewPanel.tsx；视图类不写 JSX 字面量（见 P6_Views/Views.md 契约） */
    protected renderPanel(): ReactNode {
        return createElement(OverviewPanel, {
            state: this.state,
            onToggleLinking: () => this.toggleLinking(),
            onContainerReady: (container: HTMLDivElement) => void this.attachBoard(container),
            onContainerDispose: () => this.detachBoard(),
            onBlankContextMenu: (e: globalThis.MouseEvent) => this.showBlankMenu(e),
        });
    }

    // ============================================================
    // 画布挂载 / 卸载（命令式资源，由本类掌管）
    // ============================================================

    private async attachBoard(container: HTMLDivElement): Promise<void> {
        const { nodes, edges } = this.collectData();
        const board = new CanvasBoard(container, {
            cacheKey: 'overview',
            loadLayout: (key) => this.loadLayout(key),
            saveLayout: (key, layout) => this.saveLayout(key, layout),
            onEdgeAdd: (s, t) => this.handleEdgeAdd(s, t),
            onEdgeRemove: (s, t, directed) => this.handleEdgeRemove(s, t, directed),
            onNodeDblClick: (id) => this.openNodeFile(id),
            onNodeContextMenu: (id, e) => {
                this.nodeMenuAt = Date.now();
                this.showNodeMenu(id, e);
            },
        });
        this.board = board;
        await board.init(nodes, edges);

        this.unsub = this.pipe.SUB_ActiveView(() => void this.refreshBoard());
        // 兜底：若缓存恰在 init 期间就绪（store 通知先于订阅发生），主动拉取一次数据
        if (this.pipe.isInitialized) {
            void this.refreshBoard();
        }
    }

    /** 由 OverviewPanel 的 onContainerDispose 调用（React 卸载容器前） */
    private detachBoard(): void {
        this.unsub?.();
        this.unsub = null;
        this.board?.destroy();
        this.board = null;
    }

    private toggleLinking(): void {
        const board = this.board;
        if (!board) return;
        const next = !board.isLinkingMode;
        board.setLinkingMode(next);
        this.state.set({ linkingMode: next });
    }

    // ============================================================
    // 数据收集
    // ============================================================

    /** 全局未归档证据 + 证据间 links 边（跨事务） */
    private collectData(): {
        nodes: { id: string; kind: NodeKindValue; desc: string }[];
        edges: { source: string; target: string }[];
    } {
        const evNodes = new Map<string, SeqtkNode>();
        for (const [id, data] of this.pipe.GET_ActiveView()) {
            if (EVIDENCE_KINDS.includes(data.kind)) {
                evNodes.set(id, data);
            }
        }
        const nodes = Array.from(evNodes, ([id, d]) => ({ id, kind: d.kind, desc: d.desc }));
        const evIds = new Set(evNodes.keys());
        const seen = new Set<string>();
        const edges: { source: string; target: string }[] = [];
        for (const [id, data] of evNodes) {
            for (const linkId of data.links ?? []) {
                if (!evIds.has(linkId)) continue;
                const key = [id, linkId].sort().join('|');
                if (seen.has(key)) continue;
                seen.add(key);
                edges.push({ source: id, target: linkId });
            }
        }
        return { nodes, edges };
    }

    private async refreshBoard(): Promise<void> {
        if (this.refreshing) {
            this.refreshQueued = true;
            return;
        }
        this.refreshing = true;
        try {
            if (!this.pipe.isInitialized || !this.board) return;
            const { nodes, edges } = this.collectData();
            await this.board.update(nodes, edges);
        } finally {
            this.refreshing = false;
            if (this.refreshQueued) {
                this.refreshQueued = false;
                void this.refreshBoard();
            }
        }
    }

    // ============================================================
    // 连线编辑（证据间 links，跨事务）
    // ============================================================

    private handleEdgeAdd(s: string, t: string): void {
        this.addLink(s, t);
    }

    private handleEdgeRemove(s: string, t: string, directed: boolean): void {
        if (directed) return; // 总览无 follows 边
        this.removeLink(s, t);
    }

    /** 双向维护 links：两个节点各一条 update 写意图（缓存立即 + 文件慢序列） */
    private addLink(aId: string, bId: string): void {
        const a = this.pipe.GET_Node(aId);
        const b = this.pipe.GET_Node(bId);
        if (!a || !b || (a.links ?? []).includes(bId)) return;
        this.pipe.EXEC_Mutation({ op: 'update', kind: a.kind, nodeId: aId, updates: { links: [...(a.links ?? []), bId] } });
        this.pipe.EXEC_Mutation({ op: 'update', kind: b.kind, nodeId: bId, updates: { links: [...(b.links ?? []), aId] } });
    }

    private removeLink(aId: string, bId: string): void {
        const a = this.pipe.GET_Node(aId);
        const b = this.pipe.GET_Node(bId);
        if (!a || !b) return;
        this.pipe.EXEC_Mutation({ op: 'update', kind: a.kind, nodeId: aId, updates: { links: (a.links ?? []).filter((id) => id !== bId) } });
        this.pipe.EXEC_Mutation({ op: 'update', kind: b.kind, nodeId: bId, updates: { links: (b.links ?? []).filter((id) => id !== aId) } });
    }

    // ============================================================
    // 右键菜单
    // ============================================================

    private showNodeMenu(nodeId: string, e: MouseEvent): void {
        const node = this.pipe.GET_Node(nodeId);
        if (!node) return;
        const menu = new Menu();
        menu.addItem((item) =>
            item.setTitle('重命名').setIcon('pencil')
                .onClick(() => {
                    // 只改名称：时间相关字段交给「时间规则」模态框，别在这里混着
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
                }));
        menu.addItem((item) =>
            item.setTitle('添加关联证据').setIcon('link')
                .onClick(() => this.createLinkedEvidence(nodeId)));
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

    /**
     * 白板空白右键：新建无指向证据（四类，不挂事务）。
     * 节点右键已由 Cytoscape cxttap 触发节点菜单，此处按时间戳跳过，
     * 避免同一右键冒泡至此再次弹出空白菜单。
     */
    private showBlankMenu(e: MouseEvent): void {
        if (Date.now() - this.nodeMenuAt < 300) return;

        // 记录右键处的模型坐标，供新节点落位（右键后视图可能变化，故此刻即换算缓存）
        const board = this.board;
        if (board) {
            const cyContainer = board.cy.container();
            if (!cyContainer) return;
            const rect = cyContainer.getBoundingClientRect();
            const zoom = board.cy.zoom();
            const pan = board.cy.pan();
            this.pendingCreatePos = {
                x: (e.clientX - rect.left - pan.x) / zoom,
                y: (e.clientY - rect.top - pan.y) / zoom,
            };
        }

        const menu = new Menu();
        for (const k of EVIDENCE_KINDS) {
            menu.addItem((item) =>
                item.setTitle(`新建${NODE_KIND_LABELS[k]}`).setIcon('plus')
                    .onClick(() => this.createDetachedEvidence(k)));
        }
        menu.showAtMouseEvent(e);
    }

    /** 创建无指向证据（不挂任何事务） */
    private createDetachedEvidence(kind: NodeKindValue): void {
        new TransactionCreateModal(this.app, {
            kinds: [kind],
            onSubmit: (input) => {
                const now = new Date().toISOString();
                const data = {
                    kind: input.kind,
                    desc: input.desc,
                    open: true,
                    ...(input.kind === NODE_KIND.SNAPSHOT ? { at: new Date().toISOString() } : {}),
                    create: now,
                    modify: now,
                } as SeqtkNode;
                void this.pipe.EXEC_Create({ kind: input.kind, data }).then((nodeId) => {
                    void this.refreshBoard().then(() => {
                        // 新节点落位到空白右键处的模型坐标（无则保持默认增量定位）
                        const pos = this.pendingCreatePos;
                        if (pos) {
                            this.pendingCreatePos = null;
                            this.board?.positionNode(nodeId, pos);
                        }
                    });
                }).catch((err) => {
                    console.error('[SeqTK] 新建证据失败:', err);
                    new Notice('新建证据失败，请查看控制台');
                });
            },
        }).open();
    }

    /** 创建无指向证据并与源证据建立 links（双向） */
    private createLinkedEvidence(sourceId: string): void {
        const source = this.pipe.GET_Node(sourceId);
        if (!source) return;
        new TransactionCreateModal(this.app, {
            kinds: EVIDENCE_KINDS,
            onSubmit: (input) => {
                const now = new Date().toISOString();
                const data = {
                    kind: input.kind,
                    desc: input.desc,
                    open: true,
                    ...(input.kind === NODE_KIND.SNAPSHOT ? { at: new Date().toISOString() } : {}),
                    create: now,
                    modify: now,
                } as SeqtkNode;
                void this.pipe.EXEC_Create({ kind: input.kind, data }).then((nodeId) => {
                    this.addLink(sourceId, nodeId);
                    void this.refreshBoard();
                    new Notice('已创建关联证据');
                }).catch((err) => {
                    console.error('[SeqTK] 创建关联证据失败:', err);
                    new Notice('创建关联证据失败，请查看控制台');
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

    // ============================================================
    // 布局缓存（插件数据目录 JSON）
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
