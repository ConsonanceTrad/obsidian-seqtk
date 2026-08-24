/**
 * TransactionView — 事务面板（已取代，保留作参考）
 *
 * 注意：本视图已被 DesignView（设计模式）取代，不再被 main.ts 引用。
 * 文件保留供参考，不参与类型检查（@ts-nocheck）。
 *
 * 旧功能说明（历史）：
 * 展示事务节点（project / checklist / item / event）的树形从属关系；
 * 支持创建、编辑、状态切换、级联删除。
 *
 * 数据流：
 *   视图操作 → OperationQueue（cacheOp 立即更新缓存+响应式快照 / fileOp 延迟写盘）
 *   → 重启后 NodeCache.initialize 从 MD 扫描重建，保证「重启读回一致」
 */
// @ts-nocheck

import { ItemView, MarkdownView, Menu, Notice, TFile, WorkspaceLeaf, getFrontMatterInfo } from 'obsidian';
import type { SeqtkNode, SeqtkState, TransactionKind, EventNature } from '../types/index';
import {
  NODE_KIND_LABELS,
  NODE_STATE_LABELS,
  STATE_VALUES,
  EVENT_NATURE_LABELS,
  isTransactionKind,
} from '../types/index';
import type { NodeCache } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import type { OperationQueue } from '../core/OperationQueue';
import {
  TransactionCreateModal,
  TransactionEditModal,
} from './components/TransactionModals';

export const VIEW_TYPE_TRANSACTION = 'seqtk-transaction';

/** 树形节点（仅事务类型） */
interface TxnTreeNode {
  nodeId: string;
  data: SeqtkNode;
  children: TxnTreeNode[];
}

export class TransactionView extends ItemView {
  private treeEl!: HTMLElement;
  private unsub: (() => void) | null = null;
  /** 展开状态（nodeId 集合，默认全部展开） */
  private expanded = new Set<string>();

  constructor(
    leaf: WorkspaceLeaf,
    private nodeCache: NodeCache,
    private fileManager: NodeFileManager,
    private operationQueue: OperationQueue,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_TRANSACTION;
  }

  getDisplayText(): string {
    return '事务面板';
  }

  getIcon(): string {
    return 'list-tree';
  }

  // ============================================================
  // 生命周期
  // ============================================================

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('seqtk-transaction-view');

    this.buildToolbar(container);
    this.treeEl = container.createDiv('seqtk-tree');

    // 订阅缓存快照，任何变更自动重渲染
    this.unsub = this.nodeCache.nodeStore.subscribe(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
  }

  // ============================================================
  // 工具栏
  // ============================================================

  private buildToolbar(container: HTMLElement): void {
    const toolbar = container.createDiv('seqtk-toolbar');

    toolbar.createEl('button', { text: '新建项目', cls: 'seqtk-btn' })
      .addEventListener('click', () => this.openCreate('concept'));
    toolbar.createEl('button', { text: '新建清单', cls: 'seqtk-btn' })
      .addEventListener('click', () => this.openCreate('checklist'));
    toolbar.createEl('button', { text: '刷新', cls: 'seqtk-btn seqtk-btn-ghost' })
      .addEventListener('click', async () => {
        if (!this.nodeCache.isInitialized) {
          new Notice('查询缓存尚未就绪，请稍候');
          return;
        }
        await this.nodeCache.verifyWithDisk(this.fileManager);
        new Notice('已从磁盘刷新');
      });
  }

  // ============================================================
  // 渲染
  // ============================================================

