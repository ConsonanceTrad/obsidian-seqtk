/**
 * OverviewView — 证据管理 · 总览模式
 *
 * 不聚焦事务，单栏白板阅览全局证据的相互关系：
 * - 数据：快速缓存中全部未归档证据（对象/条件/信息/状态）+ 全局 links 无向边
 * - 可连接跨事务的证据（连线模式任意两证据建 links）
 * - 可建立无指向的证据（右键空白新建，不挂任何事务；右键证据添加关联证据）
 * - 布局缓存 key「overview」（位置 + 视口持久化）
 */

import { ItemView, Menu, Notice, WorkspaceLeaf } from 'obsidian';
import type { NodeKind, SeqtkNode } from '../types/index';
import { NODE_KIND_LABELS } from '../types/index';
import type { NodeCache } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import type { OperationQueue } from '../core/OperationQueue';
import { CanvasBoard } from './components/CanvasBoard';
import type { BoardLayout, BoardPositions } from './components/CanvasBoard';
import { TransactionCreateModal, TransactionEditModal } from './components/TransactionModals';

export const VIEW_TYPE_OVERVIEW = 'seqtk-overview';

/** 证据类型 */
const EVIDENCE_KINDS: NodeKind[] = ['factor', 'requirement', 'clue', 'snapshot'];

/** 布局缓存文件（存放于插件用户数据文件夹 rootFolder 下） */
const LAYOUT_CACHE_FILE = 'layout-cache.json';

export class OverviewView extends ItemView {
  private boardContainer!: HTMLElement;
  private board: CanvasBoard | null = null;
  private unsub: (() => void) | null = null;
  private linkToggleBtn: HTMLButtonElement | null = null;
  private refreshing = false;
  private refreshQueued = false;
  /** 最近一次节点右键菜单触发时间（用于区分节点右键与画布空白右键） */
  private nodeMenuAt = 0;
  /** 空白右键处的模型坐标：新创建的无指向证据落位到该处（null = 无待落位） */
  private pendingCreatePos: { x: number; y: number } | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private nodeCache: NodeCache,
    private fileManager: NodeFileManager,
    private operationQueue: OperationQueue,
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

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('seqtk-design-view');

    // 标题行：标题 + 右侧连线模式开关
    const titleRow = container.createDiv('seqtk-board-titlebar');
    titleRow.createEl('div', { cls: 'seqtk-split-title', text: '证据总览' });
    this.linkToggleBtn = titleRow.createEl('button', { cls: 'seqtk-btn seqtk-btn-small', text: '连线模式' });
    this.linkToggleBtn.addEventListener('click', () => {
      if (!this.board) return;
      const next = !this.board.isLinkingMode;
      this.board.setLinkingMode(next);
      this.updateLinkToggle();
    });

    this.boardContainer = container.createDiv('seqtk-board');
    // 白板空白右键：新建无指向证据
    // （Cytoscape 容器内渲染为 canvas 子元素，需按「包含」判断而非严格相等，
    //   否则空白处右键 e.target 是内部 canvas，恒不等于容器，菜单无法打开）
    this.boardContainer.addEventListener('contextmenu', (e) => {
      const cyContainer = this.board?.cy.container();
      if (!cyContainer || !(e.target instanceof Node) || !cyContainer.contains(e.target)) return;
      // 节点右键已由 Cytoscape cxttap（mouseup 时）触发节点菜单，
      // 此处跳过，避免同一右键冒泡至此再次弹出空白菜单
      if (Date.now() - this.nodeMenuAt < 300) return;
      e.preventDefault();
      this.showBlankMenu(e);
    });

