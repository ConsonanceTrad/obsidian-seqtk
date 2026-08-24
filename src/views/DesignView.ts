/**
 * DesignView — 事务设计 · 设计模式
 *
 * 双栏布局：
 * - 左栏：框架-子框架结构树（事务框架 / 信息框架），支持子框架嵌套与创建
 * - 右栏：选中框架的内部节点（事务 + 证据）统一编辑；未选中时显示
 *   「全部事务总览」（构想 / 清单 / 事项 / 事件树），保留原事务面板能力
 *
 * 支持操作：
 * - 创建框架 / 子框架，创建框架内事务与证据节点（双向维护 follows + parent）
 * - 节点行编辑（名称 / 状态 / 事件性质）、状态切换、级联删除
 * - 正文编辑跳转文件（MD 渲染由 Obsidian 编辑器提供）
 *
 * 数据流：
 *   视图操作 → OperationQueue（cacheOp 立即更新缓存+响应式快照 / fileOp 延迟写盘）
 *   → 重启后 NodeCache.initialize 从 MD 扫描重建，保证「重启读回一致」
 */

import { ItemView, MarkdownView, Menu, Notice, TFile, WorkspaceLeaf, getFrontMatterInfo } from 'obsidian';
import type { NodeKind, SeqtkNode, SeqtkState, EventNature } from '../types/index';
import {
  NODE_KIND_LABELS,
  NODE_STATE_LABELS,
  STATE_VALUES,
  EVENT_NATURE_LABELS,
  isFrameworkKind,
} from '../types/index';
import type { NodeCache } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import type { OperationQueue } from '../core/OperationQueue';
import {
  TransactionCreateModal,
  TransactionEditModal,
  kindUsesState,
} from './components/TransactionModals';

export const VIEW_TYPE_DESIGN = 'seqtk-design';

/** 树形节点 */
interface TreeNode {
  nodeId: string;
  data: SeqtkNode;
  children: TreeNode[];
}