  private render(): void {
    this.treeEl.empty();

    // 缓存尚未初始化（懒加载，视图可能在初始化完成前被打开）：
    // 渲染占位，待 refreshStore 触发订阅回调后自动渲染真实数据
    if (!this.nodeCache.isInitialized) {
      this.treeEl.createEl('div', { cls: 'seqtk-empty', text: '正在加载查询缓存…' });
      return;
    }

    const conceptRoots = this.buildConceptTree();
    const checklistRoots = this.buildChecklistTree();

    const total = conceptRoots.length + checklistRoots.length;
    if (total === 0) {
      this.treeEl.createEl('div', { cls: 'seqtk-empty', text: '暂无事务节点，点击上方按钮新建' });
      return;
    }

    if (conceptRoots.length > 0) {
      this.treeEl.createEl('div', { cls: 'seqtk-section-title', text: `项目（${conceptRoots.length}）` });
      for (const root of conceptRoots) {
        this.renderNode(root, 0, this.treeEl);
      }
    }

    if (checklistRoots.length > 0) {
      this.treeEl.createEl('div', { cls: 'seqtk-section-title', text: `清单（${checklistRoots.length}）` });
      for (const root of checklistRoots) {
        this.renderNode(root, 0, this.treeEl);
      }
    }
  }

  /** 项目树：顶级 = 构想（concept），即项目类顶层节点 */
  private buildConceptTree(): TxnTreeNode[] {
    const roots: TxnTreeNode[] = [];
    for (const { nodeId, data } of this.nodeCache.getByKind('concept')) {
      roots.push(this.buildNode(nodeId, data));
    }
    return roots.sort((a, b) => (a.data.create ?? '').localeCompare(b.data.create ?? ''));
  }

  /** 清单树：顶级 = checklist，子节点为 item（仅两层） */
  private buildChecklistTree(): TxnTreeNode[] {
    const roots: TxnTreeNode[] = [];
    for (const { nodeId, data } of this.nodeCache.getByKind('checklist')) {
      roots.push(this.buildNode(nodeId, data));
    }
    return roots.sort((a, b) => (a.data.create ?? '').localeCompare(b.data.create ?? ''));
  }

  /** 递归构建树节点（仅保留事务类型子节点） */
  private buildNode(nodeId: string, data: SeqtkNode): TxnTreeNode {
    const children = this.nodeCache
      .getChildren(nodeId)
      .filter((c): c is { kind: TransactionKind; nodeId: string; data: SeqtkNode } =>
        !!c.data && isTransactionKind(c.data.kind))
      .map((c) => this.buildNode(c.nodeId, c.data))
      .sort((a, b) => (a.data.create ?? '').localeCompare(b.data.create ?? ''));
    return { nodeId, data, children };
  }

