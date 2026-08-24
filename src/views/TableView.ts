/**
 * TableView — 事务设计 · 表格模式
 *
 * 表格编辑器：节点属性的阅览、管理与批量编辑。
 * - 列：勾选 / 类型 / 名称 / 状态 / Open / 创建时间 / 修改时间
 * - 类型筛选；「含归档」开关（默认仅未归档，开启显示全量缓存含归档节点）
 * - 行内编辑：状态下拉（框架/事务）、Open 开关；名称点击弹窗编辑
 * - 多选批量：批量改状态 / 归档 / 删除
 * - 行右键：新建子节点 / 编辑 / 归档 / 删除
 */

import { ItemView, Menu, Notice, WorkspaceLeaf } from 'obsidian';
import type { NodeKind, SeqtkNode, SeqtkState } from '../types/index';
import {
  NODE_KIND_LABELS,
  NODE_STATE_LABELS,
  STATE_VALUES,
  getCategoryOf,
} from '../types/index';
import type { NodeCache } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import type { OperationQueue } from '../core/OperationQueue';
import { TransactionCreateModal, TransactionEditModal, kindUsesState } from './components/TransactionModals';

export const VIEW_TYPE_TABLE = 'seqtk-table';

/** 表格行条目 */
interface TableRow {
  nodeId: string;
  data: SeqtkNode;
}

export class TableView extends ItemView {
  private tableEl!: HTMLElement;
  private unsub: (() => void) | null = null;
  /** 是否显示归档节点（含归档 = 全量缓存） */
  private showArchived = false;
  /** 类型筛选：'all' 或具体类型 */
  private kindFilter: 'all' | NodeKind = 'all';
  /** 勾选的行 */
  private selected = new Set<string>();

  constructor(
    leaf: WorkspaceLeaf,
    private nodeCache: NodeCache,
    private fileManager: NodeFileManager,
    private operationQueue: OperationQueue,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_TABLE;
  }

  getDisplayText(): string {
    return '表格模式';
  }

  getIcon(): string {
    return 'table';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('seqtk-table-view');

    this.buildToolbar(container);

    const wrap = container.createDiv('seqtk-table-wrap');
    this.tableEl = wrap.createEl('table', { cls: 'seqtk-table' });

    this.unsub = this.nodeCache.nodeStore.subscribe(() => this.render());
    this.unsub2 = this.nodeCache.fullStore.subscribe(() => this.render());
    this.render();
  }

  private unsub2: (() => void) | null = null;

  async onClose(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
    this.unsub2?.();
    this.unsub2 = null;
  }

  // ============================================================
  // 工具栏
  // ============================================================

  private buildToolbar(container: HTMLElement): void {
    const toolbar = container.createDiv('seqtk-toolbar');

    toolbar.createEl('button', { text: '新建节点', cls: 'seqtk-btn' })
      .addEventListener('click', () => this.openCreate());

    // 类型筛选
    const filterSel = toolbar.createEl('select', { cls: 'dropdown' });
    filterSel.add(new Option('全部类型', 'all'));
    const allKinds: NodeKind[] = [
      'concept', 'checklist', 'item', 'event',
      'factor', 'requirement', 'clue', 'snapshot',
      'framework-transaction', 'framework-info', 'framework-template',
    ];
    for (const k of allKinds) {
      filterSel.add(new Option(NODE_KIND_LABELS[k], k));
    }
    filterSel.addEventListener('change', () => {
      this.kindFilter = filterSel.value as 'all' | NodeKind;
      this.render();
    });

    // 含归档开关
    const archivedLabel = toolbar.createEl('label', { cls: 'seqtk-checkbox-label' });
    const archivedCb = archivedLabel.createEl('input', { type: 'checkbox' });
    archivedLabel.appendText(' 含归档');
    archivedCb.addEventListener('change', () => {
      this.showArchived = archivedCb.checked;
      this.selected.clear();
      this.render();
    });

    // 批量操作
    const batch = toolbar.createDiv('seqtk-batch');
    batch.createEl('span', { cls: 'seqtk-batch-label', text: '已选 0 项' });
    const batchState = batch.createEl('select', { cls: 'dropdown' });
    batchState.add(new Option('批量改状态…', ''));
    for (const s of [...STATE_VALUES]) {
      batchState.add(new Option(NODE_STATE_LABELS[s], s));
    }
    batchState.addEventListener('change', () => {
      if (!batchState.value) return;
      this.batchSetState(batchState.value as SeqtkState);
      batchState.value = '';
    });
    batch.createEl('button', { text: '归档', cls: 'seqtk-btn seqtk-btn-small' })
      .addEventListener('click', () => this.batchArchive());
    batch.createEl('button', { text: '删除', cls: 'seqtk-btn seqtk-btn-small seqtk-btn-danger' })
      .addEventListener('click', () => this.batchDelete());
  }

