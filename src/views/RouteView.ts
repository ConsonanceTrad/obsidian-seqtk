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
 */

import { App, ItemView, Menu, Modal, Notice, Setting, WorkspaceLeaf } from 'obsidian';
import type { NodeKind, SeqtkNode } from '../types/index';
import { NODE_KIND_LABELS, isFrameworkKind } from '../types/index';
import type { NodeCache } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import type { OperationQueue } from '../core/OperationQueue';
import { CanvasBoard } from './components/CanvasBoard';
import type { BoardLayout, BoardPositions } from './components/CanvasBoard';
import { TransactionCreateModal, TransactionEditModal } from './components/TransactionModals';

export const VIEW_TYPE_ROUTE = 'seqtk-route';

/** 事务类型（树中展示） */
const TXN_KINDS: NodeKind[] = ['concept', 'checklist', 'item', 'event'];

/** 布局缓存文件（存放于插件用户数据文件夹 rootFolder 下） */
const LAYOUT_CACHE_FILE = 'layout-cache.json';

/** route 关联描述输入弹窗 */
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
    contentEl.createEl('h3', { text: '建立线路关联' });
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

/** 确认弹窗 */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private opts: { title: string; message: string; onConfirm: () => void },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.opts.title });
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

export class RouteView extends ItemView {
  private leftEl!: HTMLElement;
  private rightEl!: HTMLElement;
  private infoEl!: HTMLElement;
  private boardContainer!: HTMLElement;
  private board: CanvasBoard | null = null;
  private linkToggleBtn: HTMLButtonElement | null = null;
  private unsub: (() => void) | null = null;
  private refreshing = false;
  private refreshQueued = false;
  /** 当前选中的框架 */
  private selectedFwId: string | null = null;
  /** 临时渲染到画布的框架（本次打开中，右键加入） */
  private renderSet = new Set<string>();
  /** 白板当前数据 key（选中+临时集合变化时重建） */
  private boardKey = '';

