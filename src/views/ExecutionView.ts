/**
 * ExecutionView — 执行面板（周期追踪 + 当前任务 + 归档）
 *
 * 布局结构：
 * - 当前任务：高亮活跃叶子任务（来自所有活跃 Cycle 的 targetTaskitems）+ 悬挂任务
 * - 周期追踪区：每个活跃 Cycle 渲染为可折叠卡片，包含：
 *   - 目标任务项（taskchain 引用的 taskitem）
 *   - 检查表执行（list 及其 rite/event 子节点，使用周期状态）
 *   - 仪式/事项（Cycle 直接引用的 rite/event）
 * - 归档：折叠终态任务（completed/giveup）
 *
 * 渲染模式复用 PlanningView 的 duplicant-node-header 结构 + SVG toggle + Menu API
 * 定时刷新：每 30 秒自动刷新，追踪进行中周期状态变化
 */

import { ItemView, WorkspaceLeaf, Menu, TFile, Notice, setTooltip } from 'obsidian';
import { VIEW_TYPE_EXECUTION } from '../types/index';
import type { NodeType, AnyNode, PluginSettings } from '../types/index';
import {
  getStatusValues,
  NODE_TYPE_LABELS,
  NODE_STATUS_LABELS,
  isJointStatusType,
} from '../types/index';
import { validateCycleRule, getNextTriggerTime } from '../utils/cycleRuleParser';
import type { NodeCache, ExecRefItem, ExecCycleTracker, ExecChecklistGroup } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import type { OperationQueue } from '../core/OperationQueue';
import { DescriptionEditModal } from './components/DescriptionEditModal';
import type { Unsubscriber } from '../utils/SimpleStore';
import { pickToggleSvg, getToggleTitle } from '../utils/toggleSvg';

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

const TERMINAL_STATUSES = new Set(['completed', 'giveup', 'done', 'cancelled']);
const ACTIVE_STATUSES = new Set(['doing', 'progress']);

/** 引用条目树节点（类内部使用） */
interface RefItemTreeNode {
  item: ExecRefItem;
  children: RefItemTreeNode[];
}

// ============================================================
// ExecutionView
// ============================================================

export class ExecutionView extends ItemView {
  private nodeCache: NodeCache;
  private fileManager: NodeFileManager;
  private operationQueue: OperationQueue;
  private settings: PluginSettings;
  private unsubscribers: Unsubscriber[] = [];

