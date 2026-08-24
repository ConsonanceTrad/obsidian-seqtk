/**
 * ChecklistView — 清单面板（联合节点视图）
 * 
 * V1 对齐：卡片式周期布局
 * - 每个 cycle 渲染为 duplicant-cycle-card（可折叠卡片）
 * - 卡片 header：状态徽章 + 名称 + 展开/折叠按钮
 * - 卡片 body：子节点使用 duplicant-node-header 内联渲染
 * - 底部快速新增栏
 * - 右键菜单使用 Obsidian 原生 Menu API
 * DeferredView 兼容
 */

import { ItemView, WorkspaceLeaf, Menu, Notice, Modal, Setting, setTooltip } from 'obsidian';
import { VIEW_TYPE_CHECKLIST, VIEW_TYPE_PLANNING } from '../types/index';
import type { NodeType, AnyNode, JointNodeType, PeriodStates, PluginSettings } from '../types/index';
// isJointStatusType: 判断 list/rite/event 类型，用于 writeStatus 的周期状态路由
import { getNextStatuses, getStatusValues, NODE_TYPE_LABELS, NODE_STATUS_LABELS, ALLOWED_CHILD_TYPES, isJointStatusType, packCycleRules } from '../types/index';
import type { NodeCache } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import type { OperationQueue } from '../core/OperationQueue';
import type { Unsubscriber } from '../utils/SimpleStore';
import { NodeEditorModal } from './components/NodeEditorModal';
import { DescriptionEditModal } from './components/DescriptionEditModal';
import { ConfirmModal } from './components/ConfirmModal';
import { QuickCreateModal } from './components/QuickCreateModal';
import { CycleRuleModal } from './components/CycleRuleModal';
import { pickToggleSvg, getToggleTitle } from '../utils/toggleSvg';
import { getDisplayName, updateNodeIdDisplayName } from '../utils/timestamp';

// ============================================================
// 状态映射
// ============================================================

const STATUS_CLASS_MAP: Record<string, string> = {
  pending: 'duplicant-status-pending',
  doing: 'duplicant-status-active',
  progress: 'duplicant-status-active',
  paused: 'duplicant-status-suspended',
  completed: 'duplicant-status-completed',
  done: 'duplicant-status-completed',
  giveup: 'duplicant-status-abandoned',
  cancelled: 'duplicant-status-abandoned',
};

/** 展开状态（向下箭头） */
const SVG_CHEVRON_DOWN = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
/** 折叠状态（向右箭头） */
const SVG_CHEVRON_RIGHT = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ============================================================
// ChecklistView
// ============================================================

export class ChecklistView extends ItemView {
  private nodeCache: NodeCache;
  private fileManager: NodeFileManager;
  private operationQueue: OperationQueue;
  private settings: PluginSettings;
  private unsubscribers: Unsubscriber[] = [];

  // 面板状态：展开的 cycle 节点
  private expandedCycles = new Set<string>();
  // 收纳箱展开状态（在构造函数中从设置读取默认值）
  private inboxExpanded: boolean;

  constructor(
    leaf: WorkspaceLeaf,
    nodeCache: NodeCache,
    fileManager: NodeFileManager,
    operationQueue: OperationQueue,
    settings: PluginSettings,
  ) {
    super(leaf);
    this.nodeCache = nodeCache;
    this.fileManager = fileManager;
    this.operationQueue = operationQueue;
    this.settings = settings;
    this.inboxExpanded = settings.checklistInboxDefaultExpand;
  }

  getViewType(): string { return VIEW_TYPE_CHECKLIST; }
  getDisplayText(): string { return '设计'; }
  getIcon(): string { return 'check-square'; }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('duplicant-cycle-view');

    // ── 标题栏 ──
    const header = container.createEl('div', { cls: 'duplicant-view-header' });
    const headerLeft = header.createEl('div', { cls: 'duplicant-header-left' });
    const tabPlanning = headerLeft.createEl('span', { cls: 'duplicant-view-tab', text: '规划' });
    const tabChecklist = headerLeft.createEl('span', { cls: 'duplicant-view-tab duplicant-view-tab-active', text: '清单' });
    tabPlanning.addEventListener('click', () => {
      this.leaf.setViewState({ type: VIEW_TYPE_PLANNING });
    });
    tabChecklist.addEventListener('click', () => {
      this.leaf.setViewState({ type: VIEW_TYPE_CHECKLIST });
    });

    const headerBtns = header.createEl('div', { cls: 'duplicant-header-btns' });

    // 快速创建周期
    const btnNewCycle = headerBtns.createEl('button', {
      cls: 'duplicant-btn duplicant-btn-icon',
      attr: { 'aria-label': '新建周期' },
    });
    btnNewCycle.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 8V12L15 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 3V5M12 19V21M3 12H5M19 12H21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    btnNewCycle.addEventListener('click', () => this.showNewCycleModal());

    // 定位到收纳箱
    const btnInbox = headerBtns.createEl('button', {
      cls: 'duplicant-btn duplicant-btn-icon',
      attr: { 'aria-label': '定位到收纳箱' },
    });
    btnInbox.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.45 5.11L2 12V18A2 2 0 0 0 4 20H20A2 2 0 0 0 22 18V12L18.55 5.11A2 2 0 0 0 16.76 4H7.24A2 2 0 0 0 5.45 5.11Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    btnInbox.addEventListener('click', () => this.scrollToInbox());

    // ── 周期卡片列表 ──
    container.createEl('div', { cls: 'duplicant-cycle-list', attr: { 'data-role': 'cycle-list' } });