  private renderNode(node: TxnTreeNode, depth: number, container: HTMLElement): void {
    const row = container.createDiv('seqtk-row');
    row.style.paddingLeft = `${8 + depth * 18}px`;

    // 展开/折叠
    const hasChildren = node.children.length > 0;
    const toggle = row.createSpan('seqtk-toggle');
    if (hasChildren) {
      toggle.setText(this.expanded.has(node.nodeId) ? '▾' : '▸');
      toggle.addEventListener('click', () => this.toggleExpand(node.nodeId));
    }

    // 类型徽章（事件额外标注性质：事件·临时 / 事件·补录）
    const kindLabel = node.data.kind === 'event'
      ? `${NODE_KIND_LABELS[node.data.kind]}·${EVENT_NATURE_LABELS[node.data.nature ?? 'temp']}`
      : NODE_KIND_LABELS[node.data.kind];
    row.createEl('span', { cls: 'seqtk-kind-badge', text: kindLabel });

    // 名称（点击编辑）
    const desc = row.createEl('span', { cls: 'seqtk-desc', text: node.data.desc });
    desc.title = `${node.nodeId}\n点击编辑`;
    desc.addEventListener('click', () => this.openEdit(node.nodeId));

    // 状态徽章（点击切换）
    const state = node.data.state ?? 'plan';
    const stateBtn = row.createEl('button', {
      cls: `seqtk-state-badge state-${state}`,
      text: NODE_STATE_LABELS[state],
    });
    stateBtn.addEventListener('click', (e) => this.showStateMenu(e, node));

    // 右键菜单
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showRowMenu(e, node);
    });

    if (hasChildren && this.expanded.has(node.nodeId)) {
      for (const child of node.children) {
        this.renderNode(child, depth + 1, container);
      }
    }
  }

  private toggleExpand(nodeId: string): void {
    if (this.expanded.has(nodeId)) {
      this.expanded.delete(nodeId);
    } else {
      this.expanded.add(nodeId);
    }
    this.render();
  }

  // ============================================================
  // 创建
  // ============================================================

  /**
   * 打开创建模态框
   *
   * @param fixedKind 固定类型（工具栏按钮）
   * @param parentId  父节点 ID（创建下属时）
   * @param parentKind 父节点类型（决定可创建的子类型）
   */
  private openCreate(fixedKind?: TransactionKind, parentId?: string, parentKind?: TransactionKind): void {
    if (!this.nodeCache.isInitialized) {
      new Notice('查询缓存尚未就绪，请稍候');
      return;
    }
    let kinds: TransactionKind[];
    if (fixedKind) {
      kinds = [fixedKind];
    } else if (parentId && parentKind) {
      kinds = this.getChildKinds(parentKind);
    } else {
      // 无父节点：仅创建事务顶类型（构想 / 清单）；事件从属项目，不在此处独立创建
      kinds = ['concept', 'checklist'];
    }
    if (kinds.length === 0) return;

    new TransactionCreateModal(this.app, {
      kinds,
      onSubmit: (input) => this.createNode(input, parentId),
    }).open();
  }

  /**
   * 根据父节点类型返回可创建的子类型
   * 构想（concept）下当前可建事件（方向/目标/工序后续接入）；
   * project 为子类型占位（暂无 UI 入口）；checklist 下属为 item。
   */
  private getChildKinds(parentKind: TransactionKind): TransactionKind[] {
    switch (parentKind) {
      case 'concept':
        return ['event'];
      case 'project':
        return ['project', 'event'];
      case 'checklist':
        return ['item'];
      default:
        return [];
    }
  }

  /** 创建节点：写盘 → 维护双向关系 → 更新缓存 →（按选项）跳转文件编辑正文 */
  private async createNode(
    input: { kind: TransactionKind; desc: string; state: SeqtkState; nature?: EventNature; afterCreate: 'direct' | 'edit-body' },
    parentId?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const data = {
      kind: input.kind,
      desc: input.desc,
      open: true,
      state: input.state,
      create: now,
      modify: now,
      ...(input.kind === 'event' && input.nature ? { nature: input.nature } : {}),
      ...(parentId ? { parent: parentId } : {}),
    } as SeqtkNode;

    let nodeId: string;
    try {
      nodeId = await this.fileManager.createNode(input.kind, data, '');
    } catch (err) {
      console.error('[SeqTK] 创建节点失败:', err);
      new Notice(`[SeqTK] 创建节点失败: ${err}`);
      return;
    }

    // 子节点：在父节点 follows 中追加引用（双向维护）
    if (parentId) {
      const parent = this.nodeCache.getNode(parentId);
      if (parent) {
        const follows = [...(parent.follows ?? []), nodeId];
        this.operationQueue.enqueue(
          () => this.nodeCache.updateNode(parentId, { follows }),
          async () => { await this.fileManager.updateNode(parent.kind, parentId, { follows }); },
        );
      }
    }

    this.operationQueue.enqueueCacheOp(() => this.nodeCache.addNode(nodeId, data, ''));

    // 按选项决定是否跳转到新文件编辑正文（MD 渲染/补全由 Obsidian 编辑器提供）
    if (input.afterCreate === 'edit-body') {
      await this.openNodeFile(nodeId);
    }
  }

  // ============================================================
  // 编辑
  // ============================================================

  private openEdit(nodeId: string): void {
    if (!this.nodeCache.isInitialized) return;
    const node = this.nodeCache.getNode(nodeId);
    if (!node) return;

    new TransactionEditModal(this.app, {
      node,
      onSubmit: (input) => this.editNode(nodeId, node, input),
      onOpenFile: () => void this.openNodeFile(nodeId),
    }).open();
  }

  private editNode(
    nodeId: string,
    node: SeqtkNode,
    input: { desc: string; state: SeqtkState; nature?: EventNature },
  ): void {
    const updates: Partial<SeqtkNode> = {};
    if (input.desc !== node.desc) updates.desc = input.desc;
    if (input.state !== node.state) updates.state = input.state;
    if (node.kind === 'event' && input.nature && input.nature !== (node as any).nature) {
      updates.nature = input.nature;
    }

    if (Object.keys(updates).length === 0) return;

    this.operationQueue.enqueue(
      () => this.nodeCache.updateNode(nodeId, { ...updates, modify: new Date().toISOString() }),
      async () => { await this.fileManager.updateNode(node.kind, nodeId, updates); },
    );
  }

  /**
   * 在 Obsidian 编辑器中打开节点文件（source 模式），定位光标到正文起始
   *
   * 正文（Markdown）在编辑器中有渲染/补全体验，因此正文的添加与修改
   * 都在文件中进行，而非模态框。
   */
  private async openNodeFile(nodeId: string): Promise<void> {
    const node = this.nodeCache.getNode(nodeId);
    if (!node) return;
    const filePath = this.fileManager.getNodeFilePath(node.kind, nodeId);
    const file = this.app.vault.getFileByPath(filePath);
    if (!(file instanceof TFile)) return;

    const leaf = this.app.workspace.getLeaf('tab');
    if (!leaf) return;
    await leaf.openFile(file, { state: { mode: 'source' } });

    // 定位光标到 frontmatter 之后的正文起始处
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view.file?.path === filePath) {
        const info = getFrontMatterInfo(view.data);
        view.editor.setCursor(view.editor.offsetToPos(info.contentStart ?? 0));
      }
    } catch (err) {
      // 定位失败不影响打开文件
      console.warn('[SeqTK] 定位正文光标失败:', err);
    }
  }

  // ============================================================
  // 状态切换
  // ============================================================

  private showStateMenu(e: MouseEvent, node: TxnTreeNode): void {
    const menu = new Menu();
    for (const s of [...STATE_VALUES]) {
      menu.addItem((item) => {
        item.setTitle(NODE_STATE_LABELS[s]);
        if (node.data.state === s) item.setChecked(true);
        item.onClick(() => this.setNodeState(node.nodeId, s));
      });
    }
    menu.showAtMouseEvent(e);
  }

  private setNodeState(nodeId: string, state: SeqtkState): void {
    const node = this.nodeCache.getNode(nodeId);
    if (!node || node.state === state) return;
    this.operationQueue.enqueue(
      () => this.nodeCache.updateNode(nodeId, { state, modify: new Date().toISOString() }),
      async () => { await this.fileManager.updateNode(node.kind, nodeId, { state }); },
    );
  }

  // ============================================================
  // 删除 / 右键菜单
  // ============================================================

  private showRowMenu(e: MouseEvent, node: TxnTreeNode): void {
    const menu = new Menu();

    if (this.getChildKinds(node.data.kind as TransactionKind).length > 0) {
      menu.addItem((item) =>
        item.setTitle('新建子节点').setIcon('plus')
          .onClick(() => this.openCreate(undefined, node.nodeId, node.data.kind as TransactionKind)));
    }
    menu.addItem((item) =>
      item.setTitle('编辑').setIcon('pencil')
        .onClick(() => this.openEdit(node.nodeId)));
    menu.addItem((item) =>
      item.setTitle('切换状态').setIcon('refresh-cw')
        .onClick(() => this.showStateMenu(e, node)));
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle('删除').setIcon('trash')
        .onClick(() => this.deleteNodeTree(node)));

    menu.showAtMouseEvent(e);
  }

  /** 级联删除：先捕获子树结构，再同步清缓存、异步删文件 */
  private deleteNodeTree(node: TxnTreeNode): void {
    const collect = (n: TxnTreeNode): { kind: TransactionKind; nodeId: string }[] => [
      ...n.children.flatMap(collect),
      { kind: n.data.kind as TransactionKind, nodeId: n.nodeId },
    ];
    const targets = collect(node);

    this.operationQueue.enqueueCacheBatch(
      targets.map((t) => () => this.nodeCache.removeNode(t.nodeId)),
    );
    this.operationQueue.enqueueFileBatch(
      targets.map((t) => async () => { await this.fileManager.deleteNode(t.kind, t.nodeId); }),
    );

    new Notice(`已删除 ${targets.length} 个节点`);
  }
}
