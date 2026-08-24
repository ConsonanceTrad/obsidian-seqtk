/**
 * NodeRowRenderer — 节点行渲染器（替代 NodeRow.svelte）
 * 
 * 行布局：toggle | 类型中文标签 | 展示名 | 正文预览 | 额外区域 | 状态标签
 * 支持右键菜单浮层
 *
 * 设计偏向：toggle 图标使用纯 SVG 绘制各种状态（虚线圆、鱼眼圆、
 * 斜线圆等），而非 CSS border + pseudo-element。原因：SVG 在 HiDPI
 * 下更清晰、能表达更丰富的视觉状态，且便于统一旋转/缩放动画。
 * 共享 SVG 常量已抽取到 utils/toggleSvg.ts。
 */

import type { NodeType } from '../../types/index';
import { NODE_TYPE_LABELS, NODE_STATUS_LABELS } from '../../types/index';

// ============================================================
// SVG 图标常量（从 NodeRow.svelte 迁移）
// ============================================================

/** 展开状态 SVG：虚线圆 */
const SVG_EXPANDED = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 2.17"/>
</svg>`;

/** 折叠状态 SVG：鱼眼圆（外圆带顶部和底部缺口） */
const SVG_COLLAPSED = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="18.42 2 18.42 2" stroke-dashoffset="9.21"/>
  <circle cx="8" cy="8" r="4" fill="currentColor"/>
</svg>`;

/** 折叠状态 SVG（全部子孙已完成）：无缺口鱼眼圆 */
const SVG_COLLAPSED_ALL_DONE = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="8" cy="8" r="4" fill="currentColor"/>
</svg>`;

/** 展开状态 SVG（全部子孙已完成）：虚线圆中心填入稍小实心圆 */
const SVG_EXPANDED_ALL_DONE = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 2.17"/>
  <circle cx="8" cy="8" r="3" fill="currentColor"/>
</svg>`;

/** 叶子节点 SVG：实线空心圆 */
const SVG_LEAF = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
</svg>`;

/** 已完成叶子节点 SVG：无缺口鱼眼圆 */
const SVG_FISHEYE = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="8" cy="8" r="4" fill="currentColor"/>
</svg>`;

/** 已放弃节点 SVG：实线圆内含三条右上→左下斜线 */
const SVG_ABANDONED = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
  <line x1="9.7" y1="1.7" x2="1.7" y2="9.7" stroke="currentColor" stroke-width="1.5"/>
  <line x1="12.6" y1="3.4" x2="3.4" y2="12.6" stroke="currentColor" stroke-width="1.5"/>
  <line x1="14.3" y1="6.2" x2="6.2" y2="14.3" stroke="currentColor" stroke-width="1.5"/>