  // ============================================================
  // 渲染
  // ============================================================

  private render(): void {
    this.tableEl.empty();

    if (!this.nodeCache.isInitialized) {
      this.tableEl.createEl('caption', { text: '正在加载缓存…' });
      return;
    }

    const snapshot = this.showArchived
      ? this.nodeCache.fullStore.get()
      : this.nodeCache.nodeStore.get();

    const rows: TableRow[] = [];
    for (const [nodeId, data] of snapshot) {
      if (this.kindFilter !== 'all' && data.kind !== this.kindFilter) continue;
      rows.push({ nodeId, data });
    }
    rows.sort((a, b) => (a.data.create ?? '').localeCompare(b.data.create ?? ''));

    // 表头
    const thead = this.tableEl.createEl('thead');
    const headRow = thead.createEl('tr');
    headRow.createEl('th');
    for (const col of ['类型', '名称', '状态', 'Open', '创建时间']) {
      headRow.createEl('th', { text: col });
    }

    if (rows.length === 0) {
      this.tableEl.createEl('caption', { text: '无匹配节点' });
      return;
    }

    // 更新批量计数
    const batchLabel = this.tableEl.parentElement?.parentElement?.querySelector('.seqtk-batch-label');
    if (batchLabel) batchLabel.textContent = `已选 ${this.selected.size} 项`;

    const tbody = this.tableEl.createEl('tbody');
    for (const row of rows) {
      this.renderRow(tbody, row);
    }
  }

