/**
 * toggleSvg — 共享的节点行 toggle SVG 图标常量与工具函数
 *
 * 设计偏向：使用 SVG 绘制各种状态图案，而非 CSS border + pseudo-element。
 * 原因：SVG 在不同缩放比例下更清晰，能表达更丰富的视觉状态
 * （如已完成鱼眼、已放弃斜线、展开虚线圆等），且与 V2 的视觉语言一致。
 *
 * 所有 SVG viewBox 统一为 0 0 16 16，stroke-width 1.5。
 */

// ============================================================
// SVG 图标常量
// ============================================================

/** 展开状态：虚线圆 */
export const SVG_EXPANDED = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 2.17"/>
</svg>`;

/** 折叠状态：鱼眼圆（外圆带顶部和底部缺口 + 内实心圆） */
export const SVG_COLLAPSED = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="18.42 2 18.42 2" stroke-dashoffset="9.21"/>
  <circle cx="8" cy="8" r="4" fill="currentColor"/>
</svg>`;

/** 折叠状态（全部子孙已完成）：无缺口鱼眼圆 */
export const SVG_COLLAPSED_ALL_DONE = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="8" cy="8" r="4" fill="currentColor"/>
</svg>`;

/** 展开状态（全部子孙已完成）：虚线圆 + 中心稍小实心圆 */
export const SVG_EXPANDED_ALL_DONE = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 2.17"/>
  <circle cx="8" cy="8" r="3" fill="currentColor"/>
</svg>`;

/** 叶子节点：实线空心圆 */
export const SVG_LEAF = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
</svg>`;

/** 已完成叶子节点：鱼眼圆（实线外圆 + 内实心圆） */
export const SVG_FISHEYE = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="8" cy="8" r="4" fill="currentColor"/>
</svg>`;

/** 终态叶子节点：实心圆 */
export const SVG_SOLID = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="7" fill="currentColor"/>
</svg>`;

/** 已完成叶子节点：带斜杠的实线圆 */
export const SVG_SLASH_CIRCLE = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
  <line x1="4.5" y1="11.5" x2="11.5" y2="4.5" stroke="currentColor" stroke-width="1.5"/>
</svg>`;

/** 已放弃节点：实线圆 + 三条右上→左下斜线 */
export const SVG_ABANDONED = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
  <line x1="9.7" y1="1.7" x2="1.7" y2="9.7" stroke="currentColor" stroke-width="1.5"/>
  <line x1="12.6" y1="3.4" x2="3.4" y2="12.6" stroke="currentColor" stroke-width="1.5"/>
  <line x1="14.3" y1="6.2" x2="6.2" y2="14.3" stroke="currentColor" stroke-width="1.5"/>
</svg>`;

/** 暂停状态：实线圆 + 中心短横线 */
export const SVG_SUSPENDED = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
  <line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

/** 活跃进行中：实线圆 + 绿色圆点 */
export const SVG_ACTIVE = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="8" cy="8" r="3" fill="currentColor"/>
</svg>`;

// ============================================================
// toggle 提示文字映射
// ============================================================

/**
 * 根据节点状态返回 toggle 的 title 提示文字。
 * 用于鼠标悬浮时的 tooltip。
 */
export function getToggleTitle(
  hasChildren: boolean,
  expanded: boolean,
  isCompleted: boolean,
  isAbandoned: boolean,
  isSuspended: boolean,
  isActive: boolean
): string {
  if (isAbandoned) return hasChildren ? (expanded ? '已放弃（展开）' : '已放弃（折叠）') : '已放弃';
  if (isCompleted) return hasChildren ? (expanded ? '已完成（展开）' : '已完成（折叠）') : '已完成';
  if (isSuspended) return '已暂停';
  if (isActive) return '进行中';
  if (!hasChildren) return '';
  return expanded ? '点击折叠' : '点击展开';
}

// ============================================================
// toggle SVG 选择逻辑
// ============================================================

/**
 * 根据节点状态选择合适的 SVG 图标。
 * 偏好使用 SVG 绘制各种状态图案，保持与 V2 一致的视觉语言。
 *
 * 父节点（有子节点）：
 *   - 终态（完成/放弃）：收起=无缺鱼眼圆，展开=虚线圆+中心实心圆
 *   - 非终态：收起=带缺口鱼眼圆，展开=虚线圆
 * 子节点（叶子）：
 *   - 已完成：实心圆
 *   - 已放弃：带斜杠的实线圆
 *   - 非终态：实线空心圆
 */
export function pickToggleSvg(
  hasChildren: boolean,
  expanded: boolean,
  isAbandoned: boolean,
  isCompleted: boolean,
  isActive: boolean,
  isSuspended: boolean
): string {
  const isTerminal = isCompleted || isAbandoned;
  if (hasChildren) {
    if (isTerminal) {
      return expanded ? SVG_EXPANDED_ALL_DONE : SVG_COLLAPSED_ALL_DONE;
    }
    return expanded ? SVG_EXPANDED : SVG_COLLAPSED;
  }
  // 叶子节点
  if (isCompleted) return SVG_SOLID;
  if (isAbandoned) return SVG_SLASH_CIRCLE;
  if (isSuspended) return SVG_SUSPENDED;
  return SVG_LEAF;
}