</svg>`;

/** 可快速完成节点 SVG：实心圆内嵌对号（hover 时显示） */
const SVG_COMPLETE = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="7" fill="currentColor"/>
  <polyline points="5 8.2 7.2 10.4 11 5.8" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;

// ============================================================
// 接口定义
// ============================================================

export interface NodeRowOptions {
  /** 节点类型 */
  nodeType: NodeType;
  /** 展示名 */
  name: string;
  /** 状态值 */
  status: string;
  /** 缩进深度 */
  depth?: number;
  /** 是否有子节点 */
  hasChildren?: boolean;
  /** 是否已展开 */
  expanded?: boolean;
  /** 所有子孙目标是否均已完成 */
  allDone?: boolean;
  /** 是否已放弃 */
  isAbandoned?: boolean;
  /** 是否已完成 */
  isCompleted?: boolean;
  /** 叶子节点是否可快速完成 */
  isCompletable?: boolean;
  /** 正文预览 */
  bodyPreview?: string;
  /** toggle 回调 */
  onToggle?: () => void;
  /** 快速完成回调 */
  onQuickComplete?: () => void;

  /** 右键菜单项构建函数 */
  contextMenuItems?: (container: HTMLElement) => void;
}

// ============================================================
// 渲染函数
// ============================================================

/**
 * 创建节点行 DOM 元素
 */
export function createNodeRow(options: NodeRowOptions): HTMLElement {
  const {
    nodeType, name, status, depth = 0,
    hasChildren = false, expanded = false,
    allDone = false, isAbandoned = false, isCompleted = false,
    isCompletable = false, bodyPreview,
    onToggle, onQuickComplete,
    contextMenuItems,
  } = options;

  const row = document.createElement('div');
  row.className = 'node-row';
  if (isCompleted) row.classList.add('row-completed');
  if (isAbandoned) row.classList.add('row-abandoned');
  row.style.paddingLeft = `${depth * 24 + 4}px`;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('tabindex', '-1');

  // toggle 按钮
  const toggle = document.createElement('button');
  toggle.className = getToggleClass(hasChildren, isCompletable);
  toggle.innerHTML = getToggleSvg(hasChildren, expanded, allDone, isAbandoned, isCompleted, isCompletable);
  toggle.setAttribute('aria-label', hasChildren ? (expanded ? '折叠' : '展开') : '');
  if (isCompletable) {
    toggle.addEventListener('click', () => onQuickComplete?.());
  } else if (hasChildren) {
    toggle.addEventListener('click', () => onToggle?.());
  }
  row.appendChild(toggle);

  // 类型中文标签
  const typeLabel = document.createElement('span');
  typeLabel.className = `nr-type nr-type-${nodeType}`;
  typeLabel.textContent = NODE_TYPE_LABELS[nodeType] ?? nodeType;
  row.appendChild(typeLabel);

  // 展示名
  const nameEl = document.createElement('span');
  nameEl.className = 'nr-name';
  nameEl.textContent = name;
  row.appendChild(nameEl);

  // 正文预览
  if (bodyPreview) {
    const previewEl = document.createElement('span');
    previewEl.className = 'nr-body-preview';
    previewEl.textContent = bodyPreview;
    row.appendChild(previewEl);
  }

  // 弹性间隔
  const spacer = document.createElement('span');
  spacer.className = 'nr-spacer';
  row.appendChild(spacer);

  // 状态中文标签（纯展示，不可点击）
  const statusLabel = document.createElement('span');
  statusLabel.className = `nr-status ${statusClass(status)}`;
  statusLabel.textContent = NODE_STATUS_LABELS[status] ?? status;
  row.appendChild(statusLabel);

  // 右键菜单
  if (contextMenuItems) {
    row.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, contextMenuItems);
    });
  }

  return row;
}

// ============================================================
// 右键菜单
// ============================================================

let currentMenuOverlay: HTMLElement | null = null;

function showContextMenu(x: number, y: number, buildItems: (container: HTMLElement) => void): void {
  // 关闭已有菜单
  closeContextMenu();

  const overlay = document.createElement('div');
  overlay.className = 'nr-menu-overlay';
  overlay.addEventListener('click', closeContextMenu);
  overlay.addEventListener('contextmenu', (e) => { e.preventDefault(); closeContextMenu(); });

  const menu = document.createElement('div');
  menu.className = 'nr-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.setAttribute('role', 'menu');

  buildItems(menu);

  overlay.appendChild(menu);
  document.body.appendChild(overlay);
  currentMenuOverlay = overlay;
}

function closeContextMenu(): void {
  if (currentMenuOverlay) {
    currentMenuOverlay.remove();
    currentMenuOverlay = null;
  }
}

/**
 * 创建右键菜单项按钮
 */
export function createMenuItem(label: string, onClick: () => void, danger = false): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'nr-menu-item' + (danger ? ' danger' : '');
  btn.textContent = label;
  btn.addEventListener('click', () => {
    closeContextMenu();
    onClick();
  });
  return btn;
}

/**
 * 创建右键菜单分隔线
 */
export function createMenuSeparator(): HTMLDivElement {
  const sep = document.createElement('div');
  sep.className = 'nr-menu-separator';
  return sep;
}

// ============================================================
// 内部工具函数
// ============================================================

function getToggleClass(hasChildren: boolean, isCompletable: boolean): string {
  const parts = ['nr-toggle'];
  if (!hasChildren && !isCompletable) parts.push('nr-toggle-leaf');
  if (isCompletable) parts.push('nr-toggle-completable');
  return parts.join(' ');
}

function getToggleSvg(
  hasChildren: boolean, expanded: boolean,
  allDone: boolean, isAbandoned: boolean,
  isCompleted: boolean, isCompletable: boolean
): string {
  if (isCompletable) {
    return `<span class="nr-toggle-svg nr-toggle-svg-default">${SVG_LEAF}</span>` +
           `<span class="nr-toggle-svg nr-toggle-svg-hover">${SVG_COMPLETE}</span>`;
  }
  if (hasChildren) {
    if (isAbandoned) return `<span class="nr-toggle-svg">${SVG_ABANDONED}</span>`;
    if (expanded) return `<span class="nr-toggle-svg">${allDone ? SVG_EXPANDED_ALL_DONE : SVG_EXPANDED}</span>`;
    return `<span class="nr-toggle-svg">${allDone ? SVG_COLLAPSED_ALL_DONE : SVG_COLLAPSED}</span>`;
  }
  if (isCompleted) return `<span class="nr-toggle-svg">${SVG_FISHEYE}</span>`;
  if (isAbandoned) return `<span class="nr-toggle-svg">${SVG_ABANDONED}</span>`;
  return `<span class="nr-toggle-svg">${SVG_LEAF}</span>`;
}

function statusClass(s: string): string {
  switch (s) {
    case 'pending': return 'nr-status-pending';
    case 'doing':
    case 'progress': return 'nr-status-active';
    case 'paused': return 'nr-status-paused';
    case 'completed':
    case 'done': return 'nr-status-done';
    case 'giveup':
    case 'cancelled': return 'nr-status-inactive';
    default: return 'nr-status-pending';
  }
}
