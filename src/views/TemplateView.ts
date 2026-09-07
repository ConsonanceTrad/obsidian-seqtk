/**
 * TemplateView — 模板模式（模板库管理视图）
 *
 * 双栏布局：
 * - 左栏：模板框架列表（含嵌套子模板框架）
 * - 右栏：选中模板框架 → 管理模板单元
 *   - 工具栏：新建模板单元 / 新建子模板框架
 *   - 模板单元树（可含子树）递归展示；顶层单元提供 应用 / 编辑 / 删除（级联子树）
 *
 * 模板语义：
 * - 模板单元 = 模板框架（framework-template）的 follows 直属子树（普通节点承载），
 *   desc/body 可含 {{框架名}} 占位，应用时替换为被使用框架的名称；
 *   单元支持子树嵌套——「存为模板」把选中节点及其下属节点整棵存入模板框架。
 * - 模板创建主入口已并入事务设计（DesignView）右键「存为模板」；
 *   本视图聚焦模板库整理与管理（新建单元、编辑内容/占位、删除与结构调整）。
 * - 「插入时行为」（占位与多变量、覆写或附加、附加模式等）为预留扩展面，
 *   参见 src/core/template.ts 文件头说明；当前仅默认行为（仅替换 {{框架名}}）。
 *
 * 注：旧的「从源框架提取」界面已隐藏（创建模板的入口并入事务设计右键），
 * renderExtractSource / extractTemplate 方法体保留作为参考实现。
 */

import { ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import type { NodeKind, SeqtkNode, SeqtkState } from '../types/index';
import {
  NODE_KIND_LABELS,
  isFrameworkKind,
  getAllowedChildKinds,
} from '../types/index';
import type { NodeCache } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import type { OperationQueue } from '../core/OperationQueue';
import { cloneSubtree, TEMPLATE_FRAMEWORK_NAME_TOKEN } from '../core/template';
import { SelectFrameworkModal } from './components/TemplateModals';
import { TransactionCreateModal } from './components/TransactionModals';

export const VIEW_TYPE_TEMPLATE = 'seqtk-template';

export class TemplateView extends ItemView {
  private leftEl!: HTMLElement;
  private rightEl!: HTMLElement;
  private unsub: (() => void) | null = null;
  /** 当前选中的框架 nodeId（模板框架） */
  private selectedId: string | null = null;
  /** 右栏模板单元树展开状态（nodeId 集合） */
  private expandedUnitIds = new Set<string>();

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
    this.leftEl.createEl('div', { cls: 'seqtk-split-title', text: '模板框架' });

    if (!this.nodeCache.isInitialized) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '正在加载缓存…' });
      return;
    }

    // 模板框架组（含嵌套子模板框架）
    const templates = this.nodeCache.getByKind('framework-template');
    if (templates.length === 0) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '暂无模板框架' });
      const btn = this.leftEl.createEl('button', { text: '新建模板框架', cls: 'seqtk-btn' });
      btn.addEventListener('click', () => this.openCreateRootTemplate());
    } else {
      for (const { nodeId, data } of templates) {
        this.renderLeftItem(nodeId, data, 'framework-template');
      }
    }

    // 旧的「事务 / 信息框架（源框架）」分组已移除：创建模板的入口并入事务设计右键「存为模板」
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
      // 源框架管理已并入事务设计（DesignView）；此处兜底提示，不调用已隐藏的 renderExtractSource
      this.rightEl.createEl('div', { cls: 'seqtk-empty', text: '模板提取请使用事务设计右键「存为模板」' });
    }
  }

  /** 右栏：选中模板框架 → 模板单元管理（单元可含子树，递归展示） */
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
    actions.createEl('button', { text: '收起全部', cls: 'seqtk-btn' })
      .addEventListener('click', () => {
        this.expandedUnitIds.clear();
        this.renderRight();
      });

    const children = this.nodeCache
      .getChildren(this.selectedId!)
      .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } => !!c.data);

    if (children.length === 0) {
      this.rightEl.createEl('div', {
        cls: 'seqtk-empty',
        text: '暂无模板单元：可在事务设计右键「存为模板」，或点击「新建模板单元」创建',
      });
      return;
    }

    // 子模板框架：单独行提供「管理」跳转（其下单元在选中该框架后管理）
    const subFrameworks = children.filter((c) => c.data.kind === 'framework-template');
    for (const fw of subFrameworks) {
      const row = this.rightEl.createDiv('seqtk-row');
      row.createEl('span', { cls: 'seqtk-kind-badge', text: NODE_KIND_LABELS[fw.data.kind] });
      row.createEl('span', { cls: 'seqtk-desc', text: fw.data.desc });
      const manageBtn = row.createEl('button', { text: '管理', cls: 'seqtk-btn seqtk-btn-small' });
      manageBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectedId = fw.nodeId;
        this.renderLeft();
        this.renderRight();
      });
    }

    // 模板单元（非框架节点）：树形递归展示，顶层单元提供 应用 / 编辑 / 删除（级联子树）
    for (const unit of children.filter((c) => c.data.kind !== 'framework-template')) {
      this.renderUnitEntry(unit.nodeId, unit.data, 0, true);
    }
  }

  /**
   * 渲染模板单元（顶层带操作按钮，子级递归缩进展示）。
   * 有子级时点击行展开/收起子树；顶层单元即「存为模板」存入的整棵子树入口。
   */
  private renderUnitEntry(nodeId: string, data: SeqtkNode, depth: number, isTop: boolean): void {
    const row = this.rightEl.createDiv('seqtk-row');
    row.style.paddingLeft = `${10 + depth * 18}px`;

    const children = this.nodeCache.getChildren(nodeId).filter((c) => !!c.data);
    const hasChildren = children.length > 0;
    const isExpanded = this.expandedUnitIds.has(nodeId);

    // 折叠标识占位（有子级时随展开状态切换 ▸/▾）
    const mark = row.createEl('span');
    mark.style.width = '14px';
    mark.style.flexShrink = '0';
    if (hasChildren) mark.setText(isExpanded ? '▾' : '▸');

    row.createEl('span', { cls: 'seqtk-kind-badge', text: NODE_KIND_LABELS[data.kind] });
    const desc = row.createEl('span', { cls: 'seqtk-desc', text: data.desc });
    desc.title = nodeId;
    row.createSpan('seqtk-spacer');

    const click = (fn: () => void) => (e: MouseEvent) => {
      e.stopPropagation();
      fn();
    };
    if (isTop) {
      row.createEl('button', { text: '应用', cls: 'seqtk-btn seqtk-btn-small' })
        .addEventListener('click', click(() => this.applyTemplate(nodeId)));
      row.createEl('button', { text: '编辑', cls: 'seqtk-btn seqtk-btn-small' })
        .addEventListener('click', click(() => this.openNodeFile(nodeId)));
      row.createEl('button', { text: '删除', cls: 'seqtk-btn seqtk-btn-small seqtk-btn-danger' })
        .addEventListener('click', click(() => this.deleteTemplateTree(nodeId)));
    } else {
      row.createEl('button', { text: '打开', cls: 'seqtk-btn seqtk-btn-small' })
        .addEventListener('click', click(() => this.openNodeFile(nodeId)));
    }

    if (hasChildren) {
      row.addEventListener('click', () => {
        if (this.expandedUnitIds.has(nodeId)) this.expandedUnitIds.delete(nodeId);
        else this.expandedUnitIds.add(nodeId);
        this.renderRight();
      });
    }

    if (hasChildren && isExpanded) {
      for (const child of children) {
        if (child.data) this.renderUnitEntry(child.nodeId, child.data as SeqtkNode, depth + 1, false);
      }
    }
  }

  /**
   * 右栏：选中源框架 → 展示结构 + 提取为模板
   * @deprecated 创建模板的入口已并入事务设计右键「存为模板」，本方法保留作参考、不再被调用
   */
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

  /**
   * 提取：将源框架的内部节点结构复制为模板单元（源框架名 → {{框架名}} 占位）
   * @deprecated 入口并入事务设计右键「存为模板」（支持整棵子树），本方法保留作参考、不再被调用
   */
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

  /**
   * 应用：将模板单元整棵子树克隆到目标框架（{{框架名}} 按目标框架名替换）。
   * 复用 core/template.cloneSubtree 递归克隆；模板顶层 kind 须为目标框架允许的类型。
   */
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
      onSelect: (targetId) => {
        const target = this.nodeCache.getNode(targetId);
        if (!target) return;
        // 顶层类型校验：模板单元顶层须可直属于目标框架（规则与事务设计一致，types/index.ts）
        if (!getAllowedChildKinds(target.kind).includes(template.kind)) {
          new Notice(`该模板顶层类型「${NODE_KIND_LABELS[template.kind]}」不能插入此框架`);
          return;
        }
        void this.applyTemplateTo(targetId, target.desc, templateId);
      },
    }).open();
  }

  /** 递归克隆模板单元整棵子树到目标框架（供 applyTemplate 调用） */
  private async applyTemplateTo(targetId: string, targetDesc: string, templateId: string): Promise<void> {
    const rootId = await cloneSubtree({
      sourceId: templateId,
      parentId: targetId,
      nodeCache: this.nodeCache,
      fileManager: this.fileManager,
      operationQueue: this.operationQueue,
      resolveText: (text) => text.split(TEMPLATE_FRAMEWORK_NAME_TOKEN).join(targetDesc),
    });
    if (rootId) new Notice('模板已应用');
    else new Notice('应用模板失败');
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

  /** 新建根级模板框架（无父节点；模板框架的首次创建入口） */
  private openCreateRootTemplate(): void {
    new TransactionCreateModal(this.app, {
      kinds: ['framework-template'],
      onSubmit: (input) => void this.createNode(input),
    }).open();
  }

  /** 创建节点（parentId 提供时挂到该父框架下，双向维护 follows + parent） */
  private async createNode(
    input: { kind: NodeKind; desc: string; state: SeqtkState },
    parentId?: string,
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
      ...(parentId ? { parent: parentId } : {}),
    } as SeqtkNode;

    try {
      const nodeId = await this.fileManager.createNode(input.kind, data, '');
      this.operationQueue.enqueueCacheOp(() => this.nodeCache.addNode(nodeId, data, ''));
      if (parentId) this.appendFollows(parentId, nodeId);
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

  /** 级联删除模板单元：移除整棵子树缓存与文件（顶层为「存为模板」存入的单元入口） */
  private deleteTemplateTree(nodeId: string): void {
    const root = this.nodeCache.getNodeFull(nodeId);
    if (!root) return;

    // 先收集子树（含归档后代），再统一清缓存与删文件
    const targets = [
      ...this.nodeCache.collectDescendantsFull(nodeId).map((d) => ({ kind: d.kind, nodeId: d.nodeId })),
      { kind: root.kind, nodeId },
    ];
    this.operationQueue.enqueueCacheBatch([() => this.nodeCache.removeNodeTree(nodeId)]);
    this.operationQueue.enqueueFileBatch(
      targets.map((t) => async () => { await this.fileManager.deleteNode(t.kind, t.nodeId); }),
    );
    new Notice(`模板单元已删除（含 ${targets.length} 个节点）`);
  }
}