    // 订阅 nodeStore
    const unsub = this.nodeCache.nodeStore.subscribe(() => {
      this.refreshList();
    });
    this.unsubscribers.push(unsub);
  }

  async onClose(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.contentEl.empty();
  }

  // ============================================================
  // 渲染
  // ============================================================

  private refreshList(): void {
    const listContainer = this.contentEl.querySelector('[data-role="cycle-list"]') as HTMLDivElement;
    if (!listContainer) return;
    listContainer.empty();

    const snapshot = this.nodeCache.nodeStore.get();

    // 收集所有 cycle 节点
    const cycles: { nodeId: string; data: AnyNode }[] = [];
    for (const [id, data] of snapshot) {
      if (data.type === 'cycle') {
        cycles.push({ nodeId: id, data });
      }
    }

    // 排序：进行中 → 待处理 → 已完成 → 已放弃
    const statusOrder: Record<string, number> = { doing: 0, pending: 1, completed: 2, giveup: 3 };
    cycles.sort((a, b) => {
      const da = statusOrder[a.data.status] ?? 9;
      const db = statusOrder[b.data.status] ?? 9;
      if (da !== db) return da - db;
      // 同状态按时间正序（旧的在上）
      return (a.data.created ?? '').localeCompare(b.data.created ?? '');
    });

    if (cycles.length === 0 && !Array.from(snapshot.values()).some(
      (d) => d.type === 'list' || d.type === 'rite' || d.type === 'event',
    )) {
      const empty = listContainer.createEl('div', { cls: 'duplicant-empty-state' });
      empty.createEl('p', { text: '尚未创建任何周期或联合节点。' });
      empty.createEl('p', { text: '创建一个周期来安排你的执行计划。' });
      return;
    }

    for (const cycle of cycles) {
      this.renderCycleCard(listContainer, cycle.nodeId, cycle.data);
    }

    // ── 新建周期按钮（周期卡片与收纳箱之间）──
    const btnWrap = listContainer.createEl('div', { cls: 'duplicant-add-cycle-wrap' });
    const btnNew = btnWrap.createEl('button', {
      cls: 'duplicant-btn duplicant-btn-primary duplicant-btn-block',
      text: '新建周期',
    });
    btnNew.addEventListener('click', () => this.showNewCycleModal());

    // ── 收纳箱卡片 ──
    // 收集全部 list / rite / event 节点（不论是否已被周期引用）
    const inboxItems: { nodeId: string; data: AnyNode }[] = [];
    for (const [id, data] of snapshot) {
      if (data.type === 'list' || data.type === 'rite' || data.type === 'event') {
        inboxItems.push({ nodeId: id, data });
      }
    }

    // 排序：类型优先级（清单 > 仪式 > 事项），同类型按创建时间倒序（新的在上）
    const typePriority: Record<string, number> = { list: 0, rite: 1, event: 2 };
    inboxItems.sort((a, b) => {
      const tp = (typePriority[a.data.type] ?? 9) - (typePriority[b.data.type] ?? 9);
      if (tp !== 0) return tp;
      return (b.data.created ?? '').localeCompare(a.data.created ?? '');
    });

    // 收纳箱始终显示（即使无内容）
    this.renderInboxCard(listContainer, inboxItems);
  }

  /**
   * 渲染收纳箱卡片 — 收集全部 list / rite / event 节点
   */
  private renderInboxCard(parent: HTMLDivElement, items: { nodeId: string; data: AnyNode }[]): void {
    const card = parent.createEl('div', { cls: 'duplicant-cycle-card duplicant-cycle-card-inbox' });

    // 标题行
    const titleRow = card.createEl('div', { cls: 'duplicant-cycle-card-header' });
    const titleLeft = titleRow.createEl('div', { cls: 'duplicant-cycle-card-title-left' });
    titleLeft.createEl('h4', { text: '收纳箱' });

    // 展开/折叠按钮
    const titleRight = titleRow.createEl('div', { cls: 'duplicant-cycle-card-title-right' });
    const expandBtn = titleRight.createEl('span', { cls: 'duplicant-card-state-icon' });
    expandBtn.innerHTML = this.inboxExpanded ? SVG_CHEVRON_DOWN : SVG_CHEVRON_RIGHT;

    const toggleCollapse = () => {
      this.inboxExpanded = !this.inboxExpanded;
      card.classList.toggle('collapsed', !this.inboxExpanded);
      expandBtn.innerHTML = this.inboxExpanded ? SVG_CHEVRON_DOWN : SVG_CHEVRON_RIGHT;
    };
    titleRow.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      toggleCollapse();
    });

    // 右键菜单：快速创建检查表/仪式/事件 + 删除孤立事件
    titleRow.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();
      const createTypes: { label: string; jt: JointNodeType; icon: string }[] = [
        { label: '新建 检查表', jt: 'list', icon: 'list-checks' },
        { label: '新建 仪式', jt: 'rite', icon: 'flame' },
        { label: '新建 事件', jt: 'event', icon: 'calendar-clock' },
      ];
      for (const t of createTypes) {
        menu.addItem((item) => {
          item.setTitle(t.label).setIcon(t.icon);
          item.onClick(() => {
            new QuickCreateModal(this.app, {
              nodeType: t.jt,
              onSave: (_nodeType, name) => {
                const nid = this.genId(name);
                const now = new Date().toISOString();
                const data: Partial<AnyNode> = { type: t.jt, name, status: 'pending', created: now, modified: now } as any;
                this.operationQueue.enqueue(
                  () => this.nodeCache.addNode(nid, data as AnyNode),
                  async () => { await this.fileManager.createNode(t.jt, data, '', nid); },
                );
              },
            }).open();
          });
        });
      }
      menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle('归档孤立事件').setIcon('trash').setWarning(true);
        item.onClick(() => this.handleArchiveOrphanedEvents());
      });
      menu.showAtMouseEvent(e);
    });

    // 初始状态：根据 inboxExpanded 决定
    if (!this.inboxExpanded) card.classList.add('collapsed');

    // 内容区
    const bodyEl = card.createEl('div', { cls: 'duplicant-cycle-card-body' });
    const section = bodyEl.createEl('div', { cls: 'duplicant-cycle-section' });

    for (const item of items) {
      this.renderInboxNode(section, item.nodeId, item.data, false);
    }
  }

  /**
   * 渲染收纳箱节点行
   *
   * 已被包含在清单中的事项依旧渲染（不做过滤）。
   * 右键菜单按节点类型分发：list 仅删除；rite/event 按根/子显示不同操作。
   */
  private renderInboxNode(parent: HTMLElement, nodeId: string, data: AnyNode, isNested: boolean = false): void {
    // 收纳箱始终展示初始状态（节点自身的 status），不取周期状态。
    // 原因：收纳箱是模板管理区域，用户在此查看/编辑节点的「初始属性」，
    // 而非其在某具体周期中的执行状态。周期状态的查看/操作在周期卡片中进行。
    //
    // 对比 renderChildNode()：周期卡片中的子节点使用 getEffectiveStatus()
    // 获取周期状态，而非节点自身的 status。
    const isCompleted = data.status === 'completed' || data.status === 'done';
    const isAbandoned = data.status === 'giveup' || data.status === 'cancelled';

    // 先检测子节点，决定 toggle 类型
    const children = this.getJointChildren(nodeId);
    const hasChildren = children.length > 0;

    const nodeEl = parent.createEl('div', {
      cls: `duplicant-node ${isCompleted ? 'completed' : ''} ${isAbandoned ? 'abandoned' : ''}`.trim(),
      attr: { 'data-node-id': nodeId },
    });

    const headerEl = nodeEl.createEl('div', { cls: 'duplicant-node-header' });

    if (hasChildren) {
      // 有子节点：可展开/折叠的 toggle
      const isCollapsedByDefault = isCompleted || isAbandoned;
      const toggle = headerEl.createEl('span', { cls: 'duplicant-node-toggle' });
      const toggleSvg = pickToggleSvg(true, !isCollapsedByDefault, isAbandoned, isCompleted, false, false);
      toggle.innerHTML = `<span class="toggle-svg">${toggleSvg}</span>`;

      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const childContainer = nodeEl.querySelector('.duplicant-node-children') as HTMLElement;
        if (childContainer) {
          const isHidden = childContainer.classList.toggle('collapsed');
          const nowExpanded = !isHidden;
          toggle.innerHTML = `<span class="toggle-svg">${pickToggleSvg(true, nowExpanded, isAbandoned, isCompleted, false, false)}</span>`;
        }
      });
    } else {
      // 叶子节点：toggle 占位符
      const placeholderCls = [
        'duplicant-node-toggle-placeholder',
        isCompleted ? 'is-completed' : '',
        isAbandoned ? 'is-abandoned' : '',
      ].filter(Boolean).join(' ');
      const placeholder = headerEl.createEl('span', { cls: placeholderCls });
      const svg = pickToggleSvg(false, false, isAbandoned, isCompleted, false, false);
      placeholder.innerHTML = `<span class="toggle-svg">${svg}</span>`;
    }

    // 类型标签
    headerEl.createEl('span', {
      cls: `duplicant-node-type-label duplicant-type-${data.type}`,
      text: NODE_TYPE_LABELS[data.type as NodeType] ?? data.type,
    });

    // 名称
    headerEl.createEl('span', { cls: 'duplicant-node-name', text: data.name });

    // 正文预览
    const preview = this.getBodyPreview(nodeId);
    if (preview) {
      headerEl.createEl('span', { cls: 'duplicant-node-body-preview', text: preview });
    }

    // 状态标签 — 始终使用 data.status（节点自身的初始属性），
    // 而非周期状态。收纳箱是模板管理区域，不反映执行进度。
    // 对比 renderChildNode() 中使用 getEffectiveStatus() 获取周期状态。
    headerEl.createEl('span', {
      cls: `duplicant-node-status ${STATUS_CLASS_MAP[data.status] ?? ''}`,
      text: NODE_STATUS_LABELS[data.status] ?? data.status,
    });

    // 右键菜单
    headerEl.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.showInboxNodeMenu(e, nodeId, data, isNested);
    });

    // 左键点击行为（可配置：编辑描述 或 展开/折叠）
    headerEl.addEventListener('click', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.duplicant-node-toggle, .duplicant-node-toggle-placeholder')) return;
      e.stopPropagation();

      if (this.settings.planningClickAction === 'toggle' && hasChildren) {
        // 展开/折叠模式：切换子节点容器的收起状态
        const childContainer = nodeEl.querySelector('.duplicant-node-children') as HTMLElement;
        const toggleEl = headerEl.querySelector('.duplicant-node-toggle') as HTMLElement;
        if (childContainer && toggleEl) {
          const isHidden = childContainer.classList.toggle('collapsed');
          const nowExpanded = !isHidden;
          const newSvg = pickToggleSvg(true, nowExpanded, isAbandoned, isCompleted, false, false);
          toggleEl.innerHTML = `<span class="toggle-svg">${newSvg}</span>`;
        }
      } else {
        // 编辑描述模式（默认）
        this.promptEditBody(nodeId, data);
      }
    });

    // 子节点容器
    if (hasChildren) {
      const childContainer = nodeEl.createEl('div', { cls: 'duplicant-node-children' });
      for (const child of children) {
        this.renderInboxNode(childContainer, child.nodeId, child.data, true);
      }
    }
  }

  /**
   * 收纳箱节点右键菜单 — 按节点类型和父子关系分发
   *
   * 菜单结构：
   *   1. 「切换初始状态」— 通用操作，修改节点自身的 status（初始属性）
   *      使用 handleInitialStatusSet() 直接写入，绕过 writeStatus() 的周期状态路由。
   *      因为收纳箱是模板管理区域，操作的是「初始属性」而非「周期状态」。
   *   2. 按类型分发的专用操作 — 归档、插入到检查表、移除引用等
   *
   * 注意「切换初始状态」与周期卡片中「更改状态」的区别：
   *   - 收纳箱：切换初始状态 → handleInitialStatusSet() → 写入节点 YAML status
   *   - 周期卡片：更改状态 → writeStatus() → 路由到 updatePeriodState() 写入 periodStates
   *
   * @see handleInitialStatusSet  绕过周期路由的直接状态写入
   * @see writeStatus              周期感知的状态写入（周期卡片使用）
   */
  private showInboxNodeMenu(e: MouseEvent, nodeId: string, data: AnyNode, isNested: boolean = false): void {
    const menu = new Menu();

    // ── 切换初始状态（所有收纳箱节点共用）──
    // 此菜单操作节点自身的 status 字段（初始属性），不影响周期状态。
    const STATUS_ICONS: Record<string, string> = {
      pending: 'circle', doing: 'circle-dot', paused: 'pause',
      completed: 'check-circle', giveup: 'x-circle',
      progress: 'circle-dot', done: 'check-circle', cancelled: 'x-circle',
    };
    menu.addItem((item) => {
      item.setTitle('切换初始状态').setIcon('circle-dot');
      const submenu = (item as any).setSubmenu?.();
      if (submenu) {
        const allStatuses = getStatusValues(data.type as NodeType);
        for (const s of allStatuses) {
          const isCurrent = s === data.status;
          submenu.addItem((subItem: any) => {
            subItem.setTitle(`标记为${NODE_STATUS_LABELS[s] ?? s}`);
            subItem.setIcon(STATUS_ICONS[s] ?? 'circle');
            if (isCurrent) subItem.setDisabled(true);
            else subItem.onClick(() => this.handleInitialStatusSet(nodeId, data.type as NodeType, s));
          });
        }
      }
    });

    // ── 子节点行（嵌套在父节点下的引用展示）：仅提供移除引用 ──
    if (isNested) {
      const directParent = this.findDirectParent(nodeId);
      if (directParent) {
        menu.addSeparator();
        menu.addItem((item) => {
          item.setTitle('移除节点引用').setIcon('unlink');
          item.onClick(() => this.removeChildReference(directParent.nodeId, nodeId));
        });
      }
      menu.showAtMouseEvent(e);
      return;
    }

    // ── 根节点行：按类型分发菜单 ──
    menu.addSeparator();

    // 编辑描述（当左键行为为展开/折叠时，在右键菜单中提供编辑入口）
    if (this.settings.planningClickAction === 'toggle') {
      menu.addItem((item) => {
        item.setTitle('编辑描述').setIcon('pencil');
        item.onClick(() => this.promptEditBody(nodeId, data));
      });
    }

    switch (data.type) {
      case 'list': {
        // 检查表 — 加入已有节点（仪式、事件）、排序子节点、归档
        menu.addItem((item) => {
          item.setTitle('加入已有节点').setIcon('log-in');
          const submenu = (item as any).setSubmenu?.();
          if (submenu) {
            const iconMap: Record<string, string> = { rite: 'flame', event: 'calendar-clock' };
            for (const t of ['rite', 'event'] as NodeType[]) {
              submenu.addItem((subItem: any) => {
                subItem.setTitle(`引入${NODE_TYPE_LABELS[t] ?? t}`);
                subItem.setIcon(iconMap[t] ?? 'file-plus');
                subItem.onClick(() => this.handleAddExistingToList(nodeId, t));
              });
            }
          }
        });
        menu.addItem((item) => {
          item.setTitle('批量添加或创建').setIcon('layers');
          item.onClick(() => this.showBatchAddToListModal(nodeId, data));
        });
        // 子节点排序（仅当有子节点时显示）
        const listChildren = (data as any).children as string[] | undefined;
        if (listChildren && listChildren.length > 1) {
          menu.addItem((item) => {
            item.setTitle('排序与管理子项').setIcon('list-ordered');
            item.onClick(() => this.showChildReorderModal(nodeId, data));
          });
        }
        menu.addSeparator();
        menu.addItem((item) => {
          item.setTitle('重命名').setIcon('pencil');
          item.onClick(() => this.handleRename(nodeId));
        });
        menu.addItem((item) => {
          item.setTitle('归档节点文件').setIcon('trash').setWarning(true);
          item.onClick(() => this.handleArchive(nodeId, data.type as NodeType));
        });
        break;
      }

      case 'rite': {
        // 仪式（根） — 插入到检查表、重命名、归档节点文件
        menu.addItem((item) => {
          item.setTitle('插入到检查表').setIcon('log-in');
          item.onClick(() => this.handleInsertIntoParent(nodeId, data, 'list'));
        });
        menu.addSeparator();
        menu.addItem((item) => {
          item.setTitle('重命名').setIcon('pencil');
          item.onClick(() => this.handleRename(nodeId));
        });
        menu.addItem((item) => {
          item.setTitle('归档节点文件').setIcon('trash').setWarning(true);
          item.onClick(() => this.handleArchive(nodeId, data.type as NodeType));
        });
        break;
      }

      case 'event': {
        // 事件（根） — 插入到检查表、重命名、归档节点文件
        menu.addItem((item) => {
          item.setTitle('插入到检查表').setIcon('log-in');
          item.onClick(() => this.handleInsertIntoParent(nodeId, data, 'list'));
        });
        menu.addSeparator();
        menu.addItem((item) => {
          item.setTitle('重命名').setIcon('pencil');
          item.onClick(() => this.handleRename(nodeId));
        });
        menu.addItem((item) => {
          item.setTitle('归档节点文件').setIcon('trash').setWarning(true);
          item.onClick(() => this.handleArchive(nodeId, data.type as NodeType));
        });
        break;
      }

      default:
        // 其他类型不应出现在收纳箱中
        break;
    }

    menu.showAtMouseEvent(e);
  }

  /**
   * 查找节点的直属上级 — 遍历所有节点的 children 数组，
   * 找到第一个引用了 childNodeId 的父节点
   */
  private findDirectParent(childNodeId: string): { nodeId: string; data: AnyNode } | null {
    const snapshot = this.nodeCache.nodeStore.get();
    for (const [id, data] of snapshot) {
      const refs = (data as any).children;
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        const refId = typeof ref === 'string' ? ref.replace(/^\[\[(.+)\]\]$/, '$1') : '';
        if (refId === childNodeId) {
          return { nodeId: id, data };
        }
      }
    }
    return null;
  }

  /**
   * 插入到父节点 — 弹出选择器让用户挑选一个 parentType 节点，
   * 将当前节点的 nodeId 添加到父节点的 children 数组
   */
  private handleInsertIntoParent(childNodeId: string, childData: AnyNode, parentType: NodeType): void {
    const parentNodes = this.nodeCache.getByType(parentType);

    // 过滤掉已包含此子节点的父节点
    const candidates = parentNodes.filter((p) => {
      const refs: string[] = (p.data as any).children ?? [];
      return !refs.some((r: string) => {
        const id = typeof r === 'string' ? r.replace(/^\[\[(.+)\]\]$/, '$1') : '';
        return id === childNodeId;
      });
    });

    // 按创建时间降序（新到旧）
    candidates.sort((a, b) => (b.data.created ?? '').localeCompare(a.data.created ?? ''));

    if (candidates.length === 0) {
      new Notice(`没有可插入的${NODE_TYPE_LABELS[parentType]}节点。`);
      return;
    }

    const modal = new Modal(this.app);
    modal.setTitle(`插入到${NODE_TYPE_LABELS[parentType]}`);

    const searchInput = modal.contentEl.createEl('input', {
      cls: 'duplicant-node-picker-search',
      attr: { type: 'text', placeholder: `搜索${NODE_TYPE_LABELS[parentType]}名称…` },
    });
    const listEl = modal.contentEl.createEl('div', { cls: 'duplicant-node-picker-list' });

    const renderList = (filter: string) => {
      listEl.empty();
      const q = filter.toLowerCase();
      const matched = candidates.filter(
        (c) => c.nodeId.toLowerCase().includes(q) || (c.data.name ?? '').toLowerCase().includes(q),
      );
      if (matched.length === 0) {
        listEl.createEl('div', { cls: 'duplicant-node-picker-empty', text: '无匹配节点' });
        return;
      }
      for (const c of matched) {
        const row = listEl.createEl('div', { cls: 'duplicant-node-picker-item' });
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.cursor = 'pointer';
        row.createEl('span', { cls: 'duplicant-node-picker-name', text: getDisplayName(c.nodeId) });
        const statusLabel = NODE_STATUS_LABELS[c.data.status] ?? c.data.status;
        row.createEl('span', {
          cls: `duplicant-node-status ${STATUS_CLASS_MAP[c.data.status] ?? ''}`,
          text: statusLabel,
          attr: { style: 'margin-left: auto; font-size: 0.75em; flex-shrink: 0;' },
        });
        row.addEventListener('click', () => {
          const latestParent = this.nodeCache.getNode(c.nodeId);
          const latestChildren: string[] = latestParent ? ((latestParent as any).children ?? []) : [];
          const newChildren = [...latestChildren, `[[${childNodeId}]]`];
          this.operationQueue.enqueue(
            () => this.nodeCache.updateNode(c.nodeId, { children: newChildren } as Partial<AnyNode>),
            () => this.fileManager.updateNode(parentType, c.nodeId, { children: newChildren } as Partial<AnyNode>),
          );
          modal.close();
        });
      }
    };

    renderList('');
    searchInput.addEventListener('input', () => renderList(searchInput.value.trim()));
    modal.onOpen = () => setTimeout(() => searchInput.focus(), 50);
    modal.open();
  }

  /**
   * 渲染单个周期卡片
   *
   * 卡片 body 分为两个区域：
   * 1. 目标区（taskchain） — 位于上方
   * 2. 其他子节点区（list / rite / event） — 位于下方
   *
   * 卡片级右键菜单处理周期自身操作（状态、加入目标、新建检查表等）；
   * 子节点有独立的右键菜单（状态、从周期中移除、归档节点文件）。
   */
  private renderCycleCard(parent: HTMLDivElement, nodeId: string, data: AnyNode): void {
    const isActive = data.status === 'doing';
    const isCompleted = data.status === 'completed';
    // 活跃周期默认展开；非活跃周期根据 expandedCycles 记忆状态
    const isCollapsed = !isActive && !this.expandedCycles.has(nodeId);

    // 活跃周期自动展开时也写入 expandedCycles，确保后续 refreshList 能记忆状态
    if (!isCollapsed) {
      this.expandedCycles.add(nodeId);
    }

    const card = parent.createEl('div', {
      cls: [
        'duplicant-cycle-card',
        isActive ? 'active' : '',
        isCompleted ? 'completed' : '',
        isCollapsed ? 'collapsed' : '',
      ].filter(Boolean).join(' '),
    });

    // ---- 标题行 ----
    const titleRow = card.createEl('div', { cls: 'duplicant-cycle-card-header' });
    const titleLeft = titleRow.createEl('div', { cls: 'duplicant-cycle-card-title-left' });

    // 状态徽章
    titleLeft.createEl('span', {
      cls: `duplicant-node-status ${STATUS_CLASS_MAP[data.status] ?? ''}`,
      text: NODE_STATUS_LABELS[data.status] ?? data.status,
    });
    titleLeft.createEl('h4', { text: data.name });

    // 右侧按钮区
    const titleRight = titleRow.createEl('div', { cls: 'duplicant-cycle-card-title-right' });
    const expandBtn = titleRight.createEl('span', { cls: 'duplicant-card-state-icon' });
    expandBtn.innerHTML = isCollapsed ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN;

    // 展开/折叠逻辑（mousedown 左键触发，避免 click 抢占 contextmenu）
    const toggleCollapse = () => {
      const nowCollapsed = card.classList.toggle('collapsed');
      expandBtn.innerHTML = nowCollapsed ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_DOWN;
      if (nowCollapsed) this.expandedCycles.delete(nodeId);
      else this.expandedCycles.add(nodeId);
    };
    titleRow.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      toggleCollapse();
    });

    // 右键菜单（标题行直接注册，card 覆盖 body 区域）
    titleRow.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      this.showNodeMenu(e, nodeId, data);
    });
    card.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      this.showNodeMenu(e, nodeId, data);
    });

    // ---- 可折叠的内容区域 ----
    const bodyEl = card.createEl('div', { cls: 'duplicant-cycle-card-body' });
    const children = this.getJointChildren(nodeId);

    if (children.length === 0) {
      bodyEl.createEl('div', {
        cls: 'duplicant-cycle-section',
        text: '暂无子节点。',
      });
      return;
    }

    // 按类型分组：taskchain 归入目标区，其余归入其他子节点区
    const taskchains = children.filter((c) => c.data.type === 'taskchain');
    const others = children.filter((c) => c.data.type !== 'taskchain');

    // ── 目标区（上方） ──
    if (taskchains.length > 0) {
      const tcSection = bodyEl.createEl('div', { cls: 'duplicant-cycle-section' });
      tcSection.createEl('span', { cls: 'duplicant-cycle-section-label', text: '目标' });
      for (const tc of taskchains) {
        this.renderChildNode(tcSection, tc.nodeId, tc.data, nodeId, true);
      }
    }

    // ── 其他子节点区（下方） ──
    if (others.length > 0) {
      const otherSection = bodyEl.createEl('div', { cls: 'duplicant-cycle-section' });
      otherSection.createEl('span', { cls: 'duplicant-cycle-section-label', text: '执行清单' });
      for (const child of others) {
        this.renderChildNode(otherSection, child.nodeId, child.data, nodeId, true);
      }
    }
  }

  /**
   * 渲染子节点为 duplicant-node-header 行
   *
   * @param parentNodeId 所属周期的 nodeId，用于「从周期中移除」操作
   */
  /**
   * 渲染子节点为 duplicant-node-header 行
   *
   * 一式多份状态管理：
   *   此方法渲染周期卡片 body 中的子节点（taskchain / list / rite / event）。
   *   对于 list/rite/event 类型，使用 nodeCache.getEffectiveStatus(nodeId)
   *   获取有效状态（优先取周期状态，退化为初始属性）。
   *   对于 taskchain 类型，getEffectiveStatus 内部直接返回 data.status
   *   （taskchain 不参与一式多份管理）。
   *
   * @param parentNodeId 所属周期的 nodeId，用于「从周期中移除」操作
   *
   * @see NodeCache.getEffectiveStatus  获取有效状态的统一入口
   * @see renderInboxNode               收纳箱中使用初始状态（对比参考）
   * @see writeStatus                    状态变更时的周期感知路由
   */
  private renderChildNode(parent: HTMLElement, nodeId: string, data: AnyNode, parentNodeId: string, isDirectChild: boolean = false): void {
    // 获取有效状态：对 list/rite/event 优先使用周期状态，
    // 对 taskchain 等其他类型直接返回 data.status（初始属性）
    // parentNodeId 即所属 Cycle 的 ID，用于从正确的 Cycle.periodStates 中读取
    const effectiveStatus = this.nodeCache.getEffectiveStatus(nodeId, parentNodeId);
    const isCompleted = effectiveStatus === 'completed' || effectiveStatus === 'done';
    const isAbandoned = effectiveStatus === 'giveup' || effectiveStatus === 'cancelled';

    // 先检测子节点，决定 toggle 类型
    const grandChildren = this.getJointChildren(nodeId);
    const hasChildren = grandChildren.length > 0;

    const nodeEl = parent.createEl('div', {
      cls: `duplicant-node ${isCompleted ? 'completed' : ''} ${isAbandoned ? 'abandoned' : ''}`.trim(),
    });

    const headerEl = nodeEl.createEl('div', { cls: 'duplicant-node-header' });

    if (hasChildren) {
      // 有子节点：可展开/折叠的 toggle（默认收起）
      const isCollapsedByDefault = true;
      const toggle = headerEl.createEl('span', { cls: 'duplicant-node-toggle' });
      const toggleSvg = pickToggleSvg(true, !isCollapsedByDefault, isAbandoned, isCompleted, false, false);
      toggle.innerHTML = `<span class="toggle-svg">${toggleSvg}</span>`;
      const toggleTitle = getToggleTitle(true, !isCollapsedByDefault, isCompleted, isAbandoned, false, false);
      if (toggleTitle) setTooltip(toggle, toggleTitle);

      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const childContainer = nodeEl.querySelector('.duplicant-node-children') as HTMLElement;
        if (childContainer) {
          const isHidden = childContainer.classList.toggle('collapsed');
          const nowExpanded = !isHidden;
          const newSvg = pickToggleSvg(true, nowExpanded, isAbandoned, isCompleted, false, false);
          toggle.innerHTML = `<span class="toggle-svg">${newSvg}</span>`;
          const newTitle = getToggleTitle(true, nowExpanded, isCompleted, isAbandoned, false, false);
          setTooltip(toggle, newTitle ?? '');
        }
      });
    } else {
      // 叶子节点：toggle 占位符
      const placeholderCls = [
        'duplicant-node-toggle-placeholder',
        isCompleted ? 'is-completed' : '',
        isAbandoned ? 'is-abandoned' : '',
      ].filter(Boolean).join(' ');
      const placeholder = headerEl.createEl('span', { cls: placeholderCls });
      const svg = pickToggleSvg(false, false, isAbandoned, isCompleted, false, false);
      placeholder.innerHTML = `<span class="toggle-svg">${svg}</span>`;
      const title = getToggleTitle(false, false, isCompleted, isAbandoned, false, false);
      if (title) setTooltip(placeholder, title);
    }

    // 类型标签
    headerEl.createEl('span', {
      cls: `duplicant-node-type-label duplicant-type-${data.type}`,
      text: NODE_TYPE_LABELS[data.type as NodeType] ?? data.type,
    });

    // 名称
    headerEl.createEl('span', { cls: 'duplicant-node-name', text: data.name });

    // 正文预览
    const preview = this.getBodyPreview(nodeId);
    if (preview) {
      headerEl.createEl('span', { cls: 'duplicant-node-body-preview', text: preview });
    }

    // 状态标签 — 使用有效状态（effectiveStatus），而非 data.status。
    // 对 list/rite/event：优先取所属 Cycle 的周期状态（periodStates），
    // 若无活跃周期则退化为节点自身的 status（初始属性）。
    // 对 taskchain 等其他类型：effectiveStatus === data.status，无变化。
    headerEl.createEl('span', {
      cls: `duplicant-node-status ${STATUS_CLASS_MAP[effectiveStatus] ?? ''}`,
      text: NODE_STATUS_LABELS[effectiveStatus] ?? effectiveStatus,
    });

    // 右键菜单 — 按子节点类型分发
    headerEl.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (data.type === 'taskchain') {
        this.showTaskchainChildMenu(e, nodeId, data, parentNodeId);
      } else {
        this.showExecutionChildMenu(e, nodeId, data, parentNodeId, isDirectChild);
      }
    });

    // 左键点击行为（可配置：编辑描述 或 展开/折叠）
    headerEl.addEventListener('click', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.duplicant-node-toggle, .duplicant-node-toggle-placeholder')) return;
      e.stopPropagation();

      if (this.settings.planningClickAction === 'toggle' && hasChildren) {
        // 展开/折叠模式：切换子节点容器的收起状态
        const childContainer = nodeEl.querySelector('.duplicant-node-children') as HTMLElement;
        const toggleEl = headerEl.querySelector('.duplicant-node-toggle') as HTMLElement;
        if (childContainer && toggleEl) {
          const isHidden = childContainer.classList.toggle('collapsed');
          const nowExpanded = !isHidden;
          const newSvg = pickToggleSvg(true, nowExpanded, isAbandoned, isCompleted, false, false);
          toggleEl.innerHTML = `<span class="toggle-svg">${newSvg}</span>`;
          const newTitle = getToggleTitle(true, nowExpanded, isCompleted, isAbandoned, false, false);
          setTooltip(toggleEl, newTitle ?? '');
        }
      } else {
        // 编辑描述模式（默认）
        this.promptEditBody(nodeId, data);
      }
    });

    // 子节点容器（有子节点时渲染，默认收起）
    if (hasChildren) {
      const childContainer = nodeEl.createEl('div', { cls: 'duplicant-node-children collapsed' });
      for (const gc of grandChildren) {
        this.renderChildNode(childContainer, gc.nodeId, gc.data, parentNodeId, false);
      }
    }
  }

  // ============================================================
  // 数据辅助
  // ============================================================

  /**
   * 获取联合节点的子节点列表
   * 从节点的 children 数组读取双链引用，解析为 nodeId 后查缓存。
   * 不限制子节点类型——cycle 的 children 可同时包含 joint（list/rite/event）
   * 和 chain（taskchain）类型，按 ALLOWED_CHILD_TYPES 约束。
   *
   * 子节点顺序：严格保持 children 数组中的顺序（即加入时间从旧到新）。
   * 这是有意设计——用户可通过拖拽排序模态框（showChildReorderModal）
   * 微调 children 数组顺序，从而控制子节点的显示排列。
   */
  private getJointChildren(nodeId: string): { nodeId: string; data: AnyNode }[] {
    const snapshot = this.nodeCache.nodeStore.get();
    const node = snapshot.get(nodeId);
    if (!node) return [];

    const childRefs = (node as any).children;
    if (!Array.isArray(childRefs)) return [];

    const children: { nodeId: string; data: AnyNode }[] = [];
    const seen = new Set<string>();

    for (const ref of childRefs) {
      const childId = typeof ref === 'string' ? ref.replace(/^\[\[(.+)\]\]$/, '$1') : '';
      if (!childId || seen.has(childId)) continue;
      seen.add(childId);

      const childData = snapshot.get(childId);
      // 存在于缓存即渲染，类型约束由 ALLOWED_CHILD_TYPES 和菜单逻辑保证
      if (childData) {
        children.push({ nodeId: childId, data: childData });
      }
    }
    return children;
  }

  private getBodyPreview(nodeId: string): string {
    const body = this.nodeCache.getNodeBody(nodeId);
    if (!body) return '';
    // 对齐旧版 v1：显示完整正文，由 CSS 控制截断显示
    return body;
  }

  // ============================================================
  // 右键菜单（Obsidian Menu API）
  // ============================================================

  private showNodeMenu(e: MouseEvent, nodeId: string, data: AnyNode): void {
    const menu = new Menu();

    const STATUS_ICONS: Record<string, string> = {
      pending: 'circle', doing: 'circle-dot', paused: 'pause',
      completed: 'check-circle', giveup: 'x-circle',
      progress: 'circle-dot', done: 'check-circle', cancelled: 'x-circle',
    };

    // 更改状态（子菜单，展示全部状态，当前状态置灰 — 与 PlanningView 一致）
    menu.addItem(item => {
      item.setTitle('更改状态').setIcon('circle-dot');
      const submenu = (item as any).setSubmenu?.();
      if (submenu) {
        const allStatuses = getStatusValues(data.type as NodeType);
        for (const s of allStatuses) {
          const isCurrent = s === data.status;
          submenu.addItem((subItem: any) => {
            subItem.setTitle(`标记为${NODE_STATUS_LABELS[s] ?? s}`);
            subItem.setIcon(STATUS_ICONS[s] ?? 'circle');
            if (isCurrent) {
              subItem.setDisabled(true);
            } else {
              subItem.onClick(() => this.handleStatusSet(nodeId, s));
            }
          });
        }
      }
    });

    menu.addSeparator();

    // 编辑功能将不再需要
    // menu.addItem(item => item
    //   .setTitle('编辑')
    //   .setIcon('pencil')
    //   .onClick(() => this.handleEdit(nodeId, data))
    // );

    // 新建并加入（子菜单，列出允许的子节点类型）
    // cycle 节点的 taskchain 改为「加入目标」（引用已有目标），不走新建流程
    const allowedChildren = ALLOWED_CHILD_TYPES[data.type as NodeType] ?? [];
    const skipCreate: Set<NodeType> = data.type === 'cycle' ? new Set(['taskchain']) : new Set();
    const createItems = allowedChildren.filter(t => !skipCreate.has(t));
    if (createItems.length > 0) {
      menu.addItem(item => {
        item.setTitle('新建并加入项').setIcon('file-plus');
        const submenu = (item as any).setSubmenu?.();
        if (submenu) {
          for (const childType of createItems) {
            submenu.addItem((subItem: any) => {
              subItem.setTitle(`新建${NODE_TYPE_LABELS[childType] ?? childType}`);
              const iconMap: Record<string, string> = { list: 'list-checks', rite: 'flame', event: 'calendar-clock' };
              subItem.setIcon(iconMap[childType] ?? 'file-plus');
              subItem.onClick(() => this.handleAddChild(nodeId, data.type as NodeType, childType));
            });
          }
        }
      });
    }

    // cycle 节点
    if (data.type === 'cycle') {
      // 加入执行清单（子菜单：检查表、仪式、事件）
      const execTypes: NodeType[] = ['list', 'rite', 'event'];
      menu.addItem(item => {
        item.setTitle('加入已有节点').setIcon('log-in');
        const submenu = (item as any).setSubmenu?.();
        if (submenu) {
          const iconMap: Record<string, string> = { list: 'list-checks', rite: 'flame', event: 'calendar-clock' };
          for (const t of execTypes) {
            submenu.addItem((subItem: any) => {
              subItem.setTitle(`引入${NODE_TYPE_LABELS[t] ?? t}`);
              subItem.setIcon(iconMap[t] ?? 'file-plus');
              subItem.onClick(() => this.handleAddExistingToCycle(nodeId, t));
            });
          }
        }
      });

      // 加入已有目标
      menu.addItem(item => {
        item.setTitle('加入已有目标');
        item.setIcon('link');
        item.onClick(() => this.handleAddExistingTaskchain(nodeId));
      });
    }

    menu.addSeparator();

    menu.addItem(item => {
      item.setTitle('重命名').setIcon('pencil');
      item.onClick(() => this.handleRename(nodeId));
    });

    menu.addItem(item => {
      item.setTitle('归档节点文件').setIcon('trash').setWarning(true);
      item.onClick(() => this.handleArchive(nodeId, data.type as NodeType));
    });

    menu.showAtMouseEvent(e);
  }

  /**
   * 目标(taskchain)子节点右键菜单 — 周期卡片"目标"区
   *
   * 包含：更改状态 / 从周期中移除
   */
  private showTaskchainChildMenu(e: MouseEvent, nodeId: string, data: AnyNode, parentNodeId: string): void {
    const menu = new Menu();

    const STATUS_ICONS: Record<string, string> = {
      pending: 'circle', doing: 'circle-dot', paused: 'pause',
      completed: 'check-circle', giveup: 'x-circle',
      progress: 'circle-dot', done: 'check-circle', cancelled: 'x-circle',
    };

    // 更改状态（展示全部状态，当前状态不可选用）
    menu.addItem((item) => {
      item.setTitle('更改状态').setIcon('circle-dot');
      const submenu = (item as any).setSubmenu?.();
      if (submenu) {
        const allStatuses = getStatusValues(data.type as NodeType);
        for (const s of allStatuses) {
          const isCurrent = s === data.status;
          submenu.addItem((subItem: any) => {
            subItem.setTitle(`标记为${NODE_STATUS_LABELS[s] ?? s}`);
            subItem.setIcon(STATUS_ICONS[s] ?? 'circle');
            if (isCurrent) subItem.setDisabled(true);
            else subItem.onClick(() => this.handleStatusSet(nodeId, s));
          });
        }
      }
    });

    menu.addSeparator();

    // 编辑描述（当左键行为为展开/折叠时，在右键菜单中提供编辑入口）
    if (this.settings.planningClickAction === 'toggle') {
      menu.addItem((item) => {
        item.setTitle('编辑描述').setIcon('pencil');
        item.onClick(() => this.promptEditBody(nodeId, data));
      });
    }

    // 从周期中移除
    menu.addItem((item) => {
      item.setTitle('从周期中移除').setIcon('unlink');
      item.onClick(() => this.removeChildReference(parentNodeId, nodeId));
    });

    menu.showAtMouseEvent(e);
  }

  /**
   * 执行清单(list/rite/event)子节点右键菜单 — 周期卡片"执行清单"区
   *
   * - 直接子节点（isDirectChild=true）：更改状态 / 跳转到收纳箱 / 从周期中移除 / 归档节点文件
   * - 嵌套子节点（isDirectChild=false）：更改状态 / 跳转到收纳箱
   */
  private showExecutionChildMenu(e: MouseEvent, nodeId: string, data: AnyNode, parentNodeId: string, isDirectChild: boolean = false): void {
    const menu = new Menu();

    const STATUS_ICONS: Record<string, string> = {
      pending: 'circle', doing: 'circle-dot', paused: 'pause',
      completed: 'check-circle', giveup: 'x-circle',
      progress: 'circle-dot', done: 'check-circle', cancelled: 'x-circle',
    };

    // 更改状态子菜单
    menu.addItem((item) => {
      item.setTitle('更改状态').setIcon('circle-dot');
      const submenu = (item as any).setSubmenu?.();
      if (submenu) {
        const allStatuses = getStatusValues(data.type as NodeType);
        const effectiveStatus = this.nodeCache.getEffectiveStatus(nodeId, parentNodeId);
        for (const s of allStatuses) {
          const isCurrent = s === effectiveStatus;
          submenu.addItem((subItem: any) => {
            subItem.setTitle(`标记为${NODE_STATUS_LABELS[s] ?? s}`);
            subItem.setIcon(STATUS_ICONS[s] ?? 'circle');
            if (isCurrent) subItem.setDisabled(true);
            else subItem.onClick(() => this.handleStatusSet(nodeId, s, parentNodeId));
          });
        }
      }
    });

    // 跳转到收纳箱
    menu.addItem((item) => {
      item.setTitle('跳转到收纳箱').setIcon('arrow-right');
      item.onClick(() => this.scrollToInboxNode(nodeId));
    });

    // 编辑描述（当左键行为为展开/折叠时，在右键菜单中提供编辑入口）
    if (this.settings.planningClickAction === 'toggle') {
      menu.addItem((item) => {
        item.setTitle('编辑描述').setIcon('pencil');
        item.onClick(() => this.promptEditBody(nodeId, data));
      });
    }

    // 循环规则（仅 rite/event，且需在某个 Cycle 内）
    // 使用 parentNodeId（右键菜单入口所在的 cycle）而非 findOwningCycle，
    // 确保规则写入用户操作的上下文 cycle，而非任意第一个匹配的 cycle。
    if (data.type === 'rite' || data.type === 'event') {
      const ownerCycleId = parentNodeId;
      const ownerCycleData = this.nodeCache.getNode(ownerCycleId);
      if (ownerCycleData && ownerCycleData.type === 'cycle') {
        const existingRule = this.nodeCache.getRiteCycleRuleInfo(ownerCycleId, nodeId);
        menu.addItem((item) => {
          item.setTitle(existingRule ? '编辑循环规则' : '设置循环规则');
          item.setIcon('refresh-cw');
          item.onClick(() => {
            new CycleRuleModal(this.app, {
              targetType: 'rite',
              nodeId,
              cycleId: ownerCycleId,
              nodeCache: this.nodeCache,
              fileManager: this.fileManager,
              operationQueue: this.operationQueue,
            }).open();
          });
        });
        if (existingRule) {
          menu.addItem((item) => {
            item.setTitle('清除循环规则');
            item.setIcon('x');
            item.onClick(() => {
              this.nodeCache.removeCycleRuleEntry(ownerCycleId, nodeId);
              const entries = this.nodeCache.getCycleRuleEntries(ownerCycleId);
              const newFlat = entries.length > 0 ? packCycleRules(entries) : undefined;
              const currentPs = (this.nodeCache.getNode(ownerCycleId) as any)?.periodStates;
              this.operationQueue.enqueueFileOp(async () => {
                await this.fileManager.updateNode('cycle', ownerCycleId, { cycleRules: newFlat, periodStates: currentPs } as any);
              });
            });
          });
        }
      }
    }

    // 直接子节点额外操作：重命名、从周期中移除、归档节点文件
    if (isDirectChild) {
      menu.addItem((item) => {
        item.setTitle('重命名').setIcon('pencil');
        item.onClick(() => this.handleRename(nodeId));
      });

      menu.addItem((item) => {
        item.setTitle('从周期中移除').setIcon('unlink');
        item.onClick(() => this.removeChildReference(parentNodeId, nodeId));
      });

      menu.addItem((item) => {
        item.setTitle('归档节点文件').setIcon('trash').setWarning(true);
        item.onClick(() => this.handleArchive(nodeId, data.type as NodeType));
      });
    }

    menu.showAtMouseEvent(e);
  }

  /**
   * 移除父节点 children 数组中对指定子节点的引用（不删除子节点本身）
   */
  private removeChildReference(parentNodeId: string, childNodeId: string): void {
    const parentNode = this.nodeCache.getNode(parentNodeId);
    if (!parentNode) return;

    const existingChildren: string[] = ((parentNode as any).children ?? []);
    const target = `[[${childNodeId}]]`;
    const newChildren = existingChildren.filter((ref) => ref !== target);

    // 无变化时不操作
    if (newChildren.length === existingChildren.length) return;

    this.operationQueue.enqueue(
      () => this.nodeCache.updateNode(parentNodeId, { children: newChildren } as Partial<AnyNode>),
      () => this.fileManager.updateNode(
        parentNode.type as NodeType,
        parentNodeId,
        { children: newChildren } as Partial<AnyNode>,
      ),
    );
  }

  // ============================================================
  // 新建周期（简化模态框：名称 + 状态）
  // ============================================================

  /**
   * 展开收纳箱并滚动到其位置
   */
  /**
   * 展开收纳箱并滚动到指定节点行位置
   *
   * 用于周期卡片执行清单中的节点行右键菜单「跳转到收纳箱」。
   * 先确保收纳箱已展开，再通过 data-node-id 属性定位目标节点行并滚动。
   */
  private scrollToInboxNode(nodeId: string): void {
    // 确保收纳箱已展开
    if (!this.inboxExpanded) {
      this.inboxExpanded = true;
      this.refreshList();
    }
    requestAnimationFrame(() => {
      const target = this.contentEl.querySelector(
        `.duplicant-cycle-card-inbox [data-node-id="${nodeId}"]`,
      ) as HTMLElement | null;
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // 短暂高亮便于识别
        target.style.outline = '2px solid var(--interactive-accent)';
        setTimeout(() => { target.style.outline = ''; }, 1500);
      } else {
        // 未找到节点行，仅滚动到收纳箱卡片
        const inboxCard = this.contentEl.querySelector('.duplicant-cycle-card-inbox') as HTMLElement;
        if (inboxCard) inboxCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  private scrollToInbox(): void {
    if (this.inboxExpanded) {
      // 已展开 → 收起收纳箱并滚动到顶部
      this.inboxExpanded = false;
      this.refreshList();
      requestAnimationFrame(() => {
        const cycleList = this.contentEl.querySelector('[data-role="cycle-list"]') as HTMLElement;
        if (cycleList) cycleList.scrollTo({ top: 0, behavior: 'smooth' });
      });
    } else {
      // 已收起 → 展开收纳箱并滚动到其位置
      this.inboxExpanded = true;
      this.refreshList();
      requestAnimationFrame(() => {
        const inboxCard = this.contentEl.querySelector('.duplicant-cycle-card-inbox') as HTMLElement;
        if (inboxCard) inboxCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  private showNewCycleModal(): void {
    const modal = new Modal(this.app);
    modal.setTitle('新建周期');

    let name = '';

    // 名称输入
    new Setting(modal.contentEl)
      .setName('名称')
      .addText((text) => {
        text.setPlaceholder('周期名称')
          .onChange((v) => { name = v.trim(); });
        text.inputEl.style.width = '100%';
        modal.onOpen = () => setTimeout(() => text.inputEl.focus(), 50);
      });

    // 确认按钮
    new Setting(modal.contentEl)
      .addButton((btn) => {
        btn.setButtonText('创建').setCta().onClick(() => {
          if (!name) { new Notice('请输入周期名称'); return; }
          const nid = this.genId(name);
          const now = new Date().toISOString();
          const data: Partial<AnyNode> = { type: 'cycle', name, status: 'pending', created: now, modified: now } as any;
          this.operationQueue.enqueue(
            () => this.nodeCache.addNode(nid, data as AnyNode),
            async () => { await this.fileManager.createNode('cycle', data, '', nid); },
          );
          modal.close();
        });
      });

    modal.open();
  }

  // ============================================================
  // 操作处理
  // ============================================================

  private handleNew(type: JointNodeType): void {
    const CHILD_TYPE_MAP: Record<string, NodeType[]> = {
      cycle: ['taskchain', 'list', 'rite', 'event'],
      list: ['rite', 'event'],
    };
    const childTypes = CHILD_TYPE_MAP[type];
    const childCandidates: { nodeId: string; data: AnyNode }[] = [];
    if (childTypes) {
      for (const t of childTypes) {
        childCandidates.push(...this.nodeCache.getByType(t));
      }
    }

    new NodeEditorModal(this.app, {
      nodeType: type,
      childCandidates,
      onSave: (data, body) => this.handleSave(undefined, undefined, type, data, body),
    }).open();
  }

  /**
   * 加入已有目标 — 弹出选择器让用户挑选一个 taskchain，将其 nodeId 添加到 cycle 的 children
   *
   * 使用 Modal + 搜索框 + 可点击列表（而非 SuggestModal），
   * 避免内联子类的运行时兼容性问题。
   */
  private handleAddExistingTaskchain(cycleId: string): void {
    // 获取全部 taskchain 节点
    const taskchains = this.nodeCache.getByType('taskchain');

    // 过滤掉当前 cycle 已引用的目标（避免重复关联）
    const cycleNode = this.nodeCache.getNode(cycleId);
    const existingRefs: string[] = cycleNode ? ((cycleNode as any).children ?? []) : [];
    const existingIds = new Set(
      existingRefs.map((r: string) => typeof r === 'string' ? r.replace(/^\[\[(.+)\]\]$/, '$1') : ''),
    );

    const candidates = taskchains.filter((tc) => !existingIds.has(tc.nodeId) && tc.data.status !== 'completed' && tc.data.status !== 'giveup');

    if (candidates.length === 0) {
      new Notice('没有可加入的目标（所有目标均已关联、已完成/已放弃或尚无目标）。');
      return;
    }

    const modal = new Modal(this.app);
    modal.setTitle('加入目标');

    // 搜索框
    const searchInput = modal.contentEl.createEl('input', {
      cls: 'duplicant-node-picker-search',
      attr: { type: 'text', placeholder: '输入文件名或名称搜索…' },
    });

    // 列表容器
    const listEl = modal.contentEl.createEl('div', { cls: 'duplicant-node-picker-list' });

    // 渲染候选列表（根据搜索词过滤）
    const renderCandidates = (filter: string) => {
      listEl.empty();
      const q = filter.toLowerCase();
      const matched = candidates.filter(
        (c) => c.nodeId.toLowerCase().includes(q) || (c.data.name ?? '').toLowerCase().includes(q),
      );

      if (matched.length === 0) {
        listEl.createEl('div', { cls: 'duplicant-node-picker-empty', text: '无匹配目标' });
        return;
      }

      for (const c of matched) {
        const row = listEl.createEl('div', { cls: 'duplicant-node-picker-item' });
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.cursor = 'pointer';

        // 展示名（去掉时间戳前缀）
        row.createEl('span', { cls: 'duplicant-node-picker-name', text: getDisplayName(c.nodeId) });
        // 状态标签靠右
        const statusLabel = NODE_STATUS_LABELS[c.data.status] ?? c.data.status;
        row.createEl('span', {
          cls: `duplicant-node-status ${STATUS_CLASS_MAP[c.data.status] ?? ''}`,
          text: statusLabel,
          attr: { style: 'margin-left: auto; font-size: 0.75em; flex-shrink: 0;' },
        });

        // 构建完整 YAML 信息文本
        const yamlLines: string[] = [
          `type: ${c.data.type}`,
          `name: ${c.data.name}`,
          `status: ${c.data.status}`,
        ];
        for (const [k, v] of Object.entries(c.data)) {
          if (['type', 'name', 'status'].includes(k)) continue;
          if (v === undefined || v === null) continue;
          yamlLines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
        }
        yamlLines.push(`nodeId: ${c.nodeId}`);

        // 悬浮超过 2 秒时，手动弹出 tooltip（避免 displayTooltip 在循环中共享实例）
        const yamlText = yamlLines.join('\n');
        let tooltipEl: HTMLElement | null = null;
        let tooltipTimer: ReturnType<typeof setTimeout> | null = null;

        row.addEventListener('mouseenter', () => {
          tooltipTimer = setTimeout(() => {
            tooltipEl = document.body.createEl('div', { cls: 'duplicant-picker-tooltip' });
            tooltipEl.textContent = yamlText;
            const rect = row.getBoundingClientRect();
            tooltipEl.style.position = 'fixed';
            tooltipEl.style.left = `${rect.left}px`;
            tooltipEl.style.top = `${rect.bottom + 4}px`;
            tooltipEl.style.zIndex = '9999';
          }, 2000);
        });
        row.addEventListener('mouseleave', () => {
          if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
          if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
        });

        // 点击选择
        row.addEventListener('click', () => {
          // 读取最新的 cycle children（避免闭包捕获过期快照）
          const latestNode = this.nodeCache.getNode(cycleId);
          const latestChildren: string[] = latestNode ? ((latestNode as any).children ?? []) : [];
          const newChildren = [...latestChildren, `[[${c.nodeId}]]`];

          // 更新缓存 + 写入文件
          this.operationQueue.enqueue(
            () => this.nodeCache.updateNode(cycleId, { children: newChildren } as Partial<AnyNode>),
            () => this.fileManager.updateNode('cycle', cycleId, { children: newChildren } as Partial<AnyNode>),
          );

          modal.close();
        });
      }
    };

    // 初始渲染全量列表
    renderCandidates('');

    // 搜索输入过滤
    searchInput.addEventListener('input', () => {
      renderCandidates(searchInput.value.trim());
    });

    // 自动聚焦搜索框
    modal.onOpen = () => setTimeout(() => searchInput.focus(), 50);

    modal.open();
  }

  /**
   * 加入执行清单 — 弹出选择器让用户挑选一个指定类型的节点，
   * 将其 nodeId 添加到 cycle 的 children
   */
  private handleAddExistingToCycle(cycleId: string, childType: NodeType): void {
    const nodes = this.nodeCache.getByType(childType);

    // 过滤掉当前 cycle 已引用的
    const cycleNode = this.nodeCache.getNode(cycleId);
    const existingRefs: string[] = cycleNode ? ((cycleNode as any).children ?? []) : [];
    const existingIds = new Set(
      existingRefs.map((r: string) => typeof r === 'string' ? r.replace(/^\[\[(.+)\]\]$/, '$1') : ''),
    );
    const candidates = nodes.filter((n) => !existingIds.has(n.nodeId));

    // 按创建时间降序（新到旧）
    candidates.sort((a, b) => (b.data.created ?? '').localeCompare(a.data.created ?? ''));

    if (candidates.length === 0) {
      new Notice(`没有可加入的${NODE_TYPE_LABELS[childType]}节点。`);
      return;
    }

    const modal = new Modal(this.app);
    modal.setTitle(`加入${NODE_TYPE_LABELS[childType]}`);

    const searchInput = modal.contentEl.createEl('input', {
      cls: 'duplicant-node-picker-search',
      attr: { type: 'text', placeholder: `搜索${NODE_TYPE_LABELS[childType]}名称…` },
    });
    const listEl = modal.contentEl.createEl('div', { cls: 'duplicant-node-picker-list' });

    const renderCandidates = (filter: string) => {
      listEl.empty();
      const q = filter.toLowerCase();
      const matched = candidates.filter(
        (c) => c.nodeId.toLowerCase().includes(q) || (c.data.name ?? '').toLowerCase().includes(q),
      );
      if (matched.length === 0) {
        listEl.createEl('div', { cls: 'duplicant-node-picker-empty', text: '无匹配节点' });
        return;
      }
      for (const c of matched) {
        const row = listEl.createEl('div', { cls: 'duplicant-node-picker-item' });
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.cursor = 'pointer';
        row.createEl('span', { cls: 'duplicant-node-picker-name', text: getDisplayName(c.nodeId) });
        const statusLabel = NODE_STATUS_LABELS[c.data.status] ?? c.data.status;
        row.createEl('span', {
          cls: `duplicant-node-status ${STATUS_CLASS_MAP[c.data.status] ?? ''}`,
          text: statusLabel,
          attr: { style: 'margin-left: auto; font-size: 0.75em; flex-shrink: 0;' },
        });
        row.addEventListener('click', () => {
          const latestCycle = this.nodeCache.getNode(cycleId);
          const latestChildren: string[] = latestCycle ? ((latestCycle as any).children ?? []) : [];
          const newChildren = [...latestChildren, `[[${c.nodeId}]]`];
          this.operationQueue.enqueue(
            () => this.nodeCache.updateNode(cycleId, { children: newChildren } as Partial<AnyNode>),
            () => this.fileManager.updateNode('cycle', cycleId, { children: newChildren } as Partial<AnyNode>),
          );
          modal.close();
        });
      }
    };

    renderCandidates('');
    searchInput.addEventListener('input', () => renderCandidates(searchInput.value.trim()));
    modal.onOpen = () => setTimeout(() => searchInput.focus(), 50);
    modal.open();
  }

  /**
   * 为检查表加入已有的仪式/事件节点 — 弹出选择器
   *
   * 与 handleAddExistingToCycle 类似，但操作对象是 List 的 children 数组。
   * 将选中的 rite/event nodeId 追加到 List 的 children 末尾。
   *
   * @param listId    检查表节点 ID
   * @param childType 要加入的子节点类型（'rite' 或 'event'）
   */
  private handleAddExistingToList(listId: string, childType: NodeType): void {
    const nodes = this.nodeCache.getByType(childType);

    // 过滤掉当前 list 已引用的
    const listNode = this.nodeCache.getNode(listId);
    const existingRefs: string[] = listNode ? ((listNode as any).children ?? []) : [];
    const existingIds = new Set(
      existingRefs.map((r: string) => typeof r === 'string' ? r.replace(/^\[\[(.+)\]\]$/, '$1') : ''),
    );
    const candidates = nodes.filter((n) => !existingIds.has(n.nodeId));

    // 按创建时间降序（新到旧）
    candidates.sort((a, b) => (b.data.created ?? '').localeCompare(a.data.created ?? ''));

    if (candidates.length === 0) {
      new Notice(`没有可加入的${NODE_TYPE_LABELS[childType]}节点。`);
      return;
    }

    const modal = new Modal(this.app);
    modal.setTitle(`加入${NODE_TYPE_LABELS[childType]}`);

    const searchInput = modal.contentEl.createEl('input', {
      cls: 'duplicant-node-picker-search',
      attr: { type: 'text', placeholder: `搜索${NODE_TYPE_LABELS[childType]}名称…` },
    });
    const listEl = modal.contentEl.createEl('div', { cls: 'duplicant-node-picker-list' });

    const renderCandidates = (filter: string) => {
      listEl.empty();
      const q = filter.toLowerCase();
      const matched = candidates.filter(
        (c) => c.nodeId.toLowerCase().includes(q) || (c.data.name ?? '').toLowerCase().includes(q),
      );
      if (matched.length === 0) {
        listEl.createEl('div', { cls: 'duplicant-node-picker-empty', text: '无匹配节点' });
        return;
      }
      for (const c of matched) {
        const row = listEl.createEl('div', { cls: 'duplicant-node-picker-item' });
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.cursor = 'pointer';
        row.createEl('span', { cls: 'duplicant-node-picker-name', text: getDisplayName(c.nodeId) });
        const statusLabel = NODE_STATUS_LABELS[c.data.status] ?? c.data.status;
        row.createEl('span', {
          cls: `duplicant-node-status ${STATUS_CLASS_MAP[c.data.status] ?? ''}`,
          text: statusLabel,
          attr: { style: 'margin-left: auto; font-size: 0.75em; flex-shrink: 0;' },
        });
        row.addEventListener('click', () => {
          const latestList = this.nodeCache.getNode(listId);
          const latestChildren: string[] = latestList ? ((latestList as any).children ?? []) : [];
          const newChildren = [...latestChildren, `[[${c.nodeId}]]`];
          this.operationQueue.enqueue(
            () => this.nodeCache.updateNode(listId, { children: newChildren } as Partial<AnyNode>),
            () => this.fileManager.updateNode('list', listId, { children: newChildren } as Partial<AnyNode>),
          );
          modal.close();
        });
      }
    };

    renderCandidates('');
    searchInput.addEventListener('input', () => renderCandidates(searchInput.value.trim()));
    modal.onOpen = () => setTimeout(() => searchInput.focus(), 50);
    modal.open();
  }

  /**
   * 检查表子节点拖拽排序模态框
   *
   * 通过拖拽调整 List 的 children 数组顺序。
   * children 数组的顺序即为子节点的显示顺序（按加入时间从旧到新），
   * 此设计方便用户通过拖拽微调节点顺序。
   *
   * @param listId 检查表节点 ID
   * @param data   检查表节点数据
   */
  /**
   * 批量添加或创建子节点模态框
   *
   * 两个区域：
   *   1. 已有节点区 — 勾选收纳箱中尚未被此检查表引用的 rite/event，批量加入
   *   2. 新建节点区 — 每行输入一个名称，批量创建 rite/event 并加入
   *
   * @param listId 检查表节点 ID
   * @param data   检查表节点数据
   */
  private showBatchAddToListModal(listId: string, data: AnyNode): void {
    const modal = new Modal(this.app);
    modal.setTitle(`批量添加 — ${data.name}`);

    // 已有引用集合（用于过滤）
    const existingRefs: string[] = ((data as any).children ?? []).map((r: string) =>
      typeof r === 'string' ? r.replace(/^\[\[(.+)\]\]$/, '$1') : r,
    );
    const existingIds = new Set(existingRefs);

    // ── 区域 1：已有节点勾选 ──
    const existingSection = modal.contentEl.createEl('div');
    existingSection.createEl('h4', { text: '加入已有节点', cls: 'duplicant-batch-section-title' });

    const candidates = this.nodeCache.getByType('rite')
      .concat(this.nodeCache.getByType('event'))
      .filter((n) => !existingIds.has(n.nodeId))
      .sort((a, b) => (b.data.created ?? '').localeCompare(a.data.created ?? ''));

    const checkboxes = new Map<string, HTMLInputElement>();

    if (candidates.length === 0) {
      existingSection.createEl('p', { text: '无可加入的仪式或事件。', cls: 'duplicant-empty-state' });
    } else {
      const searchInput = existingSection.createEl('input', {
        cls: 'duplicant-node-picker-search',
        attr: { type: 'text', placeholder: '搜索节点名称…' },
      });
      const listEl = existingSection.createEl('div', { cls: 'duplicant-node-picker-list' });

      const renderCandidateList = (filter: string) => {
        listEl.empty();
        const q = filter.toLowerCase();
        const matched = candidates.filter(
          (c) => c.nodeId.toLowerCase().includes(q) || (c.data.name ?? '').toLowerCase().includes(q),
        );
        for (const c of matched) {
          const row = listEl.createEl('div', { cls: 'duplicant-node-picker-item' });
          row.style.display = 'flex';
          row.style.alignItems = 'center';
          row.style.gap = '8px';
          row.style.cursor = 'pointer';

          const cb = row.createEl('input');
          cb.type = 'checkbox';
          cb.checked = false;
          checkboxes.set(c.nodeId, cb);

          // 点击整行切换勾选
          row.addEventListener('click', (e) => {
            if (e.target !== cb) cb.checked = !cb.checked;
          });

          row.createEl('span', {
            cls: `duplicant-node-type-label duplicant-type-${c.data.type}`,
            text: NODE_TYPE_LABELS[c.data.type as NodeType] ?? c.data.type,
          });
          row.createEl('span', { cls: 'duplicant-node-picker-name', text: getDisplayName(c.nodeId) });
        }
      };
      renderCandidateList('');
      searchInput.addEventListener('input', () => renderCandidateList(searchInput.value.trim()));
    }

    // ── 区域 2：新建节点（表格形式）──
    const createSection = modal.contentEl.createEl('div');
    createSection.style.marginTop = '12px';
    createSection.createEl('h4', { text: '批量新建并加入', cls: 'duplicant-batch-section-title' });

    // 表格容器
    const table = createSection.createEl('table', { cls: 'duplicant-batch-table' });
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';

    // 表头
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    headerRow.createEl('th', { text: '类型' }).style.width = '80px';
    headerRow.createEl('th', { text: '名称' });
    // 删除列占位
    headerRow.createEl('th').style.width = '36px';

    // 表体
    const tbody = table.createEl('tbody');

    // 行数据：{ type, nameInput }
    interface BatchRow {
      typeSelect: HTMLSelectElement;
      nameInput: HTMLInputElement;
      tr: HTMLTableRowElement;
    }
    const rows: BatchRow[] = [];

    const addRow = (defaultType: NodeType = 'event', defaultName = '') => {
      const tr = tbody.createEl('tr');

      // 类型下拉
      const tdType = tr.createEl('td');
      const typeSelect = tdType.createEl('select');
      typeSelect.style.width = '100%';
      typeSelect.createEl('option', { value: 'rite', text: '仪式' });
      typeSelect.createEl('option', { value: 'event', text: '事件' });
      typeSelect.value = defaultType;

      // 名称输入
      const tdName = tr.createEl('td');
      const nameInput = tdName.createEl('input');
      nameInput.type = 'text';
      nameInput.placeholder = '输入名称';
      nameInput.value = defaultName;
      nameInput.style.width = '100%';

      // 删除按钮
      const tdDel = tr.createEl('td');
      tdDel.style.textAlign = 'center';
      const btnDel = tdDel.createEl('button', { text: '✕', cls: 'duplicant-batch-del-btn' });
      btnDel.style.cursor = 'pointer';
      btnDel.style.border = 'none';
      btnDel.style.background = 'transparent';
      btnDel.style.color = 'var(--text-muted)';
      btnDel.style.fontSize = '14px';
      btnDel.addEventListener('click', () => {
        const idx = rows.findIndex(r => r.tr === tr);
        if (idx >= 0) rows.splice(idx, 1);
        tr.remove();
      });

      rows.push({ typeSelect, nameInput, tr });

      // 自动聚焦新行的名称输入
      nameInput.focus();
    };

    // 初始 1 行空行
    addRow();

    // 添加行按钮
    const addRowBtn = createSection.createEl('button', { text: '+ 添加行', cls: 'duplicant-batch-add-row' });
    addRowBtn.style.marginTop = '6px';
    addRowBtn.style.width = '100%';
    addRowBtn.style.cursor = 'pointer';
    addRowBtn.addEventListener('click', () => addRow());

    // ── 操作按钮 ──
    const btnRow = modal.contentEl.createEl('div');
    btnRow.style.display = 'flex';
    btnRow.style.justifyContent = 'flex-end';
    btnRow.style.gap = '8px';
    btnRow.style.marginTop = '12px';

    const btnSave = btnRow.createEl('button', { cls: 'mod-cta', text: '确认' });
    btnSave.addEventListener('click', () => {
      const newChildren: string[] = [];

      // 收集勾选的已有节点
      for (const [nodeId, cb] of checkboxes) {
        if (cb.checked) newChildren.push(`[[${nodeId}]]`);
      }

      // 从表格行批量新建（跳过空名称行）
      for (const row of rows) {
        const name = row.nameInput.value.trim();
        if (!name) continue;
        const createType = row.typeSelect.value as NodeType;
        const nid = this.genId(name);
        const now = new Date().toISOString();
        const nodeData = { type: createType, name, status: 'pending', created: now, modified: now } as AnyNode;
        this.operationQueue.enqueue(
          () => this.nodeCache.addNode(nid, nodeData),
          async () => { await this.fileManager.createNode(createType, nodeData, '', nid); },
        );
        newChildren.push(`[[${nid}]]`);
      }

      // 更新 List 的 children
      if (newChildren.length > 0) {
        const latestList = this.nodeCache.getNode(listId);
        const latestChildren: string[] = latestList ? ((latestList as any).children ?? []) : [];
        const merged = [...latestChildren, ...newChildren];
        this.operationQueue.enqueue(
          () => this.nodeCache.updateNode(listId, { children: merged } as Partial<AnyNode>),
          () => this.fileManager.updateNode('list', listId, { children: merged } as Partial<AnyNode>),
        );
      }

      modal.close();
    });

    const btnCancel = btnRow.createEl('button', { text: '取消' });
    btnCancel.addEventListener('click', () => modal.close());

    modal.open();
  }

  private showChildReorderModal(listId: string, data: AnyNode): void {
    const modal = new Modal(this.app);
    modal.setTitle(`排序与管理 — ${data.name}`);

    // 从缓存读取最新的 children，避免读到已取消引入的旧数据
    const latestNode = this.nodeCache.getNode(listId);
    const childRefs: string[] = ((latestNode as any)?.children ?? (data as any).children ?? []).map((r: string) =>
      typeof r === 'string' ? r.replace(/^\[\[(.+)\]\]$/, '$1') : r,
    );

    // 过滤掉缓存中已不存在的节点（已被归档/删除）
    const validRefs = childRefs.filter(id => this.nodeCache.getNode(id));
    let currentOrder = [...validRefs];

    const container = modal.contentEl.createEl('div', { cls: 'duplicant-reorder-list' });
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '4px';
    container.style.minHeight = '100px';

    let dragIndex: number | null = null;

    const renderItems = () => {
      container.empty();
      for (let i = 0; i < currentOrder.length; i++) {
        const childId = currentOrder[i];
        const childData = this.nodeCache.getNode(childId);
        const row = container.createEl('div', { cls: 'duplicant-reorder-item' });
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '8px';
        row.style.padding = '6px 8px';
        row.style.borderRadius = '4px';
        row.style.cursor = 'grab';
        row.style.userSelect = 'none';
        row.style.background = 'var(--background-secondary)';
        row.setAttribute('draggable', 'true');
        row.dataset.index = String(i);

        // 拖拽手柄
        const handle = row.createEl('span', { text: '⠿', cls: 'duplicant-reorder-handle' });
        handle.style.cursor = 'grab';
        handle.style.opacity = '0.5';
        handle.style.fontSize = '16px';

        // 类型标签
        const type = childData?.type ?? 'unknown';
        row.createEl('span', {
          cls: `duplicant-node-type-label duplicant-type-${type}`,
          text: NODE_TYPE_LABELS[type as NodeType] ?? type,
        });

        // 名称
        row.createEl('span', { text: childData?.name ?? childId });

        // 名称占满剩余空间
        const spacer = row.createEl('span');
        spacer.style.flex = '1';

        // 删除按钮（移除此引用）
        const btnRemove = row.createEl('button', { text: '✕' });
        btnRemove.style.border = 'none';
        btnRemove.style.outline = 'none';
        btnRemove.style.boxShadow = 'none';
        btnRemove.style.background = 'transparent';
        btnRemove.style.color = 'var(--text-muted)';
        btnRemove.style.cursor = 'pointer';
        btnRemove.style.fontSize = '14px';
        btnRemove.style.width = '24px';
        btnRemove.style.height = '24px';
        btnRemove.style.padding = '0';
        btnRemove.style.display = 'inline-flex';
        btnRemove.style.alignItems = 'center';
        btnRemove.style.justifyContent = 'center';
        btnRemove.style.flexShrink = '0';
        btnRemove.style.borderRadius = '0';
        btnRemove.setAttribute('aria-label', '移除此引用');
        btnRemove.addEventListener('click', (e) => {
          e.stopPropagation();
          currentOrder.splice(i, 1);
          renderItems();
        });

        // 拖拽事件
        row.addEventListener('dragstart', (e) => {
          dragIndex = i;
          row.style.opacity = '0.4';
          e.dataTransfer!.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => {
          row.style.opacity = '1';
          dragIndex = null;
          // 清除所有 drop 指示
          container.querySelectorAll('.duplicant-reorder-item').forEach((el) => {
            (el as HTMLElement).style.borderTop = '';
            (el as HTMLElement).style.borderBottom = '';
          });
        });
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer!.dropEffect = 'move';
          const rect = row.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          // 清除其他行的指示
          container.querySelectorAll('.duplicant-reorder-item').forEach((el) => {
            (el as HTMLElement).style.borderTop = '';
            (el as HTMLElement).style.borderBottom = '';
          });
          if (e.clientY < midY) {
            row.style.borderTop = '2px solid var(--interactive-accent)';
          } else {
            row.style.borderBottom = '2px solid var(--interactive-accent)';
          }
        });
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          row.style.borderTop = '';
          row.style.borderBottom = '';
          if (dragIndex === null || dragIndex === i) return;

          const rect = row.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          const insertBefore = e.clientY < midY;

          // 移动元素
          const [moved] = currentOrder.splice(dragIndex, 1);
          let targetIndex = i;
          // 如果从上方拖到下方，splice 后索引偏移
          if (dragIndex < i) targetIndex--;
          const insertIndex = insertBefore ? targetIndex : targetIndex + 1;
          currentOrder.splice(insertIndex, 0, moved);

          dragIndex = null;
          renderItems();
        });
      }
    };

    renderItems();

    // 底部按钮
    const btnRow = modal.contentEl.createEl('div', { cls: 'duplicant-reorder-actions' });
    btnRow.style.display = 'flex';
    btnRow.style.justifyContent = 'flex-end';
    btnRow.style.gap = '8px';
    btnRow.style.marginTop = '12px';

    const btnSave = btnRow.createEl('button', { cls: 'mod-cta', text: '保存' });
    btnSave.addEventListener('click', () => {
      const newChildren = currentOrder.map(id => `[[${id}]]`);
      this.operationQueue.enqueue(
        () => this.nodeCache.updateNode(listId, { children: newChildren } as Partial<AnyNode>),
        () => this.fileManager.updateNode('list', listId, { children: newChildren } as Partial<AnyNode>),
      );
      modal.close();
    });

    const btnCancel = btnRow.createEl('button', { text: '取消' });
    btnCancel.addEventListener('click', () => modal.close());

    modal.open();
  }

  private handleAddChild(parentId: string, parentType: NodeType, childType: NodeType): void {
    new QuickCreateModal(this.app, {
      nodeType: childType,
      onSave: (_nodeType, name) => {
        // 创建子节点
        const nid = this.genId(name);
        const now = new Date().toISOString();
        const data: Partial<AnyNode> = { type: childType, name, status: 'pending', created: now, modified: now } as any;
        this.operationQueue.enqueue(
          () => this.nodeCache.addNode(nid, data as AnyNode),
          async () => { await this.fileManager.createNode(childType, data, '', nid); },
        );
        // 更新父节点的 children 引用
        const parentNode = this.nodeCache.getNode(parentId);
        if (parentNode) {
          const existingChildren = ((parentNode as any).children as string[]) ?? [];
          const newChildren = [...existingChildren, `[[${nid}]]`];
          this.operationQueue.enqueue(
            () => this.nodeCache.updateNode(parentId, { children: newChildren } as Partial<AnyNode>),
            () => this.fileManager.updateNode(parentType, parentId, { children: newChildren } as Partial<AnyNode>),
          );

          // 状态联级：新增子节点时，若父节点为终态则恢复为进行中
          if (this.settings.stateCascade && (parentNode.status === 'completed' || parentNode.status === 'giveup')) {
            this.operationQueue.enqueue(
              () => this.nodeCache.updateNode(parentId, { status: 'doing' }),
              () => this.fileManager.updateNode(parentType, parentId, { status: 'doing' }),
            );
          }
        }
      },
    }).open();
  }

  private handleEdit(nodeId: string, data: AnyNode): void {
    const CHILD_TYPE_MAP: Record<string, NodeType[]> = {
      cycle: ['taskchain', 'list', 'rite', 'event'],
      list: ['rite', 'event'],
    };
    const childTypes = CHILD_TYPE_MAP[data.type] ?? [];
    const childCandidates: { nodeId: string; data: AnyNode }[] = [];
    for (const t of childTypes) {
      childCandidates.push(...this.nodeCache.getByType(t));
    }

    new NodeEditorModal(this.app, {
      nodeType: data.type as NodeType,
      existingData: data,
      existingNodeId: nodeId,
      existingBody: this.nodeCache.getNodeBody(nodeId),
      childCandidates,
      onSave: (updatedData, body) => this.handleSave(data, nodeId, data.type as NodeType, updatedData, body),
    }).open();
  }

  /**
   * 编辑节点描述（正文内容）— 对齐旧版 v1 promptEditBody
   * 左键点击节点行时触发，打开轻量级描述编辑模态框。
   */
  private promptEditBody(nodeId: string, data: AnyNode): void {
    const nodeType = this.nodeCache.getNodeType(nodeId);
    if (!nodeType) return;

    new DescriptionEditModal(this.app, {
      currentBody: this.nodeCache.getNodeBody(nodeId),
      onSave: (body: string) => {
        this.operationQueue.enqueue(
          () => this.nodeCache.setNodeBody(nodeId, body),
          () => this.fileManager.updateNodeBody(nodeType, nodeId, body),
        );
      },
    }).open();
  }

  /**
   * 归档孤立事件 — 收纳箱卡片右键菜单
   *
   * 孤立事件定义：不被任何其他节点的 children 数组引用的 event 节点。
   * 即该 event 既不在任何 cycle / list / event 的 children 中。
   */
  private handleArchiveOrphanedEvents(): void {
    // 收集所有被引用的 event nodeId
    const allNodes = this.nodeCache.nodeStore.get();
    const referencedIds = new Set<string>();
    for (const [, data] of allNodes) {
      const refs = (data as any).children;
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        const id = typeof ref === 'string' ? ref.replace(/^\[\[(.+)\]\]$/, '$1') : '';
        if (id) referencedIds.add(id);
      }
    }

    // 找出未被引用的 event
    const orphans: { nodeId: string; name: string }[] = [];
    for (const [nodeId, data] of allNodes) {
      if (data.type === 'event' && !referencedIds.has(nodeId)) {
        orphans.push({ nodeId, name: data.name });
      }
    }

    if (orphans.length === 0) {
      new Notice('没有孤立事件。');
      return;
    }

    // 模态框展示孤立事件列表，请用户确认
    const modal = new Modal(this.app);
    modal.setTitle(`归档 ${orphans.length} 个孤立事件`);

    const desc = modal.contentEl.createEl('p', { text: '以下事件未被任何检查表或周期引用，将被归档：' });
    desc.style.marginBottom = '8px';

    const table = modal.contentEl.createEl('table', { cls: 'duplicant-orphan-table' });
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    const thead = table.createEl('thead').createEl('tr');
    thead.createEl('th', { text: '类型' }).style.textAlign = 'left';
    thead.createEl('th', { text: '名称' }).style.textAlign = 'left';
    const tbody = table.createEl('tbody');
    for (const o of orphans) {
      const tr = tbody.createEl('tr');
      tr.createEl('td', {
        cls: `duplicant-node-type-label duplicant-type-event`,
        text: '事件',
      });
      tr.createEl('td', { text: o.name });
    }

    const btnRow = modal.contentEl.createEl('div');
    btnRow.style.display = 'flex';
    btnRow.style.justifyContent = 'flex-end';
    btnRow.style.gap = '8px';
    btnRow.style.marginTop = '12px';

    const btnArchive = btnRow.createEl('button', { cls: 'mod-warning', text: '归档' });
    btnArchive.addEventListener('click', () => {
      for (const o of orphans) {
        this.nodeCache.removeNode(o.nodeId);
        this.operationQueue.enqueueFileOp(() => this.fileManager.archiveNode('event', o.nodeId));
      }
      new Notice(`已归档 ${orphans.length} 个孤立事件。`);
      modal.close();
    });

    const btnCancel = btnRow.createEl('button', { text: '取消' });
    btnCancel.addEventListener('click', () => modal.close());

    modal.open();
  }

  /**
   * 重命名节点 — 弹出模态框输入新名称
   */
  private handleRename(nodeId: string): void {
    const node = this.nodeCache.getNode(nodeId);
    if (!node) return;
    const modal = new Modal(this.app);
    modal.setTitle('重命名');
    let newName = node.name;
    new Setting(modal.contentEl)
      .setName('新名称')
      .addText((text) => {
        text.setValue(node.name);
        text.onChange((v) => { newName = v.trim(); });
        setTimeout(() => text.inputEl.focus(), 100);
      });
    new Setting(modal.contentEl)
      .addButton((btn) => {
        btn.setButtonText('确认').setCta().onClick(() => {
          if (!newName || newName === node.name) { modal.close(); return; }
          const nType = this.nodeCache.getNodeType(nodeId)!;
          const newNodeId = updateNodeIdDisplayName(nodeId, newName);
          this.operationQueue.enqueue(
            () => {
              const data = this.nodeCache.getNode(nodeId);
              if (data) {
                this.nodeCache.removeNode(nodeId);
                this.nodeCache.addNode(newNodeId, { ...data, name: newName } as AnyNode);
              }
            },
            () => this.fileManager.renameNodeDisplayName(nType, nodeId, newName),
          );
          modal.close();
        });
      })
      .addButton((btn) => {
        btn.setButtonText('取消').onClick(() => modal.close());
      });
    modal.open();
  }

  private handleArchive(nodeId: string, nodeType: NodeType): void {
    // 清单面板：非递归归档，直接执行，无需确认
    this.executeArchive(nodeId, nodeType);
  }

  private executeArchive(nodeId: string, nodeType: NodeType): void {
    // 非递归：只归档单个节点，从缓存移除并移动文件到 Trash
    this.nodeCache.removeNode(nodeId);
    this.operationQueue.enqueueFileOp(() => this.fileManager.archiveNode(nodeType, nodeId));
  }

  /**
   * 统一的状态流转入口 — 委托给 writeStatus
   *
   * 由 toggle SVG 点击触发（按状态流转规则取第一个可流转状态）。
   * @see writeStatus  周期感知的实际写入逻辑
   */
  private handleStatusChange(nodeId: string, _current: string): void {
    const nType = this.nodeCache.getNodeType(nodeId)!;
    const next = getNextStatuses(_current, nType);
    if (next.length === 0) return;
    const newStatus = next[0];
    this.writeStatus(nodeId, nType, newStatus);
  }

  /**
   * 直接设置状态入口 — 委托给 writeStatus
   *
   * 由右键菜单「更改状态」子菜单触发（用户选择具体目标状态）。
   * @see writeStatus  周期感知的实际写入逻辑
   */
  private handleStatusSet(nodeId: string, newStatus: string, contextCycleId?: string): void {
    const nType = this.nodeCache.getNodeType(nodeId)!;
    this.writeStatus(nodeId, nType, newStatus, contextCycleId);
  }

  /**
   * 统一的状态写入方法 — 一式多份的核心路由逻辑
   *
   * 按优先级分三条路径写入状态：
   *
   * 路径 1 — Cycle 激活（auto-init）：
   *   条件：目标是 cycle 类型，newStatus 为 doing，
   *         Cycle 有 list/rite/event 后代，且无 currentPeriod。
   *   动作：先更新 Cycle 自身 status，再调用 initializePeriod()
   *         创建首个周期状态快照（以各子节点的 status 初始属性为种子）。
   *   结果：Cycle 的 currentPeriod 和 periodStates 被设置，子节点获得
   *         独立的周期状态（初始值来自各自的 status 字段）。
   *
   * 路径 2 — 周期状态写入（period-aware）：
   *   条件：目标是 list/rite/event 类型，所属 Cycle 存在（findOwningCycle
   *         返回非 null）。无论 Cycle 是否已有 currentPeriod 均走此路径。
   *   动作：若 Cycle 尚无 currentPeriod，先自动调用 initializePeriod()
   *         创建周期快照，再调用 updatePeriodState() 更新周期状态。
   *         整个过程不修改节点自身的 status 字段（初始属性保持不变）。
   *   隔离保证：此路径确保周期卡片中的状态变更永远只写入 periodStates，
   *         不会污染节点的初始属性，与收纳箱的 handleInitialStatusSet 完全隔离。
   *
   * 路径 3 — 直接写入（default）：
   *   条件：以上两条均不满足（非 cycle 的非 list/rite/event 节点，
   *         或 list/rite/event 不在任何 Cycle 中）。
   *   动作：直接更新节点 YAML 中的 status 字段。
   *   结果：行为与改造前完全一致（向下兼容）。
   *
   * @param nodeId    目标节点 ID
   * @param nType     目标节点类型
   * @param newStatus 要设置的新状态值
   *
   * @see initializePeriod    路径 1 中调用
   * @see updatePeriodState   路径 2 中调用
   * @see handleInitialStatusSet  收纳箱专用，始终走路径 3
   * @see ExecutionView.handleStatusSet  执行面板的同类路由逻辑
   */
  private writeStatus(nodeId: string, nType: NodeType, newStatus: string, contextCycleId?: string): void {

    // ── 路径 1：Cycle 激活时自动初始化周期 ──
    // 当 Cycle 首次被设为 doing 状态，且有 list/rite/event 后代时，
    // 自动创建周期状态快照。
    if (nType === 'cycle' && newStatus === 'doing') {
      // 唯一周期：将其他进行中的 Cycle 先变更为指定状态
      if (this.settings.uniqueCycle) {
        const allCycles = this.nodeCache.getByType('cycle');
        const targetStatus = this.settings.uniqueCycleTarget;
        for (const c of allCycles) {
          if (c.nodeId === nodeId) continue;
          if (c.data.status === 'doing') {
            this.operationQueue.enqueue(
              () => this.nodeCache.updateNode(c.nodeId, { status: targetStatus }),
              () => this.fileManager.updateNode('cycle', c.nodeId, { status: targetStatus }),
            );
          }
        }
      }
      const cycleData = this.nodeCache.getNode(nodeId);
      const hasPeriod = cycleData && (cycleData as any).periodStates && Object.keys((cycleData as any).periodStates).length > 0;
      const hasDescendants = cycleData && this.nodeCache.getCycleDescendants(nodeId).length > 0;
      if (!hasPeriod && hasDescendants) {
        this.operationQueue.enqueue(
          () => {
            // 缓存层：先更新 Cycle 自身 status，再初始化周期状态快照
            this.nodeCache.updateNode(nodeId, { status: newStatus });
            this.nodeCache.initializePeriod(nodeId);
          },
          async () => {
            // 文件层：一次性写入 Cycle 的所有变更字段（status + periodStates）
            await this.fileManager.updateNode(nType, nodeId, {
              status: newStatus,
              periodStates: (this.nodeCache.getNode(nodeId) as any)?.periodStates,
            } as Partial<AnyNode>);
          },
        );
        return;
      }
    }

    // ── 路径 2：List/Rite/Event 在周期中 → 写入周期状态 ──
    // 优先使用上下文周期（contextCycleId，来自用户操作所在的 cycle 卡片），
    // 否则回退到 findOwningCycle（第一个匹配的 cycle）。
    if (isJointStatusType(nType)) {
      let owner: { cycleId: string; cycle: AnyNode } | null = null;
      if (contextCycleId) {
        const cycleData = this.nodeCache.getNode(contextCycleId);
        if (cycleData && cycleData.type === 'cycle') {
          owner = { cycleId: contextCycleId, cycle: cycleData };
        }
      }
      if (!owner) {
        owner = this.nodeCache.findOwningCycle(nodeId);
      }
      if (owner) {
        const hasPeriod = (owner.cycle as any).periodStates && Object.keys((owner.cycle as any).periodStates).length > 0;

        // 若 Cycle 尚未初始化 periodStates，自动初始化
        if (!hasPeriod) {
          this.nodeCache.initializePeriod(owner.cycleId);
        }

        this.operationQueue.enqueue(
          // 缓存层：更新 Cycle 内存中的 periodStates
          () => {
            this.nodeCache.updatePeriodState(owner.cycleId, nodeId, newStatus);
            // 状态联级：检查表子记录全完成时自动标记检查表完成
            if (this.settings.stateCascade) {
              this.nodeCache.cascadePeriodList(owner.cycleId, nodeId);
            }
          },
          async () => {
            // 文件层：将更新后的 periodStates 写入 Cycle 的 YAML 文件
            const updatedCycle = this.nodeCache.getNode(owner.cycleId);
            if (updatedCycle) {
              await this.fileManager.updateNode('cycle', owner.cycleId, {
                periodStates: (updatedCycle as any).periodStates,
              } as Partial<AnyNode>);
            }
          },
        );
        return;
      }
    }

    // ── 路径 3：默认 — 直接写入节点自身 status ──
    // 适用于：taskchain/taskitem 等非一式多份类型，
    // 或 list/rite/event 未被任何 Cycle 引用时（向下兼容）。
    this.operationQueue.enqueue(
      () => {
        this.nodeCache.updateNode(nodeId, { status: newStatus });
        // 状态联级：沿 parent 链自动传播
        if (this.settings.stateCascade) {
          const cascades = this.nodeCache.cascadeChainParent(nodeId);
          for (const c of cascades) {
            this.operationQueue.enqueue(
              () => this.nodeCache.updateNode(c.nodeId, { status: c.newStatus }),
              () => this.fileManager.updateNode(c.nodeType, c.nodeId, { status: c.newStatus }),
            );
          }
          // 级联将 desire 节点标记为完成时，提示用户
          for (const c of cascades) {
            if (c.nodeType === 'desire' && c.newStatus === 'completed') {
              const desireName = this.nodeCache.getNode(c.nodeId)?.name ?? c.nodeId;
              new Notice(`期望「${desireName}」的所有子节点已完成，已自动标记为完成`);
            }
          }
        }
      },
      () => this.fileManager.updateNode(nType, nodeId, { status: newStatus }),
    );
  }

  /**
   * 直接写入节点自身的初始状态 — 绕过周期状态路由
   *
   * 专用于收纳箱右键菜单「切换初始状态」。与 writeStatus() 的区别：
   *   - writeStatus:          周期感知，对 list/rite/event 可能写入 periodStates
   *   - handleInitialStatusSet: 始终写入节点 YAML 中的 status 字段
   *
   * 语义：修改的是「初始属性」——即节点被加入周期时的默认起始状态。
   * 已存在的周期状态不受影响（periodStates 中的值保持不变）。
   * 下次调用 initializePeriod() 时会使用新的 status 值作为种子。
   *
   * @param nodeId    目标节点 ID
   * @param nType     节点类型（list / rite / event）
   * @param newStatus 新的初始状态值
   *
   * @see showInboxNodeMenu       调用方（收纳箱右键菜单）
   * @see writeStatus             对比参考（周期感知路由）
   * @see initializePeriod        周期初始化时读取 status 作为种子
   */
  private handleInitialStatusSet(nodeId: string, nType: NodeType, newStatus: string): void {
    // 始终走直接写入路径：更新节点 YAML 中的 status 字段
    this.operationQueue.enqueue(
      () => this.nodeCache.updateNode(nodeId, { status: newStatus }),
      () => this.fileManager.updateNode(nType, nodeId, { status: newStatus }),
    );
  }

  private handleSave(
    existingData: AnyNode | undefined,
    existingNodeId: string | undefined,
    nodeType: NodeType,
    data: Partial<AnyNode>,
    body: string
  ): void {
    if (existingData && existingNodeId) {
      this.operationQueue.enqueue(
        () => this.nodeCache.updateNode(existingNodeId, data),
        () => this.fileManager.updateNode(nodeType, existingNodeId, data),
      );
      this.operationQueue.enqueue(
        () => this.nodeCache.setNodeBody(existingNodeId, body),
        () => this.fileManager.updateNodeBody(nodeType, existingNodeId, body),
      );
    } else {
      const nid = this.genId(data.name ?? '未命名');
      const now = new Date().toISOString();
      this.operationQueue.enqueue(
        () => this.nodeCache.addNode(nid, { ...data, created: now, modified: now } as AnyNode, body),
        async () => { await this.fileManager.createNode(nodeType, data, body, nid); },
      );
    }
  }

  private genId(name: string): string {
    const d = new Date();
    const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}-${String(d.getMilliseconds()).padStart(3, '0')}`;
    const r = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
    return `${ts}-${r}-${name.replace(/[\\/:*?"<>|]/g, '_')}`;
  }
}
