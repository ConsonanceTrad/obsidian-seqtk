/**
 * 日期格式化 — 节点行预期属性徽章的紧凑日期显示
 */

/**
 * 将 ISO 日期/时间字符串格式化为 MM-DD（如 2026-08-19 → 08-19）。
 * 解析失败时尽力截取原字符串的月-日片段。
 */
export function formatShortDate(isoDate: string): string {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  if (!Number.isNaN(d.getTime())) {
    const M = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${M}-${day}`;
  }
  return isoDate.slice(5, 10);
}