    const { nodes, edges } = this.collectData();
    this.board = new CanvasBoard(this.boardContainer, {
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
    await this.board.init(nodes, edges);

    this.unsub = this.nodeCache.nodeStore.subscribe(() => void this.refreshBoard());
    // 兜底：若缓存恰在 init 期间就绪（store 通知先于订阅发生），主动拉取一次数据
    if (this.nodeCache.isInitialized) {
      void this.refreshBoard();
    }
  }

  async onClose(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
    this.board?.destroy();
    this.board = null;
  }

  private updateLinkToggle(): void {
    if (!this.linkToggleBtn) return;
    const on = this.board?.isLinkingMode ?? false;
    this.linkToggleBtn.setText(on ? '退出连线' : '连线模式');
    this.linkToggleBtn.toggleClass('seqtk-btn-active', on);
  }

  // ============================================================
  // 数据收集
  // ============================================================

  /** 全局未归档证据 + 证据间 links 边（跨事务） */
  private collectData(): { nodes: { id: string; kind: NodeKind; desc: string }[]; edges: { source: string; target: string }[] } {
    const evNodes = new Map<string, SeqtkNode>();
    for (const [id, data] of this.nodeCache.nodeStore.get()) {
      if (EVIDENCE_KINDS.includes(data.kind as NodeKind)) {
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
      if (!this.nodeCache.isInitialized || !this.board) return;
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

  private addLink(aId: string, bId: string): void {
    const a = this.nodeCache.getNode(aId);
    const b = this.nodeCache.getNode(bId);
    if (!a || !b || (a.links ?? []).includes(bId)) return;
    const aLinks = [...(a.links ?? []), bId];
    const bLinks = [...(b.links ?? []), aId];
    this.operationQueue.enqueue(
      () => {
        this.nodeCache.updateNode(aId, { links: aLinks });
        this.nodeCache.updateNode(bId, { links: bLinks });
      },
      async () => {
        await this.fileManager.updateNode(a.kind, aId, { links: aLinks });
        await this.fileManager.updateNode(b.kind, bId, { links: bLinks });
      },
    );
  }

  private removeLink(aId: string, bId: string): void {
    const a = this.nodeCache.getNode(aId);
    const b = this.nodeCache.getNode(bId);
    if (!a || !b) return;
    const aLinks = (a.links ?? []).filter((id) => id !== bId);
    const bLinks = (b.links ?? []).filter((id) => id !== aId);
    this.operationQueue.enqueue(
      () => {
        this.nodeCache.updateNode(aId, { links: aLinks });
        this.nodeCache.updateNode(bId, { links: bLinks });
      },
      async () => {
        await this.fileManager.updateNode(a.kind, aId, { links: aLinks });
        await this.fileManager.updateNode(b.kind, bId, { links: bLinks });
      },
    );
  }

  // ============================================================
  // 右键菜单
  // ============================================================

  private showNodeMenu(nodeId: string, e: MouseEvent): void {
    const node = this.nodeCache.getNode(nodeId);
    if (!node) return;
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle('重命名').setIcon('pencil')
        .onClick(() => {
          new TransactionEditModal(this.app, {
            node,
            onSubmit: (input) => {
              if (input.desc === node.desc) return;
              this.operationQueue.enqueue(
                () => this.nodeCache.updateNode(nodeId, { desc: input.desc, modify: new Date().toISOString() }),
                async () => { await this.fileManager.updateNode(node.kind, nodeId, { desc: input.desc }); },
              );
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
          this.operationQueue.enqueue(
            () => this.nodeCache.updateNode(nodeId, { open: false, modify: new Date().toISOString() }),
            async () => { await this.fileManager.updateNode(node.kind, nodeId, { open: false }); },
          );
          new Notice('已归档');
        }));
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle('删除').setIcon('trash')
        .onClick(() => {
          this.operationQueue.enqueueCacheOp(() => this.nodeCache.removeNode(nodeId));
          this.operationQueue.enqueueFileOp(async () => { await this.fileManager.deleteNode(node.kind, nodeId); });
        }));
    menu.showAtMouseEvent(e);
  }

  /** 白板空白右键：新建无指向证据（四类，不挂事务） */
  private showBlankMenu(e: MouseEvent): void {
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
  private createDetachedEvidence(kind: NodeKind): void {
    new TransactionCreateModal(this.app, {
      kinds: [kind],
      onSubmit: (input) => {
        const now = new Date().toISOString();
        const data = {
          kind: input.kind,
          desc: input.desc,
          open: true,
          ...(input.kind === 'snapshot' ? { at: new Date().toISOString() } : {}),
          create: now,
          modify: now,
        } as SeqtkNode;
        void this.fileManager.createNode(input.kind, data, '').then((nodeId) => {
          this.operationQueue.enqueueCacheOp(() => this.nodeCache.addNode(nodeId, data, ''));
          void this.refreshBoard().then(() => {
            // 新节点落位到空白右键处的模型坐标（无则保持默认增量定位）
            const pos = this.pendingCreatePos;
            if (pos) {
              this.pendingCreatePos = null;
              this.board?.positionNode(nodeId, pos);
            }
          });
        });
      },
    }).open();
  }

  /** 创建无指向证据并与源证据建立 links（双向） */
  private createLinkedEvidence(sourceId: string): void {
    const source = this.nodeCache.getNode(sourceId);
    if (!source) return;
    new TransactionCreateModal(this.app, {
      kinds: EVIDENCE_KINDS,
      onSubmit: (input) => {
        const now = new Date().toISOString();
        const data = {
          kind: input.kind,
          desc: input.desc,
          open: true,
          ...(input.kind === 'snapshot' ? { at: new Date().toISOString() } : {}),
          create: now,
          modify: now,
        } as SeqtkNode;
        void this.fileManager.createNode(input.kind, data, '').then((nodeId) => {
          this.operationQueue.enqueueCacheOp(() => this.nodeCache.addNode(nodeId, data, ''));
          this.addLink(sourceId, nodeId);
          void this.refreshBoard();
          new Notice('已创建关联证据');
        });
      },
    }).open();
  }

  private openNodeFile(nodeId: string): void {
    const node = this.nodeCache.getNode(nodeId);
    if (!node) return;
    const file = this.app.vault.getFileByPath(this.fileManager.getNodeFilePath(node.kind, nodeId));
    if (file) void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
  }

  // ============================================================
  // 布局缓存（插件数据目录 JSON，与聚焦模式共用文件）
  // ============================================================

  private async loadLayout(key: string): Promise<BoardLayout | null> {
    try {
      const adapter = this.app.vault.adapter;
      const path = `${this.fileManager.rootFolder}/${LAYOUT_CACHE_FILE}`;
      if (!(await adapter.exists(path))) return null;
      const raw = await adapter.read(path);
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
      const adapter = this.app.vault.adapter;
      const path = `${this.fileManager.rootFolder}/${LAYOUT_CACHE_FILE}`;
      let all: Record<string, unknown> = {};
      if (await adapter.exists(path)) {
        try {
          all = JSON.parse(await adapter.read(path));
        } catch { /* 损坏则重建 */ }
      }
      all[key] = layout;
      const json = JSON.stringify(all);
      if (await adapter.exists(path)) {
        await adapter.write(path, json);
      } else {
        await this.fileManager.ensureRootFolder();
        await this.app.vault.create(path, json);
      }
    } catch (err) {
      console.warn('[SeqTK] 写入布局缓存失败:', err);
    }
  }
}