  constructor(
    leaf: WorkspaceLeaf,
    private nodeCache: NodeCache,
    private fileManager: NodeFileManager,
    private operationQueue: OperationQueue,
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

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('seqtk-design-view');

    const split = container.createDiv('seqtk-split');
    this.leftEl = split.createDiv('seqtk-split-left');
    this.rightEl = split.createDiv('seqtk-split-right');

    // 标题行（标题 + 连线开关）
    const titleRow = this.rightEl.createDiv('seqtk-board-titlebar');
    titleRow.createEl('div', { cls: 'seqtk-split-title', text: '线路图' });
    this.linkToggleBtn = titleRow.createEl('button', { cls: 'seqtk-btn seqtk-btn-small', text: '连线模式' });
    this.linkToggleBtn.addEventListener('click', () => {
      if (!this.board) return;
      const next = !this.board.isLinkingMode;
      this.board.setLinkingMode(next);
      this.updateLinkToggle();
    });

    // 复合信息区
    this.infoEl = this.rightEl.createDiv('seqtk-route-info');

    this.boardContainer = this.rightEl.createDiv('seqtk-board');
    // 白板空白右键：新建顶层事务
    this.boardContainer.addEventListener('contextmenu', (e) => {
      if (this.board && e.target === this.board.cy.container()) {
        e.preventDefault();
        this.showBlankMenu(e);
      }
    });

    this.unsub = this.nodeCache.nodeStore.subscribe(() => {
      this.renderLeft();
      void this.refreshBoard();
    });
    this.renderLeft();
    void this.refreshBoard();
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
  // 左栏：框架选择区
  // ============================================================

  private renderLeft(): void {
    this.leftEl.empty();
    this.leftEl.createEl('div', { cls: 'seqtk-split-title', text: '框架' });

    if (!this.nodeCache.isInitialized) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '正在加载缓存…' });
      return;
    }

    const frameworks = [
      ...this.nodeCache.getByKind('framework-transaction'),
      ...this.nodeCache.getByKind('framework-info'),
    ];
    if (frameworks.length === 0) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '暂无框架（右键此处新建）' });
    } else {
      for (const { nodeId, data } of frameworks) {
        this.renderFrameItem(nodeId, data);
      }
    }

    // 左栏空白右键：新建框架
    this.leftEl.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.seqtk-frame-item')) return;
      e.preventDefault();
      this.showFrameBlankMenu(e);
    });
  }

  private renderFrameItem(nodeId: string, data: SeqtkNode): void {
    const row = this.leftEl.createDiv('seqtk-frame-item');
    if (this.selectedFwId === nodeId) row.addClass('seqtk-frame-item-active');
    if (this.renderSet.has(nodeId)) row.addClass('seqtk-frame-item-temp');
    row.createEl('span', { cls: 'seqtk-kind-badge', text: NODE_KIND_LABELS[data.kind] });
    row.createEl('span', { cls: 'seqtk-desc', text: data.desc });
    row.addEventListener('click', () => {
      this.selectedFwId = nodeId;
      this.renderLeft();
      void this.refreshBoard();
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 右键非选中框架：临时渲染到画布（本次打开中）
      if (nodeId !== this.selectedFwId) {
        if (this.renderSet.has(nodeId)) this.renderSet.delete(nodeId);
        else this.renderSet.add(nodeId);
        this.renderLeft();
        void this.refreshBoard();
      }
    });
  }

  private showFrameBlankMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle('新建事务框架').setIcon('folder-plus')
        .onClick(() => this.createFramework('framework-transaction')));
    menu.addItem((item) =>
      item.setTitle('新建信息框架').setIcon('folder-plus')
        .onClick(() => this.createFramework('framework-info')));
    menu.showAtMouseEvent(e);
  }

  private createFramework(kind: NodeKind): void {
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
        void this.fileManager.createNode(input.kind, data, '').then((nodeId) => {
          this.operationQueue.enqueueCacheOp(() => this.nodeCache.addNode(nodeId, data, ''));
        });
      },
    }).open();
  }

  // ============================================================
  // 右栏数据收集
  // ============================================================

  /** 收集白板数据：选中框架 + route 关联框架 + 临时框架 及其事务树 */
  private collectData(): { nodes: { id: string; kind: NodeKind; desc: string }[]; edges: any[]; roots: string[] } {
    const nodeSet = new Map<string, SeqtkNode>();
    const followsEdges: any[] = [];
    const routeEdges: any[] = [];
    const rootFwIds: string[] = [];

    // 纳入框架：选中 + 临时
    const frameIds = new Set<string>();
    if (this.selectedFwId) frameIds.add(this.selectedFwId);
    for (const id of this.renderSet) frameIds.add(id);

    // route 关联：选中框架的出/入边关联节点
    if (this.selectedFwId) {
      const routOut = this.nodeCache.getRouteOutgoing(this.selectedFwId);
      const routIn = this.nodeCache.getRouteIncoming(this.selectedFwId);
      for (const r of routOut) frameIds.add(r.nodeId);
      for (const r of routIn) frameIds.add(r.nodeId);
    }

    // 树收集：框架/事务类 follows 后代
    const collect = (id: string, parentId: string | null) => {
      const node = this.nodeCache.getNode(id);
      if (!node || nodeSet.has(id)) return;
      nodeSet.set(id, node);
      if (parentId) followsEdges.push({ source: parentId, target: id, directed: true, rel: 'follows' });
      for (const child of this.nodeCache.getChildren(id)) {
        if (!child.data) continue;
        if (isFrameworkKind(child.data.kind) || TXN_KINDS.includes(child.data.kind as NodeKind)) {
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
      for (const r of this.nodeCache.getRouteOutgoing(id)) {
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
  private filterRoots(roots: string[], edges: any[]): string[] {
    const childMap = new Map<string, string[]>();
    for (const e of edges) {
      if (e.rel === 'follows' && e.directed) {
        const list = childMap.get(e.source) ?? [];
        list.push(e.target);
        childMap.set(e.source, list);
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

  private async refreshBoard(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      if (!this.nodeCache.isInitialized) return;
      if (this.selectedFwId === null && this.renderSet.size === 0) {
        this.rightEl.createEl('div', { cls: 'seqtk-empty', text: '请在左侧选择框架' });
        return;
      }
      const { nodes, edges, roots } = this.collectData();
      const key = `${this.selectedFwId ?? ''}|${[...this.renderSet].sort().join(',')}`;

      if (this.board && this.boardKey === key) {
        await this.board.update(nodes, edges);
      } else {
        // 重建：销毁旧实例，新建白板（层级方块布局 + 子树跟随拖动）
        this.board?.destroy();
        this.board = null;
        this.boardKey = key;
        this.boardContainer.empty();
        this.board = new CanvasBoard(this.boardContainer, {
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
        this.updateLinkToggle();
      }

      // 复合信息：选中框架子树状态聚合
      this.renderInfo();
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refreshBoard();
      }
    }
  }

  /** 复合信息：选中框架子树状态聚合 */
  private renderInfo(): void {
    this.infoEl.empty();
    if (!this.selectedFwId) return;
    const counts: Record<string, number> = {};
    let total = 0;    const walk = (id: string) => {
      const node = this.nodeCache.getNode(id);
      if (!node) return;
      total++;
      const st = node.state ?? 'plan';
      counts[st] = (counts[st] ?? 0) + 1;
      for (const child of this.nodeCache.getChildren(id)) {
        if (child.data && (isFrameworkKind(child.data.kind) || TXN_KINDS.includes(child.data.kind as NodeKind))) {
          walk(child.nodeId);
        }
      }
    };
    walk(this.selectedFwId);

    const done = counts['done'] ?? 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    this.infoEl.createEl('div', {
      cls: 'seqtk-route-info-text',
      text: `复合进度：${done}/${total} 完成（${pct}%）`,
    });
  }

  // ============================================================
  // 连线编辑（route）
  // ============================================================

  private handleEdgeAdd(s: string, t: string): void {
    const a = this.nodeCache.getNode(s);
    const b = this.nodeCache.getNode(t);
    if (!a || !b) return;
    new RouteDescModal(this.app, {
      fromDesc: a.desc,
      toDesc: b.desc,
      onConfirm: (desc) => {
        this.nodeCache.addRoute(s, t, desc);
        void this.refreshBoard();
      },
    }).open();
  }

  private handleEdgeRemove(s: string, t: string, directed: boolean, rel: string): void {
    if (rel !== 'route') {
      new Notice('从属树边为只读');
      return;
    }
    const a = this.nodeCache.getNode(s);
    new ConfirmModal(this.app, {
      title: '删除线路关联',
      message: `确认删除「${a?.desc ?? s}」到「${this.nodeCache.getNode(t)?.desc ?? t}」的线路关联？`,
      onConfirm: () => {
        this.nodeCache.removeRoute(s, t);
        void this.refreshBoard();
      },
    }).open();
  }

  // ============================================================
  // 右键菜单
  // ============================================================

  private showNodeMenu(nodeId: string, e: MouseEvent): void {
    const node = this.nodeCache.getNode(nodeId);
    if (!node) return;
    const menu = new Menu();
    const childKinds = isFrameworkKind(node.kind)
      ? ['framework-transaction', 'concept', 'checklist', 'event'] as NodeKind[]
      : (node.kind === 'checklist' ? ['item'] as NodeKind[] : [] as NodeKind[]);
    if (childKinds.length > 0) {
      menu.addItem((item) =>
        item.setTitle('新建子节点').setIcon('plus')
          .onClick(() => this.createChild(nodeId, node.kind, childKinds)));
    }
    menu.addItem((item) =>
      item.setTitle('编辑').setIcon('pencil')
        .onClick(() => this.openEdit(nodeId, node)));
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

  private createChild(parentId: string, parentKind: NodeKind, kinds: NodeKind[]): void {
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
        void this.fileManager.createNode(input.kind, data, '').then((nodeId) => {
          this.operationQueue.enqueueCacheOp(() => this.nodeCache.addNode(nodeId, data, ''));
          const parent = this.nodeCache.getNode(parentId);
          if (parent) {
            const follows = [...(parent.follows ?? []), nodeId];
            this.operationQueue.enqueue(
              () => this.nodeCache.updateNode(parentId, { follows }),
              async () => { await this.fileManager.updateNode(parent.kind, parentId, { follows }); },
            );
          }
          void this.refreshBoard();
        });
      },
    }).open();
  }

  private openEdit(nodeId: string, node: SeqtkNode): void {
    new TransactionEditModal(this.app, {
      node,
      onSubmit: (input) => {
        const updates: Partial<SeqtkNode> = {};
        if (input.desc !== node.desc) updates.desc = input.desc;
        if (Object.keys(updates).length === 0) return;
        this.operationQueue.enqueue(
          () => this.nodeCache.updateNode(nodeId, { ...updates, modify: new Date().toISOString() }),
          async () => { await this.fileManager.updateNode(node.kind, nodeId, updates); },
        );
      },
      onOpenFile: () => this.openNodeFile(nodeId),
    }).open();
  }

  private openNodeFile(nodeId: string): void {
    const node = this.nodeCache.getNode(nodeId);
    if (!node) return;
    const file = this.app.vault.getFileByPath(this.fileManager.getNodeFilePath(node.kind, nodeId));
    if (file) void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
  }

  private showBlankMenu(e: MouseEvent): void {
    const menu = new Menu();
    for (const k of ['concept', 'checklist', 'event'] as NodeKind[]) {
      menu.addItem((item) =>
        item.setTitle(`新建${NODE_KIND_LABELS[k]}`).setIcon('plus')
          .onClick(() => this.createChild(this.selectedFwId ?? '', 'framework-transaction', [k])));
    }
    menu.showAtMouseEvent(e);
  }

  // ============================================================
  // 布局缓存（插件数据目录 JSON，与其他白板视图共用文件）
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
