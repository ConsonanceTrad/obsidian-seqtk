/**
 * PlanningView — 规划面板（链路节点视图）
 * 
 * V1 对齐：
 * - 粘性 header（规划 + 展开/收起全部 + 快速节点 + 链路创建 + 刷新）
 * - 过滤栏：搜索 + 类型筛选 + 状态筛选 + 复原按钮
 * - duplicant-node-header 内联渲染（替代 createNodeRow）
 * - 已归档折叠区域
 * - 右键菜单使用 Obsidian 原生 Menu API
 * DeferredView 兼容
 */

import { ItemView, WorkspaceLeaf, Menu, Modal, Setting, Notice, setTooltip, FuzzySuggestModal, type FuzzyMatch, type App } from 'obsidian';
import { VIEW_TYPE_PLANNING, VIEW_TYPE_CHECKLIST } from '../types/index';
import type { NodeType, AnyNode, PluginSettings } from '../types/index';
import { getNextStatuses, getStatusValues, NODE_TYPE_LABELS, NODE_STATUS_LABELS, ALLOWED_CHILD_TYPES } from '../types/index';
import type { NodeCache, TreeNode } from '../core/NodeCache';
import type { NodeFileManager } from '../core/NodeFileManager';
import type { OperationQueue } from '../core/OperationQueue';
import type { Unsubscriber } from '../utils/SimpleStore';
import { NodeEditorModal } from './components/NodeEditorModal';
import { DescriptionEditModal } from './components/DescriptionEditModal';
import { ConfirmModal } from './components/ConfirmModal';
import { QuickCreateModal } from './components/QuickCreateModal';
import { ChainCreateModal } from './components/ChainCreateModal';
import { CycleRuleModal } from './components/CycleRuleModal';
import { pickToggleSvg, getToggleTitle, SVG_EXPANDED, SVG_COLLAPSED, SVG_EXPANDED_ALL_DONE, SVG_COLLAPSED_ALL_DONE } from '../utils/toggleSvg';
import { updateNodeIdDisplayName } from '../utils/timestamp';
import { validateCycleRule, getNextTriggerTime } from '../utils/cycleRuleParser';

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

// ============================================================
// ParentSuggestModal — 变更归属用的模糊搜索弹窗
// ============================================================

interface ParentCandidate {
  nodeId: string;
  data: AnyNode;
}

class ParentSuggestModal extends FuzzySuggestModal<ParentCandidate> {
  private items: ParentCandidate[];
  private onSelect: (item: ParentCandidate) => void;

  constructor(app: App, items: ParentCandidate[], onSelect: (item: ParentCandidate) => void) {
    super(app);
    this.items = items;
    this.onSelect = onSelect;
  }

  getItems(): ParentCandidate[] {
    return this.items;
  }

  getItemText(item: ParentCandidate): string {
    return item.data.name;
  }

  renderSuggestion(item: FuzzyMatch<ParentCandidate>, el: HTMLElement): void {
    el.createEl('span', { cls: 'duplicant-node-name', text: item.item.data.name });
  }

  onChooseSuggestion(item: FuzzyMatch<ParentCandidate>): void {
    this.onSelect(item.item);
  }
}

// ============================================================
// PlanningView
// ============================================================

export class PlanningView extends ItemView {
  private nodeCache: NodeCache;
  private fileManager: NodeFileManager;
  private operationQueue: OperationQueue;
  private settings: PluginSettings;
  private unsubscribers: Unsubscriber[] = [];

  // 面板状态
  private expandedNodes = new Set<string>();
  private searchQuery = '';
  private typeFilter = 'all';
  private statusFilter = 'all';
  private allExpanded = true;

