/**
 * AppendView — 证据管理 · 追加模式
 *
 * 双栏：左栏选择事务（构想/清单/事项/事件），右栏编辑该事务的证据
 * （对象/条件/信息/状态）与证据间的互相关系（links 无向关联）。
 *
 * - 创建证据：四类证据节点挂到所选事务下（双向维护 follows + parent）
 * - 编辑证据：名称/状态弹窗、正文跳文件、状态节点 at 时间点
 * - 链接管理：勾选建立/断开证据间 links（双向维护两节点）
 */

import { App, ItemView, Modal, Notice, Setting, WorkspaceLeaf } from 'obsidian';
import type { NodeKind, SeqtkNode } from '../types/index';
import { NODE_KIND_LABELS } from '../types/index';
import type { NodeCache } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import type { OperationQueue } from '../core/OperationQueue';
import { TransactionCreateModal, TransactionEditModal } from './components/TransactionModals';

export const VIEW_TYPE_APPEND = 'seqtk-append';

/** 证据类型 */
const EVIDENCE_KINDS: NodeKind[] = ['factor', 'requirement', 'clue', 'snapshot'];

/** 事务类型 */
const TXN_KINDS: NodeKind[] = ['concept', 'checklist', 'item', 'event'];

/** 链接管理模态框：编辑某证据与同事务其他证据的 links 关联 */
class LinkManageModal extends Modal {
  private states = new Map<string, boolean>();

  constructor(
    app: App,
    private opts: {
      evidenceId: string;
      evidenceDesc: string;
      /** 同事务下的其他证据（候选链接对象） */
      candidates: { nodeId: string; desc: string; kind: NodeKind }[];
      /** 当前已链接的 nodeId 集合 */
      linked: Set<string>;
      onSave: (changed: { nodeId: string; linked: boolean }[]) => void;
    },
  ) {
    super(app);
    for (const c of opts.candidates) {
      this.states.set(c.nodeId, opts.linked.has(c.nodeId));
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: `链接管理 · ${this.opts.evidenceDesc}` });

    if (this.opts.candidates.length === 0) {
      contentEl.createEl('div', { cls: 'seqtk-empty', text: '该事务下暂无其他证据' });
    } else {
      for (const c of this.opts.candidates) {
        new Setting(contentEl)
          .setName(`${NODE_KIND_LABELS[c.kind]} · ${c.desc}`)
          .addToggle((t) => {
            t.setValue(this.states.get(c.nodeId) ?? false);
            t.onChange((v) => this.states.set(c.nodeId, v));
          });
      }
    }

