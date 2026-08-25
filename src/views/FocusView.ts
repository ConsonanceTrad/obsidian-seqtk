/**
 * FocusView — 证据管理 · 聚焦模式
 *
 * 选择某个事务，白板阅览其中证据相互的关联关系（links 无向关联）。
 * - 左栏：事务选择（构想 / 清单 / 事项 / 事件）
 * - 右栏：CanvasBoard 白板，节点 = 该事务下证据（对象/条件/信息/状态），
 *   边 = 证据间 links；连线模式建边/断边双向维护 links
 * - 布局：cose 凝固定格 + 新证据增量插入关系区域边缘，位置存插件数据目录
 */

import { App, ItemView, Menu, Modal, Notice, Setting, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import type { NodeKind, SeqtkNode } from '../types/index';
import { NODE_KIND_LABELS, getCategoryOf } from '../types/index';
import type { NodeCache } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import type { OperationQueue } from '../core/OperationQueue';
import { describeCycleRule } from '../utils/cycleRuleParser';
import { formatShortDate } from '../utils/formatDate';
import { tooltipBodyText } from '../utils/tooltip';
import { CanvasBoard } from './components/CanvasBoard';
import type { BoardLayout, BoardPositions } from './components/CanvasBoard';
import { TransactionCreateModal, TransactionEditModal } from './components/TransactionModals';

export const VIEW_TYPE_FOCUS = 'seqtk-focus';

/** 证据类型 */
const EVIDENCE_KINDS: NodeKind[] = ['factor', 'requirement', 'clue', 'snapshot'];

/** 事务类型 */
const TXN_KINDS: NodeKind[] = ['concept', 'checklist', 'item', 'event'];

/** 布局缓存文件名（存放于插件用户数据文件夹 rootFolder 下） */
const LAYOUT_CACHE_FILE = 'layout-cache.json';

/** 确认弹窗 */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private opts: {
      title: string;
      message: string;
      onConfirm: () => void;
    },
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

export class FocusView extends ItemView {
  private leftEl!: HTMLElement;
  private rightEl!: HTMLElement;
  private boardContainer!: HTMLElement;
  private board: CanvasBoard | null = null;
  private unsub: (() => void) | null = null;
  private expanded = new Set<string>();
  private selectedTxnId: string | null = null;
  /** 白板当前对应的事务（用于增量更新判断） */
  private currentTxnId: string | null = null;
  /** 防止并发刷新（触发时若进行中则标记补跑，不丢弃刷新） */
  private refreshing = false;
  private refreshQueued = false;
  /** 标题栏连线模式开关按钮 */
  private linkToggleBtn: HTMLButtonElement | null = null;
  /** 当前聚焦画布上的全部节点 id（强关联事务/证据 + 弱关联证据），用于删除连线后的孤立判断 */
  private boardNodeIds = new Set<string>();

  constructor(
    leaf: WorkspaceLeaf,
    private nodeCache: NodeCache,
    private fileManager: NodeFileManager,
    private operationQueue: OperationQueue,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_FOCUS;
  }

  getDisplayText(): string {
    return '证据聚焦';
  }

  getIcon(): string {
    return 'network';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('seqtk-design-view');

    const split = container.createDiv('seqtk-split');
    this.leftEl = split.createDiv('seqtk-split-left');
    this.rightEl = split.createDiv('seqtk-split-right');

    this.unsub = this.nodeCache.nodeStore.subscribe(() => {
      this.renderLeft();
      this.refreshBoard();
    });
    this.renderLeft();
    this.refreshBoard();
  }

  async onClose(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
    this.board?.destroy();
    this.board = null;
  }

  // ============================================================
  // 左栏：事务选择
  // ============================================================

  private renderLeft(): void {
    this.leftEl.empty();
    this.leftEl.createEl('div', { cls: 'seqtk-split-title', text: '事务' });

    if (!this.nodeCache.isInitialized) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '正在加载缓存…' });
      return;
    }

    let total = 0;
    for (const kind of ['concept', 'checklist'] as NodeKind[]) {
      const roots = this.nodeCache.getByKind(kind);
      if (roots.length === 0) continue;
      this.leftEl.createEl('div', { cls: 'seqtk-section-title', text: NODE_KIND_LABELS[kind] });
      for (const { nodeId, data } of roots) {
        this.renderTxnNode(nodeId, data, 0);
        total++;
      }
    }
    if (total === 0) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '暂无事务' });
    }
  }

  private renderTxnNode(nodeId: string, data: SeqtkNode, depth: number, inExpandedTree = false): void {
    const row = this.leftEl.createDiv('seqtk-frame-item');
    if (this.selectedTxnId === nodeId) row.addClass('seqtk-frame-item-active');
    row.style.paddingLeft = `${8 + depth * 14}px`;
    const isExpanded = this.expanded.has(nodeId);
    if (isExpanded) row.addClass('seqtk-row-expanded');
    if (inExpandedTree) row.addClass('seqtk-row-in-expanded');

    // 左栏仅展示事务类子节点，证据节点不在此显示
    const children = this.nodeCache.getChildren(nodeId)
      .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } =>
        !!c.data && TXN_KINDS.includes(c.data.kind as NodeKind));
    const hasChildren = children.length > 0;

    // 折叠标识小方块（有子项时显示；展开态由 CSS 隐藏）
    if (hasChildren) row.createSpan('seqtk-collapse-mark');

    // 左栏：行单击=展开/折叠（直接响应，无延迟）；行末按钮=在右侧打开
    row.addEventListener('click', () => {
      if (hasChildren) this.toggleExpand(nodeId);
    });

    row.createEl('span', { cls: `seqtk-kind-badge kind-${getCategoryOf(data.kind)}`, text: NODE_KIND_LABELS[data.kind] });

    const desc = row.createEl('span', { cls: 'seqtk-desc', text: data.desc });
    // 节点行悬浮：仅显示目标时间点与重复规则（都无则不显示）
    const hints: string[] = [];
    if ((data as any).expectedTime) hints.push(`目标时间: ${(data as any).expectedTime}`);
    if ((data as any).expectedRepeat) hints.push(`重复规则: ${(data as any).expectedRepeat}`);
    if (hints.length > 0) setTooltip(desc, hints.join(' · '));

    // 正文预览（节点名后，超长省略截断）
    const bodyPreview = this.nodeCache.getNodeBody(nodeId);
    if (bodyPreview) {
      const preview = row.createEl('span', { cls: 'seqtk-body-preview', text: bodyPreview });
      setTooltip(preview, tooltipBodyText(bodyPreview));
    }
    // 弹性间隔：填充剩余空间，使右侧徽章/打开按钮靠右
    row.createSpan('seqtk-spacer');

    // 预期属性徽章（事务节点）
    if ((data as any).expectedTime) {
      const timeBadge = row.createEl('span', { cls: 'seqtk-expected-badge', text: `🗓 ${formatShortDate((data as any).expectedTime)}` });
      setTooltip(timeBadge, `预期时间: ${(data as any).expectedTime}`);
    }
    if ((data as any).expectedRepeat) {
      const repeatBadge = row.createEl('span', { cls: 'seqtk-expected-badge', text: `♺ ${describeCycleRule((data as any).expectedRepeat)}` });
      setTooltip(repeatBadge, `预期重复: ${(data as any).expectedRepeat}`);
    }

    // 行末：在右侧打开（选中并在右侧显现）
    const openBtn = row.createEl('button', { cls: 'seqtk-open-btn' });
    setTooltip(openBtn, '在右侧打开');
    setIcon(openBtn, 'right-arrow');
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectedTxnId = nodeId;
      this.renderLeft();
      this.refreshBoard();
    });

    if (hasChildren && isExpanded) {
      for (const c of children) {
        this.renderTxnNode(c.nodeId, c.data, depth + 1, true);
      }
    }
  }

  private toggleExpand(nodeId: string): void {
    if (this.expanded.has(nodeId)) this.expanded.delete(nodeId);
    else this.expanded.add(nodeId);
    this.renderLeft();
  }

  // ============================================================
  // 右栏：白板
  // ============================================================

  private async refreshBoard(): Promise<void> {
    if (this.refreshing) {
      // 进行中：标记补跑，完成后再次刷新，避免丢失拖拽等触发的更新
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      if (!this.nodeCache.isInitialized) return;

      const txnId = this.selectedTxnId;
      if (txnId === null || !this.nodeCache.getNode(txnId)) {
        // 无选中：清空白板
        this.currentTxnId = null;
        this.board?.destroy();
        this.board = null;
        this.rightEl.empty();
        return;
      }

      // 收集白板数据：中心事务 + 子事务（递归）+ 各事务直属证据；
      // 边：事务→证据/子事务 的 follows 有向边 + 证据间 links 无向边
      const txnNodes = new Map<string, SeqtkNode>();
      const evNodes = new Map<string, SeqtkNode>();
      const followsEdges: { source: string; target: string; directed: true }[] = [];
      const linksEdges: { source: string; target: string }[] = [];

      const collect = (txnId: string, parentId: string | null) => {
        const node = this.nodeCache.getNode(txnId);
        if (!node) return;
        txnNodes.set(txnId, node);
        if (parentId) followsEdges.push({ source: parentId, target: txnId, directed: true });
        for (const child of this.nodeCache.getChildren(txnId)) {
          if (!child.data) continue;
          if (TXN_KINDS.includes(child.data.kind as NodeKind)) {
            collect(child.nodeId, txnId);
          } else if (EVIDENCE_KINDS.includes(child.data.kind as NodeKind)) {
            evNodes.set(child.nodeId, child.data);
            followsEdges.push({ source: txnId, target: child.nodeId, directed: true });
          }
        }
      };
      collect(txnId, null);

      // 弱关联证据：递归收集任意层级——凡与集合内证据存在 links
      // 连接的证据都纳入（不直接从属事务也可）
      const seenEv = new Set(evNodes.keys());
      let frontier = [...seenEv];
      while (frontier.length > 0) {
        const next: string[] = [];
        for (const evId of frontier) {
          const data = this.nodeCache.getNode(evId);
          if (!data) continue;
          for (const linkId of data.links ?? []) {
            if (seenEv.has(linkId)) continue;
            const weak = this.nodeCache.getNode(linkId);
            if (weak && EVIDENCE_KINDS.includes(weak.kind as NodeKind)) {
              seenEv.add(linkId);
              evNodes.set(linkId, weak);
              next.push(linkId);
            }
          }
        }
        frontier = next;
      }

      // 证据间 links（含弱关联证据，双向去重）
      const allEvIds = new Set(evNodes.keys());
      const seen = new Set<string>();
      for (const [evId, data] of evNodes) {
        for (const linkId of data.links ?? []) {
          if (!allEvIds.has(linkId)) continue;
          const key = [evId, linkId].sort().join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          linksEdges.push({ source: evId, target: linkId });
        }
      }

      const nodes = [
        ...Array.from(txnNodes, ([id, d]) => ({ id, kind: d.kind, desc: d.desc })),
        ...Array.from(evNodes, ([id, d]) => ({ id, kind: d.kind, desc: d.desc })),
      ];
      const edges = [...followsEdges, ...linksEdges];
      // 记录画布节点集：删除连线时据此判断证据是否仍与强/弱关联节点相连
      this.boardNodeIds = new Set(nodes.map((n) => n.id));

      // 同一事务且白板已存在 → 增量更新（新节点插入关系区域边缘），不重建
      if (this.board && this.currentTxnId === txnId) {
        await this.board.update(nodes, edges);
        return;
      }

      // 首次或切换事务 → 安全重建：先销毁旧实例，再清空容器
      this.board?.destroy();
      this.board = null;
      this.currentTxnId = txnId;
      this.rightEl.empty();

      const txn = this.nodeCache.getNode(txnId)!;
      // 标题行：左侧标题 + 右侧连线模式开关
      const titleRow = this.rightEl.createDiv('seqtk-board-titlebar');
      titleRow.createEl('div', {
        cls: 'seqtk-split-title',
        text: `${NODE_KIND_LABELS[txn.kind]} · ${txn.desc}`,
      });
      this.linkToggleBtn = titleRow.createEl('button', { cls: 'seqtk-btn seqtk-btn-small', text: '连线模式' });
      this.linkToggleBtn.addEventListener('click', () => {
        if (!this.board) return;
        const next = !this.board.isLinkingMode;
        this.board.setLinkingMode(next);
        this.updateLinkToggle();
      });

      this.boardContainer = this.rightEl.createDiv('seqtk-board');
      this.board = new CanvasBoard(this.boardContainer, {
        cacheKey: `focus-${txnId}`,
        loadLayout: (key) => this.loadLayout(key),
        saveLayout: (key, positions) => this.saveLayout(key, positions),
        onEdgeAdd: (s, t) => this.handleEdgeAdd(s, t),
        onEdgeRemove: (s, t, directed) => this.handleEdgeRemove(s, t, directed),
        onNodeDblClick: (id) => this.openNodeFile(id),
        onNodeContextMenu: (id, e) => this.showNodeMenu(id, e),
      });
      await this.board.init(nodes, edges);
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refreshBoard();
      }
    }
  }

  /** 更新连线模式开关的显示状态 */
  private updateLinkToggle(): void {
    if (!this.linkToggleBtn) return;
    const on = this.board?.isLinkingMode ?? false;
    this.linkToggleBtn.setText(on ? '退出连线' : '连线模式');
    this.linkToggleBtn.toggleClass('seqtk-btn-active', on);
  }

  /** 创建指定类型证据并挂到指定事务（默认当前选中事务；双向维护 follows + parent） */
  private createEvidence(kind: NodeKind, txnId?: string): void {
    const targetTxnId = txnId ?? this.selectedTxnId;
    if (!this.nodeCache.isInitialized || targetTxnId === null) {
      new Notice('请先在左侧选择一个事务');
      return;
    }
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
          parent: targetTxnId,
        } as SeqtkNode;
        void this.fileManager.createNode(input.kind, data, '').then((nodeId) => {
          this.operationQueue.enqueueCacheOp(() => this.nodeCache.addNode(nodeId, data, ''));
          this.appendFollows(targetTxnId, nodeId);
          // 显式刷新当前画布，确保新节点立即显现
          void this.refreshBoard();
          if (input.afterCreate === 'edit-body') {
            const file = this.app.vault.getFileByPath(this.fileManager.getNodeFilePath(input.kind, nodeId));
            if (file) void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
          }
        });
      },
    }).open();
  }

  /** 在父节点 follows 中追加引用（双向维护） */
  private appendFollows(parentId: string, childId: string): void {
    const parent = this.nodeCache.getNode(parentId);
    if (!parent) return;
    const follows = [...(parent.follows ?? []), childId];
    this.operationQueue.enqueue(
      () => this.nodeCache.updateNode(parentId, { follows }),
      async () => { await this.fileManager.updateNode(parent.kind, parentId, { follows }); },
    );
  }

  // ============================================================
  // 链接维护（双向，与追加模式一致）
  // ============================================================

  /** 连线模式建边：按两端类型分流 */
  private handleEdgeAdd(s: string, t: string): void {
    const a = this.nodeCache.getNode(s);
    const b = this.nodeCache.getNode(t);
    if (!a || !b) return;
    const aEv = EVIDENCE_KINDS.includes(a.kind as NodeKind);
    const bEv = EVIDENCE_KINDS.includes(b.kind as NodeKind);
    const aTxn = TXN_KINDS.includes(a.kind as NodeKind);
    const bTxn = TXN_KINDS.includes(b.kind as NodeKind);

    if (aEv && bEv) {
      this.addLink(s, t);
    } else if (aEv && bTxn) {
      this.attachEvidenceToTxn(s, t);
    } else if (aTxn && bEv) {
      this.attachEvidenceToTxn(t, s);
    } else {
      new Notice('事务间不建立链接');
    }
  }

  /** 连线模式删边：links 直接断开；follows 仅证据-事务可删（最后一条需确认） */
  private handleEdgeRemove(s: string, t: string, directed: boolean): void {
    if (!directed) {
      this.removeLink(s, t);
      return;
    }
    // follows 有向边：一端证据一端事务才可删；事务间为只读
    const a = this.nodeCache.getNode(s);
    const b = this.nodeCache.getNode(t);
    if (!a || !b) return;
    const aEv = EVIDENCE_KINDS.includes(a.kind as NodeKind);
    const bEv = EVIDENCE_KINDS.includes(b.kind as NodeKind);
    const aTxn = TXN_KINDS.includes(a.kind as NodeKind);
    const bTxn = TXN_KINDS.includes(b.kind as NodeKind);

    let evId: string | null = null;
    let txnId: string | null = null;
    if (aEv && bTxn) { evId = s; txnId = t; }
    else if (aTxn && bEv) { evId = t; txnId = s; }
    else {
      new Notice('事务间的从属关系为只读');
      return;
    }

    // 若删除该边后，证据与当前聚焦画布上的任何节点（强/弱关联）都不再相连
    // → 会从当前展示中消失，需确认；否则直接断开（仍通过其它边留在画布上）
    if (this.wouldBeOrphanInBoard(evId, txnId)) {
      const ev = this.nodeCache.getNode(evId)!;
      new ConfirmModal(this.app, {
        title: '删除从属连线',
        message: `「${ev.desc}」将不再与当前聚焦内容有任何连接，会从当前展示中消失。确认删除？`,
        onConfirm: () => this.removeEvidenceTxnLink(evId!, txnId!),
      }).open();
    } else {
      this.removeEvidenceTxnLink(evId, txnId);
    }
  }

  /**
   * 判断证据在删除与 txnId 的这条从属连线后，是否与当前聚焦画布上的
   * 任何节点（强关联事务/证据或弱关联证据）都不再相连（将被孤立）。
   *
   * 连接判定：
   * - 被画布内其它事务/框架 follows 引用；
   * - 与画布内其它节点存在 links 无向关联。
   */
  private wouldBeOrphanInBoard(evId: string, txnId: string): boolean {
    const ev = this.nodeCache.getNode(evId);
    if (!ev) return false;
    for (const id of this.boardNodeIds) {
      if (id === evId || id === txnId) continue; // txnId 的这条引用即将被删除，不计
      const n = this.nodeCache.getNode(id);
      if (!n) continue;
      if ((n.follows ?? []).includes(evId)) return false; // 仍被其它事务/框架引用
      if ((ev.links ?? []).includes(id)) return false;     // 仍与画布内节点存在 links
    }
    return true;
  }

  /** 将证据挂到事务（证据 parent + 事务 follows 双向维护） */
  private attachEvidenceToTxn(evId: string, txnId: string): void {
    const ev = this.nodeCache.getNode(evId);
    const txn = this.nodeCache.getNode(txnId);
    if (!ev || !txn) return;
    if ((ev as any).parent === txnId || (txn.follows ?? []).includes(evId)) {
      new Notice('该证据已从属于此事务');
      return;
    }
    const follows = [...(txn.follows ?? []), evId];
    this.operationQueue.enqueue(
      () => {
        this.nodeCache.updateNode(evId, { parent: txnId });
        this.nodeCache.updateNode(txnId, { follows });
      },
      async () => {
        await this.fileManager.updateNode(ev.kind, evId, { parent: txnId });
        await this.fileManager.updateNode(txn.kind, txnId, { follows });
      },
    );
    new Notice('已将该证据添加到事务');
  }

  /** 移除证据与某事务的从属连线（证据 parent + 事务 follows） */
  private removeEvidenceTxnLink(evId: string, txnId: string): void {
    const ev = this.nodeCache.getNode(evId);
    const txn = this.nodeCache.getNode(txnId);
    if (!ev || !txn) return;
    const updates: Partial<SeqtkNode> = {};
    if ((ev as any).parent === txnId) {
      (updates as any).parent = undefined;
    }
    const txnFollows = (txn.follows ?? []).filter((id) => id !== evId);
    this.operationQueue.enqueue(
      () => {
        if (Object.keys(updates).length > 0) this.nodeCache.updateNode(evId, updates);
        this.nodeCache.updateNode(txnId, { follows: txnFollows });
      },
      async () => {
        if (Object.keys(updates).length > 0) await this.fileManager.updateNode(ev.kind, evId, updates);
        await this.fileManager.updateNode(txn.kind, txnId, { follows: txnFollows });
      },
    );
    new Notice('已移除从属连线');
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
  // 节点操作
  // ============================================================

  private openNodeFile(nodeId: string): void {
    const node = this.nodeCache.getNode(nodeId);
    if (!node) return;
    const file = this.app.vault.getFileByPath(this.fileManager.getNodeFilePath(node.kind, nodeId));
    if (file) void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
  }

  private showNodeMenu(nodeId: string, e: MouseEvent): void {
    const node = this.nodeCache.getNode(nodeId);
    if (!node) return;
    const isEv = EVIDENCE_KINDS.includes(node.kind as NodeKind);
    const isTxn = TXN_KINDS.includes(node.kind as NodeKind);
    const menu = new Menu();

    if (isEv) {
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
    }

    if (isTxn) {
      menu.addItem((item) =>
        item.setTitle('新建证据').setIcon('plus')
          .onClick(() => this.createEvidenceAtTxn(nodeId)));
    }

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

  /** 右键事务：新建证据（四类可选），挂到该事务 */
  private createEvidenceAtTxn(txnId: string): void {
    if (!this.nodeCache.isInitialized) return;
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
          parent: txnId,
        } as SeqtkNode;
        void this.fileManager.createNode(input.kind, data, '').then((nodeId) => {
          this.operationQueue.enqueueCacheOp(() => this.nodeCache.addNode(nodeId, data, ''));
          this.appendFollows(txnId, nodeId);
          void this.refreshBoard();
        });
      },
    }).open();
  }

  /** 右键证据：创建无指向证据并自动与该证据建立 links（双向，不挂事务） */
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
          // 仅与源证据建立 links（双向），不连接任何事务节点
          this.addLink(sourceId, nodeId);
          void this.refreshBoard();
          new Notice('已创建关联证据');
        });
      },
    }).open();
  }

  // ============================================================
  // 布局缓存（插件数据目录 JSON）
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
      // 兼容旧格式（直接为位置映射 {id:{x,y}}）与新格式（{positions, viewport}）
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
        // 确保用户数据目录存在后创建文件（Obsidian adapter.write 无法创建不存在的文件）
        await this.fileManager.ensureRootFolder();
        await this.app.vault.create(path, json);
      }
    } catch (err) {
      console.warn('[SeqTK] 写入布局缓存失败:', err);
    }
  }
}