  private renderRow(tbody: HTMLElement, row: TableRow): void {
    const tr = tbody.createEl('tr');
    if (this.selected.has(row.nodeId)) tr.addClass('seqtk-table-row-selected');

    // 勾选
    const cbTd = tr.createEl('td');
    const cb = cbTd.createEl('input', { type: 'checkbox' });
    cb.checked = this.selected.has(row.nodeId);
    cb.addEventListener('change', () => {
      if (cb.checked) this.selected.add(row.nodeId);
      else this.selected.delete(row.nodeId);
      this.render();
    });

    // 类型
    tr.createEl('td', { text: NODE_KIND_LABELS[row.data.kind], cls: 'seqtk-table-kind' });

    // 名称（点击编辑）
    const nameTd = tr.createEl('td');
    const nameEl = nameTd.createEl('span', { cls: 'seqtk-desc', text: row.data.desc });
    nameEl.addEventListener('click', () => this.openEdit(row.nodeId));

    // 状态（仅框架/事务可编辑）
    const stateTd = tr.createEl('td');
    if (kindUsesState(row.data.kind)) {
      const stateSel = stateTd.createEl('select', { cls: 'dropdown' });
      for (const s of [...STATE_VALUES]) {
        stateSel.add(new Option(NODE_STATE_LABELS[s], s));
      }
      stateSel.value = row.data.state ?? 'plan';
      stateSel.addEventListener('change', () => this.setNodeState(row.nodeId, stateSel.value as SeqtkState));
    }

    // Open 开关
    const openTd = tr.createEl('td');
    const openCb = openTd.createEl('input', { type: 'checkbox' });
    openCb.checked = row.data.open !== false;
    openCb.addEventListener('change', () => {
      this.operationQueue.enqueue(
        () => this.nodeCache.updateNode(row.nodeId, { open: openCb.checked, modify: new Date().toISOString() }),
        async () => { await this.fileManager.updateNode(row.data.kind, row.nodeId, { open: openCb.checked }); },
      );
    });

    // 创建时间
    tr.createEl('td', { text: (row.data.create ?? '').slice(0, 10), cls: 'seqtk-table-time' });

    // 行右键菜单
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showRowMenu(e, row);
    });
  }

  // ============================================================
  // 行操作
  // ============================================================

  private showRowMenu(e: MouseEvent, row: TableRow): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle('编辑').setIcon('pencil')
        .onClick(() => this.openEdit(row.nodeId)));
    menu.addItem((item) =>
      item.setTitle('打开文件').setIcon('file-text')
        .onClick(() => this.openNodeFile(row.nodeId)));
    if (row.data.open !== false) {
      menu.addItem((item) =>
        item.setTitle('归档').setIcon('archive')
          .onClick(() => this.archiveNode(row.nodeId, row.data.kind)));
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle('删除').setIcon('trash')
        .onClick(() => this.deleteNode(row.nodeId)));
    menu.showAtMouseEvent(e);
  }

  private openEdit(nodeId: string): void {
    const node = this.nodeCache.getNode(nodeId) ?? this.nodeCache.getNodeFull(nodeId);
    if (!node) return;
    new TransactionEditModal(this.app, {
      node,
      onSubmit: (input) => {
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
      },
      onOpenFile: () => this.openNodeFile(nodeId),
    }).open();
  }

  private setNodeState(nodeId: string, state: SeqtkState): void {
    const node = this.nodeCache.getNode(nodeId);
    if (!node || node.state === state) return;
    this.operationQueue.enqueue(
      () => this.nodeCache.updateNode(nodeId, { state, modify: new Date().toISOString() }),
      async () => { await this.fileManager.updateNode(node.kind, nodeId, { state }); },
    );
  }

  private archiveNode(nodeId: string, kind: NodeKind): void {
    this.operationQueue.enqueue(
      () => this.nodeCache.updateNode(nodeId, { open: false, modify: new Date().toISOString() }),
      async () => { await this.fileManager.updateNode(kind, nodeId, { open: false }); },
    );
    new Notice('已归档');
  }

  private deleteNode(nodeId: string): void {
    this.operationQueue.enqueueCacheOp(() => this.nodeCache.removeNode(nodeId));
    const kind = this.nodeCache.getNodeFull(nodeId)?.kind;
    if (kind) {
      this.operationQueue.enqueueFileOp(async () => { await this.fileManager.deleteNode(kind, nodeId); });
    }
    new Notice('已删除');
  }

  private openNodeFile(nodeId: string): void {
    const node = this.nodeCache.getNode(nodeId) ?? this.nodeCache.getNodeFull(nodeId);
    if (!node) return;
    const file = this.app.vault.getFileByPath(this.fileManager.getNodeFilePath(node.kind, nodeId));
    if (file) {
      void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
    }
  }

  // ============================================================
  // 批量操作
  // ============================================================

  private batchSetState(state: SeqtkState): void {
    for (const nodeId of this.selected) {
      const node = this.nodeCache.getNode(nodeId);
      if (!node || !kindUsesState(node.kind)) continue;
      this.operationQueue.enqueue(
        () => this.nodeCache.updateNode(nodeId, { state, modify: new Date().toISOString() }),
        async () => { await this.fileManager.updateNode(node.kind, nodeId, { state }); },
      );
    }
    new Notice(`已将 ${this.selected.size} 项状态改为 ${NODE_STATE_LABELS[state]}`);
  }

  private batchArchive(): void {
    for (const nodeId of this.selected) {
      const node = this.nodeCache.getNode(nodeId);
      if (!node || node.open === false) continue;
      this.operationQueue.enqueue(
        () => this.nodeCache.updateNode(nodeId, { open: false, modify: new Date().toISOString() }),
        async () => { await this.fileManager.updateNode(node.kind, nodeId, { open: false }); },
      );
    }
    new Notice(`已归档 ${this.selected.size} 项`);
  }

  private batchDelete(): void {
    const ids = [...this.selected];
    this.operationQueue.enqueueCacheBatch(
      ids.map((id) => () => this.nodeCache.removeNode(id)),
    );
    this.operationQueue.enqueueFileBatch(
      ids.map((id) => async () => {
        const kind = this.nodeCache.getNodeFull(id)?.kind;
        if (kind) await this.fileManager.deleteNode(kind, id);
      }),
    );
    this.selected.clear();
    new Notice(`已删除 ${ids.length} 项`);
  }

  // ============================================================
  // 新建
  // ============================================================

  private openCreate(): void {
    if (!this.nodeCache.isInitialized) {
      new Notice('查询缓存尚未就绪，请稍候');
      return;
    }
    const kinds: NodeKind[] = [
      'concept', 'checklist', 'item', 'event',
      'factor', 'requirement', 'clue', 'snapshot',
      'framework-transaction', 'framework-info', 'framework-template',
    ];
    new TransactionCreateModal(this.app, {
      kinds,
      onSubmit: (input) => {
        const now = new Date().toISOString();
        const data = {
          kind: input.kind,
          desc: input.desc,
          open: true,
          ...(kindUsesState(input.kind) ? { state: input.state } : {}),
          ...(input.kind === 'event' && input.nature ? { nature: input.nature } : {}),
          create: now,
          modify: now,
        } as SeqtkNode;
        void this.fileManager.createNode(input.kind, data, '').then((nodeId) => {
          this.operationQueue.enqueueCacheOp(() => this.nodeCache.addNode(nodeId, data, ''));
          if (input.afterCreate === 'edit-body') {
            const file = this.app.vault.getFileByPath(this.fileManager.getNodeFilePath(input.kind, nodeId));
            if (file) void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
          }
        });
      },
    }).open();
  }
}