    new Setting(contentEl).addButton((b) => {
      b.setButtonText('保存').setCta().onClick(() => this.save());
    }).addButton((b) => {
      b.setButtonText('取消').onClick(() => this.close());
    });
  }

  private save(): void {
    const changed: { nodeId: string; linked: boolean }[] = [];
    for (const [nodeId, linked] of this.states) {
      if (linked !== (this.opts.linked.has(nodeId))) {
        changed.push({ nodeId, linked });
      }
    }
    this.opts.onSave(changed);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class AppendView extends ItemView {
  private leftEl!: HTMLElement;
  private rightEl!: HTMLElement;
  private unsub: (() => void) | null = null;
  private expanded = new Set<string>();
  /** 当前选中的事务 nodeId */
  private selectedTxnId: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private nodeCache: NodeCache,
    private fileManager: NodeFileManager,
    private operationQueue: OperationQueue,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_APPEND;
  }

  getDisplayText(): string {
    return '证据追加';
  }

  getIcon(): string {
    return 'git-branch';
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
      this.renderRight();
    });
    this.renderLeft();
    this.renderRight();
  }

  async onClose(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
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

  /** 递归渲染事务树（所有类型子节点均可作为证据宿主） */
  private renderTxnNode(nodeId: string, data: SeqtkNode, depth: number): void {
    const row = this.leftEl.createDiv('seqtk-frame-item');
    if (this.selectedTxnId === nodeId) row.addClass('seqtk-frame-item-active');
    row.style.paddingLeft = `${8 + depth * 14}px`;

    // 左栏仅展示事务类子节点，证据节点不在此显示
    const children = this.nodeCache.getChildren(nodeId)
      .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } =>
        !!c.data && TXN_KINDS.includes(c.data.kind as NodeKind));
    const hasChildren = children.length > 0;
    const toggle = row.createSpan('seqtk-toggle');
    if (hasChildren) {
      toggle.setText(this.expanded.has(nodeId) ? '▾' : '▸');
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleExpand(nodeId);
      });
    }

    row.createEl('span', { cls: 'seqtk-kind-badge', text: NODE_KIND_LABELS[data.kind] });
    row.createEl('span', { cls: 'seqtk-desc', text: data.desc });
    row.addEventListener('click', () => {
      this.selectedTxnId = nodeId;
      this.renderLeft();
      this.renderRight();
    });

    if (hasChildren && this.expanded.has(nodeId)) {
      for (const c of children) {
        this.renderTxnNode(c.nodeId, c.data, depth + 1);
      }
    }
  }

  private toggleExpand(nodeId: string): void {
    if (this.expanded.has(nodeId)) this.expanded.delete(nodeId);
    else this.expanded.add(nodeId);
    this.renderLeft();
  }

  // ============================================================
  // 右栏：证据编辑
  // ============================================================

  private renderRight(): void {
    this.rightEl.empty();

    if (!this.nodeCache.isInitialized) {
      this.rightEl.createEl('div', { cls: 'seqtk-empty', text: '正在加载缓存…' });
      return;
    }
    if (this.selectedTxnId === null) {
      this.rightEl.createEl('div', { cls: 'seqtk-empty', text: '在左侧选择一个事务，编辑其证据' });
      return;
    }
    const txn = this.nodeCache.getNode(this.selectedTxnId);
    if (!txn) {
      this.selectedTxnId = null;
      this.rightEl.createEl('div', { cls: 'seqtk-empty', text: '在左侧选择一个事务' });
      return;
    }

    this.rightEl.createEl('div', {
      cls: 'seqtk-split-title',
      text: `${NODE_KIND_LABELS[txn.kind]} · ${txn.desc}`,
    });

    // 工具栏：新建证据（四类按钮）
    const toolbar = this.rightEl.createDiv('seqtk-toolbar');
    for (const k of EVIDENCE_KINDS) {
      toolbar.createEl('button', { text: `新建${NODE_KIND_LABELS[k]}`, cls: 'seqtk-btn' })
        .addEventListener('click', () => this.createEvidence(k));
    }

    // 证据列表
    const evidences = this.nodeCache
      .getChildren(this.selectedTxnId)
      .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } =>
        !!c.data && EVIDENCE_KINDS.includes(c.data.kind as NodeKind));

    if (evidences.length === 0) {
      this.rightEl.createEl('div', { cls: 'seqtk-empty', text: '该事务暂无证据，点击上方按钮新建' });
      return;
    }

    this.rightEl.createEl('div', { cls: 'seqtk-section-title', text: `证据（${evidences.length}）` });
    for (const ev of evidences) {
      this.renderEvidenceRow(ev);
    }
  }

  private renderEvidenceRow(ev: { kind: NodeKind; nodeId: string; data: SeqtkNode }): void {
    const row = this.rightEl.createDiv('seqtk-row');

    let kindLabel = NODE_KIND_LABELS[ev.data.kind];
    if (ev.data.kind === 'snapshot' && (ev.data as any).at) {
      kindLabel = `${kindLabel}·${String((ev.data as any).at).slice(5, 16)}`;
    }
    row.createEl('span', { cls: 'seqtk-kind-badge', text: kindLabel });
    const desc = row.createEl('span', { cls: 'seqtk-desc', text: ev.data.desc });
    desc.title = ev.nodeId;

    row.createEl('button', { text: '编辑', cls: 'seqtk-btn seqtk-btn-small' })
      .addEventListener('click', () => this.openEditEvidence(ev));
    row.createEl('button', { text: '链接', cls: 'seqtk-btn seqtk-btn-small' })
      .addEventListener('click', () => this.openLinkManage(ev));
    row.createEl('button', { text: '删除', cls: 'seqtk-btn seqtk-btn-small seqtk-btn-danger' })
      .addEventListener('click', () => this.deleteEvidence(ev));
  }

  // ============================================================
  // 证据操作
  // ============================================================

  private createEvidence(kind: NodeKind): void {
    if (!this.selectedTxnId) return;
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
          parent: this.selectedTxnId!,
        } as SeqtkNode;
        void this.fileManager.createNode(input.kind, data, '').then((nodeId) => {
          this.operationQueue.enqueueCacheOp(() => this.nodeCache.addNode(nodeId, data, ''));
          this.appendFollows(this.selectedTxnId!, nodeId);
          if (input.afterCreate === 'edit-body') {
            const file = this.app.vault.getFileByPath(this.fileManager.getNodeFilePath(input.kind, nodeId));
            if (file) void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
          }
        });
      },
    }).open();
  }

  private openEditEvidence(ev: { nodeId: string; data: SeqtkNode }): void {
    new TransactionEditModal(this.app, {
      node: ev.data,
      onSubmit: (input) => {
        const updates: Partial<SeqtkNode> = {};
        if (input.desc !== ev.data.desc) updates.desc = input.desc;
        if (Object.keys(updates).length === 0) return;
        this.operationQueue.enqueue(
          () => this.nodeCache.updateNode(ev.nodeId, { ...updates, modify: new Date().toISOString() }),
          async () => { await this.fileManager.updateNode(ev.data.kind, ev.nodeId, updates); },
        );
      },
      onOpenFile: () => {
        const file = this.app.vault.getFileByPath(this.fileManager.getNodeFilePath(ev.data.kind, ev.nodeId));
        if (file) void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
      },
    }).open();
  }

  private openLinkManage(ev: { nodeId: string; data: SeqtkNode }): void {
    if (!this.selectedTxnId) return;
    const allEvidence = this.nodeCache
      .getChildren(this.selectedTxnId)
      .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } =>
        !!c.data && EVIDENCE_KINDS.includes(c.data.kind as NodeKind) && c.nodeId !== ev.nodeId);

    const currentLinks = new Set<string>(ev.data.links ?? []);
    new LinkManageModal(this.app, {
      evidenceId: ev.nodeId,
      evidenceDesc: ev.data.desc,
      candidates: allEvidence.map((c) => ({ nodeId: c.nodeId, desc: c.data.desc, kind: c.data.kind })),
      linked: currentLinks,
      onSave: (changed) => {
        for (const { nodeId: otherId, linked } of changed) {
          if (linked) {
            this.addLink(ev.nodeId, otherId);
          } else {
            this.removeLink(ev.nodeId, otherId);
          }
        }
        new Notice(`已更新 ${changed.length} 条链接`);
      },
    }).open();
  }

  /** 建立 A↔B 无向关联 */
  private addLink(aId: string, bId: string): void {
    const a = this.nodeCache.getNode(aId);
    const b = this.nodeCache.getNode(bId);
    if (!a || !b) return;
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

  /** 断开 A↔B 无向关联 */
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

  private deleteEvidence(ev: { nodeId: string; kind: NodeKind }): void {
    this.operationQueue.enqueueCacheOp(() => this.nodeCache.removeNode(ev.nodeId));
    this.operationQueue.enqueueFileOp(async () => { await this.fileManager.deleteNode(ev.kind, ev.nodeId); });
    new Notice('证据已删除');
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
}