export class DesignView extends ItemView {
  private leftEl!: HTMLElement;
  private rightEl!: HTMLElement;
  private unsub: (() => void) | null = null;
  /** 展开状态（nodeId 集合，默认全部展开） */
  private expanded = new Set<string>();
  /** 当前选中的框架 nodeId；null 表示「全部事务总览」 */
  private selectedFrameworkId: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private nodeCache: NodeCache,
    private fileManager: NodeFileManager,
    private operationQueue: OperationQueue,
  ) {
    super(leaf);
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
  // 生命周期
  // ============================================================

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('seqtk-design-view');

    const split = container.createDiv('seqtk-split');
    this.leftEl = split.createDiv('seqtk-split-left');
    this.rightEl = split.createDiv('seqtk-split-right');

    // 空白区域右键菜单（创建子节点快捷入口）
    this.leftEl.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.seqtk-frame-item')) return;
      e.preventDefault();
      this.showLeftBlankMenu(e);
    });
    this.rightEl.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.seqtk-row')) return;
      e.preventDefault();
      this.showRightBlankMenu(e);
    });

    this.unsub = this.nodeCache.nodeStore.subscribe(() => {
      this.renderLeft();
      this.renderRight();
    });
    this.renderLeft();
    this.renderRight();
  }

  /** 左栏空白右键：新建框架 */
  private showLeftBlankMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle('新建事务框架').setIcon('folder-plus')
        .onClick(() => this.openCreate('framework-transaction')));
    menu.addItem((item) =>
      item.setTitle('新建信息框架').setIcon('folder-plus')
        .onClick(() => this.openCreate('framework-info')));
    menu.showAtMouseEvent(e);
  }

  /** 右栏空白右键：按当前上下文创建节点 */
  private showRightBlankMenu(e: MouseEvent): void {
    const menu = new Menu();
    const fwId = this.selectedFrameworkId;

    if (fwId !== null) {
      // 选中框架：创建该框架可容纳的子节点
      const fw = this.nodeCache.getNode(fwId);
      if (fw) {
        const kinds = this.getChildKinds(fw.kind);
        for (const k of kinds) {
          menu.addItem((item) =>
            item.setTitle(`新建${NODE_KIND_LABELS[k]}`).setIcon('plus')
              .onClick(() => this.openCreate(k, fwId)));
        }
      }
    } else {
      // 全部事务总览：创建顶类型
      menu.addItem((item) =>
        item.setTitle('新建构想').setIcon('plus')
          .onClick(() => this.openCreate('concept')));
      menu.addItem((item) =>
        item.setTitle('新建清单').setIcon('plus')
          .onClick(() => this.openCreate('checklist')));
      menu.addSeparator();
      menu.addItem((item) =>
        item.setTitle('新建事务框架').setIcon('folder-plus')
          .onClick(() => this.openCreate('framework-transaction')));
      menu.addItem((item) =>
        item.setTitle('新建信息框架').setIcon('folder-plus')
          .onClick(() => this.openCreate('framework-info')));
    }

    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle('从磁盘刷新').setIcon('refresh-cw')
        .onClick(async () => {
          if (!this.nodeCache.isInitialized) {
            new Notice('查询缓存尚未就绪，请稍候');
            return;
          }
          await this.nodeCache.verifyWithDisk(this.fileManager);
          new Notice('已从磁盘刷新');
        }));

    menu.showAtMouseEvent(e);
  }

  async onClose(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
  }

  // ============================================================
  // 左栏：框架树
  // ============================================================

  private renderLeft(): void {
    this.leftEl.empty();
    this.leftEl.createEl('div', { cls: 'seqtk-split-title', text: '框架' });

    if (!this.nodeCache.isInitialized) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '正在加载缓存…' });
      return;
    }

    // 「全部事务」入口
    const allItem = this.leftEl.createDiv('seqtk-frame-item');
    if (this.selectedFrameworkId === null) {
      allItem.addClass('seqtk-frame-item-active');
    }
    allItem.createEl('span', { cls: 'seqtk-kind-badge', text: '总览' });
    allItem.createEl('span', { cls: 'seqtk-desc', text: '全部事务' });
    allItem.addEventListener('click', () => {
      this.selectedFrameworkId = null;
      this.renderLeft();
      this.renderRight();
    });

    const roots = this.buildFrameworkTree();
    if (roots.length === 0) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '暂无框架，右键空白处新建' });
      return;
    }

    for (const root of roots) {
      this.renderFrameNode(root, 0);
    }
  }

  /** 框架树：顶级 = 无框架父节点的框架（事务框架 / 信息框架），递归子框架 */
  private buildFrameworkTree(): TreeNode[] {
    const roots: TreeNode[] = [];
    for (const kind of ['framework-transaction', 'framework-info'] as NodeKind[]) {
      for (const { nodeId, data } of this.nodeCache.getByKind(kind)) {
        const parent = this.nodeCache.getParent(nodeId);
        const parentData = parent ? this.nodeCache.getNode(parent.nodeId) : undefined;
        if (parentData && isFrameworkKind(parentData.kind)) continue;
        roots.push(this.buildFrameworkNode(nodeId, data));
      }
    }
    return roots.sort((a, b) => (a.data.create ?? '').localeCompare(b.data.create ?? ''));
  }

  private buildFrameworkNode(nodeId: string, data: SeqtkNode): TreeNode {
    const children = this.nodeCache
      .getChildren(nodeId)
      .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } =>
        !!c.data && isFrameworkKind(c.data.kind))
      .map((c) => this.buildFrameworkNode(c.nodeId, c.data))
      .sort((a, b) => (a.data.create ?? '').localeCompare(b.data.create ?? ''));
    return { nodeId, data, children };
  }

  private renderFrameNode(node: TreeNode, depth: number): void {
    const row = this.leftEl.createDiv('seqtk-frame-item');
    if (this.selectedFrameworkId === node.nodeId) {
      row.addClass('seqtk-frame-item-active');
    }
    row.style.paddingLeft = `${8 + depth * 14}px`;

    const hasChildren = node.children.length > 0;
    const toggle = row.createSpan('seqtk-toggle');
    if (hasChildren) {
      toggle.setText(this.expanded.has(node.nodeId) ? '▾' : '▸');
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleExpand(node.nodeId);
      });
    }

    row.createEl('span', { cls: 'seqtk-kind-badge', text: NODE_KIND_LABELS[node.data.kind] });
    row.createEl('span', { cls: 'seqtk-desc', text: node.data.desc });
    row.addEventListener('click', () => {
      this.selectedFrameworkId = node.nodeId;
      this.renderLeft();
      this.renderRight();
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showFrameMenu(e, node);
    });

    if (hasChildren && this.expanded.has(node.nodeId)) {
      for (const child of node.children) {
        this.renderFrameNode(child, depth + 1);
      }
    }
  }

  private showFrameMenu(e: MouseEvent, node: TreeNode): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle('新建子框架').setIcon('folder-plus')
        .onClick(() => this.openCreate('framework-transaction', node.nodeId)));
    menu.addItem((item) =>
      item.setTitle('编辑').setIcon('pencil')
        .onClick(() => this.openEdit(node.nodeId)));
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle('删除').setIcon('trash')
        .onClick(() => this.deleteNodeTree(node)));
    menu.showAtMouseEvent(e);
  }

  // ============================================================
  // 右栏：节点列表
  // ============================================================

  private renderRight(): void {
    this.rightEl.empty();

    if (!this.nodeCache.isInitialized) {
      this.rightEl.createEl('div', { cls: 'seqtk-empty', text: '正在加载缓存…' });
      return;
    }

    // 未选中框架 → 全部事务总览
    if (this.selectedFrameworkId === null) {
      this.renderAllOverview();
      return;
    }

    const framework = this.nodeCache.getNode(this.selectedFrameworkId);
    if (!framework) {
      this.selectedFrameworkId = null;
      this.renderAllOverview();
      return;
    }

    this.rightEl.createEl('div', {
      cls: 'seqtk-split-title',
      text: `${NODE_KIND_LABELS[framework.kind]} · ${framework.desc}`,
    });

    const roots = this.buildInnerTree(this.selectedFrameworkId);
    if (roots.length === 0) {
      this.rightEl.createEl('div', {
        cls: 'seqtk-empty',
        text: '该框架暂无内部节点\n在右栏空白处右键可创建子节点',
      });
      return;
    }
    for (const root of roots) {
      this.renderNode(root, 0, this.rightEl);
    }
  }

  /** 全部事务总览：构想树 + 清单树 */
  private renderAllOverview(): void {
    this.rightEl.createEl('div', { cls: 'seqtk-split-title', text: '全部事务' });

    const conceptRoots = this.buildConceptTree();
    const checklistRoots = this.buildChecklistTree();
    if (conceptRoots.length === 0 && checklistRoots.length === 0) {
      this.rightEl.createEl('div', {
        cls: 'seqtk-empty',
        text: '暂无事务节点\n在右栏空白处右键新建',
      });
      return;
    }

    if (conceptRoots.length > 0) {
      this.rightEl.createEl('div', { cls: 'seqtk-section-title', text: `项目（${conceptRoots.length}）` });
      for (const root of conceptRoots) {
        this.renderNode(root, 0, this.rightEl);
      }
    }
    if (checklistRoots.length > 0) {
      this.rightEl.createEl('div', { cls: 'seqtk-section-title', text: `清单（${checklistRoots.length}）` });
      for (const root of checklistRoots) {
        this.renderNode(root, 0, this.rightEl);
      }
    }
  }

  /** 构想树（顶级 = 所有 concept） */
  private buildConceptTree(): TreeNode[] {
    const roots: TreeNode[] = [];
    for (const { nodeId, data } of this.nodeCache.getByKind('concept')) {
      roots.push(this.buildNode(nodeId, data));
    }
    return roots.sort((a, b) => (a.data.create ?? '').localeCompare(b.data.create ?? ''));
  }

  /** 清单树（顶级 = 所有 checklist） */
  private buildChecklistTree(): TreeNode[] {
    const roots: TreeNode[] = [];
    for (const { nodeId, data } of this.nodeCache.getByKind('checklist')) {
      roots.push(this.buildNode(nodeId, data));
    }
    return roots.sort((a, b) => (a.data.create ?? '').localeCompare(b.data.create ?? ''));
  }

  /** 递归构建树节点（所有类型子节点） */
  private buildNode(nodeId: string, data: SeqtkNode): TreeNode {
    const children = this.nodeCache
      .getChildren(nodeId)
      .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } => !!c.data)
      .map((c) => this.buildNode(c.nodeId, c.data))
      .sort((a, b) => (a.data.create ?? '').localeCompare(b.data.create ?? ''));
    return { nodeId, data, children };
  }

  /** 选中框架的内部节点树（非框架子节点：事务 + 证据） */
  private buildInnerTree(frameworkId: string): TreeNode[] {
    const roots: TreeNode[] = [];
    for (const child of this.nodeCache.getChildren(frameworkId)) {
      if (!child.data || isFrameworkKind(child.data.kind)) continue;
      roots.push(this.buildNode(child.nodeId, child.data));
    }
    return roots.sort((a, b) => (a.data.create ?? '').localeCompare(b.data.create ?? ''));
  }

  // ============================================================
  // 节点行渲染
  // ============================================================

  private renderNode(node: TreeNode, depth: number, container: HTMLElement): void {
    const row = container.createDiv('seqtk-row');
    row.style.paddingLeft = `${8 + depth * 18}px`;

    const hasChildren = node.children.length > 0;
    const toggle = row.createSpan('seqtk-toggle');
    if (hasChildren) {
      toggle.setText(this.expanded.has(node.nodeId) ? '▾' : '▸');
      toggle.addEventListener('click', () => this.toggleExpand(node.nodeId));
    }

    // 类型徽章（事件标注性质；状态节点标注时间点）
    let kindLabel = NODE_KIND_LABELS[node.data.kind];
    if (node.data.kind === 'event') {
      kindLabel = `${kindLabel}·${EVENT_NATURE_LABELS[node.data.nature ?? 'temp']}`;
    } else if (node.data.kind === 'snapshot' && (node.data as any).at) {
      kindLabel = `${kindLabel}·${String((node.data as any).at).slice(5, 16)}`;
    }
    row.createEl('span', { cls: 'seqtk-kind-badge', text: kindLabel });

    const desc = row.createEl('span', { cls: 'seqtk-desc', text: node.data.desc });
    desc.title = `${node.nodeId}\n点击编辑`;
    desc.addEventListener('click', () => this.openEdit(node.nodeId));

    // 状态徽章（仅框架/事务显示）
    if (kindUsesState(node.data.kind)) {
      const state = node.data.state ?? 'plan';
      const stateBtn = row.createEl('button', {
        cls: `seqtk-state-badge state-${state}`,
        text: NODE_STATE_LABELS[state],
      });
      stateBtn.addEventListener('click', (e) => this.showStateMenu(e, node));
    }

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
    this.renderLeft();
    this.renderRight();
  }

  // ============================================================
  // 创建
  // ============================================================

  /**
   * 打开创建模态框
   *
   * @param fixedKind 固定类型（工具栏）
   * @param parentId  父节点 ID（创建下属时）
   * @param parentKind 父节点类型（决定可创建的子类型）
   */
  private openCreate(fixedKind?: NodeKind, parentId?: string, parentKind?: NodeKind): void {
    if (!this.nodeCache.isInitialized) {
      new Notice('查询缓存尚未就绪，请稍候');
      return;
    }
    let kinds: NodeKind[];
    if (fixedKind) {
      kinds = [fixedKind];
    } else if (parentId && parentKind) {
      kinds = this.getChildKinds(parentKind);
    } else {
      // 无父节点：构想 / 清单 / 框架
      kinds = ['concept', 'checklist', 'framework-transaction', 'framework-info'];
    }
    if (kinds.length === 0) return;

    new TransactionCreateModal(this.app, {
      kinds,
      onSubmit: (input) => this.createNode(input, parentId),
    }).open();
  }

  /**
   * 根据父节点类型返回可创建的子类型
   * - 事务框架：子框架 / 事务（构想、清单、事件）/ 证据（对象、条件、信息、状态）
   * - 信息框架：子框架 / 证据
   * - 构想：事件；清单：事项
   */
  private getChildKinds(parentKind: NodeKind): NodeKind[] {
    switch (parentKind) {
      case 'framework-transaction':
        return ['framework-transaction', 'concept', 'checklist', 'event', 'factor', 'requirement', 'clue', 'snapshot'];
      case 'framework-info':
        return ['framework-info', 'factor', 'requirement', 'clue', 'snapshot'];
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
    input: { kind: NodeKind; desc: string; state: SeqtkState; nature?: EventNature; afterCreate: 'direct' | 'edit-body' },
    parentId?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const data = {
      kind: input.kind,
      desc: input.desc,
      open: true,
      ...(kindUsesState(input.kind) ? { state: input.state } : {}),
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
    if (kindUsesState(node.kind) && input.state !== node.state) updates.state = input.state;
    if (node.kind === 'event' && input.nature && input.nature !== (node as any).nature) {
      updates.nature = input.nature;
    }

    if (Object.keys(updates).length === 0) return;

    this.operationQueue.enqueue(
      () => this.nodeCache.updateNode(nodeId, { ...updates, modify: new Date().toISOString() }),
      async () => { await this.fileManager.updateNode(node.kind, nodeId, updates); },
    );
  }

  /** 在 Obsidian 编辑器中打开节点文件（source 模式），定位光标到正文起始 */
  private async openNodeFile(nodeId: string): Promise<void> {
    const node = this.nodeCache.getNode(nodeId);
    if (!node) return;
    const filePath = this.fileManager.getNodeFilePath(node.kind, nodeId);
    const file = this.app.vault.getFileByPath(filePath);
    if (!(file instanceof TFile)) return;

    const leaf = this.app.workspace.getLeaf('tab');
    if (!leaf) return;
    await leaf.openFile(file, { state: { mode: 'source' } });

    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view.file?.path === filePath) {
        const info = getFrontMatterInfo(view.data);
        view.editor.setCursor(view.editor.offsetToPos(info.contentStart ?? 0));
      }
    } catch (err) {
      console.warn('[SeqTK] 定位正文光标失败:', err);
    }
  }

  // ============================================================
  // 状态切换
  // ============================================================

  private showStateMenu(e: MouseEvent, node: TreeNode): void {
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

  private showRowMenu(e: MouseEvent, node: TreeNode): void {
    const menu = new Menu();

    if (this.getChildKinds(node.data.kind).length > 0) {
      menu.addItem((item) =>
        item.setTitle('新建子节点').setIcon('plus')
          .onClick(() => this.openCreate(undefined, node.nodeId, node.data.kind)));
    }
    menu.addItem((item) =>
      item.setTitle('编辑').setIcon('pencil')
        .onClick(() => this.openEdit(node.nodeId)));
    if (kindUsesState(node.data.kind)) {
      menu.addItem((item) =>
        item.setTitle('切换状态').setIcon('refresh-cw')
          .onClick(() => this.showStateMenu(e, node)));
    }
    menu.addItem((item) =>
      item.setTitle('归档').setIcon('archive')
        .onClick(() => this.archiveNode(node.nodeId)));
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle('删除').setIcon('trash')
        .onClick(() => this.deleteNodeTree(node)));

    menu.showAtMouseEvent(e);
  }

  /** 归档节点：置 open:false（从快速缓存移除，保留于全量缓存供回收/决策视图） */
  private archiveNode(nodeId: string): void {
    const node = this.nodeCache.getNodeFull(nodeId);
    if (!node) return;
    if (node.open === false) return;
    this.operationQueue.enqueue(
      () => this.nodeCache.updateNode(nodeId, { open: false, modify: new Date().toISOString() }),
      async () => { await this.fileManager.updateNode(node.kind, nodeId, { open: false }); },
    );
    new Notice('已归档（可在回收模式中还原）');
  }

  /** 级联删除：先捕获子树结构，再同步清缓存、异步删文件 */
  private deleteNodeTree(node: TreeNode): void {
    const collect = (n: TreeNode): { kind: NodeKind; nodeId: string }[] => [
      ...n.children.flatMap(collect),
      { kind: n.data.kind, nodeId: n.nodeId },
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
