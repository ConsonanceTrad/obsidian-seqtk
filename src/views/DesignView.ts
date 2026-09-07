/**
 * DesignView — 事务设计 · 设计模式（主干：状态 + 生命周期 + 渲染编排）
 *
 * 双栏布局：
 * - 左栏：框架-子框架结构树（事务框架 / 信息框架），支持子框架嵌套与创建
 * - 右栏：选中框架的内部节点（事务 + 证据）统一编辑；未选中时显示
 *   「全部事务总览」（构想 / 清单 / 事项 / 事件树），保留原事务面板能力
 *
 * 数据流：
 *   视图操作 → OperationQueue（cacheOp 立即更新缓存+响应式快照 / fileOp 延迟写盘）
 *   → 重启后 NodeCache.initialize 从 MD 扫描重建，保证「重启读回一致」
 *
 * ── 文件地图（功能按模块拆分到 src/views/design/，本文件只负责“怎么渲染与展开”）──
 *   tree.ts            树构建纯函数：TreeNode / buildFrameworkTree / buildNode / sortByFollows
 *   actions.ts         节点数据写：创建 / 修改属性 / 状态 / 归档 / 级联删除 / 保存 / 打开文件
 *   templateActions.ts 右键「存为模板 / 使用模板」编排 + appendTemplateMenu
 *   menus.ts           全部右键 / 空白 / 状态菜单构建（showFrameMenu / showRowMenu / …）
 *   inline.ts          行内交互：重命名覆盖层 / 行内新建 / 行内正文编辑
 *   drag.ts            拖拽引擎：落点解析 / 合法性判定 / 排序与跨父移动 / 指示清理 / 右键取消
 *
 * 功能增补指引：
 * - 加右键菜单项            → design/menus.ts 对应函数
 * - 加行内快捷操作          → design/inline.ts（参考 beginInlineEditBody 覆盖层模式）
 * - 加数据字段与落盘        → design/actions.ts
 * - 加树形聚合 / 改排序      → design/tree.ts
 * - 改拖拽落点规则          → design/drag.ts
 * - 改行渲染、加新徽章/按钮  → 本文件 renderNode / renderFrameNode
 *
 * 可见性说明：本类状态字段与渲染方法大多为 public —— 这是 design/* 切片以
 * `view` 为第一参数协作所需（切片只 import type DesignView，无运行期回环）。
 */

import { WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import { DualPaneView } from './dual/DualPaneView';
import type { PluginSettings } from '../types/index';
import {
  NODE_KIND_LABELS,
  NODE_STATE_LABELS,
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
import { kindUsesState } from './components/TransactionModals';
import {
  buildFrameworkTree,
  buildConceptTree,
  buildChecklistTree,
  buildNode,
  sortByFollows,
  type TreeNode,
} from './design/tree';
import {
  showLeftBlankMenu,
  showRightBlankMenu,
  showFrameMenu,
  showRowMenu,
  showStateMenu,
} from './design/menus';
import {
  resolveDropTarget,
  moveChildInFollows,
  moveTopInOrder,
  moveChildAcrossParents,
  canDrop,
  canDropToFrameworkBlank,
  clearDropIndicators,
  installDragCancelHandler,
} from './design/drag';
import { setNodeState } from './design/actions';
import {
  renderLeftTree,
  createTreeRow,
  type TreeRowContext,
} from './dual/leftTree';

export const VIEW_TYPE_DESIGN = 'seqtk-design';

export class DesignView extends DualPaneView {
  /** 视图容器附加类（基座 addClass 用） */
  protected cssClass = 'seqtk-design-view';
  public leftEl!: HTMLElement;
  public rightEl!: HTMLElement;
  public unsub: (() => void) | null = null;  /** 左栏展开状态（nodeId 集合） */
  public expandedLeft = new Set<string>();
  /** 右栏展开状态（nodeId 集合，与左栏独立） */
  public expandedRight = new Set<string>();
  /** 当前选中的框架 nodeId；null 表示「全部事务总览」 */
  public selectedFrameworkId: string | null = null;
  /** 顺序更改模式：开启后按 follows 混合渲染并支持拖拽排序 */
  public sortMode = false;
  /** 当前拖拽源（dragstart 写入，dragover/drop 读取，dragend 清空） */
  public dragSource: { sourceId: string; parentId: string } | null = null;
  /** 行内新建期间抑制 nodeStore 触发的全量重渲染（由局部插入替代，避免画面闪烁） */
  public suppressRender = false;
  /** 拖拽中右键取消处理器（document contextmenu，捕获阶段） */
  public dragCancelHandler: ((e: MouseEvent) => void) | null = null;
  /** 顶级框架排序（nodeId 顺序，持久化于 settings.topFrameworkOrder） */
  public topOrder: string[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    public nodeCache: NodeCache,
    public fileManager: NodeFileManager,
    public operationQueue: OperationQueue,
    public settings: PluginSettings,
    public onTopOrderChange?: (order: string[]) => void,
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

  protected onPanesReady(): void {
    // 空白区域右键菜单（创建子节点快捷入口）
    this.leftEl.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.seqtk-frame-item')) return;
      e.preventDefault();
      showLeftBlankMenu(this, e);
    });
    this.rightEl.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.seqtk-row')) return;
      e.preventDefault();
      showRightBlankMenu(this, e);
    });

    // 右栏空白落点：拖拽到空白处 → 改为选中框架的直属子节点（仅容许框架目标的类型生效）
    this.rightEl.addEventListener('dragover', (e) => {
      // 行内落点由行自身处理，此处仅处理空白区域
      if ((e.target as HTMLElement).closest('.seqtk-row')) return;
      const source = this.dragSource;
      if (!source || !canDropToFrameworkBlank(this, source)) return;
      e.preventDefault();
      clearDropIndicators(this);
      this.rightEl.addClass('seqtk-drop-blank');
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    this.rightEl.addEventListener('drop', (e) => {
      if ((e.target as HTMLElement).closest('.seqtk-row')) return;
      const source = this.dragSource;
      if (!source || !canDropToFrameworkBlank(this, source)) return;
      e.preventDefault();
      clearDropIndicators(this);
      moveChildAcrossParents(this, source.parentId, source.sourceId, this.selectedFrameworkId!, '', false);
      this.dragSource = null;
    });
    this.rightEl.addEventListener('dragleave', (e) => {
      // 离开右栏时清理空白落点指示
      if (!this.rightEl.contains(e.relatedTarget as Node)) {
        this.rightEl.removeClass('seqtk-drop-blank');
      }
    });

    this.unsub = this.nodeCache.nodeStore.subscribe(() => {
      // 行内新建期间由局部插入维护 DOM，跳过全量重渲染避免闪烁
      if (this.suppressRender) return;
      this.renderLeft();
      this.renderRight();
    });

    // 拖拽进行中：右键点击取消本次拖拽（阻止默认菜单并清理状态）
    this.dragCancelHandler = installDragCancelHandler(this);

    // 关闭时统一清理（由基座 onClose 执行）
    this.registerOnClose(() => {
      this.unsub?.();
      this.unsub = null;
      if (this.dragCancelHandler) {
        document.removeEventListener('contextmenu', this.dragCancelHandler, true);
        this.dragCancelHandler = null;
      }
    });
  }

  /** 设置变更后刷新视图 */
  refreshSettings(): void {
    this.refresh();
  }

  // ============================================================
  // 左栏：框架树
  // ============================================================

  public renderLeft(): void {
    this.leftEl.empty();
    this.leftEl.createEl('div', { cls: 'seqtk-split-title', text: '框架' });

    if (!this.nodeCache.isInitialized) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '正在加载缓存…' });
      return;
    }

    // 「全部事务」入口（默认隐藏，可在设置中打开） 此功能不再需要，进行注释
    // if (this.settings.showAllOverview) {
    //   const allItem = this.leftEl.createDiv('seqtk-frame-item');
    //   if (this.selectedFrameworkId === null) {
    //     allItem.addClass('seqtk-frame-item-active');
    //   }
    //   allItem.createEl('span', { cls: 'seqtk-kind-badge', text: '总览' });
    //   allItem.createEl('span', { cls: 'seqtk-desc', text: '全部事务' });
    //   allItem.addEventListener('click', () => {
    //     this.selectedFrameworkId = null;
    //     this.renderLeft();
    //     this.renderRight();
    //   });
    // }

    const roots = buildFrameworkTree(this.nodeCache, this.topOrder);
    if (roots.length === 0) {
      this.leftEl.createEl('div', { cls: 'seqtk-empty', text: '暂无框架，右键空白处新建' });
      return;
    }

    // 固定左树形态由 leftTree.renderLeftTree 渲染（递归与展开控制），行内容见 renderFrameRow
    renderLeftTree(this.leftEl, roots, {
      isExpanded: (nodeId) => this.expandedLeft.has(nodeId),
      makeRow: (ctx) => this.renderFrameRow(ctx),
    });
  }

  /**
   * 左栏框架行渲染入口（单行渲染；递归与展开控制由 leftTree.renderLeftTree 承担）。
   * inline 行内新建原地替换行时使用：新节点无子树，此处只渲染该行本身。
   */
  public renderFrameNode(node: TreeNode, depth: number, inExpandedTree = false, parentNodeId?: string): HTMLElement {
    return this.renderFrameRow({
      node,
      depth,
      inExpandedTree,
      parentNodeId: parentNodeId ?? '',
      hasChildren: node.children.length > 0,
      isExpanded: this.expandedLeft.has(node.nodeId),
    });
  }

  /** 左栏框架单行渲染：行内容 / 事件 / 拖拽都在此定制（树形态由 leftTree 承担） */
  private renderFrameRow(ctx: TreeRowContext): HTMLElement {
    const node = ctx.node;
    const row = createTreeRow(this.leftEl, ctx);
    if (this.selectedFrameworkId === node.nodeId) {
      row.addClass('seqtk-frame-item-active');
    }
    row.style.paddingLeft = `${8 + ctx.depth * 14}px`;
    // 仅有子节点的框架才显示展开态/展开树标识（空子框架左侧不显现展开边框标识）
    if (ctx.hasChildren) {
      if (ctx.isExpanded) row.addClass('seqtk-row-expanded');
      if (ctx.inExpandedTree) row.addClass('seqtk-row-in-expanded');
    }

    // 折叠标识小方块（有子项时显示；展开态由 CSS 隐藏）
    if (ctx.hasChildren) row.createSpan('seqtk-collapse-mark');

    // 左栏：行单击=展开/折叠（直接响应，无延迟）；行末按钮=在右侧打开
    row.addEventListener('click', () => {
      if (ctx.hasChildren) this.toggleExpand(node.nodeId, 'left');
    });

    // 左栏拖拽排序（默认启用）：同父同级排序（子框架→父 follows，顶级→topFrameworkOrder）
    row.draggable = true;
    row.dataset.parentId = ctx.parentNodeId;
    row.addEventListener('dragstart', (e) => {
      this.dragSource = { sourceId: node.nodeId, parentId: ctx.parentNodeId };
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
      clearDropIndicators(this);
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      clearDropIndicators(this);
      let valid = false;
      const source = this.dragSource;
      if (source) {
        const target = resolveDropTarget(e);
        // 左栏仅同父同级排序：上方→目标前、下方→目标后；中心（子级）与跨父/跨级驳回
        if (target && target.parentId === source.parentId && target.nodeId !== source.sourceId && target.zone !== 'middle') {
          valid = true;
          target.row.addClass(target.zone === 'above' ? 'seqtk-drop-before' : 'seqtk-drop-after');
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
      clearDropIndicators(this);
      const source = this.dragSource;
      const target = resolveDropTarget(e);
      if (!source) return;
      // 左栏仅同父同级排序（above/below），middle（子级）不执行
      if (target && target.zone !== 'middle' && target.parentId === source.parentId && target.nodeId !== source.sourceId) {
        const before = target.zone === 'above';
        if (source.parentId) {
          // 子框架：父 follows 排序
          moveChildInFollows(this, source.parentId, source.sourceId, target.nodeId, before);
        } else {
          // 顶级框架：topFrameworkOrder 排序
          moveTopInOrder(this, source.sourceId, target.nodeId, before);
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
      showFrameMenu(this, e, node);
    });

    return row;
  }

  // ============================================================
  // 右栏：节点列表
  // ============================================================

  public renderRight(): void {
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
    const sorted = parent ? sortByFollows(parent, directChildren) : directChildren;
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
      this.renderNode(buildNode(this.nodeCache, child.nodeId, node), 0, this.rightEl, false, fwId);
    }
  }

  /** 全部事务总览：构想树 + 清单树 */
  public renderAllOverview(): void {
    this.rightEl.createEl('div', { cls: 'seqtk-split-title', text: '全部事务' });

    const conceptRoots = buildConceptTree(this.nodeCache);
    const checklistRoots = buildChecklistTree(this.nodeCache);
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

  // ============================================================
  // 节点行渲染
  // ============================================================

  public renderNode(node: TreeNode, depth: number, container: HTMLElement, inExpandedTree = false, parentNodeId?: string): HTMLElement {
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
        clearDropIndicators(this);
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        clearDropIndicators(this);
        let valid = false;
        const source = this.dragSource;
        if (source) {
          const target = resolveDropTarget(e);
          if (target && canDrop(this, source, target)) {
            valid = true;
            // 三段式指示：上方→同级前（before 顶线）、中心→子级（child 缩进）、下方→同级后（after 底线）
            if (target.zone === 'above') target.row.addClass('seqtk-drop-before');
            else if (target.zone === 'below') target.row.addClass('seqtk-drop-after');
            else target.row.addClass('seqtk-drop-child');
          } else if (target) {
            // 非容许目标（跨父不允许/自身）：驳回
            target.row.addClass('seqtk-drop-invalid');
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
        clearDropIndicators(this);
        const source = this.dragSource;
        const target = resolveDropTarget(e);
        // console.log('[SeqTK] drop source=', source, 'target=', target ? { nodeId: target.nodeId, parentId: target.parentId, zone: target.zone } : null);
        if (!source) return;
        if (target && canDrop(this, source, target)) {
          if (target.zone === 'middle') {
            // 中心：添加到目标子级末尾（目标作为新父）
            moveChildAcrossParents(this, source.parentId, source.sourceId, target.nodeId, '', false);
          } else {
            // 上方/下方：添加到目标同级（前/后）
            const before = target.zone === 'above';
            if (target.parentId === source.parentId) {
              moveChildInFollows(this, source.parentId, source.sourceId, target.nodeId, before);
            } else {
              moveChildAcrossParents(this, source.parentId, source.sourceId, target.parentId, target.nodeId, before);
            }
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
      stateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // 单击状态原点：规划/进行 → 完成；完成 → 规划（循环切换）
        const next = state === 'done' ? 'plan' : 'done';
        setNodeState(this, node.nodeId, next);
      });
      // 右键状态原点：保留完整状态菜单（不删菜单功能）
      stateBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showStateMenu(this, e, node);
      });
    }

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // 框架行用框架菜单（新建子框架/编辑/归档/删除；右侧拆分为行内新建入口），其余用节点行菜单
      if (isFrameworkKind(node.data.kind)) {
        showFrameMenu(this, e, node, 'right');
      } else {
        showRowMenu(this, e, node);
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

  /** 按栏切换展开/收起（左右栏展开状态相互独立） */
  public toggleExpand(nodeId: string, side: 'left' | 'right'): void {
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
  public toggleExpandAll(node: TreeNode, side: 'left' | 'right'): void {
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

}