  // 定时刷新
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  // DOM 引用
  private contentWrapper!: HTMLDivElement;

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
  }

  getViewType(): string { return VIEW_TYPE_EXECUTION; }
  getDisplayText(): string { return '执行'; }
  getIcon(): string { return 'clock'; }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('duplicant-execution-view');

    // ── 标题栏 ──
    const header = container.createEl('div', { cls: 'duplicant-view-header' });
    const headerLeft = header.createEl('div', { cls: 'duplicant-header-left' });
    headerLeft.createEl('h3', { text: '执行', cls: 'duplicant-view-title' });

    const headerBtns = header.createEl('div', { cls: 'duplicant-header-btns' });
    const btnInsert = headerBtns.createEl('button', {
      cls: 'duplicant-btn duplicant-btn-primary',
      text: '插入事件',
    });
    btnInsert.addEventListener('click', () => this.handleInsertEvent());

    // ── 内容区域 ──
    this.contentWrapper = container.createEl('div', { cls: 'duplicant-exec-list' });

    // 订阅全量节点变更（refreshView 内部会检查 isInitialized）
    const unsub = this.nodeCache.nodeStore.subscribe(() => {
      this.refreshView();
    });
    this.unsubscribers.push(unsub);

    // 启动定时刷新（每 10 秒，用于追踪周期状态变化和时间推进）
    this.refreshTimer = window.setInterval(() => this.refreshView(), 10_000);
  }

  async onClose(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];

    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    this.contentEl.empty();
  }

  // ============================================================
  // 视图刷新
  // ============================================================

  private refreshView(): void {
    const wrapper = this.contentWrapper;
    if (!wrapper) return;

    // 缓存未初始化完成时跳过刷新
    if (!this.nodeCache.isInitialized) return;

    // ── 保存当前滚动位置和展开状态 ──
    const scrollEl = wrapper.closest('.view-content') ?? wrapper.parentElement;
    const scrollTop = scrollEl?.scrollTop ?? 0;
    const expandedIds = this.collectExpandedState(wrapper);
    const archiveExpanded = this.collectArchiveExpandedState(wrapper);

    wrapper.empty();

    const trackers = this.nodeCache.execCycleTrackers.get();

    // 无活跃周期时显示空状态
    if (trackers.length === 0) {
      const empty = wrapper.createEl('div', { cls: 'duplicant-empty-state' });
      empty.createEl('p', { text: '暂无活跃周期' });
      empty.createEl('p', { text: '在「清单」面板中激活一个周期开始执行。' });
      return;
    }

    // ── 当前任务区域（跨所有 Cycle 取第一个活跃叶子任务） ──
    const { currentTask, suspendedItems } = this.findGlobalCurrentTask(trackers);
    this.renderCurrentSection(wrapper, currentTask, suspendedItems);

    // ── 分隔线 ──
    wrapper.createEl('hr', { cls: 'duplicant-exec-divider' });

    // ── 周期追踪区域（每个活跃 Cycle 一个卡片） ──
    for (const tracker of trackers) {
      this.renderCycleTrackerCard(wrapper, tracker);
    }

    // ── 归档区域（收集进行中周期的终态任务项） ──
    const allTerminalItems: ExecRefItem[] = [];
    for (const tracker of trackers) {
      for (const item of tracker.targetTaskitems) {
        if (TERMINAL_STATUSES.has(item.data.status)) {
          allTerminalItems.push(item);
        }
      }
      for (const item of tracker.directItems) {
        if (TERMINAL_STATUSES.has(item.effectiveStatus)) {
          allTerminalItems.push(item);
        }
      }
    }
    this.renderArchiveSection(wrapper, allTerminalItems);

    // ── 恢复滚动位置和展开状态 ──
    this.restoreExpandedState(wrapper, expandedIds);
    this.restoreArchiveExpandedState(wrapper, archiveExpanded);
    if (scrollEl) scrollEl.scrollTop = scrollTop;
  }

  /**
   * 收集当前展开的节点 ID 集合（未被 .collapsed 的 .duplicant-node-children 的父节点 data-node-id）
   */
  private collectExpandedState(wrapper: HTMLElement): Set<string> {
    const expanded = new Set<string>();
    for (const childEl of wrapper.querySelectorAll('.duplicant-node-children:not(.collapsed)')) {
      const nodeEl = childEl.closest('.duplicant-node');
      const nid = nodeEl?.getAttribute('data-node-id');
      if (nid) expanded.add(nid);
    }
    return expanded;
  }

  /**
   * 收集归档区展开状态（.duplicant-exec-terminal-body 未被 .collapsed）
   */
  private collectArchiveExpandedState(wrapper: HTMLElement): boolean {
    const body = wrapper.querySelector('.duplicant-exec-terminal-body');
    return body ? !body.classList.contains('collapsed') : false;
  }

  /**
   * 恢复节点展开状态
   */
  private restoreExpandedState(wrapper: HTMLElement, expandedIds: Set<string>): void {
    for (const nid of expandedIds) {
      const nodeEl = wrapper.querySelector(`.duplicant-node[data-node-id="${nid}"]`);
      if (!nodeEl) continue;
      const childContainer = nodeEl.querySelector('.duplicant-node-children') as HTMLElement;
      if (childContainer && childContainer.classList.contains('collapsed')) {
        childContainer.classList.remove('collapsed');
        // 更新 toggle SVG
        const toggle = nodeEl.querySelector('.duplicant-node-toggle') as HTMLElement;
        if (toggle) {
          const nodeData = this.nodeCache.getNode(nid);
          const status = nodeData?.status ?? 'pending';
          const isCompleted = status === 'completed' || status === 'done';
          const isAbandoned = status === 'giveup' || status === 'cancelled';
          toggle.innerHTML = `<span class="toggle-svg">${pickToggleSvg(true, true, isAbandoned, isCompleted, false, false)}</span>`;
        }
      }
    }
  }

  /**
   * 恢复归档区展开状态
   */
  private restoreArchiveExpandedState(wrapper: HTMLElement, expanded: boolean): void {
    if (!expanded) return;
    const body = wrapper.querySelector('.duplicant-exec-terminal-body') as HTMLElement;
    if (body && body.classList.contains('collapsed')) {
      body.classList.remove('collapsed');
      const toggle = wrapper.querySelector('.duplicant-exec-terminal-header .duplicant-node-toggle') as HTMLElement;
      if (toggle) {
        toggle.classList.remove('collapsed');
        toggle.innerHTML = `<span class="toggle-svg">${pickToggleSvg(true, true, false, false, false, false)}</span>`;
      }
    }
  }

  // ============================================================
  // 全局当前任务查找
  // ============================================================

  /**
   * 跨所有活跃 Cycle 查找全局当前任务和悬挂任务
   *
   * 从所有 Cycle 的 targetTaskitems 中：
   *   1. 找出 doing 状态的叶子任务（无 doing 子节点的 taskitem）
   *   2. 取排序最前的一个作为当前任务
   *   3. 收集所有 paused 状态的任务作为悬挂任务
   */
  private findGlobalCurrentTask(trackers: ExecCycleTracker[]): {
    currentTask: ExecRefItem | null;
    suspendedItems: ExecRefItem[];
  } {
    const allTaskitems: ExecRefItem[] = [];
    for (const tracker of trackers) {
      allTaskitems.push(...tracker.targetTaskitems);
    }

    if (allTaskitems.length === 0) {
      return { currentTask: null, suspendedItems: [] };
    }

    // 构建父子关系索引
    const doingIds = new Set(allTaskitems.filter((i) => i.data.status === 'doing').map((i) => i.nodeId));
    const childrenOf = new Map<string, Set<string>>();
    for (const item of allTaskitems) {
      const raw = item.data as any;
      if ( 'source' in raw && typeof raw.source === 'string') {
        const parentId = raw.source.replace(/^\[\[(.+)\]\]$/, '$1');
        if (!childrenOf.has(parentId)) childrenOf.set(parentId, new Set());
        childrenOf.get(parentId)!.add(item.nodeId);
      }
    }

    // 叶子：doing 状态且无 doing 子节点
    const activeLeafTasks = allTaskitems.filter((i) => {
      if (i.data.status !== 'doing') return false;
      const kids = childrenOf.get(i.nodeId);
      if (!kids) return true;
      for (const kid of kids) {
        if (doingIds.has(kid)) return false;
      }
      return true;
    }).sort((a, b) => a.sortTime - b.sortTime);

    const currentTask = activeLeafTasks[0] ?? null;

    // 悬挂任务（排除当前任务）
    const suspendedItems = allTaskitems.filter(
      (i) => i.data.status === 'paused' && i.nodeId !== currentTask?.nodeId,
    );

    return { currentTask, suspendedItems };
  }

  // ============================================================
  // 当前任务区域
  // ============================================================

  private renderCurrentSection(
    parent: HTMLElement,
    currentTask: ExecRefItem | null,
    suspendedItems: ExecRefItem[],
  ): void {
    const section = parent.createEl('div', { cls: 'duplicant-exec-current' });
    section.createEl('div', { cls: 'duplicant-exec-current-label', text: '当前任务' });

    if (currentTask) {
      this.renderRefItemRow(section, currentTask, true);
    } else {
      section.createEl('div', {
        cls: 'duplicant-empty-state',
        text: '无活跃任务',
      });
    }

    // 悬挂任务
    if (suspendedItems.length > 0) {
      section.createEl('div', { cls: 'duplicant-exec-current-label', text: '悬挂任务' });
      for (const item of suspendedItems) {
        this.renderRefItemRow(section, item, false);
      }
    }
  }

  // ============================================================
  // 周期追踪卡片
  // ============================================================

  /**
   * 渲染单个活跃 Cycle 的追踪卡片
   *
   * 包含三个子区：
   *   1. 目标任务项（taskchain 引用的 taskitem）
   *   2. 检查表执行（list 及其 rite/event 子节点）
   *   3. 仪式/事项（直接引用的 rite/event）
   */
  private renderCycleTrackerCard(parent: HTMLElement, tracker: ExecCycleTracker): void {
    // ── 直接渲染内容区，不显示周期卡片标题 ──
    const hasContent = tracker.targetTaskitems.length > 0
      || tracker.checklistGroups.length > 0
      || tracker.directItems.length > 0;

    if (!hasContent) return;

    // ── 1. 目标任务项区 ──
    if (tracker.targetTaskitems.length > 0) {
      const tcSection = parent.createEl('div', { cls: 'duplicant-exec-section' });

      // 构建树形结构
      const tree = this.buildRefItemTree(tracker.targetTaskitems);
      for (const node of tree) {
        this.renderRefItemTreeNode(tcSection, node, 0, tracker.cycleId);
      }
    }

    // ── 2. 检查表执行区 ──
    if (tracker.checklistGroups.length > 0) {
      const clSection = parent.createEl('div', { cls: 'duplicant-exec-section' });

      for (const group of tracker.checklistGroups) {
        this.renderChecklistGroup(clSection, group, tracker.cycleId);
      }
    }

    // ── 3. 仪式/事项区 ──
    if (tracker.directItems.length > 0) {
      const dirSection = parent.createEl('div', { cls: 'duplicant-exec-section' });

      for (const item of tracker.directItems) {
        this.renderRefItemRow(dirSection, item, false, tracker.cycleId);
      }
    }
  }

  // ============================================================
  // 检查表分组渲染
  // ============================================================

  /**
   * 渲染检查表分组（List 节点 + 其 rite/event 子节点）
   *
   * List 节点使用 effectiveStatus（周期状态），子节点同样使用 effectiveStatus。
   */
  private renderChecklistGroup(parent: HTMLElement, group: ExecChecklistGroup, cycleId: string): void {
    const data = group.listData;
    const isCompleted = group.effectiveStatus === 'completed' || group.effectiveStatus === 'done';
    const isAbandoned = group.effectiveStatus === 'giveup' || group.effectiveStatus === 'cancelled';
    const hasChildren = group.children.length > 0;

    const nodeEl = parent.createEl('div', {
      cls: `duplicant-node ${isCompleted ? 'completed' : ''} ${isAbandoned ? 'abandoned' : ''}`.trim(),
      attr: { 'data-node-id': group.listId },
    });

    const headerEl = nodeEl.createEl('div', { cls: 'duplicant-node-header' });

    // toggle
    if (hasChildren) {
      const isCollapsedByDefault = isCompleted || isAbandoned;
      const toggle = headerEl.createEl('span', { cls: 'duplicant-node-toggle' });
      const svg = pickToggleSvg(true, !isCollapsedByDefault, isAbandoned, isCompleted, false, false);
      toggle.innerHTML = `<span class="toggle-svg">${svg}</span>`;
      const title = getToggleTitle(true, !isCollapsedByDefault, isCompleted, isAbandoned, false, false);
      if (title) setTooltip(toggle, title);

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
    const preview = this.getBodyPreview(group.listId);
    if (preview) {
      headerEl.createEl('span', { cls: 'duplicant-node-body-preview', text: preview });
    }

    // 状态标签（使用 effectiveStatus）
    headerEl.createEl('span', {
      cls: `duplicant-node-status ${STATUS_CLASS_MAP[group.effectiveStatus] ?? ''}`,
      text: NODE_STATUS_LABELS[group.effectiveStatus] ?? group.effectiveStatus,
    });

    // 右键菜单
    headerEl.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      this.showNodeMenu(e, group.listId, data, cycleId);
    });

    // 子节点容器
    if (hasChildren) {
      const childContainer = nodeEl.createEl('div', {
        cls: `duplicant-node-children ${isCompleted || isAbandoned ? 'collapsed' : ''}`.trim(),
      });
      for (const child of group.children) {
        this.renderRefItemRow(childContainer, child, false, cycleId);
      }
    }
  }

  // ============================================================
  // 引用条目行渲染（统一渲染 taskitem / rite / event）
  // ============================================================

  /**
   * 渲染单个引用条目行
   *
   * 状态显示统一使用 effectiveStatus：
   *   - 联合节点（list/rite/event）：来自 Cycle.periodStates 的周期状态
   *   - 链路节点（taskitem）：节点自身 status（effectiveStatus = data.status）
   *
   * @param item 引用条目
   * @param isCurrentTask 是否为当前任务（可点击快速完成）
   */
  private renderRefItemRow(
    parent: HTMLElement,
    item: ExecRefItem,
    isCurrentTask: boolean,
    contextCycleId?: string,
  ): void {
    const data = item.data;
    // 统一使用 effectiveStatus：联合节点取周期状态，链路节点取自身 status
    const displayStatus = item.effectiveStatus;
    const isActive = ACTIVE_STATUSES.has(displayStatus);
    const isCompleted = displayStatus === 'completed' || displayStatus === 'done';
    const isAbandoned = displayStatus === 'giveup' || displayStatus === 'cancelled';
    const isSuspended = displayStatus === 'paused';

    const taskCls = [
      'duplicant-exec-task',
      isCurrentTask && isActive ? 'active' : '',
      isSuspended ? 'suspended' : '',
    ].filter(Boolean).join(' ');
    const taskEl = parent.createEl('div', { cls: taskCls });

    const nodeEl = taskEl.createEl('div', {
      cls: `duplicant-node ${isCompleted ? 'completed' : ''} ${isAbandoned ? 'abandoned' : ''}`.trim(),
      attr: { 'data-node-id': item.nodeId },
    });
    const headerEl = nodeEl.createEl('div', { cls: 'duplicant-node-header' });

    // toggle — 当前活跃任务可点击快速完成
    if (isCurrentTask && isActive) {
      const placeholder = headerEl.createEl('span', { cls: 'duplicant-node-toggle-placeholder is-active' });
      placeholder.innerHTML = `<span class="toggle-svg">${pickToggleSvg(false, false, false, false, true, false)}</span>`;
      setTooltip(placeholder, getToggleTitle(false, false, false, false, false, true) ?? '');
      placeholder.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleStatusSet(item.nodeId, 'completed', contextCycleId);
      });
    } else {
      this.renderLeafToggle(headerEl, data, displayStatus, contextCycleId);
    }

    // 类型标签
    headerEl.createEl('span', {
      cls: `duplicant-node-type-label duplicant-type-${data.type}`,
      text: NODE_TYPE_LABELS[data.type as NodeType] ?? data.type,
    });

    // 名称
    headerEl.createEl('span', { cls: 'duplicant-node-name', text: data.name });

    // 循环规则徽章（紧跟名称）
    this.appendCycleBadge(headerEl, item.nodeId, data, contextCycleId);

    // 正文预览
    const preview = this.getBodyPreview(item.nodeId);
    if (preview) {
      headerEl.createEl('span', { cls: 'duplicant-node-body-preview', text: preview });
    }

    // 状态标签
    headerEl.createEl('span', {
      cls: `duplicant-node-status ${STATUS_CLASS_MAP[displayStatus] ?? ''}`,
      text: NODE_STATUS_LABELS[displayStatus] ?? displayStatus,
    });

    // 右键菜单
    headerEl.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      this.showNodeMenu(e, item.nodeId, data, contextCycleId);
    });
  }

  // ============================================================
  // 引用条目树结构（用于 taskitem 层级渲染）
  // ============================================================

  // 树节点类型（类内部使用）
  // { item: ExecRefItem; children: ... }

  /**
   * 从扁平 ExecRefItem 列表构建树结构
   */
  private buildRefItemTree(items: ExecRefItem[]): RefItemTreeNode[] {
    const nodeMap = new Map<string, RefItemTreeNode>();
    for (const item of items) {
      nodeMap.set(item.nodeId, { item, children: [] });
    }

    const roots: RefItemTreeNode[] = [];

    for (const item of items) {
      const node = nodeMap.get(item.nodeId)!;
      const raw = item.data as any;
      let parentId: string | null = null;

      if ( 'source' in raw && typeof raw.source === 'string') {
        parentId = raw.source.replace(/^\[\[(.+)\]\]$/, '$1');
      }

      if (parentId && nodeMap.has(parentId)) {
        nodeMap.get(parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  /**
   * 渲染引用条目树节点（递归）
   *
   * 状态显示统一使用 effectiveStatus：
   *   - 联合节点（list/rite/event）：来自 Cycle.periodStates 的周期状态
   *   - 链路节点（taskitem）：节点自身 status（effectiveStatus = data.status）
   */
  private renderRefItemTreeNode(parent: HTMLElement, node: RefItemTreeNode, depth: number, contextCycleId?: string): void {
    const item = node.item;
    const data = item.data;
    const hasChildren = node.children.length > 0;
    // 统一使用 effectiveStatus：联合节点取周期状态，链路节点取自身 status
    const displayStatus = item.effectiveStatus;
    const isCompleted = displayStatus === 'completed' || displayStatus === 'done';
    const isAbandoned = displayStatus === 'giveup' || displayStatus === 'cancelled';
    const isActive = ACTIVE_STATUSES.has(displayStatus);
    const isSuspended = displayStatus === 'paused';
    const isTerminal = isCompleted || isAbandoned;

    const nodeEl = parent.createEl('div', {
      cls: `duplicant-node ${isCompleted ? 'completed' : ''} ${isAbandoned ? 'abandoned' : ''}`.trim(),
      attr: { 'data-node-id': item.nodeId },
    });

    const headerEl = nodeEl.createEl('div', { cls: 'duplicant-node-header' });

    if (hasChildren) {
      const isCollapsedByDefault = isTerminal;
      const toggle = headerEl.createEl('span', { cls: 'duplicant-node-toggle' });
      const svg = pickToggleSvg(true, !isCollapsedByDefault, isAbandoned, isCompleted, false, false);
      toggle.innerHTML = `<span class="toggle-svg">${svg}</span>`;
      const title = getToggleTitle(true, !isCollapsedByDefault, isCompleted, isAbandoned, false, false);
      if (title) setTooltip(toggle, title);

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
      this.renderLeafToggle(headerEl, data, undefined, contextCycleId);
    }

    // 类型标签
    headerEl.createEl('span', {
      cls: `duplicant-node-type-label duplicant-type-${data.type}`,
      text: NODE_TYPE_LABELS[data.type as NodeType] ?? data.type,
    });

    // 名称
    headerEl.createEl('span', { cls: 'duplicant-node-name', text: data.name });

    // 循环规则徽章（紧跟名称）
    this.appendCycleBadge(headerEl, item.nodeId, data, contextCycleId);

    // 正文预览
    const preview = this.getBodyPreview(item.nodeId);
    if (preview) {
      headerEl.createEl('span', { cls: 'duplicant-node-body-preview', text: preview });
    }

    // 状态标签（使用 effectiveStatus：联合节点取周期状态，链路节点取自身 status）
    headerEl.createEl('span', {
      cls: `duplicant-node-status ${STATUS_CLASS_MAP[displayStatus] ?? ''}`,
      text: NODE_STATUS_LABELS[displayStatus] ?? displayStatus,
    });

    // 右键菜单
    headerEl.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      this.showNodeMenu(e, item.nodeId, data, contextCycleId);
    });

    // 左键点击
    headerEl.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.duplicant-node-toggle, .duplicant-node-toggle-placeholder')) return;
      e.stopPropagation();
      this.promptEditBody(item.nodeId, data);
    });

    // 子节点容器
    if (hasChildren) {
      const childContainer = nodeEl.createEl('div', {
        cls: `duplicant-node-children ${isTerminal ? 'collapsed' : ''}`.trim(),
      });
      for (const child of node.children) {
        this.renderRefItemTreeNode(childContainer, child, depth + 1, contextCycleId);
      }
    }
  }

  // ============================================================
  // 归档区域
  // ============================================================

  private renderArchiveSection(parent: HTMLElement, terminalItems: ExecRefItem[]): void {
    if (terminalItems.length === 0) return;

    const wrapper = parent.createEl('div', { cls: 'duplicant-exec-terminal-wrapper' });
    const header = wrapper.createEl('div', { cls: 'duplicant-exec-terminal-header' });
    const toggle = header.createEl('span', { cls: 'duplicant-node-toggle collapsed' });
    toggle.innerHTML = `<span class="toggle-svg">${pickToggleSvg(true, false, false, false, false, false)}</span>`;
    header.createEl('span', {
      cls: 'duplicant-exec-terminal-label',
      text: `已完成（${terminalItems.length}）`,
    });

    const body = wrapper.createEl('div', { cls: 'duplicant-exec-terminal-body collapsed' });

    // 渲染归档条目
    for (const item of terminalItems) {
      this.renderRefItemRow(body, item, false);
    }

    header.addEventListener('click', () => {
      const isHidden = body.classList.toggle('collapsed');
      const nowExpanded = !isHidden;
      toggle.innerHTML = `<span class="toggle-svg">${pickToggleSvg(true, nowExpanded, false, false, false, false)}</span>`;
    });
  }

  // ============================================================
  // 叶子节点 toggle 渲染
  // ============================================================

  /**
   * 渲染叶子节点的 toggle 占位符（SVG 图标）
   *
   * @param headerEl 头部元素
   * @param data 节点数据
   * @param overrideStatus 可选的状态覆盖（用于 effectiveStatus 渲染）
   */
  private renderLeafToggle(headerEl: HTMLElement, data: AnyNode, overrideStatus?: string, contextCycleId?: string): void {
    const status = overrideStatus ?? data.status;
    const isCompleted = status === 'completed' || status === 'done';
    const isAbandoned = status === 'giveup' || status === 'cancelled';
    const isActive = ACTIVE_STATUSES.has(status);
    const isSuspended = status === 'paused';
    // 待执行状态的仪式/事件节点支持点击快速完成
    const isPendingClickable = status === 'pending' && (data.type === 'rite' || data.type === 'event');

    const placeholderCls = [
      'duplicant-node-toggle-placeholder',
      isCompleted ? 'is-completed' : '',
      isAbandoned ? 'is-abandoned' : '',
      isSuspended ? 'is-suspended' : '',
      isActive ? 'is-active' : '',
      isPendingClickable ? 'is-pending-clickable' : '',
    ].filter(Boolean).join(' ');
    const placeholder = headerEl.createEl('span', { cls: placeholderCls });
    const svg = pickToggleSvg(false, false, isAbandoned, isCompleted, isActive, isSuspended);
    placeholder.innerHTML = `<span class="toggle-svg">${svg}</span>`;
    const title = getToggleTitle(false, false, isCompleted, isAbandoned, isSuspended, isActive);
    if (title) setTooltip(placeholder, title);
    else if (isPendingClickable) setTooltip(placeholder, '点击标记完成');

    // 活跃叶子节点可点击快速完成
    if (isActive) {
      placeholder.addEventListener('click', (e) => {
        e.stopPropagation();
        const nodeEl = placeholder.closest('.duplicant-node');
        const nodeId = nodeEl?.getAttribute('data-node-id');
        if (nodeId) {
          this.handleStatusSet(nodeId, 'completed', contextCycleId);
        }
      });
    }

    // 待执行的仪式/事件节点可点击快速标记完成
    if (isPendingClickable) {
      placeholder.addEventListener('click', (e) => {
        e.stopPropagation();
        const nodeEl = placeholder.closest('.duplicant-node');
        const nodeId = nodeEl?.getAttribute('data-node-id');
        if (nodeId) {
          // 事件用 'done'，仪式用 'completed'
          const targetStatus = data.type === 'event' ? 'done' : 'completed';
          this.handleStatusSet(nodeId, targetStatus, contextCycleId);
        }
      });
    }
  }

  // ============================================================
  // 右键菜单
  // ============================================================

  private showNodeMenu(e: MouseEvent, nodeId: string, data: AnyNode, contextCycleId?: string): void {
    const menu = new Menu();

    const STATUS_ICONS: Record<string, string> = {
      pending: 'circle',
      doing: 'circle-dot',
      progress: 'circle-dot',
      paused: 'pause',
      completed: 'check-circle',
      done: 'check-circle',
      giveup: 'x-circle',
      cancelled: 'x-circle',
    };

    // 更改状态子菜单
    menu.addItem((item) => {
      item.setTitle('更改状态').setIcon('circle-dot');
      const submenu = (item as any).setSubmenu?.();
      if (submenu) {
        const allStatuses = getStatusValues(data.type as NodeType);
        // 使用周期感知的有效状态判断当前状态（非 data.status）
        const effectiveStatus = contextCycleId
          ? this.nodeCache.getEffectiveStatus(nodeId, contextCycleId)
          : data.status;
        for (const s of allStatuses) {
          const isCurrent = s === effectiveStatus;
          submenu.addItem((subItem: any) => {
            subItem.setTitle(`标记为${NODE_STATUS_LABELS[s] ?? s}`);
            subItem.setIcon(STATUS_ICONS[s] ?? 'circle');
            if (isCurrent) {
              subItem.setDisabled(true);
            } else {
              subItem.onClick(() => this.handleStatusSet(nodeId, s, contextCycleId));
            }
          });
        }
      }
    });

    menu.addSeparator();

    // 编辑描述
    menu.addItem((item) => {
      item.setTitle('编辑描述').setIcon('pencil');
      item.onClick(() => this.promptEditBody(nodeId, data));
    });

    // 打开文件
    menu.addItem((item) =>
      item.setTitle('打开文件').setIcon('file-text').onClick(() => this.handleOpenFile(nodeId)),
    );

    menu.showAtMouseEvent(e);
  }

  // ============================================================
  // 操作处理
  // ============================================================

  /**
   * 设置节点状态 — 一式多份周期状态路由
   *
   * 与 ChecklistView.writeStatus() 路径 2 逻辑一致：
   *   - List/Rite/Event 属于某 Cycle → 自动初始化周期（若需要）+ updatePeriodState()
   *     不修改节点自身 status，保持初始属性不变
   *   - 其他节点 → 直接写入节点 status + 父节点终态自动传播
   */
  private handleStatusSet(nodeId: string, newStatus: string, contextCycleId?: string): void {
    const nType = this.nodeCache.getNodeType(nodeId);
    if (!nType) return;

    // ── 周期状态路由：List/Rite/Event 属于某 Cycle 时 ──
    if (isJointStatusType(nType)) {
      // 优先使用上下文周期（来自渲染时的 tracker.cycleId）
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

        // 若 Cycle 尚未初始化 periodStates，自动初始化（无论 Cycle 状态）
        if (!hasPeriod) {
          this.nodeCache.initializePeriod(owner.cycleId);
        }

        this.operationQueue.enqueue(
          () => {
            this.nodeCache.updatePeriodState(owner.cycleId, nodeId, newStatus);
            if (this.settings.stateCascade) {
              this.nodeCache.cascadePeriodList(owner.cycleId, nodeId);
            }
          },
          async () => {
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

    // ── 默认路径：直接写入节点自身 status + 链路节点级联 ──
    this.operationQueue.enqueue(
      () => {
        this.nodeCache.updateNode(nodeId, { status: newStatus });
        if (this.settings.stateCascade) {
          const cascades = this.nodeCache.cascadeChainParent(nodeId);
          for (const c of cascades) {
            this.operationQueue.enqueue(
              () => this.nodeCache.updateNode(c.nodeId, { status: c.newStatus }),
              () => this.fileManager.updateNode(c.nodeType, c.nodeId, { status: c.newStatus }),
            );
            if (c.nodeType === 'desire' && c.newStatus === 'completed') {
              const desireName = this.nodeCache.getNode(c.nodeId)?.name ?? c.nodeId;
              new Notice(`期望「${desireName}」的所有子节点已完成，已自动标记为完成`);
            }
          }
        }
      },
      async () => {
        await this.fileManager.updateNode(nType, nodeId, { status: newStatus } as Partial<AnyNode>);
      },
    );
  }

  private handleInsertEvent(): void {
    import('./components/NodeEditorModal').then(({ NodeEditorModal }) => {
      new NodeEditorModal(this.app, {
        nodeType: 'event',
        onSave: (data, body) => {
          const nid = this.genId(data.name ?? '未命名');
          const now = new Date().toISOString();
          this.operationQueue.enqueue(
            () => this.nodeCache.addNode(nid, { ...data, created: now, modified: now } as AnyNode, body),
            async () => { await this.fileManager.createNode('event', data, body, nid); },
          );
        },
      }).open();
    });
  }

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

  private handleOpenFile(nodeId: string): void {
    const nType = this.nodeCache.getNodeType(nodeId);
    if (!nType) return;
    const filePath = this.fileManager.getNodeFilePath(nType, nodeId);
    const file = this.app.vault.getFileByPath(filePath);
    if (file instanceof TFile) {
      this.app.workspace.openLinkText(filePath, '', false);
    }
  }

  private getBodyPreview(nodeId: string): string {
    const body = this.nodeCache.getNodeBody(nodeId);
    if (!body) return '';
    const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
    const cleaned = firstLine.replace(/^#+\s*/, '').replace(/[*_`~]/g, '').trim();
    return cleaned.length > 80 ? cleaned.slice(0, 80) + '…' : cleaned;
  }

  /**
   * 在节点行中追加循环规则徽章（♲ + 规则描述 + 下次触发时间）
   *
   * 对 taskitem：从节点自身 cycleRule 字段读取
   * 对 rite/event：从所属 Cycle 的 cycleRules 中读取
   */
  private appendCycleBadge(headerEl: HTMLElement, nodeId: string, data: AnyNode, contextCycleId?: string): void {
    let ruleString: string | null = null;
    let nextTrigger: string | null = null;

    if (data.type === 'taskitem') {
      const raw = data as any;
      if (raw.cycleRule && !validateCycleRule(raw.cycleRule)) {
        ruleString = raw.cycleRule;
        nextTrigger = this.computeNextTrigger(raw.cycleRule, raw.cycleRuleBase || raw.executionTime);
      }
    } else if (data.type === 'rite' || data.type === 'event') {
      // 优先使用上下文周期查找循环规则
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
        const info = this.nodeCache.getRiteCycleRuleInfo(owner.cycleId, nodeId);
        if (info) {
          ruleString = info.rule;
          nextTrigger = info.nextTrigger;
        }
      }
    }

    if (!ruleString) return;

    const badgeEl = headerEl.createEl('span', { cls: 'cycle-rule-badge' });
    badgeEl.createEl('span', { text: '♲' });
    badgeEl.createEl('span', { text: ` ${ruleString}` });

    // tooltip：真实下次触发时间
    if (nextTrigger) {
      setTooltip(badgeEl, `下次触发: ${nextTrigger}`);
    }
  }

  /**
   * 计算下次触发时间（辅助）
   */
  private computeNextTrigger(rule: string, baseTimeStr: string | undefined): string | null {
    if (!baseTimeStr || validateCycleRule(rule)) return null;
    const baseTime = window.moment(baseTimeStr, 'YYYY-MM-DD HH:mm');
    if (!baseTime.isValid()) return null;
    const trigger = getNextTriggerTime(rule, baseTime, window.moment());
    return trigger ? trigger.format('YYYY-MM-DD HH:mm') : null;
  }

  private genId(name: string): string {
    const d = new Date();
    const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}-${String(d.getMilliseconds()).padStart(3, '0')}`;
    const r = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
    return `${ts}-${r}-${name.replace(/[\\/:*?"<>|]/g, '_')}`;
  }
}