  // DOM 引用
  private searchInput!: HTMLInputElement;
  private typeSelect!: HTMLSelectElement;
  private statusSelect!: HTMLSelectElement;
  private treeContainer!: HTMLDivElement;
  private toggleAllBtn!: HTMLButtonElement;

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
    this.allExpanded = settings.planningDefaultExpand;
  }

  getViewType(): string { return VIEW_TYPE_PLANNING; }
  getDisplayText(): string { return '设计'; }
  getIcon(): string { return 'compass'; }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('duplicant-planning-view');

    // ── V1 粘性标题栏 ──
    const header = container.createEl('div', { cls: 'duplicant-view-header' });

    const headerLeft = header.createEl('div', { cls: 'duplicant-header-left' });
    const tabPlanning = headerLeft.createEl('span', { cls: 'duplicant-view-tab duplicant-view-tab-active', text: '规划' });
    const tabChecklist = headerLeft.createEl('span', { cls: 'duplicant-view-tab', text: '清单' });
    tabPlanning.addEventListener('click', () => {
      this.leaf.setViewState({ type: VIEW_TYPE_PLANNING });
    });
    tabChecklist.addEventListener('click', () => {
      this.leaf.setViewState({ type: VIEW_TYPE_CHECKLIST });
    });

    const headerBtns = header.createEl('div', { cls: 'duplicant-header-btns' });

    // 展开/收起全部
    this.toggleAllBtn = headerBtns.createEl('button', {
      cls: 'duplicant-btn duplicant-btn-icon duplicant-btn-toggle-all',
      attr: { 'aria-label': this.allExpanded ? '收起全部' : '展开全部' },
    });
    this.toggleAllBtn.innerHTML = this.allExpanded
      ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    this.toggleAllBtn.addEventListener('click', () => this.handleToggleAll());

    // 新建期望
    const btnQuick = headerBtns.createEl('button', {
      cls: 'duplicant-btn duplicant-btn-icon',
      attr: { 'aria-label': '新建期望' },
    });
    btnQuick.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 3V13M3 8H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    btnQuick.addEventListener('click', () => this.handleQuickCreate());

    // 链路创建
    const btnChain = headerBtns.createEl('button', {
      cls: 'duplicant-btn duplicant-btn-icon',
      attr: { 'aria-label': '链路创建' },
    });
    btnChain.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    btnChain.addEventListener('click', () => this.handleChainCreate());

    // 刷新
    const btnRefresh = headerBtns.createEl('button', {
      cls: 'duplicant-btn duplicant-btn-icon',
      attr: { 'aria-label': '刷新' },
    });
    btnRefresh.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 8C2.5 4.96 4.96 2.5 8 2.5C10.21 2.5 12.11 3.95 12.84 5.5M13.5 8C13.5 11.04 11.04 13.5 8 13.5C5.79 13.5 3.89 12.05 3.16 10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M12 5.5H13.5V4M4 10.5H2.5V12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    btnRefresh.addEventListener('click', () => this.handleRefresh());

    // ── 过滤栏 ──
    const filterBar = container.createEl('div', { cls: 'duplicant-filter-bar' });

    // 搜索框
    this.searchInput = filterBar.createEl('input', {
      cls: 'duplicant-filter-search',
      attr: { type: 'text', placeholder: '搜索节点名称...' },
    });
    
    // 类型筛选
    this.typeSelect = filterBar.createEl('select', { cls: 'duplicant-filter-select' });
    this.typeSelect.createEl('option', { value: 'all', text: '所有类型' });
    this.typeSelect.createEl('option', { value: 'desire', text: '期望' });
    this.typeSelect.createEl('option', { value: 'direct', text: '方向' });
    this.typeSelect.createEl('option', { value: 'instruction', text: '指令' });
    this.typeSelect.createEl('option', { value: 'taskchain', text: '目标' });
    this.typeSelect.createEl('option', { value: 'taskitem', text: '任务项' });
    this.typeSelect.addEventListener('change', () => {
      this.typeFilter = this.typeSelect.value;
      // 期望、方向无状态概念，锁定状态为所有状态
      const lockStatus = this.typeFilter === 'desire' || this.typeFilter === 'direct';
      this.statusSelect.value = 'all';
      this.statusFilter = 'all';
      this.statusSelect.disabled = lockStatus;
      this.applyFilters();
    });

    // 状态筛选
    this.statusSelect = filterBar.createEl('select', { cls: 'duplicant-filter-select' });
    this.statusSelect.createEl('option', { value: 'all', text: '所有状态' });
    this.statusSelect.createEl('option', { value: 'pending', text: '待处理' });
    this.statusSelect.createEl('option', { value: 'doing', text: '进行中' });
    this.statusSelect.createEl('option', { value: 'paused', text: '已暂停' });
    this.statusSelect.createEl('option', { value: 'completed', text: '已完成' });
    this.statusSelect.createEl('option', { value: 'giveup', text: '已放弃' });
    this.statusSelect.addEventListener('change', () => {
      this.statusFilter = this.statusSelect.value;
      this.applyFilters();
    });

    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value.trim().toLowerCase();
      this.applyFilters();
    });

    // ── 树形容器 ──
    this.treeContainer = container.createEl('div', { cls: 'duplicant-tree' });

    // 订阅 desireTree
    const unsub = this.nodeCache.desireTree.subscribe((treeNodes) => {
      this.renderTree(treeNodes);
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

  private renderTree(treeNodes: TreeNode[]): void {
    this.treeContainer.empty();

    if (treeNodes.length === 0) {
      const empty = this.treeContainer.createEl('div', { cls: 'duplicant-empty-state' });
      empty.createEl('p', { text: '暂无期望节点' });
      const btn = empty.createEl('button', { cls: 'duplicant-btn duplicant-btn-primary', text: '创建第一个期望' });
      btn.addEventListener('click', () => this.handleNewDesire());
      return;
    }

    // 分离活跃和已归档节点
    const activeNodes: TreeNode[] = [];
    const archivedNodes: TreeNode[] = [];

    for (const node of treeNodes) {
      if (this.isArchived(node)) {
        archivedNodes.push(node);
      } else {
        activeNodes.push(node);
      }
    }

    // 渲染活跃节点
    for (const node of activeNodes) {
      this.renderNode(this.treeContainer, node, 0);
    }

    // 渲染已归档折叠区域
    if (archivedNodes.length > 0) {
      const terminalWrapper = this.treeContainer.createEl('div', { cls: 'duplicant-exec-terminal-wrapper' });
      const terminalHeader = terminalWrapper.createEl('div', { cls: 'duplicant-exec-terminal-header' });
      const terminalToggle = terminalHeader.createEl('span', { cls: 'duplicant-node-toggle' });
      terminalToggle.innerHTML = `<span class="toggle-svg">${SVG_COLLAPSED_ALL_DONE}</span>`;
      setTooltip(terminalToggle, '点击展开');
      terminalHeader.createEl('span', {
        cls: 'duplicant-exec-terminal-label',
        text: `已完成（${archivedNodes.length}）`,
      });
      const terminalBody = terminalWrapper.createEl('div', { cls: 'duplicant-exec-terminal-body collapsed' });

      for (const node of archivedNodes) {
        this.renderNode(terminalBody, node, 0);
      }

      terminalHeader.addEventListener('click', () => {
        const isHidden = terminalBody.classList.toggle('collapsed');
        terminalToggle.innerHTML = `<span class="toggle-svg">${isHidden ? SVG_COLLAPSED_ALL_DONE : SVG_EXPANDED}</span>`;
        setTooltip(terminalToggle, isHidden ? '点击展开' : '点击折叠');
      });
    }

    // 应用当前过滤
    this.applyFilters();
  }

  /**
   * 递归渲染树节点为 V1 duplicant-node-header 结构
   */
  private renderNode(parent: HTMLElement, treeNode: TreeNode, depth: number): void {
    const data = treeNode.data;
    const hasChildren = treeNode.children.length > 0;
    const isCompleted = data.status === 'completed';
    const isAbandoned = data.status === 'giveup';
    const isTerminal = isCompleted || isAbandoned;
    const isPaused = data.status === 'paused';

    // 节点容器
    const nodeEl = parent.createEl('div', {
      cls: `duplicant-node ${isCompleted ? 'completed' : ''} ${isAbandoned ? 'abandoned' : ''} ${isPaused ? 'paused' : ''}`.trim(),
    });

    // 添加 data 属性用于 DOM 级过滤
    nodeEl.setAttribute('data-node-id', treeNode.nodeId);
    nodeEl.setAttribute('data-node-name', (data.name ?? treeNode.nodeId).toLowerCase());
    nodeEl.setAttribute('data-node-type', data.type ?? 'unknown');
    nodeEl.setAttribute('data-node-status', data.status ?? 'pending');
    nodeEl.setAttribute('data-node-depth', String(depth));

    // 行容器
    const headerEl = nodeEl.createEl('div', { cls: 'duplicant-node-header' });

    if (hasChildren) {
      // 有子节点：toggle 圆圈 — 使用 SVG 图标渲染
      // 已暂停、已完成、已放弃的父节点默认收起
      const isCollapsedByDefault = this.settings.planningDefaultExpand ? (isTerminal || isPaused) : true;
      if (!isCollapsedByDefault) this.expandedNodes.add(treeNode.nodeId);

      const toggle = headerEl.createEl('span', {
        cls: 'duplicant-node-toggle',
      });
      const svg = pickToggleSvg(true, !isCollapsedByDefault, isAbandoned, isCompleted, false, false);
      toggle.innerHTML = `<span class="toggle-svg">${svg}</span>`;
      const title = getToggleTitle(true, !isCollapsedByDefault, isCompleted, isAbandoned, false, false);
      if (title) setTooltip(toggle, title);

      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const childContainer = nodeEl.querySelector('.duplicant-node-children') as HTMLElement;
        if (childContainer) {
          const isHidden = childContainer.classList.toggle('collapsed');
          // 更新 SVG 图标
          const nowExpanded = !isHidden;
          const newSvg = pickToggleSvg(true, nowExpanded, isAbandoned, isCompleted, false, false);
          toggle.innerHTML = `<span class="toggle-svg">${newSvg}</span>`;
          const newTitle = getToggleTitle(true, nowExpanded, isCompleted, isAbandoned, false, false);
          setTooltip(toggle, newTitle ?? '');
          if (isHidden) {
            this.expandedNodes.delete(treeNode.nodeId);
          } else {
            this.expandedNodes.add(treeNode.nodeId);
            // 惰性渲染：首次展开时才渲染子节点
            if (childContainer.children.length === 0) {
              for (const child of treeNode.children) {
                this.renderNode(childContainer, child, depth + 1);
              }
            }
          }
        }
      });
    } else {
      // 叶子节点：toggle 占位符 — 使用 SVG 图标渲染
      const isActive = data.status === 'doing';
      const isSuspended = data.status === 'paused';
      const placeholderCls = [
        'duplicant-node-toggle-placeholder',
        isCompleted ? 'is-completed' : '',
        isAbandoned ? 'is-abandoned' : '',
        isSuspended ? 'is-suspended' : '',
        isActive ? 'is-active' : '',
      ].filter(Boolean).join(' ');
      const placeholder = headerEl.createEl('span', { cls: placeholderCls });
      const svg = pickToggleSvg(false, false, isAbandoned, isCompleted, isActive, isSuspended);
      placeholder.innerHTML = `<span class="toggle-svg">${svg}</span>`;
      const title = getToggleTitle(false, false, isCompleted, isAbandoned, isSuspended, isActive);
      if (title) setTooltip(placeholder, title);

      // 非终态叶子节点（排除 desire/direct 无状态类型）：点击 toggle 快速变为已完成
      const noStatus = data.type === 'desire' || data.type === 'direct';
      if (!noStatus && !isTerminal) {
        placeholder.classList.add('duplicant-node-toggle-clickable');
        setTooltip(placeholder, '点击标记为已完成');
        placeholder.addEventListener('click', (e) => {
          e.stopPropagation();
          this.handleStatusSet(treeNode.nodeId, 'completed');
        });
      }
    }

    // 类型标签
    headerEl.createEl('span', {
      cls: `duplicant-node-type-label duplicant-type-${data.type}`,
      text: NODE_TYPE_LABELS[data.type as NodeType] ?? data.type,
    });

    // 名称
    headerEl.createEl('span', { cls: 'duplicant-node-name', text: data.name });

    // 循环规则徽章（紧跟名称）
    this.appendCycleBadge(headerEl, treeNode.nodeId, data);

    // 正文预览
    const preview = this.getBodyPreview(treeNode.nodeId);
    if (preview) {
      headerEl.createEl('span', { cls: 'duplicant-node-body-preview', text: preview });
    }

    // 状态标签（纯展示，不可点击；待处理不渲染；期望/方向不渲染）
    if (data.status && data.status !== 'pending' && data.type !== 'desire' && data.type !== 'direct') {
      headerEl.createEl('span', {
        cls: `duplicant-node-status ${STATUS_CLASS_MAP[data.status] ?? ''}`,
        text: NODE_STATUS_LABELS[data.status] ?? data.status,
      });
    }

    // 右键菜单
    headerEl.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      this.showNodeMenu(e, treeNode);
    });

    // 左键点击行为（可配置：编辑描述 或 展开/折叠）
    headerEl.addEventListener('click', (e: MouseEvent) => {
      // 避免 toggle 按钮的点击事件冒泡
      if ((e.target as HTMLElement).closest('.duplicant-node-toggle, .duplicant-node-toggle-placeholder')) return;
      e.stopPropagation();

      if (this.settings.planningClickAction === 'toggle' && hasChildren) {
        // 展开/折叠模式：切换子节点容器的收起状态
        const childContainer = nodeEl.querySelector('.duplicant-node-children') as HTMLElement;
        const toggle = headerEl.querySelector('.duplicant-node-toggle') as HTMLElement;
        if (childContainer && toggle) {
          const isHidden = childContainer.classList.toggle('collapsed');
          const nowExpanded = !isHidden;
          const newSvg = pickToggleSvg(true, nowExpanded, isAbandoned, isCompleted, false, false);
          toggle.innerHTML = `<span class="toggle-svg">${newSvg}</span>`;
          const newTitle = getToggleTitle(true, nowExpanded, isCompleted, isAbandoned, false, false);
          setTooltip(toggle, newTitle ?? '');
          if (isHidden) this.expandedNodes.delete(treeNode.nodeId);
          else this.expandedNodes.add(treeNode.nodeId);
        }
      } else {
        // 编辑描述模式（默认）
        this.promptEditBody(treeNode.nodeId, data);
      }
    });

    // 子节点容器
    if (hasChildren) {
      const childCollapsedByDefault = this.settings.planningDefaultExpand ? (isTerminal || isPaused) : true;
      const childContainer = nodeEl.createEl('div', {
        cls: `duplicant-node-children ${childCollapsedByDefault ? 'collapsed' : ''}`.trim(),
      });
      if (!childCollapsedByDefault) {
        for (const child of treeNode.children) {
          this.renderNode(childContainer, child, depth + 1);
        }
      }
    }
  }

  // ============================================================
  // DOM 级过滤
  // ============================================================

  private applyFilters(): void {
    const treeEl = this.treeContainer;
    if (!treeEl) return;

    const hasSearch = !!this.searchQuery;
    const hasType = this.typeFilter !== 'all';
    const hasStatus = this.statusFilter !== 'all';
    const hasAnyFilter = hasSearch || hasType || hasStatus;

    // 获取所有节点行
    const allNodes = treeEl.querySelectorAll('.duplicant-node');

    if (!hasAnyFilter) {
      // 无过滤：显示所有节点，清除高亮
      allNodes.forEach(el => {
        const htmlEl = el as HTMLElement;
        htmlEl.style.display = '';
        htmlEl.classList.remove('duplicant-search-match');
      });
      // 恢复已归档区域显示
      const terminalWrapper = treeEl.querySelector('.duplicant-exec-terminal-wrapper') as HTMLElement;
      if (terminalWrapper) terminalWrapper.style.display = '';
      return;
    }

    // 第一步：标记直接匹配的节点（排除已归档区域）
    const terminalBody = treeEl.querySelector('.duplicant-exec-terminal-body') as HTMLElement;
    const matchedIds = new Set<string>();
    allNodes.forEach(el => {
      const htmlEl = el as HTMLElement;
      // 跳过已归档区域内的节点
      if (terminalBody && terminalBody.contains(htmlEl)) return;

      const name = htmlEl.getAttribute('data-node-name') ?? '';
      const type = htmlEl.getAttribute('data-node-type') ?? '';
      const status = htmlEl.getAttribute('data-node-status') ?? '';

      let match = true;
      if (hasSearch && !name.includes(this.searchQuery)) match = false;
      if (hasType && type !== this.typeFilter) match = false;
      if (hasStatus && status !== this.statusFilter) match = false;

      if (match) {
        matchedIds.add(htmlEl.getAttribute('data-node-id') ?? '');
      }
    });

    // 第二步：构建可见集（匹配节点 + 祖先路径），同时展开祖先
    const visibleIds = new Set<string>(matchedIds);

    // 对每个匹配节点，向上遍历添加祖先并展开
    allNodes.forEach(el => {
      const htmlEl = el as HTMLElement;
      const nodeId = htmlEl.getAttribute('data-node-id') ?? '';
      if (!matchedIds.has(nodeId)) return;

      let parent = htmlEl.parentElement;
      while (parent && parent !== treeEl) {
        if (parent.classList.contains('duplicant-node')) {
          const parentNodeId = parent.getAttribute('data-node-id') ?? '';
          visibleIds.add(parentNodeId);
          // 展开祖先节点的子容器
          const childContainer = parent.querySelector(':scope > .duplicant-node-children') as HTMLElement;
          if (childContainer) {
            childContainer.classList.remove('collapsed');
            const toggle = parent.querySelector(':scope > .duplicant-node-header .duplicant-node-toggle') as HTMLElement;
            if (toggle) {
              toggle.innerHTML = `<span class="toggle-svg">${SVG_EXPANDED}</span>`;
              setTooltip(toggle, '点击折叠');
            }
          }
        }
        parent = parent.parentElement;
      }
    });

    // 第三步：应用显隐 + 高亮 + 滚动
    let lastMatchEl: HTMLElement | null = null;
    allNodes.forEach(el => {
      const htmlEl = el as HTMLElement;
      const nodeId = htmlEl.getAttribute('data-node-id') ?? '';
      if (visibleIds.has(nodeId)) {
        htmlEl.style.display = '';
        if (matchedIds.has(nodeId)) {
          htmlEl.classList.add('duplicant-search-match');
          lastMatchEl = htmlEl; // 持续更新，最终保留最深匹配
        } else {
          htmlEl.classList.remove('duplicant-search-match');
        }
      } else {
        htmlEl.style.display = 'none';
        htmlEl.classList.remove('duplicant-search-match');
      }
    });

    // 滚动到最深的匹配节点
    if (lastMatchEl) {
      lastMatchEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // 已归档区域：有过滤条件时强制隐藏
    if (terminalBody) {
      const terminalWrapper = terminalBody.closest('.duplicant-exec-terminal-wrapper') as HTMLElement;
      if (terminalWrapper) {
        if (hasAnyFilter) {
          // 有过滤条件时，隐藏整个已归档区域
          terminalWrapper.style.display = 'none';
        } else {
          // 无过滤条件时，保持原样
          terminalWrapper.style.display = '';
        }
      }
    }
  }

  // ============================================================
  // 数据辅助
  // ============================================================

  private isArchived(node: TreeNode): boolean {
    const terminalStatuses = new Set(['completed', 'giveup']);
    if (node.data.type === 'desire' || node.data.type === 'direct') {
      // 检查所有子孙 taskitem 是否都是终态
      const taskItems = this.collectDescendantTaskItems(node);
      if (taskItems.length === 0) return false;
      return taskItems.every(n => terminalStatuses.has(n.data.status));
    }
    return terminalStatuses.has(node.data.status);
  }

  private collectDescendantTaskItems(node: TreeNode): TreeNode[] {
    const result: TreeNode[] = [];
    const collect = (n: TreeNode) => {
      for (const child of n.children) {
        if (child.data.type === 'taskitem') result.push(child);
        collect(child);
      }
    };
    collect(node);
    return result;
  }

  private getBodyPreview(nodeId: string): string {
    const body = this.nodeCache.getNodeBody(nodeId);
    if (!body) return '';
    // 对齐旧版 v1：显示完整正文，由 CSS 控制截断显示
    return body;
  }

  /**
   * 在节点行中追加循环规则徽章（♲ + 下次触发时间）
   *
   * 对 taskitem：从节点自身 cycleRule 字段读取
   * 对 rite/event：从所属 Cycle 的 cycleRules 中读取
   */
  private appendCycleBadge(headerEl: HTMLElement, nodeId: string, data: AnyNode): void {
    let ruleString: string | null = null;
    let nextTrigger: string | null = null;

    if (data.type === 'taskitem') {
      const raw = data as any;
      if (raw.cycleRule && !validateCycleRule(raw.cycleRule)) {
        ruleString = raw.cycleRule;
        const baseTimeStr = raw.cycleRuleBase || raw.executionTime;
        if (baseTimeStr) {
          const baseTime = window.moment(baseTimeStr, 'YYYY-MM-DD HH:mm');
          if (baseTime.isValid()) {
            const trigger = getNextTriggerTime(raw.cycleRule, baseTime, window.moment());
            if (trigger) nextTrigger = trigger.format('YYYY-MM-DD HH:mm');
          }
        }
      }
    } else if (data.type === 'rite' || data.type === 'event') {
      const owner = this.nodeCache.findOwningCycle(nodeId);
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

  // ============================================================
  // 展开/收起全部
  // ============================================================

  private handleToggleAll(): void {
    this.allExpanded = !this.allExpanded;
    // 更新按钮图标（旋转箭头表示方向）
    this.toggleAllBtn.innerHTML = this.allExpanded
      ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    this.toggleAllBtn.setAttribute('aria-label', this.allExpanded ? '收起全部' : '展开全部');

    const treeEl = this.treeContainer;
    if (!treeEl) return;

    const children = treeEl.querySelectorAll('.duplicant-node-children');
    children.forEach(child => {
      const htmlChild = child as HTMLElement;
      // 跳过已归档区域
      if (htmlChild.closest('.duplicant-exec-terminal-body')) return;
      if (this.allExpanded) {
        htmlChild.classList.remove('collapsed');
      } else {
        htmlChild.classList.add('collapsed');
      }
    });

    const toggles = treeEl.querySelectorAll('.duplicant-node-toggle');
    toggles.forEach(toggle => {
      const htmlToggle = toggle as HTMLElement;
      if (htmlToggle.closest('.duplicant-exec-terminal-body')) return;
      if (htmlToggle.closest('.duplicant-exec-terminal-header')) return;
      // 根据节点状态选择正确的图标
      const nodeEl = htmlToggle.closest('.duplicant-node') as HTMLElement | null;
      const status = nodeEl?.getAttribute('data-node-status') ?? '';
      const isTerminal = status === 'completed' || status === 'giveup';
      let newSvg: string;
      let title: string;
      if (this.allExpanded) {
        newSvg = isTerminal ? SVG_EXPANDED_ALL_DONE : SVG_EXPANDED;
        title = isTerminal
          ? (status === 'giveup' ? '已放弃（展开）' : '已完成（展开）')
          : '点击折叠';
      } else {
        newSvg = isTerminal ? SVG_COLLAPSED_ALL_DONE : SVG_COLLAPSED;
        title = isTerminal
          ? (status === 'giveup' ? '已放弃（折叠）' : '已完成（折叠）')
          : '点击展开';
      }
      htmlToggle.innerHTML = `<span class="toggle-svg">${newSvg}</span>`;
      setTooltip(htmlToggle, title);
    });
  }

  /**
   * 递归展开指定节点下的所有子节点层级
   *
   * 从 DOM 中找到目标节点，遍历其所有后代 `.duplicant-node-children`，
   * 移除 `collapsed` 类以展开，并同步更新 `expandedNodes` 集合与 toggle 图标。
   *
   * @param nodeId 要展开的根节点 ID
   */
  private handleExpandDescendants(nodeId: string): void {
    const treeEl = this.treeContainer;
    if (!treeEl) return;

    // 找到目标节点的 DOM 元素
    const rootNodeEl = treeEl.querySelector(`[data-node-id="${nodeId}"]`) as HTMLElement | null;
    if (!rootNodeEl) return;

    // 展开所有后代子节点容器
    const childContainers = rootNodeEl.querySelectorAll('.duplicant-node-children');
    childContainers.forEach(container => {
      const htmlContainer = container as HTMLElement;
      htmlContainer.classList.remove('collapsed');
      // 从容器的父节点（.duplicant-node）获取 nodeId，加入 expandedNodes
      const parentNode = htmlContainer.closest('.duplicant-node') as HTMLElement | null;
      if (parentNode) {
        const pid = parentNode.getAttribute('data-node-id');
        if (pid) this.expandedNodes.add(pid);
      }
    });

    // 同步更新所有后代 toggle 图标为展开状态
    const toggles = rootNodeEl.querySelectorAll('.duplicant-node-toggle');
    toggles.forEach(toggle => {
      const htmlToggle = toggle as HTMLElement;
      const nodeEl = htmlToggle.closest('.duplicant-node') as HTMLElement | null;
      const status = nodeEl?.getAttribute('data-node-status') ?? '';
      const isTerminal = status === 'completed' || status === 'giveup';
      const newSvg = isTerminal ? SVG_EXPANDED_ALL_DONE : SVG_EXPANDED;
      htmlToggle.innerHTML = `<span class="toggle-svg">${newSvg}</span>`;
      const title = isTerminal
        ? (status === 'giveup' ? '已放弃（展开）' : '已完成（展开）')
        : '点击折叠';
      setTooltip(htmlToggle, title);
    });
  }

  /**
   * 递归收起指定节点下的所有子节点层级
   *
   * 从 DOM 中找到目标节点，遍历其所有后代 `.duplicant-node-children`，
   * 添加 `collapsed` 类以收起，并同步更新 `expandedNodes` 集合与 toggle 图标。
   *
   * @param nodeId 要收起的根节点 ID
   */
  private handleCollapseDescendants(nodeId: string): void {
    const treeEl = this.treeContainer;
    if (!treeEl) return;

    // 找到目标节点的 DOM 元素
    const rootNodeEl = treeEl.querySelector(`[data-node-id="${nodeId}"]`) as HTMLElement | null;
    if (!rootNodeEl) return;

    // 收起所有后代子节点容器
    const childContainers = rootNodeEl.querySelectorAll('.duplicant-node-children');
    childContainers.forEach(container => {
      const htmlContainer = container as HTMLElement;
      htmlContainer.classList.add('collapsed');
      // 从容器的父节点（.duplicant-node）获取 nodeId，从 expandedNodes 移除
      const parentNode = htmlContainer.closest('.duplicant-node') as HTMLElement | null;
      if (parentNode) {
        const pid = parentNode.getAttribute('data-node-id');
        if (pid) this.expandedNodes.delete(pid);
      }
    });

    // 同步更新所有后代 toggle 图标为收起状态
    const toggles = rootNodeEl.querySelectorAll('.duplicant-node-toggle');
    toggles.forEach(toggle => {
      const htmlToggle = toggle as HTMLElement;
      const nodeEl = htmlToggle.closest('.duplicant-node') as HTMLElement | null;
      const status = nodeEl?.getAttribute('data-node-status') ?? '';
      const isTerminal = status === 'completed' || status === 'giveup';
      const newSvg = isTerminal ? SVG_COLLAPSED_ALL_DONE : SVG_COLLAPSED;
      htmlToggle.innerHTML = `<span class="toggle-svg">${newSvg}</span>`;
      const title = isTerminal
        ? (status === 'giveup' ? '已放弃（折叠）' : '已完成（折叠）')
        : '点击展开';
      setTooltip(htmlToggle, title);
    });
  }

  // ============================================================
  // 快速节点 / 链路创建 / 刷新
  // ============================================================

  private handleQuickCreate(): void {
    new QuickCreateModal(this.app, {
      nodeType: 'desire',
      onSave: (nodeType, name) => {
        const nid = this.genId(name);
        const now = new Date().toISOString();
        const noStatus = nodeType === 'desire' || nodeType === 'direct';
        const data: Partial<AnyNode> = { type: nodeType, name, created: now, modified: now } as any;
        if (!noStatus) (data as any).status = 'pending';
        this.operationQueue.enqueue(
          () => this.nodeCache.addNode(nid, data as AnyNode),
          async () => { await this.fileManager.createNode(nodeType, data, '', nid); },
        );
      },
    }).open();
  }

  private handleChainCreate(): void {
    new ChainCreateModal(this.app, {
      onConfirm: (nodes) => {
        // 按顺序创建，建立 parent 引用链
        let prevNid: string | undefined;
        const now = new Date().toISOString();

        for (const node of nodes) {
          const nid = this.genId(node.name);
          const noStatus = node.nodeType === 'desire' || node.nodeType === 'direct';
          const data: Record<string, any> = {
            type: node.nodeType,
            name: node.name,
            created: now,
            modified: now,
          };
          if (!noStatus) data.status = 'pending';
          // 建立 source 引用（direct→desire, taskchain→direct）
          if (prevNid) {
            data.source = `[[${prevNid}]]`;
          }

          const capturedNid = nid;
          const capturedType = node.nodeType;
          const capturedData = { ...data } as AnyNode;
          this.operationQueue.enqueue(
            () => this.nodeCache.addNode(capturedNid, capturedData),
            async () => { await this.fileManager.createNode(capturedType, capturedData, '', capturedNid); },
          );

          prevNid = nid;
        }
      },
    }).open();
  }

  private handleRefresh(): void {
    // 还原搜索/筛选条件
    this.searchQuery = '';
    this.typeFilter = 'all';
    this.statusFilter = 'all';
    this.searchInput.value = '';
    this.typeSelect.value = 'all';
    this.statusSelect.value = 'all';
    this.statusSelect.disabled = false;

    // 触发 desireTree 重新计算（等效于强制刷新）
    const treeNodes = this.nodeCache.desireTree.get();
    this.renderTree(treeNodes);

    new Notice('规划面板已刷新', 1000);
  }

  // ============================================================
  // 右键菜单（Obsidian Menu API）
  // ============================================================

  private showNodeMenu(e: MouseEvent, treeNode: TreeNode): void {
    const menu = new Menu();
    const nodeId = treeNode.nodeId;
    const data = treeNode.data;

    // 状态图标映射
    const STATUS_ICONS: Record<string, string> = {
      pending: 'circle', 
      doing: 'circle-dot', 
      paused: 'pause',
      completed: 'check-circle', 
      giveup: 'x-circle',
      progress: 'circle-dot', 
      done: 'check-circle', 
      cancelled: 'x-circle',
    };

    // 快速创建子节点（直接展示允许的子节点类型，图标统一使用右箭头）
    const CHILD_ACTION_LABELS: Partial<Record<NodeType, string>> = {
      desire: '演变为期望',
      metric: '选定出指标',
      direct: '延伸出方向',
      taskchain: '完善为目标',
      taskitem: '拆解为任务项',
    };
    const allowedChildren = ALLOWED_CHILD_TYPES[data.type as NodeType] ?? [];
    const parentType = data.type as NodeType;
    for (const childType of allowedChildren) {
      let label: string;
      if (childType === 'taskitem' && parentType === 'taskitem') {
        label = '拆解为子任务项';
      } else {
        label = CHILD_ACTION_LABELS[childType] ?? `新建${NODE_TYPE_LABELS[childType] ?? childType}`;
      }
      menu.addItem(item => {
        item.setTitle(label);
        item.setIcon('arrow-right');
        item.onClick(() => this.handleAddChild(nodeId, parentType, childType));
      });
    }

    // 更改状态（子菜单，展示全部状态，当前状态置灰；期望/方向不显示）
    if (data.type !== 'desire' && data.type !== 'direct') {
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
    }

    menu.addSeparator();

    // 展开/收起子项（递归操作当前节点下所有层级；仅当有子节点时显示）
    if (treeNode.children.length > 0) {
      menu.addItem(item => item
        .setTitle('展开子项')
        .setIcon('expand')
        .onClick(() => this.handleExpandDescendants(nodeId))
      );
      menu.addItem(item => item
        .setTitle('收起子项')
        .setIcon('minimize')
        .onClick(() => this.handleCollapseDescendants(nodeId))
      );
    }

    // 编辑描述（当左键行为为展开/折叠时，在右键菜单中提供编辑入口）
    if (this.settings.planningClickAction === 'toggle') {
      menu.addItem(item => item
        .setTitle('编辑描述')
        .setIcon('pencil')
        .onClick(() => this.promptEditBody(nodeId, data))
      );
    }

    // 编辑功能将不再需要
    // menu.addItem(item => item
    //   .setTitle('编辑')
    //   .setIcon('pencil')
    //   .onClick(() => this.handleEdit(nodeId, data))
    // );

    menu.addItem(item => item
      .setTitle('打开文件')
      .setIcon('file-text')
      .onClick(() => this.handleOpenFile(nodeId))
    );

    // 变更归属（仅非 desire）
    if (['direct', 'metric', 'taskchain', 'taskitem'].includes(data.type)) {
      menu.addItem(item => item
        .setTitle('变更归属')
        .setIcon('git-branch')
        .onClick(() => this.handleChangeParent(nodeId))
      );
    }

    menu.addItem(item => item
      .setTitle('重命名')
      .setIcon('text-cursor-input')
      .onClick(() => this.handleRename(nodeId))
    );

    // 循环规则（仅 taskitem）
    if (data.type === 'taskitem') {
      const hasCycleRule = !!(data as any).cycleRule;
      menu.addItem(item => item
        .setTitle(hasCycleRule ? '编辑循环规则' : '设置循环规则')
        .setIcon('refresh-cw')
        .onClick(() => this.handleSetCycleRule(nodeId))
      );
      if (hasCycleRule) {
        menu.addItem(item => item
          .setTitle('清除循环规则')
          .setIcon('x')
          .onClick(() => this.handleClearCycleRule(nodeId))
        );
      }
    }

    menu.addSeparator();

    menu.addItem(item => {
      item.setTitle('归档节点文件').setIcon('trash').setWarning(true);
      item.onClick(() => this.handleArchive(nodeId, data.type as NodeType));
    });

    menu.showAtMouseEvent(e);
  }

  // ============================================================
  // 操作处理
  // ============================================================

  private handleNewDesire(): void {
    new NodeEditorModal(this.app, {
      nodeType: 'desire',
      parentCandidates: [],
      onSave: (data, body) => this.handleSave(undefined, undefined, 'desire', data, body),
    }).open();
  }

  private handleAddChild(nodeId: string, parentType: NodeType, childType: NodeType): void {
    new QuickCreateModal(this.app, {
      nodeType: childType,
      onSave: (_nodeType, name) => {
        const nid = this.genId(name);
        const now = new Date().toISOString();
        const noStatus = childType === 'desire' || childType === 'direct';
        const data: Partial<AnyNode> = {
          type: childType, name,
          source: `[[${nodeId}]]`,
          created: now, modified: now,
        } as any;
        if (!noStatus) {
          // 状态跟随：子节点继承父节点状态（仅非终态）
          const parentNode = this.nodeCache.getNode(nodeId);
          const parentStatus = parentNode?.status;
          const isParentTerminal = parentStatus === 'completed' || parentStatus === 'giveup';
          if (this.settings.statusFollow && parentStatus && !isParentTerminal) {
            (data as any).status = parentStatus;
          } else {
            (data as any).status = 'pending';
          }
        }
        this.operationQueue.enqueue(
          () => this.nodeCache.addNode(nid, data as AnyNode),
          async () => { await this.fileManager.createNode(childType, data, '', nid); },
        );

        // 状态联级：新增子节点时，若父节点为终态则恢复为进行中
        if (this.settings.stateCascade && !noStatus) {
          const parentNode = this.nodeCache.getNode(nodeId);
          if (parentNode && (parentNode.status === 'completed' || parentNode.status === 'giveup')) {
            this.operationQueue.enqueue(
              () => this.nodeCache.updateNode(nodeId, { status: 'doing' }),
              () => this.fileManager.updateNode(parentType, nodeId, { status: 'doing' }),
            );
          }
        }
      },
    }).open();
  }

  private handleEdit(nodeId: string, data: AnyNode): void {
    const parentTypeMap: Record<string, NodeType> = {
      direct: 'desire', metric: 'desire', taskchain: 'direct', taskitem: 'taskchain',
    };
    const parentType = parentTypeMap[data.type];
    const parentCandidates = parentType ? this.nodeCache.getByType(parentType) : [];

    new NodeEditorModal(this.app, {
      nodeType: data.type as NodeType,
      existingData: data,
      existingNodeId: nodeId,
      existingBody: this.nodeCache.getNodeBody(nodeId),
      parentCandidates,
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

  private handleArchive(nodeId: string, nodeType: NodeType): void {
    const descendants = this.nodeCache.collectDescendants(nodeId);
    if (descendants.length > 0 && this.settings.archiveConfirmPrompt) {
      new ConfirmModal(this.app, {
        message: '确认归档',
        detail: `将归档此节点及其 ${descendants.length} 个子孙节点。`,
        confirmLabel: '归档',
        danger: true,
        onConfirm: () => this.executeArchive(nodeId, nodeType),
      }).open();
    } else {
      this.executeArchive(nodeId, nodeType);
    }
  }

  private executeArchive(nodeId: string, nodeType: NodeType): void {
    // 在移除缓存前，收集子树中所有节点的 { nodeId, type }，
    // 因为 removeNodeTree 会清空缓存，之后无法查类型。
    const treeNodes: { id: string; type: NodeType }[] = [];
    const collectTypes = (id: string) => {
      const children = this.nodeCache.getChildren(id);
      for (const child of children) collectTypes(child.nodeId);
      treeNodes.push({ id, type: this.nodeCache.getNodeType(id) ?? nodeType });
    };
    collectTypes(nodeId);

    const removed = this.nodeCache.removeNodeTree(nodeId);
    // 用每个节点自身的类型归档，确保文件路径正确
    const typeMap = new Map(treeNodes.map(n => [n.id, n.type]));
    this.operationQueue.enqueueFileBatch(
      removed.map(id => () => this.fileManager.archiveNode(typeMap.get(id) ?? nodeType, id)),
    );
  }

  private handleStatusChange(nodeId: string, _current: string): void {
    const nType = this.nodeCache.getNodeType(nodeId)!;
    const next = getNextStatuses(_current, nType);
    if (next.length === 0) return;
    const newStatus = next[0];
    this.operationQueue.enqueue(
      () => {
        this.nodeCache.updateNode(nodeId, { status: newStatus });
        // 状态级联（向下）：父节点变更为 pending/doing/paused 时，
        // 处于同组活跃状态的子孙节点同步变更
        if (this.settings.stateCascade && ['pending', 'doing', 'paused'].includes(newStatus)) {
          const activeStatuses = new Set(['pending', 'doing', 'paused']);
          const descendants = this.nodeCache.collectDescendants(nodeId);
          for (const d of descendants) {
            if (d.nodeType === 'desire' || d.nodeType === 'direct') continue;
            if (!activeStatuses.has(d.data.status)) continue;
            this.operationQueue.enqueue(
              () => this.nodeCache.updateNode(d.nodeId, { status: newStatus }),
              () => this.fileManager.updateNode(d.nodeType, d.nodeId, { status: newStatus }),
            );
          }
        }
        // 状态联级：沿 parent 链自动传播
        if (this.settings.stateCascade) {
          const cascades = this.nodeCache.cascadeChainParent(nodeId);
          for (const c of cascades) {
            this.operationQueue.enqueue(
              () => this.nodeCache.updateNode(c.nodeId, { status: c.newStatus }),
              () => this.fileManager.updateNode(c.nodeType, c.nodeId, { status: c.newStatus }),
            );
            // desire 被级联标记为完成时，提示用户
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

  private handleStatusSet(nodeId: string, newStatus: string): void {
    const nType = this.nodeCache.getNodeType(nodeId)!;
    this.operationQueue.enqueue(
      () => {
        this.nodeCache.updateNode(nodeId, { status: newStatus });
        // 状态跟随：父节点手动设置为终态时，非终态子孙节点自动标记为目标状态
        if (this.settings.statusFollow && (newStatus === 'completed' || newStatus === 'giveup')) {
          const terminalStatuses = new Set(['completed', 'giveup']);
          const followStatus = this.settings.statusFollowTarget;
          const descendants = this.nodeCache.collectDescendants(nodeId);
          for (const d of descendants) {
            // 跳过无状态概念的类型（期望、方向）
            if (d.nodeType === 'desire' || d.nodeType === 'direct') continue;
            // 跳过终态节点
            if (terminalStatuses.has(d.data.status)) continue;
            this.operationQueue.enqueue(
              () => this.nodeCache.updateNode(d.nodeId, { status: followStatus }),
              () => this.fileManager.updateNode(d.nodeType, d.nodeId, { status: followStatus }),
            );
          }
        }
        // 状态级联（向下）：父节点变更为 pending/doing/paused 时，
        // 处于同组活跃状态的子孙节点同步变更
        if (this.settings.stateCascade && ['pending', 'doing', 'paused'].includes(newStatus)) {
          const activeStatuses = new Set(['pending', 'doing', 'paused']);
          const descendants = this.nodeCache.collectDescendants(nodeId);
          for (const d of descendants) {
            if (d.nodeType === 'desire' || d.nodeType === 'direct') continue;
            if (!activeStatuses.has(d.data.status)) continue;
            this.operationQueue.enqueue(
              () => this.nodeCache.updateNode(d.nodeId, { status: newStatus }),
              () => this.fileManager.updateNode(d.nodeType, d.nodeId, { status: newStatus }),
            );
          }
        }
        // 状态联级：沿 parent 链自动传播
        if (this.settings.stateCascade) {
          const cascades = this.nodeCache.cascadeChainParent(nodeId);
          for (const c of cascades) {
            this.operationQueue.enqueue(
              () => this.nodeCache.updateNode(c.nodeId, { status: c.newStatus }),
              () => this.fileManager.updateNode(c.nodeType, c.nodeId, { status: c.newStatus }),
            );
            // desire 被级联标记为完成时，提示用户
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

  private handleRename(nodeId: string): void {
    const node = this.nodeCache.getNode(nodeId);
    if (!node) return;
    const modal = new Modal(this.app);
    modal.setTitle('重命名');
    let newName = node.name;
    new Setting(modal.contentEl)
      .setName("新名称")
      .addText((text) => {
        text.setValue(node.name);
        text.onChange((v) => { newName = v.trim(); });
        setTimeout(() => text.inputEl.focus(), 100);
      });
    new Setting(modal.contentEl)
      .addButton((btn) => {
        btn.setButtonText("确认").setCta().onClick(async () => {
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
        btn.setButtonText("取消").onClick(() => modal.close());
      });
    modal.open();
  }

  private handleOpenFile(nodeId: string): void {
    const nType = this.nodeCache.getNodeType(nodeId);
    if (!nType) return;
    const filePath = this.fileManager.getNodeFilePath(nType, nodeId);
    this.app.workspace.openLinkText(filePath, '', false);
  }

  private handleChangeParent(nodeId: string): void {
    const node = this.nodeCache.getNode(nodeId);
    const nType = this.nodeCache.getNodeType(nodeId);
    if (!node || !nType) return;

    // 每种类型可归属的上级类型列表
    const parentTypeMap: Record<string, string[]> = {
      direct: ['desire'],
      metric: ['desire', 'taskchain'],
      taskchain: ['direct'],
      taskitem: ['taskchain'],
    };
    const parentTypes = parentTypeMap[nType];
    if (!parentTypes || parentTypes.length === 0) return;

    // 合并所有候选上级类型的节点
    let candidates: { nodeId: string; data: AnyNode }[] = [];
    for (const pt of parentTypes) {
      candidates.push(...this.nodeCache.getByType(pt as NodeType));
    }

    // 排除自身及后代
    const excluded = new Set<string>();
    const collectDescendants = (id: string) => {
      excluded.add(id);
      for (const ch of this.nodeCache.getChildren(id)) {
        collectDescendants(ch.nodeId);
      }
    };
    collectDescendants(nodeId);
    const filtered = candidates.filter(c => !excluded.has(c.nodeId));

    if (filtered.length === 0) {
      new Notice('没有可用的上级节点。');
      return;
    }

    const labels: Record<string, string> = { desire: '期望', direct: '方向', taskchain: '目标' };
    const labelList = parentTypes.map(t => labels[t] ?? t).join('/');

    const suggest = new ParentSuggestModal(this.app, filtered, (item) => {
      const sourceRef = `[[${item.nodeId}]]`;
      this.operationQueue.enqueue(
        () => this.nodeCache.updateNode(nodeId, { source: sourceRef } as Partial<AnyNode>),
        () => this.fileManager.updateNode(nType, nodeId, { source: sourceRef } as Partial<AnyNode>),
      );
    });
    suggest.setPlaceholder(`变更归属: ${node.name} → 选择上级${labelList}…`);
    suggest.open();
  }

  // ── 循环规则操作 ──

  private handleSetCycleRule(nodeId: string): void {
    new CycleRuleModal(this.app, {
      targetType: 'taskitem',
      nodeId,
      nodeCache: this.nodeCache,
      fileManager: this.fileManager,
      operationQueue: this.operationQueue,
    }).open();
  }

  private handleClearCycleRule(nodeId: string): void {
    const updates = {
      cycleRule: undefined,
      cycleRuleBase: undefined,
      cycleRuleTarget: undefined,
    };
    this.operationQueue.enqueue(
      () => this.nodeCache.updateNode(nodeId, updates as any),
      async () => { await this.fileManager.updateNode('taskitem', nodeId, updates as any); },
    );
  }

  private genId(name: string): string {
    const d = new Date();
    const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}-${String(d.getMilliseconds()).padStart(3, '0')}`;
    const r = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
    return `${ts}-${r}-${name.replace(/[\\/:*?"<>|]/g, '_')}`;
  }
}
