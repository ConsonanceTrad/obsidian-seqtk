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

import { ItemView, MarkdownView, Menu, Notice, TFile, WorkspaceLeaf, getFrontMatterInfo, setIcon, setTooltip } from 'obsidian';
import type { NodeKind, SeqtkNode, SeqtkState, EventNature, PluginSettings } from '../types/index';
import {
  NODE_KIND_LABELS,
  NODE_STATE_LABELS,
  STATE_VALUES,
  EVENT_NATURE_LABELS,
  isFrameworkKind,
  isTransactionKind,
  getCategoryOf,
} from '../types/index';
import { describeCycleRule } from '../utils/cycleRuleParser';
import { formatShortDate } from '../utils/formatDate';
import { tooltipBodyText } from '../utils/tooltip';
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

/** 证据类型（对象/条件/信息/状态）：可跨父拖拽随意更改从属 */
const EVIDENCE_KINDS: NodeKind[] = ['factor', 'requirement', 'clue', 'snapshot'];

export class DesignView extends ItemView {
  private leftEl!: HTMLElement;
  private rightEl!: HTMLElement;
  private unsub: (() => void) | null = null;
  /** 左栏展开状态（nodeId 集合） */
  private expandedLeft = new Set<string>();
  /** 右栏展开状态（nodeId 集合，与左栏独立） */
  private expandedRight = new Set<string>();
  /** 当前选中的框架 nodeId；null 表示「全部事务总览」 */
  private selectedFrameworkId: string | null = null;
  /** 顺序更改模式：开启后按 follows 混合渲染并支持拖拽排序 */
  private sortMode = false;
  /** 当前拖拽源（dragstart 写入，dragover/drop 读取，dragend 清空） */
  private dragSource: { sourceId: string; parentId: string } | null = null;
  /** 行内新建期间抑制 nodeStore 触发的全量重渲染（由局部插入替代，避免画面闪烁） */
  private suppressRender = false;
  /** 顶级框架排序（nodeId 顺序，持久化于 settings.topFrameworkOrder） */
  private topOrder: string[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    private nodeCache: NodeCache,
    private fileManager: NodeFileManager,
    private operationQueue: OperationQueue,
    private settings: PluginSettings,
    private onTopOrderChange?: (order: string[]) => void,
  ) {
    super(leaf);
    this.topOrder = [...(this.settings.topFrameworkOrder ?? [])];
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
      // 行内新建期间由局部插入维护 DOM，跳过全量重渲染避免闪烁
      if (this.suppressRender) return;
      this.renderLeft();
      this.renderRight();
    });
    this.renderLeft();
    this.renderRight();
  }

  /** 设置变更后刷新视图（如「全部事务」入口显隐） */
  refreshSettings(): void {
    this.renderLeft();
    this.renderRight();
  }

  /** 左栏空白右键：新建框架（行内）+ 从磁盘刷新 */
  private showLeftBlankMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle('新建框架').setIcon('folder-plus')
        .onClick(() => this.beginInlineCreateBlank('framework-transaction', this.leftEl)));
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

  /** 右栏空白右键：新建构想/清单/事件（行内）+ 从磁盘刷新（选中框架时以框架为父） */
  private showRightBlankMenu(e: MouseEvent): void {
    const menu = new Menu();
    const parentId = this.selectedFrameworkId ?? undefined;

    menu.addItem((item) =>
      item.setTitle('新建构想').setIcon('plus')
        .onClick(() => this.beginInlineCreateBlank('concept', this.rightEl, parentId)));
    menu.addItem((item) =>
      item.setTitle('新建清单').setIcon('plus')
        .onClick(() => this.beginInlineCreateBlank('checklist', this.rightEl, parentId)));
    menu.addItem((item) =>
      item.setTitle('新建事件').setIcon('plus')
        .onClick(() => this.beginInlineCreateBlank('event', this.rightEl, parentId)));
    // 追加信息：二级子菜单（对象/条件/信息/状态），行内创建证据类型（插入右栏末尾）
    this.appendEvidenceMenu(menu, (k) => this.beginInlineCreateBlank(k, this.rightEl, parentId));
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

    // 「全部事务」入口（默认隐藏，可在设置中打开）
    if (this.settings.showAllOverview) {
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
    }

    const roots = this.buildFrameworkTree();
    if (roots.length === 0) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '暂无框架，右键空白处新建' });
      return;
    }

    for (const root of roots) {
      this.renderFrameNode(root, 0);
    }
  }

  /** 框架树：顶级 = 无框架父节点的框架（仅事务框架），递归子框架；不渲染信息框架 */
  private buildFrameworkTree(): TreeNode[] {
    const roots: TreeNode[] = [];
    for (const kind of ['framework-transaction'] as NodeKind[]) {
      for (const { nodeId, data } of this.nodeCache.getByKind(kind)) {
        const parent = this.nodeCache.getParent(nodeId);
        const parentData = parent ? this.nodeCache.getNode(parent.nodeId) : undefined;
        if (parentData && isFrameworkKind(parentData.kind)) continue;
        roots.push(this.buildFrameworkNode(nodeId, data));
      }
    }
    // 顶级排序：topFrameworkOrder 中出现的按数组顺序，未列入的（新框架）按创建时间排尾部
    const order = new Map(this.topOrder.map((id, i) => [id, i]));
    return roots.sort((a, b) => {
      const ia = order.get(a.nodeId);
      const ib = order.get(b.nodeId);
      if (ia !== undefined && ib !== undefined) return ia - ib;
      if (ia !== undefined) return -1;
      if (ib !== undefined) return 1;
      return (a.data.create ?? '').localeCompare(b.data.create ?? '');
    });
  }

  private buildFrameworkNode(nodeId: string, data: SeqtkNode): TreeNode {
    const children = this.nodeCache
      .getChildren(nodeId)
      .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } =>
        !!c.data && isFrameworkKind(c.data.kind) && c.data.kind !== 'framework-info')
      .map((c) => this.buildFrameworkNode(c.nodeId, c.data));
    return { nodeId, data, children: this.sortByFollows(data, children) };
  }

  private renderFrameNode(node: TreeNode, depth: number, inExpandedTree = false, parentNodeId?: string): HTMLElement {
    const row = this.leftEl.createDiv('seqtk-frame-item');
    row.dataset.nodeId = node.nodeId;
    if (this.selectedFrameworkId === node.nodeId) {
      row.addClass('seqtk-frame-item-active');
    }
    row.style.paddingLeft = `${8 + depth * 14}px`;
    const hasChildren = node.children.length > 0;
    const isExpanded = this.expandedLeft.has(node.nodeId);
    // 仅有子节点的框架才显示展开态/展开树标识（空子框架左侧不显现展开边框标识）
    if (hasChildren) {
      if (isExpanded) row.addClass('seqtk-row-expanded');
      if (inExpandedTree) row.addClass('seqtk-row-in-expanded');
    }

    // 折叠标识小方块（有子项时显示；展开态由 CSS 隐藏）
    if (hasChildren) row.createSpan('seqtk-collapse-mark');

    // 左栏：行单击=展开/折叠（直接响应，无延迟）；行末按钮=在右侧打开
    row.addEventListener('click', () => {
      if (hasChildren) this.toggleExpand(node.nodeId, 'left');
    });

    // 左栏拖拽排序（默认启用）：同父同级排序（子框架→父 follows，顶级→topFrameworkOrder）
    row.draggable = true;
    row.dataset.parentId = parentNodeId ?? '';
    row.addEventListener('dragstart', (e) => {
      this.dragSource = { sourceId: node.nodeId, parentId: parentNodeId ?? '' };
      const dt = e.dataTransfer;
      if (dt) {
        dt.setData('text/plain', JSON.stringify(this.dragSource));
        dt.effectAllowed = 'move';
      }
      row.addClass('seqtk-dragging');
    });
    row.addEventListener('dragend', () => {
      row.removeClass('seqtk-dragging');
      this.dragSource = null;
      this.clearDropIndicators();
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.clearDropIndicators();
      let valid = false;
      const source = this.dragSource;
      if (source) {
        const target = this.resolveDropTarget(e);
        // 仅同父同级排序（跨父/跨级驳回）
        if (target && target.parentId === source.parentId && target.nodeId !== source.sourceId) {
          valid = true;
          target.row.addClass(target.before ? 'seqtk-drop-before' : 'seqtk-drop-after');
        } else if (target) {
          target.row.addClass('seqtk-drop-invalid');
        }
      }
      if (e.dataTransfer) e.dataTransfer.dropEffect = valid ? 'move' : 'none';
    });
    row.addEventListener('dragleave', () => {
      row.removeClass('seqtk-drop-before');
      row.removeClass('seqtk-drop-after');
      row.removeClass('seqtk-drop-invalid');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      this.clearDropIndicators();
      const source = this.dragSource;
      const target = this.resolveDropTarget(e);
      if (!source) return;
      if (target && target.parentId === source.parentId && target.nodeId !== source.sourceId) {
        if (source.parentId) {
          // 子框架：父 follows 排序
          this.moveChildInFollows(source.parentId, source.sourceId, target.nodeId, target.before);
        } else {
          // 顶级框架：topFrameworkOrder 排序
          this.moveTopInOrder(source.sourceId, target.nodeId, target.before);
        }
      }
      this.dragSource = null;
    });

    // 事务框架在事务设计中显示为"框架"
    const kindLabel = node.data.kind === 'framework-transaction'
      ? '框架'
      : NODE_KIND_LABELS[node.data.kind];
    row.createEl('span', { cls: `seqtk-kind-badge kind-${getCategoryOf(node.data.kind)}`, text: kindLabel });

    row.createEl('span', { cls: 'seqtk-desc', text: node.data.desc });

    // 正文预览（节点名后，超长省略截断）
    const bodyPreview = this.nodeCache.getNodeBody(node.nodeId);
    if (bodyPreview) {
      const preview = row.createEl('span', { cls: 'seqtk-body-preview', text: bodyPreview });
      setTooltip(preview, tooltipBodyText(bodyPreview));
    }
    // 弹性间隔：填充剩余空间，使右侧徽章/打开按钮靠右
    row.createSpan('seqtk-spacer');

    // 预期属性徽章
    if (isFrameworkKind(node.data.kind)) {
      const span = (node.data as any).expectedSpan;
      if (span?.from || span?.to) {
        const spanBadge = row.createEl('span', { cls: 'seqtk-expected-badge', text: `📅 ${span.from ? formatShortDate(span.from) : ''} → ${span.to ? formatShortDate(span.to) : ''}` });
        setTooltip(spanBadge, `预期时间段: ${span.from || ''} ~ ${span.to || ''}`);
      }
    }

    // 行末：在右侧打开（选中并在右侧显现）
    const openBtn = row.createEl('button', { cls: 'seqtk-open-btn' });
    setTooltip(openBtn, '在右侧打开');
    setIcon(openBtn, 'right-arrow');
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectedFrameworkId = node.nodeId;
      this.renderLeft();
      this.renderRight();
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showFrameMenu(e, node);
    });

    if (hasChildren && isExpanded) {
      for (const child of node.children) {
        this.renderFrameNode(child, depth + 1, true, node.nodeId);
      }
    }
    return row;
  }

  /**
   * 追加信息：二级子菜单（对象/条件/信息/状态），点击后执行 onPick(kind) 行内创建对应证据类型。
   * 节点行菜单、右侧框架菜单、右栏空白菜单共用。
   */
  private appendEvidenceMenu(menu: Menu, onPick: (k: NodeKind) => void): void {
    const EVIDENCE_ICONS: Record<string, string> = {
      factor: 'box',
      requirement: 'check-square',
      clue: 'info',
      snapshot: 'camera',
    };
    let usedEvidenceSubmenu = false;
    menu.addItem((item) => {
      item.setTitle('追加信息').setIcon('plus');
      const setSubmenu = (item as any).setSubmenu as (() => Menu) | undefined;
      if (typeof setSubmenu === 'function') {
        const sub = setSubmenu.call(item) as Menu;
        for (const k of EVIDENCE_KINDS) {
          sub.addItem((si) =>
            si.setTitle(NODE_KIND_LABELS[k]).setIcon(EVIDENCE_ICONS[k]).onClick(() => onPick(k)));
        }
        usedEvidenceSubmenu = true;
      } else {
        item.setIsLabel(true);
      }
    });
    if (!usedEvidenceSubmenu) {
      for (const k of EVIDENCE_KINDS) {
        menu.addItem((item) =>
          item.setTitle(NODE_KIND_LABELS[k]).setIcon(EVIDENCE_ICONS[k]).onClick(() => onPick(k)));
      }
    }
  }

  private showFrameMenu(e: MouseEvent, node: TreeNode, side: 'left' | 'right' = 'left'): void {
    const menu = new Menu();
    // 展开/收起置顶：描述与图标随即将执行的行为变化（折叠→展开，展开→收起）；展开状态按栏独立
    if (node.children.length > 0) {
      const isExpanded = (side === 'left' ? this.expandedLeft : this.expandedRight).has(node.nodeId);
      menu.addItem((item) =>
        item.setTitle(isExpanded ? '收起' : '展开').setIcon(isExpanded ? 'fold-vertical' : 'unfold-vertical')
          .onClick(() => this.toggleExpandAll(node, side)));
    }
    const splitCreate = side === 'right';
    if (splitCreate) {
      // 右侧框架菜单：新建子项拆分为四个行内创建入口（不开模态框）
      const inlineCreate = (k: NodeKind): void => {
        const row = (e.target as HTMLElement).closest('.seqtk-row');
        if (row) this.beginInlineCreate(node, row as HTMLElement, [k], 'right');
      };
      menu.addItem((item) =>
        item.setTitle('新建构思').setIcon('lightbulb').onClick(() => inlineCreate('concept')));
      menu.addItem((item) =>
        item.setTitle('新建清单').setIcon('list-checks').onClick(() => inlineCreate('checklist')));
      menu.addItem((item) =>
        item.setTitle('新建事件').setIcon('calendar').onClick(() => inlineCreate('event')));
      this.appendEvidenceMenu(menu, inlineCreate);
    } else {
      // 左栏框架菜单：新建子框架（行内添加，蓝色"框架"预览标签 + 名称输入，保持旧版行为）
      menu.addItem((item) =>
        item.setTitle('新建子框架').setIcon('folder-plus')
          .onClick(() => {
            const row = (e.target as HTMLElement).closest('.seqtk-frame-item');
            if (row) this.beginInlineCreate(node, row as HTMLElement, ['framework-transaction'], 'left');
          }));
    }
    menu.addItem((item) =>
      item.setTitle('重命名').setIcon('pencil')
        .onClick(() => {
          // 右栏框架行为 .seqtk-row，左栏为 .seqtk-frame-item，按行类选择对应行内编辑
          const row = (e.target as HTMLElement).closest<HTMLElement>('.seqtk-row, .seqtk-frame-item');
          if (!row) return;
          if (row.classList.contains('seqtk-frame-item')) {
            this.beginInlineEditFrame(node, row);
          } else {
            this.beginInlineEdit(node, row);
          }
        }));
    menu.addItem((item) =>
      item.setTitle('修改属性').setIcon('settings-2')
        .onClick(() => this.openEdit(node.nodeId)));
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle('归档').setIcon('archive')
        .onClick(() => this.archiveNode(node.nodeId)));
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

    // 未选中框架：显示全部事务总览（入口隐藏时显示占位提示，不展示总览）
    if (this.selectedFrameworkId === null) {
      if (this.settings.showAllOverview) {
        this.renderAllOverview();
      } else {
        this.rightEl.createEl('div', { cls: 'seqtk-empty', text: '在左侧选择框架以查看内容' });
      }
      return;
    }

    const framework = this.nodeCache.getNode(this.selectedFrameworkId);
    if (!framework) {
      this.selectedFrameworkId = null;
      if (this.settings.showAllOverview) {
        this.renderAllOverview();
      } else {
        this.rightEl.createEl('div', { cls: 'seqtk-empty', text: '在左侧选择框架以查看内容' });
      }
      return;
    }

    // 标题行 + 顺序更改模式切换按钮
    const titleRow = this.rightEl.createDiv('seqtk-title-row');
    titleRow.createEl('div', {
      cls: 'seqtk-split-title',
      text: `${NODE_KIND_LABELS[framework.kind]} · ${framework.desc}`,
    });
    const sortBtn = titleRow.createEl('button', {
      cls: 'seqtk-btn' + (this.sortMode ? ' seqtk-btn-active' : ''),
      text: '顺序更改模式',
    });
    sortBtn.addEventListener('click', () => {
      this.sortMode = !this.sortMode;
      this.renderRight();
    });

    const fwId = this.selectedFrameworkId;
    const parent = this.nodeCache.getNode(fwId);

    // 始终按 follows 顺序混合渲染直接子节点（框架→卡片、其他→行，平等排序）
    const directChildren = this.nodeCache.getChildren(fwId).filter((c) => !!c.data);
    const sorted = parent ? this.sortByFollows(parent, directChildren) : directChildren;
    if (sorted.length === 0) {
      this.rightEl.createEl('div', {
        cls: 'seqtk-empty',
        text: '该框架暂无内部节点\n在右栏空白处右键可创建子节点',
      });
      return;
    }
    for (const child of sorted) {
      const node = child.data!;
      // 框架节点由 renderNode 创建卡片容器（内部按需展开其直接子节点），其余为普通行
      this.renderNode(this.buildNode(child.nodeId, node), 0, this.rightEl, false, fwId);
    }
  }

  /** 按父节点 follows 数组顺序排序；未列出的子节点按创建时间排后 */
  private sortByFollows<T extends { nodeId: string }>(parent: SeqtkNode, items: T[]): T[] {
    const order = new Map((parent.follows ?? []).map((id, i) => [id, i]));
    return [...items].sort((a, b) => {
      const ia = order.get(a.nodeId);
      const ib = order.get(b.nodeId);
      if (ia !== undefined && ib !== undefined) return ia - ib;
      if (ia !== undefined) return -1;
      if (ib !== undefined) return 1;
      return ((a as any).data.create ?? '').localeCompare((b as any).data.create ?? '');
    });
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

  /** 递归构建树节点（所有类型子节点，按父节点 follows 顺序排序） */
  private buildNode(nodeId: string, data: SeqtkNode): TreeNode {
    const children = this.nodeCache
      .getChildren(nodeId)
      .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } => !!c.data)
      .map((c) => this.buildNode(c.nodeId, c.data));
    return { nodeId, data, children: this.sortByFollows(data, children) };
  }

  // ============================================================
  // 节点行渲染
  // ============================================================

  private renderNode(node: TreeNode, depth: number, container: HTMLElement, inExpandedTree = false, parentNodeId?: string): HTMLElement {
    // 框架节点以卡片容器承载行与展开内容（嵌套框架层层套卡片）；其余节点直接进容器
    const isFramework = isFrameworkKind(node.data.kind);
    const card = isFramework ? container.createDiv('seqtk-fw-card') : container;
    const row = card.createDiv('seqtk-row');
    row.dataset.nodeId = node.nodeId;
    row.style.paddingLeft = `${8 + depth * 18}px`;
    const isExpanded = this.expandedRight.has(node.nodeId);
    if (isExpanded) row.addClass('seqtk-row-expanded');
    if (inExpandedTree) row.addClass('seqtk-row-in-expanded');

    const hasChildren = node.children.length > 0;
    // 折叠标识小方块（有子项时显示；展开态由 CSS 隐藏）
    if (hasChildren) row.createSpan('seqtk-collapse-mark');

    // 右栏：行单击=展开/折叠（直接响应）；重命名入口在右键菜单
    row.addEventListener('click', () => {
      if (hasChildren) this.toggleExpand(node.nodeId, 'right');
    });

    // 排序模式：拖拽排序（仅直接子项，parentNodeId 存在时）
    if (this.sortMode && parentNodeId) {
      row.draggable = true;
      row.dataset.parentId = parentNodeId;
      row.addEventListener('dragstart', (e) => {
        // 组件状态保存拖拽源（dragover/drop 阶段 dataTransfer.getData 不可靠）
        this.dragSource = { sourceId: node.nodeId, parentId: parentNodeId };
        // console.log('[SeqTK] dragstart', this.dragSource);
        const dt = e.dataTransfer;
        if (dt) {
          dt.setData('text/plain', JSON.stringify(this.dragSource));
          dt.effectAllowed = 'move';
        }
        row.addClass('seqtk-dragging');
      });
      row.addEventListener('dragend', () => {
        // console.log('[SeqTK] dragend, dragSource=', this.dragSource);
        row.removeClass('seqtk-dragging');
        this.dragSource = null;
        this.clearDropIndicators();
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        this.clearDropIndicators();
        let valid = false;
        const source = this.dragSource;
        if (source) {
          const target = this.resolveDropTarget(e);
          if (target && this.canDrop(source, target)) {
            valid = true;
            // 上半 → 目标下方同级（after 指示线）；下半 → 目标子级（child 缩进指示）
            target.row.addClass(target.before ? 'seqtk-drop-after' : 'seqtk-drop-child');
          } else if (target) {
            // 非容许目标（跨父不允许/自身）：驳回
            target.row.addClass('seqtk-drop-invalid');
          }
          if (target) {
            // console.log('[SeqTK] dragover source=', source, 'target=', { nodeId: target.nodeId, parentId: target.parentId, before: target.before }, 'valid=', valid);
          }
        }
        if (e.dataTransfer) e.dataTransfer.dropEffect = valid ? 'move' : 'none';
      });
      row.addEventListener('dragleave', () => {
        row.removeClass('seqtk-drop-before');
        row.removeClass('seqtk-drop-after');
        row.removeClass('seqtk-drop-child');
        row.removeClass('seqtk-drop-invalid');
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        this.clearDropIndicators();
        const source = this.dragSource;
        const target = this.resolveDropTarget(e);
        // console.log('[SeqTK] drop source=', source, 'target=', target ? { nodeId: target.nodeId, parentId: target.parentId, before: target.before } : null);
        if (!source) return;
        if (target && this.canDrop(source, target)) {
          if (target.before) {
            // 上半：添加到目标下方同级（目标父集合中目标之后）
            if (target.parentId === source.parentId) {
              this.moveChildInFollows(source.parentId, source.sourceId, target.nodeId, false);
            } else {
              this.moveChildAcrossParents(source.parentId, source.sourceId, target.parentId, target.nodeId, false);
            }
          } else {
            // 下半：添加到目标下方子级（目标作为新父，插入其子列表尾部）
            this.moveChildAcrossParents(source.parentId, source.sourceId, target.nodeId, '', false);
          }
        }
        this.dragSource = null;
      });
    }

    // 类型徽章（事件标注性质；状态节点标注时间点；事务框架显示"框架"）
    let kindLabel = node.data.kind === 'framework-transaction'
      ? '框架'
      : NODE_KIND_LABELS[node.data.kind];
    if (node.data.kind === 'event') {
      kindLabel = EVENT_NATURE_LABELS[node.data.nature ?? 'temp'];
    } else if (node.data.kind === 'snapshot' && (node.data as any).at) {
      kindLabel = `${kindLabel}·${String((node.data as any).at).slice(5, 16)}`;
    }
    row.createEl('span', { cls: `seqtk-kind-badge kind-${getCategoryOf(node.data.kind)}`, text: kindLabel });

    const desc = row.createEl('span', { cls: 'seqtk-desc', text: node.data.desc });
    // 节点行悬浮：仅显示目标时间点与重复规则（都无则不显示）
    const txn = node.data as any;
    const hints: string[] = [];
    if (txn.expectedTime) hints.push(`目标时间: ${txn.expectedTime}`);
    if (txn.expectedRepeat) hints.push(`重复规则: ${txn.expectedRepeat}`);
    if (hints.length > 0) setTooltip(desc, hints.join(' · '));

    // 正文预览（节点名后，超长省略截断）
    const bodyPreview = this.nodeCache.getNodeBody(node.nodeId);
    if (bodyPreview) {
      const preview = row.createEl('span', { cls: 'seqtk-body-preview', text: bodyPreview });
      setTooltip(preview, tooltipBodyText(bodyPreview));
    }
    // 弹性间隔：填充剩余空间，使右侧徽章/状态圆点靠右
    row.createSpan('seqtk-spacer');

    // 预期属性徽章
    if (isTransactionKind(node.data.kind)) {
      if ((node.data as any).expectedTime) {
        const timeBadge = row.createEl('span', { cls: 'seqtk-expected-badge', text: `🗓 ${formatShortDate((node.data as any).expectedTime)}` });
        setTooltip(timeBadge, `预期时间: ${(node.data as any).expectedTime}`);
      }
      if ((node.data as any).expectedRepeat) {
        const repeatBadge = row.createEl('span', { cls: 'seqtk-expected-badge', text: `♺ ${describeCycleRule((node.data as any).expectedRepeat)}` });
        setTooltip(repeatBadge, `预期重复: ${(node.data as any).expectedRepeat}`);
      }
    } else if (isFrameworkKind(node.data.kind)) {
      const span = (node.data as any).expectedSpan;
      if (span?.from || span?.to) {
        const spanBadge = row.createEl('span', { cls: 'seqtk-expected-badge', text: `📅 ${span.from ? formatShortDate(span.from) : ''} → ${span.to ? formatShortDate(span.to) : ''}` });
        setTooltip(spanBadge, `预期时间段: ${span.from || ''} ~ ${span.to || ''}`);
      }
    }

    // 行末：在右侧打开（框架行，切换选中该框架；位于状态圆点之前）
    if (isFrameworkKind(node.data.kind)) {
      const openBtn = row.createEl('button', { cls: 'seqtk-open-btn' });
      setTooltip(openBtn, '在右侧打开');
      setIcon(openBtn, 'right-arrow');
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectedFrameworkId = node.nodeId;
        this.renderLeft();
        this.renderRight();
      });
    }

    // 状态圆点（仅框架/事务显示，悬停显示状态名；点击打开状态菜单）
    if (kindUsesState(node.data.kind)) {
      const state = node.data.state ?? 'plan';
      const stateBtn = row.createEl('button', {
        cls: `seqtk-state-dot state-${state}`,
      });
      setTooltip(stateBtn, NODE_STATE_LABELS[state]);
      stateBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showStateMenu(e, node); });
    }

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // 框架行用框架菜单（新建子框架/编辑/归档/删除；右侧拆分为行内新建入口），其余用节点行菜单
      if (isFrameworkKind(node.data.kind)) {
        this.showFrameMenu(e, node, 'right');
      } else {
        this.showRowMenu(e, node);
      }
    });

    if (hasChildren && isExpanded) {
      // 展开内容渲染进卡片容器（框架节点）或原容器（普通节点）
      for (const child of node.children) {
        this.renderNode(child, depth + 1, card, true, node.nodeId);
      }
    }
    return row;
  }

  /**
   * 行内编辑节点名：将行内 seqtk-desc 原位替换为输入框。
   * Enter 保存、Esc 取消、失焦（blur）保存。
   */
  private beginInlineEdit(node: TreeNode, row: HTMLElement): void {
    if (row.querySelector('.seqtk-inline-edit')) return;
    const descEl = row.querySelector<HTMLElement>('.seqtk-desc');
    if (!descEl) return;

    // 名称改为不可见但保留占位（行高不变，避免下方行上移）；隐藏正文预览/弹性间隔，输入框插入名称原位并占满至行末徽章前
    descEl.style.visibility = 'hidden';
    const preview = row.querySelector<HTMLElement>('.seqtk-body-preview');
    if (preview) preview.style.display = 'none';
    const spacer = row.querySelector<HTMLElement>('.seqtk-spacer');
    if (spacer) spacer.style.display = 'none';
    const input = document.createElement('input');
    input.className = 'seqtk-inline-edit';
    input.value = node.data.desc;
    row.insertBefore(input, descEl);
    input.focus();
    input.select();

    let finished = false;
    const finish = (save: boolean): void => {
      if (finished) return;
      finished = true;
      const newDesc = input.value.trim();
      if (save && newDesc && newDesc !== node.data.desc) {
        this.saveNodeDesc(node, newDesc);
      }
      this.renderRight();
    };

    // 编辑期间阻止行级单击/双击（不触发展开/再次编辑）
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  /**
   * 行内编辑框架名：将行内 seqtk-desc 原位替换为输入框。
   * Enter 保存、Esc 取消、失焦（blur）保存；完成后重绘左栏。
   */
  private beginInlineEditFrame(node: TreeNode, row: HTMLElement): void {
    if (row.querySelector('.seqtk-inline-edit')) return;
    const descEl = row.querySelector<HTMLElement>('.seqtk-desc');
    if (!descEl) return;

    // 隐藏名称与正文预览/弹性间隔，输入框插入名称原位并占满至行末按钮前（行高由 padding 维持）
    descEl.style.display = 'none';
    const preview = row.querySelector<HTMLElement>('.seqtk-body-preview');
    if (preview) preview.style.display = 'none';
    const spacer = row.querySelector<HTMLElement>('.seqtk-spacer');
    if (spacer) spacer.style.display = 'none';
    const input = document.createElement('input');
    input.className = 'seqtk-inline-edit';
    input.value = node.data.desc;
    row.insertBefore(input, descEl);
    input.focus();
    input.select();

    let finished = false;
    const finish = (save: boolean): void => {
      if (finished) return;
      finished = true;
      const newDesc = input.value.trim();
      if (save && newDesc && newDesc !== node.data.desc) {
        this.saveNodeDesc(node, newDesc);
      }
      this.renderLeft();
    };

    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  /** 保存节点名（desc）变更 */
  private saveNodeDesc(node: TreeNode, newDesc: string): void {
    this.operationQueue.enqueue(
      () => this.nodeCache.updateNode(node.nodeId, { desc: newDesc, modify: new Date().toISOString() }),
      async () => { await this.fileManager.updateNode(node.data.kind, node.nodeId, { desc: newDesc }); },
    );
  }

  /**
   * 行内创建（空白区域右键）：在容器末尾插入附加行（类型预览 + 名称输入），
   * Enter 创建、Esc/blur 取消。
   */
  private beginInlineCreateBlank(kind: NodeKind, container: HTMLElement, parentId?: string): void {
    if (container.querySelector('.seqtk-inline-add')) return;
    const addRow = container.createDiv('seqtk-inline-add');
    addRow.style.paddingLeft = '8px';
    // 框架类型：显示"框架"标签 + 蓝色语义类；证据类型：橙色（与行徽章一致）
    const isFw = kind === 'framework-transaction';
    const catCls = isFw ? ' kind-framework' : getCategoryOf(kind) === 'evidence' ? ' kind-evidence' : '';
    const previewCls = `seqtk-inline-kind-preview${catCls}`;
    const previewText = isFw ? '框架' : NODE_KIND_LABELS[kind];
    addRow.createEl('span', { cls: previewCls, text: previewText });
    const input = addRow.createEl('input', { cls: 'seqtk-inline-name', placeholder: `输入${NODE_KIND_LABELS[kind]}名称…` });
    input.focus();

    let finished = false;
    const finish = (confirm: boolean): void => {
      if (finished) return;
      finished = true;
      const name = input.value.trim();
      if (!confirm || !name) {
        addRow.remove();
        return;
      }
      // 右栏「全部事务总览」模式（无父）：不提前移除 addRow，由缓存订阅触发的全量渲染一次到位
      if (container === this.rightEl && !parentId) {
        void this.createNode({ kind, desc: name, state: 'plan', afterCreate: 'direct' })
          .then((ok) => { if (!ok) addRow.remove(); });
        return;
      }
      // 其余行内新建：抑制全量重渲染，创建成功后原地替换为新行（避免画面闪烁）
      void (async () => {
        this.suppressRender = true;
        try {
          const side = container === this.leftEl ? 'left' : 'right';
          const nodeId = await this.createNode(
            { kind, desc: name, state: 'plan', afterCreate: 'direct' },
            parentId,
            { skipRender: true, side },
          );
          if (!nodeId) { addRow.remove(); return; }
          const nodeData = this.nodeCache.getNode(nodeId);
          if (!nodeData) { addRow.remove(); return; }
          let newRow: HTMLElement;
          if (kind === 'framework-transaction') {
            // 左栏空白新建框架：渲染顶级框架行并原地替换
            newRow = this.renderFrameNode(this.buildFrameworkNode(nodeId, nodeData), 0);
          } else {
            newRow = this.renderNode(this.buildNode(nodeId, nodeData), 0, this.rightEl, false, parentId);
            newRow.style.paddingLeft = addRow.style.paddingLeft || '8px';
          }
          // 清理由空列表展示的占位提示（首次创建场景）
          container.querySelectorAll('.seqtk-empty').forEach((el) => el.remove());
          addRow.replaceWith(newRow);
        } finally {
          this.suppressRender = false;
        }
      })();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(false));
  }

  /**
   * 行内新建子节点：若父节点收起则先展开；在子列表末尾插入附加行
   * （类型预览 + 名称输入），Enter 创建、Esc/blur 取消。
   *
   * @param kindsOverride 固定子类型列表（如「追加信息」菜单），缺省按父节点类型推导
   * @param side 所在栏（左栏 .seqtk-frame-item / 右栏 .seqtk-row），决定展开状态与渲染方式
   */
  private beginInlineCreate(node: TreeNode, row: HTMLElement, kindsOverride?: NodeKind[], side: 'left' | 'right' = 'right'): void {
    const isLeft = side === 'left';
    const rowSel = isLeft ? '.seqtk-frame-item' : '.seqtk-row';
    const expandedSet = isLeft ? this.expandedLeft : this.expandedRight;
    const containerEl = isLeft ? this.leftEl : this.rightEl;
    if (row.parentElement?.querySelector('.seqtk-inline-add')) return;
    const kinds = kindsOverride ?? this.getChildKinds(node.data.kind);
    if (kinds.length === 0) return;

    // 收起状态：先展开父节点并重渲染，再定位新行
    if (!expandedSet.has(node.nodeId)) {
      expandedSet.add(node.nodeId);
      if (isLeft) this.renderLeft(); else this.renderRight();
      const newRow = containerEl.querySelector<HTMLElement>(`${rowSel}[data-node-id="${node.nodeId}"]`);
      if (!newRow) return;
      row = newRow;
    }

    const addRow = row.parentElement!.createDiv('seqtk-inline-add');
    // 缩进对齐新子节点层级：父行缩进 + 步长（右栏行 18px / 左栏框架行 14px）
    addRow.style.paddingLeft = `${(parseFloat(row.style.paddingLeft) || 8) + (isLeft ? 14 : 18)}px`;
    // 附加行总高与父行（同层级普通行）精确对齐，避免插入时行高度跳动
    addRow.style.boxSizing = 'border-box';
    const rowHeight = row.offsetHeight;
    if (rowHeight > 0) addRow.style.minHeight = `${rowHeight}px`;

    // 定位子列表末尾：该节点子树渲染的最后一行之后
    const subtreeIds = new Set<string>();
    const collect = (n: TreeNode): void => {
      subtreeIds.add(n.nodeId);
      for (const c of n.children) collect(c);
    };
    collect(node);
    let anchor: HTMLElement = row;
    let sib = row.nextElementSibling;
    const rowCls = isLeft ? 'seqtk-frame-item' : 'seqtk-row';
    while (sib && sib.classList.contains(rowCls) && subtreeIds.has((sib as HTMLElement).dataset.nodeId ?? '')) {
      anchor = sib as HTMLElement;
      sib = sib.nextElementSibling;
    }
    anchor.after(addRow);

    let kind: NodeKind = kinds[0];
    if (kinds.length > 1) {
      // 多子类型：类型下拉（位于输入框前；点击不结束编辑，选完回到输入框）
      const sel = addRow.createEl('select', { cls: 'seqtk-inline-kind' });
      for (const k of kinds) sel.createEl('option', { value: k, text: NODE_KIND_LABELS[k] });
      sel.addEventListener('change', () => { kind = sel.value as NodeKind; setPlaceholder(); input.focus(); });
    } else {
      // 单子类型：类型预览标签（框架显示蓝色"框架"；证据类型橙色，与行徽章一致）
      const isFw = kind === 'framework-transaction';
      const catCls = isFw ? ' kind-framework' : getCategoryOf(kind) === 'evidence' ? ' kind-evidence' : '';
      const previewText = isFw ? '框架' : NODE_KIND_LABELS[kind];
      addRow.createEl('span', { cls: `seqtk-inline-kind-preview${catCls}`, text: previewText });
    }
    const input = addRow.createEl('input', { cls: 'seqtk-inline-name' });
    // 显式约束输入框高度 = 附加行内容区高度（border-box；左右栏纵向 padding 分别为 6/8px），
    // 避免输入框按字号放大而撑高附加行导致跳动（rowHeight 已在 addRow 创建处测得）
    if (rowHeight > 0) {
      const vPad = isLeft ? 8 : 6;
      input.style.height = `${rowHeight - vPad}px`;
      input.style.boxSizing = 'border-box';
    }
    const setPlaceholder = (): void => { input.placeholder = `输入${NODE_KIND_LABELS[kind]}名称…`; };
    setPlaceholder();
    input.focus();

    let finished = false;
    const finish = (confirm: boolean): void => {
      if (finished) return;
      finished = true;
      const name = input.value.trim();
      if (!confirm || !name) {
        addRow.remove();
        return;
      }
      // 平滑创建：抑制全量重渲染，创建成功后原地替换为新行（避免画面闪烁）
      void (async () => {
        this.suppressRender = true;
        try {
          const nodeId = await this.createNode(
            { kind, desc: name, state: 'plan', afterCreate: 'direct' },
            node.nodeId,
            { skipRender: true, side },
          );
          if (!nodeId) { addRow.remove(); return; }
          if (isLeft) {
            // 左栏仅展示框架：重绘左栏即可（列表小、无闪烁；非框架子项不出现在左栏属正常语义）
            this.renderLeft();
            return;
          }
          const nodeData = this.nodeCache.getNode(nodeId);
          if (!nodeData) { addRow.remove(); return; }
          const container = row.parentElement!;
          const newRow = this.renderNode(this.buildNode(nodeId, nodeData), 0, container, true, node.nodeId);
          // 保持与附加行一致的层级缩进
          newRow.style.paddingLeft = addRow.style.paddingLeft || row.style.paddingLeft;
          // 清理由空列表展示的占位提示（首次创建场景）
          container.querySelectorAll('.seqtk-empty').forEach((el) => el.remove());
          addRow.replaceWith(newRow);
        } finally {
          this.suppressRender = false;
        }
      })();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    });
    // 焦点移到附加行内（如类型下拉）不结束编辑
    input.addEventListener('blur', (e) => {
      const related = (e as FocusEvent).relatedTarget as HTMLElement | null;
      if (related && addRow.contains(related)) return;
      finish(false);
    });
  }

  /**
   * 行内编辑正文：节点行紧邻下方覆盖式多行 textarea。
   * Ctrl+Enter 保存、Esc 取消、失焦（blur）保存。
   */
  private beginInlineEditBody(node: TreeNode, row: HTMLElement): void {
    if (row.parentElement?.querySelector('.seqtk-inline-body')) return;
    const current = this.nodeCache.getNodeBody(node.nodeId) ?? '';

    const wrap = row.parentElement!.createDiv('seqtk-inline-body');
    row.after(wrap);

    const area = wrap.createEl('textarea', { cls: 'seqtk-inline-body-area' });
    area.value = current;
    area.focus();
    area.setSelectionRange(current.length, current.length);

    let finished = false;
    const finish = (save: boolean): void => {
      if (finished) return;
      finished = true;
      const body = area.value;
      wrap.remove();
      if (save && body !== current) {
        this.saveNodeBody(node, body);
      }
      this.renderRight();
    };
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    });
    area.addEventListener('blur', () => finish(true));
  }

  /** 保存节点正文（body）变更 */
  private saveNodeBody(node: TreeNode, body: string): void {
    this.operationQueue.enqueue(
      () => this.nodeCache.setNodeBody(node.nodeId, body),
      async () => { await this.fileManager.updateNodeBody(node.data.kind, node.nodeId, body); },
    );
  }

  /** 按栏切换展开/收起（左右栏展开状态相互独立） */
  private toggleExpand(nodeId: string, side: 'left' | 'right'): void {
    const set = side === 'left' ? this.expandedLeft : this.expandedRight;
    if (set.has(nodeId)) {
      set.delete(nodeId);
    } else {
      set.add(nodeId);
    }
    this.renderLeft();
    this.renderRight();
  }

  /** 按栏展开或收起该节点的全部子孙节点（依据该栏当前展开状态切换） */
  private toggleExpandAll(node: TreeNode, side: 'left' | 'right'): void {
    const set = side === 'left' ? this.expandedLeft : this.expandedRight;
    const ids: string[] = [];
    const collect = (n: TreeNode): void => {
      ids.push(n.nodeId);
      for (const c of n.children) collect(c);
    };
    collect(node);
    if (set.has(node.nodeId)) {
      for (const id of ids) set.delete(id);
    } else {
      for (const id of ids) set.add(id);
    }
    this.renderLeft();
    this.renderRight();
  }

  /** 解析拖拽落点：目标行（右栏 .seqtk-row / 左栏 .seqtk-frame-item）+ 插入位置（上半=前、下半=后）；顶级行 parentId 为空串 */
  private resolveDropTarget(e: DragEvent): { row: HTMLElement; nodeId: string; parentId: string; before: boolean } | null {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.seqtk-row, .seqtk-frame-item');
    if (!el) return null;
    const nodeId = el.dataset.nodeId ?? '';
    const parentId = el.dataset.parentId ?? '';
    if (!nodeId) return null;
    const rect = el.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    return { row: el, nodeId, parentId, before };
  }

  /** 在同父 follows 中把 sourceId 移到 targetId 前/后，持久化并重渲染 */
  private moveChildInFollows(parentId: string, sourceId: string, targetId: string, before: boolean): void {
    const parent = this.nodeCache.getNode(parentId);
    if (!parent) {
      // console.log('[SeqTK] moveChildInFollows: 父节点不存在', parentId);
      return;
    }
    const follows = [...(parent.follows ?? [])];
    const srcIdx = follows.indexOf(sourceId);
    // console.log('[SeqTK] moveChildInFollows parent=', parentId, 'source=', sourceId, 'target=', targetId, 'before=', before, 'follows=', follows, 'srcIdx=', srcIdx);
    if (srcIdx < 0) return;
    follows.splice(srcIdx, 1);
    let insertAt = follows.indexOf(targetId);
    if (insertAt < 0) insertAt = follows.length;
    if (!before) insertAt += 1;
    follows.splice(insertAt, 0, sourceId);
    // console.log('[SeqTK] moveChildInFollows 新 follows=', follows);
    this.operationQueue.enqueue(
      () => this.nodeCache.updateNode(parentId, { follows, modify: new Date().toISOString() }),
      async () => { await this.fileManager.updateNode(parent.kind, parentId, { follows }); },
    );
    this.renderRight();
  }

  /**
   * 顶级框架排序：以当前渲染顺序（topFrameworkOrder + 未列入按创建时间）重建数组，
   * 将 sourceId 移到 targetId 前/后，更新 topOrder 并回调保存到 settings。
   */
  private moveTopInOrder(sourceId: string, targetId: string, before: boolean): void {
    const roots = this.buildFrameworkTree();
    const order = roots.map((r) => r.nodeId);
    const srcIdx = order.indexOf(sourceId);
    if (srcIdx < 0) return;
    order.splice(srcIdx, 1);
    let insertAt = order.indexOf(targetId);
    if (insertAt < 0) insertAt = order.length;
    if (!before) insertAt += 1;
    order.splice(insertAt, 0, sourceId);
    this.topOrder = order;
    this.onTopOrderChange?.(order);
    this.renderLeft();
  }

  /**
   * 拖拽落点判定（按目标行位置分两种插入语义）：
   * - 目标行上半（before=true）→ 添加到目标下方同级（目标父集合中目标之后）
   * - 目标行下半（before=false）→ 添加到目标下方子级（目标作为新父）
   * 跨父/跨级约束：证据类型可随意；event 仅限框架与目标（target）之间；其余按层级规则。
   */
  private canDrop(
    source: { sourceId: string; parentId: string },
    target: { nodeId: string; parentId: string; before: boolean },
  ): boolean {
    if (target.nodeId === source.sourceId) return false;
    const src = this.nodeCache.getNode(source.sourceId);
    if (!src) return false;

    // 下半：成为目标节点的子级（新父 = target）
    if (!target.before) {
      const targetKind = this.nodeCache.getNode(target.nodeId)?.kind;
      if (!targetKind) return false;
      if (EVIDENCE_KINDS.includes(src.kind as NodeKind)) return true;
      if (src.kind === 'event') return isFrameworkKind(targetKind) || targetKind === 'target';
      return this.getChildKinds(targetKind).includes(src.kind);
    }

    // 上半：目标父集合中目标之后（同父排序 / 跨父按类型约束）
    if (target.parentId === source.parentId) return true;
    const srcParentKind = this.nodeCache.getNode(source.parentId)?.kind;
    const tgtParentKind = this.nodeCache.getNode(target.parentId)?.kind;
    if (EVIDENCE_KINDS.includes(src.kind as NodeKind)) return true;
    if (src.kind === 'event') {
      const isFramework = (k: NodeKind | undefined): boolean => !!k && isFrameworkKind(k);
      return (isFramework(srcParentKind) && tgtParentKind === 'target')
        || (srcParentKind === 'target' && isFramework(tgtParentKind));
    }
    return false;
  }

  /**
   * 跨父移动：旧父 follows 移除 sourceId → 新父 follows 在目标行前/后插入 → source 节点 parent 更新，
   * 三者均走 OperationQueue（缓存立即 + MD 延迟写盘）；展开新父并重渲染。
   */
  private moveChildAcrossParents(
    sourceParentId: string,
    sourceId: string,
    targetParentId: string,
    targetId: string,
    before: boolean,
  ): void {
    const srcParent = this.nodeCache.getNode(sourceParentId);
    if (srcParent) {
      const oldFollows = [...(srcParent.follows ?? [])];
      const i = oldFollows.indexOf(sourceId);
      if (i >= 0) {
        oldFollows.splice(i, 1);
        this.operationQueue.enqueue(
          () => this.nodeCache.updateNode(sourceParentId, { follows: oldFollows, modify: new Date().toISOString() }),
          async () => { await this.fileManager.updateNode(srcParent.kind, sourceParentId, { follows: oldFollows }); },
        );
      }
    }
    const tgtParent = this.nodeCache.getNode(targetParentId);
    if (tgtParent) {
      const newFollows = [...(tgtParent.follows ?? [])];
      let insertAt = newFollows.indexOf(targetId);
      if (insertAt < 0) insertAt = newFollows.length;
      if (!before) insertAt += 1;
      newFollows.splice(insertAt, 0, sourceId);
      this.operationQueue.enqueue(
        () => this.nodeCache.updateNode(targetParentId, { follows: newFollows, modify: new Date().toISOString() }),
        async () => { await this.fileManager.updateNode(tgtParent.kind, targetParentId, { follows: newFollows }); },
      );
    }
    const src = this.nodeCache.getNode(sourceId);
    if (src) {
      this.operationQueue.enqueue(
        () => this.nodeCache.updateNode(sourceId, { parent: targetParentId, modify: new Date().toISOString() }),
        async () => { await this.fileManager.updateNode(src.kind, sourceId, { parent: targetParentId }); },
      );
    }
    // 展开新父（右栏拖拽）并刷新视图
    this.expandedRight.add(targetParentId);
    this.renderRight();
  }

  /** 清除左右栏所有拖拽指示样式 */
  private clearDropIndicators(): void {
    for (const root of [this.leftEl, this.rightEl]) {
      root.querySelectorAll('.seqtk-drop-before, .seqtk-drop-after, .seqtk-drop-child, .seqtk-drop-invalid')
        .forEach((el) => {
          el.removeClass('seqtk-drop-before');
          el.removeClass('seqtk-drop-after');
          el.removeClass('seqtk-drop-child');
          el.removeClass('seqtk-drop-invalid');
        });
    }
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
   * - 项目层级：concept→direction→target→process 严格逐级向下；工序支持同级任意嵌套
   * - 事件：直属框架或目标，不可同级嵌套
   * - 清单：事项
   */
  private getChildKinds(parentKind: NodeKind): NodeKind[] {
    switch (parentKind) {
      case 'framework-transaction':
        return ['framework-transaction', 'concept', 'checklist', 'event', 'factor', 'requirement', 'clue', 'snapshot'];
      case 'framework-info':
        return ['framework-info', 'factor', 'requirement', 'clue', 'snapshot'];
      case 'concept':
        return ['direction'];
      case 'direction':
        return ['target'];
      case 'target':
        return ['process', 'event'];
      case 'process':
        return ['process'];
      case 'project':
        // 旧版占位类型，保留兼容
        return ['project', 'event'];
      case 'checklist':
        return ['item'];
      case 'item':
      case 'event':
      default:
        return [];
    }
  }

  /** 创建节点：写盘 → 维护双向关系 → 更新缓存 →（按选项）跳转文件编辑正文；返回新节点 id（失败返回 undefined） */
  private async createNode(
    input: { kind: NodeKind; desc: string; state: SeqtkState; nature?: EventNature; expectedTime?: string; expectedRepeat?: string; expectedSpan?: { from?: string; to?: string }; afterCreate: 'direct' | 'edit-body' },
    parentId?: string,
    opts?: { skipRender?: boolean; side?: 'left' | 'right' },
  ): Promise<string | undefined> {
    const now = new Date().toISOString();
    const data = {
      kind: input.kind,
      desc: input.desc,
      open: true,
      ...(kindUsesState(input.kind) ? { state: input.state } : {}),
      create: now,
      modify: now,
      ...(input.kind === 'event' && input.nature ? { nature: input.nature } : {}),
      // 预期属性（事务→预期时间+预期重复；框架→预期时间段）
      ...(isTransactionKind(input.kind) ? {
        ...(input.expectedTime ? { expectedTime: input.expectedTime } : {}),
        ...(input.expectedRepeat ? { expectedRepeat: input.expectedRepeat } : {}),
      } : {}),
      ...(isFrameworkKind(input.kind) && input.expectedSpan ? { expectedSpan: input.expectedSpan } : {}),
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

    // 新建子项后默认展开父节点，供查看新节点（行内新建由调用方局部插入，跳过全量渲染）
    if (parentId) {
      // 展开状态按栏维护：side 指定时仅展开对应栏，缺省（模态框创建）两栏都展开
      if (opts?.side === 'left') this.expandedLeft.add(parentId);
      else if (opts?.side === 'right') this.expandedRight.add(parentId);
      else { this.expandedLeft.add(parentId); this.expandedRight.add(parentId); }
      if (!opts?.skipRender) {
        this.renderLeft();
        this.renderRight();
      }
    }

    if (input.afterCreate === 'edit-body') {
      await this.openNodeFile(nodeId);
    }
    return nodeId;
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
    input: { desc: string; state: SeqtkState; nature?: EventNature; expectedTime?: string; expectedRepeat?: string; expectedSpan?: { from?: string; to?: string } },
  ): void {
    const updates: Partial<SeqtkNode> = {};
    if (input.desc !== node.desc) updates.desc = input.desc;
    if (kindUsesState(node.kind) && input.state !== node.state) updates.state = input.state;
    if (node.kind === 'event' && input.nature && input.nature !== (node as any).nature) {
      updates.nature = input.nature;
    }
    if (isTransactionKind(node.kind)) {
      if ((input.expectedTime ?? '') !== ((node as any).expectedTime ?? '')) {
        updates.expectedTime = input.expectedTime || undefined;
      }
      if ((input.expectedRepeat ?? '') !== ((node as any).expectedRepeat ?? '')) {
        updates.expectedRepeat = input.expectedRepeat || undefined;
      }
    }
    if (isFrameworkKind(node.kind)) {
      const span = (node as any).expectedSpan;
      const from = input.expectedSpan?.from ?? '';
      const to = input.expectedSpan?.to ?? '';
      if (from !== (span?.from ?? '') || to !== (span?.to ?? '')) {
        updates.expectedSpan = (from || to)
          ? { ...(from ? { from } : {}), ...(to ? { to } : {}) }
          : undefined;
      }
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

    if (node.children.length > 0) {
      const isExpanded = this.expandedRight.has(node.nodeId);
      // 描述与图标随即将执行的行为变化：折叠→显示"展开"，展开→显示"收起"
      menu.addItem((item) =>
        item.setTitle(isExpanded ? '收起' : '展开').setIcon(isExpanded ? 'fold-vertical' : 'unfold-vertical')
          .onClick(() => this.toggleExpandAll(node, 'right')));
    }
    if (this.getChildKinds(node.data.kind).length > 0) {
      menu.addItem((item) =>
        item.setTitle('新建子项').setIcon('plus')
          .onClick(() => {
            const row = (e.target as HTMLElement).closest('.seqtk-row');
            if (row) this.beginInlineCreate(node, row as HTMLElement);
          }));
    }
    // 追加信息：二级子菜单（对象/条件/信息/状态），点击后行内创建对应证据类型（不开模态框）
    this.appendEvidenceMenu(menu, (k) => {
      const row = (e.target as HTMLElement).closest('.seqtk-row');
      if (row) this.beginInlineCreate(node, row as HTMLElement, [k]);
    });
    menu.addItem((item) =>
      item.setTitle('重命名').setIcon('pencil')
        .onClick(() => {
          const row = (e.target as HTMLElement).closest('.seqtk-row');
          if (row) this.beginInlineEdit(node, row as HTMLElement);
        }));
    menu.addItem((item) =>
      item.setTitle('编辑描述').setIcon('file-text')
        .onClick(() => {
          const row = (e.target as HTMLElement).closest('.seqtk-row');
          if (row) this.beginInlineEditBody(node, row as HTMLElement);
        }));
    menu.addItem((item) =>
      item.setTitle('修改属性').setIcon('settings-2')
        .onClick(() => this.openEdit(node.nodeId)));
    if (kindUsesState(node.data.kind)) {
      // 状态更改：二级子菜单（运行时支持 setSubmenu 则用子菜单，否则回退内联状态项）
      let usedSubmenu = false;
      menu.addItem((item) => {
        item.setTitle('状态更改').setIcon('refresh-cw');
        const setSubmenu = (item as any).setSubmenu as (() => Menu) | undefined;
        if (typeof setSubmenu === 'function') {
          const sub = setSubmenu.call(item) as Menu;
          for (const s of [...STATE_VALUES]) {
            sub.addItem((si) => {
              si.setTitle(NODE_STATE_LABELS[s]);
              if (node.data.state === s) si.setChecked(true);
              si.onClick(() => this.setNodeState(node.nodeId, s));
            });
          }
          usedSubmenu = true;
        } else {
          item.setIsLabel(true);
        }
      });
      if (!usedSubmenu) {
        for (const s of [...STATE_VALUES]) {
          menu.addItem((item) => {
            item.setTitle(NODE_STATE_LABELS[s]);
            if (node.data.state === s) item.setChecked(true);
            item.onClick(() => this.setNodeState(node.nodeId, s));
          });
        }
      }
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle('打开文件').setIcon('external-link')
        .onClick(() => void this.openNodeFile(node.nodeId)));
    menu.addItem((item) =>
      item.setTitle('归档').setIcon('archive')
        .onClick(() => this.archiveNode(node.nodeId)));
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
