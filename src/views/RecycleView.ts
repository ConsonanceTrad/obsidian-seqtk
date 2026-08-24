/**
 * RecycleView — 节点通用 · 回收模式
 *
 * 展示归档节点（open: false，来自全量缓存），提供还原与彻底删除：
 * - 还原：置 open: true，节点回到快速缓存，恢复可编辑
 * - 彻底删除：级联删除整个子树（含归档后代），文件移入系统回收站
 *
 * 归档语义（doc/可视化操作口/操作口目录.md）：
 * 归档节点不再被其他模式视图编辑、不在快速缓存中创建，但仍可用于
 * 其他视图（如线路）的信息判断。
 */

import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type { NodeKind, SeqtkNode } from '../types/index';
import { NODE_KIND_LABELS } from '../types/index';
import type { NodeCache } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import type { OperationQueue } from '../core/OperationQueue';

export const VIEW_TYPE_RECYCLE = 'seqtk-recycle';

export class RecycleView extends ItemView {
  private listEl!: HTMLElement;
  private unsub: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private nodeCache: NodeCache,
    private fileManager: NodeFileManager,
    private operationQueue: OperationQueue,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_RECYCLE;
  }

  getDisplayText(): string {
    return '回收模式';
  }

  getIcon(): string {
    return 'trash-2';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('seqtk-recycle-view');

    const toolbar = container.createDiv('seqtk-toolbar');
    toolbar.createEl('button', { text: '刷新', cls: 'seqtk-btn seqtk-btn-ghost' })
      .addEventListener('click', async () => {
        if (!this.nodeCache.isInitialized) {
          new Notice('查询缓存尚未就绪，请稍候');
          return;
        }
        await this.nodeCache.verifyWithDisk(this.fileManager);
        new Notice('已从磁盘刷新');
      });

    this.listEl = container.createDiv('seqtk-tree');
    this.unsub = this.nodeCache.fullStore.subscribe(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
  }

  private render(): void {
    this.listEl.empty();

    if (!this.nodeCache.isInitialized) {
      this.listEl.createEl('div', { cls: 'seqtk-empty', text: '正在加载缓存…' });
      return;
    }

    // 归档节点 = 全量快照中 open === false
    const archived: { nodeId: string; data: SeqtkNode }[] = [];
    for (const [nodeId, data] of this.nodeCache.fullStore.get()) {
      if (data.open === false) {
        archived.push({ nodeId, data });
      }
    }

    if (archived.length === 0) {
      this.listEl.createEl('div', { cls: 'seqtk-empty', text: '暂无归档节点（可在设计/表格模式中右键归档）' });
      return;
    }

    // 按类型分组展示
    const groups = new Map<NodeKind, { nodeId: string; data: SeqtkNode }[]>();
    for (const item of archived) {
      const list = groups.get(item.data.kind) ?? [];
      list.push(item);
      groups.set(item.data.kind, list);
    }

    for (const [kind, items] of groups) {
      this.listEl.createEl('div', {
        cls: 'seqtk-section-title',
        text: `${NODE_KIND_LABELS[kind]}（${items.length}）`,
      });
      for (const item of items) {
        this.renderRow(item.nodeId, item.data);
      }
    }
  }

  private renderRow(nodeId: string, data: SeqtkNode): void {
    const row = this.listEl.createDiv('seqtk-row');
    row.createEl('span', { cls: 'seqtk-kind-badge', text: NODE_KIND_LABELS[data.kind] });
    const desc = row.createEl('span', { cls: 'seqtk-desc', text: data.desc });
    desc.title = nodeId;

    row.createEl('button', { text: '还原', cls: 'seqtk-btn seqtk-btn-small' })
      .addEventListener('click', () => this.restoreNode(nodeId, data.kind));
    row.createEl('button', { text: '彻底删除', cls: 'seqtk-btn seqtk-btn-small seqtk-btn-danger' })
      .addEventListener('click', () => this.deleteNodeTree(nodeId));
  }

  /** 还原：置 open:true，回到快速缓存 */
  private restoreNode(nodeId: string, kind: NodeKind): void {
    this.operationQueue.enqueue(
      () => this.nodeCache.updateNode(nodeId, { open: true, modify: new Date().toISOString() }),
      async () => { await this.fileManager.updateNode(kind, nodeId, { open: true }); },
    );
    new Notice('已还原');
  }

  /** 彻底删除：级联删除子树（含归档后代），文件移入系统回收站 */
  private deleteNodeTree(rootNodeId: string): void {
    const descendants = this.nodeCache.collectDescendantsFull(rootNodeId);
    const targets = [
      ...descendants.map((d) => ({ kind: d.kind, nodeId: d.nodeId })),
      { kind: this.nodeCache.getNodeFull(rootNodeId)?.kind ?? 'concept' as NodeKind, nodeId: rootNodeId },
    ];

    this.operationQueue.enqueueCacheBatch(
      targets.map((t) => () => this.nodeCache.removeNode(t.nodeId)),
    );
    this.operationQueue.enqueueFileBatch(
      targets.map((t) => async () => { await this.fileManager.deleteNode(t.kind, t.nodeId); }),
    );

    new Notice(`已彻底删除 ${targets.length} 个节点`);
  }
}
