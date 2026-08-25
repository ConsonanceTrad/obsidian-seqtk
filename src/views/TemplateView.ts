/**
 * TemplateView — 事务设计 · 模板模式
 *
 * 双栏布局：
 * - 左栏：框架区（模板框架 / 事务框架与信息框架 分组）
 * - 右栏：
 *   - 选中源框架（事务/信息框架）：展示其结构，可「提取为模板」
 *   - 选中模板框架：管理模板单元（新建 / 编辑 / 删除 / 应用）
 *
 * 模板语义（doc/数据定义与持久化/节点类型.md）：
 * - 模板框架（framework-template）存储可用模板组
 * - 模板从源框架结构提取（记录类型 + 名称/正文骨架），使用 `{{框架名}}` 等占位符，
 *   应用时替换为被使用框架的名称
 *
 * 模板单元：模板框架的 follows 子节点（普通节点承载），desc/正文可含 `{{占位}}`。
 */

import { App, ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import type { NodeKind, SeqtkNode, SeqtkState } from '../types/index';
import {
  NODE_KIND_LABELS,
  isFrameworkKind,
} from '../types/index';
import type { NodeCache } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import type { OperationQueue } from '../core/OperationQueue';
import { TransactionCreateModal } from './components/TransactionModals';

export const VIEW_TYPE_TEMPLATE = 'seqtk-template';

/** 选择目标框架的模态框 */
class SelectFrameworkModal extends Modal {
  constructor(
    app: App,
    private opts: {
      title: string;
      /** 候选框架（nodeId + 展示名） */
      frameworks: { nodeId: string; label: string }[];
      onSelect: (nodeId: string) => void;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.opts.title);

    let selected = this.opts.frameworks[0]?.nodeId ?? '';
    new Setting(contentEl)
      .setName('目标框架')
      .addDropdown((dd) => {
        for (const f of this.opts.frameworks) {
          dd.addOption(f.nodeId, f.label);
        }
        dd.setValue(selected);
        dd.onChange((v) => { selected = v; });
      });

    new Setting(contentEl).addButton((b) => {
      b.setButtonText('确定').setCta().onClick(() => {
        if (selected) this.opts.onSelect(selected);
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

export class TemplateView extends ItemView {
  private leftEl!: HTMLElement;
  private rightEl!: HTMLElement;
  private unsub: (() => void) | null = null;
  /** 当前选中的框架 nodeId（源框架或模板框架） */
  private selectedId: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private nodeCache: NodeCache,
    private fileManager: NodeFileManager,
    private operationQueue: OperationQueue,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_TEMPLATE;
  }

  getDisplayText(): string {
    return '模板模式';
  }

  getIcon(): string {
    return 'copy';
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
  // 左栏：框架区
  // ============================================================

  private renderLeft(): void {
    this.leftEl.empty();
    this.leftEl.createEl('div', { cls: 'seqtk-split-title', text: '框架' });

    if (!this.nodeCache.isInitialized) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '正在加载缓存…' });
      return;
    }

    // 模板框架组
    const templates = this.nodeCache.getByKind('framework-template');
    this.leftEl.createEl('div', { cls: 'seqtk-section-title', text: '模板框架' });
    if (templates.length === 0) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '暂无模板框架（右键此处新建）' });
    } else {
      for (const { nodeId, data } of templates) {
        this.renderLeftItem(nodeId, data, 'framework-template');
      }
    }

    // 源框架组（事务/信息框架）
    const sources = [
      ...this.nodeCache.getByKind('framework-transaction'),
      ...this.nodeCache.getByKind('framework-info'),
    ];
    this.leftEl.createEl('div', { cls: 'seqtk-section-title', text: '事务 / 信息框架' });
    if (sources.length === 0) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '暂无源框架' });
    } else {
      for (const { nodeId, data } of sources) {
        this.renderLeftItem(nodeId, data, data.kind);
      }
    }
  }

  private renderLeftItem(nodeId: string, data: SeqtkNode, kind: NodeKind): void {
    const row = this.leftEl.createDiv('seqtk-frame-item');
    if (this.selectedId === nodeId) row.addClass('seqtk-frame-item-active');
    row.createEl('span', { cls: 'seqtk-kind-badge', text: NODE_KIND_LABELS[kind] });
    row.createEl('span', { cls: 'seqtk-desc', text: data.desc });
    row.addEventListener('click', () => {
      this.selectedId = nodeId;
      this.renderLeft();
      this.renderRight();
    });
  }

  // ============================================================
  // 右栏
  // ============================================================

  private renderRight(): void {
    this.rightEl.empty();

    if (!this.nodeCache.isInitialized) {
      this.rightEl.createEl('div', { cls: 'seqtk-empty', text: '正在加载缓存…' });
      return;
    }
    if (this.selectedId === null) {
      this.rightEl.createEl('div', { cls: 'seqtk-empty', text: '在左侧选择一个框架' });
      return;
    }
    const node = this.nodeCache.getNode(this.selectedId);
    if (!node) {
      this.selectedId = null;
      this.rightEl.createEl('div', { cls: 'seqtk-empty', text: '在左侧选择一个框架' });
      return;
    }

    if (node.kind === 'framework-template') {
      this.renderTemplateManage(node);
    } else {
      this.renderExtractSource(node);
    }
  }

  /** 右栏：选中模板框架 → 模板单元管理 */
  private renderTemplateManage(template: SeqtkNode): void {
    this.rightEl.createEl('div', {
      cls: 'seqtk-split-title',
      text: `模板框架 · ${template.desc}`,
    });

    const actions = this.rightEl.createDiv('seqtk-toolbar');
    actions.createEl('button', { text: '新建模板单元', cls: 'seqtk-btn' })
      .addEventListener('click', () => this.openCreateTemplateUnit(this.selectedId!));
    actions.createEl('button', { text: '新建子模板框架', cls: 'seqtk-btn' })
      .addEventListener('click', () => this.openCreate('framework-template', this.selectedId!));

    const units = this.nodeCache
      .getChildren(this.selectedId!)
      .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } => !!c.data);

    if (units.length === 0) {
      this.rightEl.createEl('div', { cls: 'seqtk-empty', text: '暂无模板单元，点击「新建模板单元」创建' });
      return;
    }

    for (const unit of units) {
      const row = this.rightEl.createDiv('seqtk-row');
      row.createEl('span', { cls: 'seqtk-kind-badge', text: NODE_KIND_LABELS[unit.data.kind] });
      const desc = row.createEl('span', { cls: 'seqtk-desc', text: unit.data.desc });
      desc.title = unit.nodeId;

      row.createEl('button', { text: '应用', cls: 'seqtk-btn seqtk-btn-small' })
        .addEventListener('click', () => this.applyTemplate(unit.nodeId));
      row.createEl('button', { text: '编辑', cls: 'seqtk-btn seqtk-btn-small' })
        .addEventListener('click', () => this.openNodeFile(unit.nodeId));
      row.createEl('button', { text: '删除', cls: 'seqtk-btn seqtk-btn-small seqtk-btn-danger' })
        .addEventListener('click', () => this.deleteUnit(unit.nodeId, unit.data.kind));
    }
  }

  /** 右栏：选中源框架 → 展示结构 + 提取为模板 */
  private renderExtractSource(framework: SeqtkNode): void {
    this.rightEl.createEl('div', {
      cls: 'seqtk-split-title',
      text: `${NODE_KIND_LABELS[framework.kind]} · ${framework.desc}`,
    });

    const actions = this.rightEl.createDiv('seqtk-toolbar');
    actions.createEl('button', { text: '提取为模板', cls: 'seqtk-btn' })
      .addEventListener('click', () => this.extractTemplate(this.selectedId!));

    const inner = this.nodeCache
      .getChildren(this.selectedId!)
      .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } => !!c.data && !isFrameworkKind(c.data.kind));

    if (inner.length === 0) {
      this.rightEl.createEl('div', { cls: 'seqtk-empty', text: '该框架暂无内部节点，无法提取' });
      return;
    }

    this.rightEl.createEl('div', { cls: 'seqtk-section-title', text: `内部节点（${inner.length}）` });
    for (const item of inner) {
      const row = this.rightEl.createDiv('seqtk-row');
      row.createEl('span', { cls: 'seqtk-kind-badge', text: NODE_KIND_LABELS[item.data.kind] });
      row.createEl('span', { cls: 'seqtk-desc', text: item.data.desc });
    }
  }

  // ============================================================
  // 模板提取
  // ============================================================

  /** 提取：将源框架的内部节点结构复制为模板单元（源框架名 → {{框架名}} 占位） */
  private extractTemplate(sourceId: string): void {
    const source = this.nodeCache.getNode(sourceId);
    if (!source) return;
    const sourceDesc = source.desc;

    const templates = this.nodeCache.getByKind('framework-template');
    if (templates.length === 0) {
      new Notice('请先创建模板框架');
      return;
    }

    new SelectFrameworkModal(this.app, {
      title: '提取到模板框架',
      frameworks: templates.map((t) => ({ nodeId: t.nodeId, label: t.data.desc })),
      onSelect: async (targetTemplateId) => {
        const inner = this.nodeCache.getChildren(sourceId)
          .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } => !!c.data && !isFrameworkKind(c.data.kind));

        const now = new Date().toISOString();
        for (const item of inner) {
          const desc = item.data.desc.split(sourceDesc).join('{{框架名}}');
          const body = this.nodeCache.getNodeBody(item.nodeId);
          const data = {
            kind: item.data.kind,
            desc,
            open: true,
            ...(item.data.state !== undefined ? { state: item.data.state } : {}),
            ...(item.data.nature !== undefined ? { nature: item.data.nature } : {}),
            create: now,
            modify: now,
            parent: targetTemplateId,
          } as SeqtkNode;

          try {
            const nodeId = await this.fileManager.createNode(data.kind, data, body);
            this.operationQueue.enqueueCacheOp(() => this.nodeCache.addNode(nodeId, data, body));
            this.appendFollows(targetTemplateId, nodeId);
          } catch (err) {
            console.error('[SeqTK] 提取模板失败:', err);
            new Notice(`[SeqTK] 提取模板失败: ${err}`);
          }
        }
        new Notice(`已提取 ${inner.length} 个模板单元`);
      },
    }).open();
  }

  // ============================================================
  // 模板应用
  // ============================================================

  /** 应用：将模板单元按骨架创建到目标框架（{{占位}} 按目标框架名替换） */
  private applyTemplate(templateId: string): void {
    const template = this.nodeCache.getNode(templateId);
    if (!template) return;

    const frameworks = [
      ...this.nodeCache.getByKind('framework-transaction'),
      ...this.nodeCache.getByKind('framework-info'),
    ];
    if (frameworks.length === 0) {
      new Notice('请先创建目标框架（事务框架 / 信息框架）');
      return;
    }

    new SelectFrameworkModal(this.app, {
      title: '应用模板到框架',
      frameworks: frameworks.map((f) => ({ nodeId: f.nodeId, label: f.data.desc })),
      onSelect: async (targetId) => {
        const target = this.nodeCache.getNode(targetId);
        if (!target) return;

        const now = new Date().toISOString();
        const desc = template.desc.split('{{框架名}}').join(target.desc);
        const body = this.nodeCache.getNodeBody(templateId);
        const data = {
          kind: template.kind,
          desc,
          open: true,
          ...(template.state !== undefined ? { state: template.state } : {}),
          ...(template.nature !== undefined ? { nature: template.nature } : {}),
          create: now,
          modify: now,
          parent: targetId,
        } as SeqtkNode;

        try {
          const nodeId = await this.fileManager.createNode(data.kind, data, body);
          this.operationQueue.enqueueCacheOp(() => this.nodeCache.addNode(nodeId, data, body));
          this.appendFollows(targetId, nodeId);
          new Notice('模板已应用');
        } catch (err) {
          console.error('[SeqTK] 应用模板失败:', err);
          new Notice(`[SeqTK] 应用模板失败: ${err}`);
        }
      },
    }).open();
  }

  // ============================================================
  // 通用操作
  // ============================================================

  /** 新建模板单元（类型可选，父节点 = 模板框架） */
  private openCreateTemplateUnit(parentId: string): void {
    const kinds: NodeKind[] = ['concept', 'checklist', 'item', 'event', 'factor', 'requirement', 'clue', 'snapshot'];
    new TransactionCreateModal(this.app, {
      kinds,
      onSubmit: (input) => this.createNode(input, parentId),
    }).open();
  }

  private openCreate(fixedKind: NodeKind, parentId: string): void {
    new TransactionCreateModal(this.app, {
      kinds: [fixedKind],
      onSubmit: (input) => this.createNode(input, parentId),
    }).open();
  }

  /** 创建节点并挂到父框架下（双向维护 follows + parent） */
  private async createNode(
    input: { kind: NodeKind; desc: string; state: SeqtkState },
    parentId: string,
  ): Promise<void> {
    if (!this.nodeCache.isInitialized) {
      new Notice('查询缓存尚未就绪，请稍候');
      return;
    }
    const now = new Date().toISOString();
    const data = {
      kind: input.kind,
      desc: input.desc,
      open: true,
      create: now,
      modify: now,
      parent: parentId,
    } as SeqtkNode;

    try {
      const nodeId = await this.fileManager.createNode(input.kind, data, '');
      this.operationQueue.enqueueCacheOp(() => this.nodeCache.addNode(nodeId, data, ''));
      this.appendFollows(parentId, nodeId);
    } catch (err) {
      console.error('[SeqTK] 创建节点失败:', err);
      new Notice(`[SeqTK] 创建节点失败: ${err}`);
    }
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

  /** 打开节点文件编辑（模板单元正文编辑） */
  private openNodeFile(nodeId: string): void {
    const node = this.nodeCache.getNode(nodeId);
    if (!node) return;
    const filePath = this.fileManager.getNodeFilePath(node.kind, nodeId);
    const file = this.app.vault.getFileByPath(filePath);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
    }
  }

  /** 删除模板单元（含文件） */
  private deleteUnit(nodeId: string, kind: NodeKind): void {
    this.operationQueue.enqueueCacheOp(() => this.nodeCache.removeNode(nodeId));
    this.operationQueue.enqueueFileOp(async () => { await this.fileManager.deleteNode(kind, nodeId); });
    new Notice('模板单元已删除');
  }
}
