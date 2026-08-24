/**
 * 时间戳工具 — 生成和解析 SeqTK 节点 ID
 *
 * nodeId 格式: {细分类型名}-{YYYYMMDD-HHmmss-SSS}-{2位防重16进制数}
 * 示例: project-20240819-103025-123-1a
 *
 * 2 位 16 进制随机后缀（00-ff，共 256 种）防止同一毫秒内创建多个节点时冲突。
 */

import type { NodeKind } from '../types/index';

/** 生成 2 位 16 进制随机字符串（00-ff，共 256 种可能） */
function randomHex2(): string {
  return Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
}

/** 将 Date 格式化为 YYYYMMDD-HHmmss-SSS */
function formatTimestamp(date: Date): string {
  const y = date.getFullYear().toString();
  const M = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  const H = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  const s = date.getSeconds().toString().padStart(2, '0');
  const ms = date.getMilliseconds().toString().padStart(3, '0');
  return `${y}${M}${d}-${H}${m}${s}-${ms}`;
}

/**
 * 生成 nodeId: {细分类型名}-{YYYYMMDD-HHmmss-SSS}-{xx}
 *
 * @param kind 节点细分类型（如 'project'、'framework-transaction'）
 * @returns 全局唯一的 nodeId，同时用作文件名（不含 .md）
 */
export function generateNodeId(kind: NodeKind): string {
  const ts = formatTimestamp(new Date());
  return `${kind}-${ts}-${randomHex2()}`;
}

export interface ParsedNodeId {
  /** 节点细分类型名（如 'project'、'framework-transaction'） */
  kind: string;
  /** 原始创建时间戳（毫秒 Unix 时间） */
  timestamp: number;
  /** 2 位防重 16 进制后缀 */
  suffix: string;
}

/**
 * 从 nodeId 解析类型、时间戳和后缀
 *
 * @param nodeId 如 "project-20240819-103025-123-1a"
 * @returns 解析结果，无法解析时 kind/suffix 为空字符串、timestamp 为 0
 */
export function parseNodeId(nodeId: string): ParsedNodeId {
  // 匹配: {kind}-{YYYYMMDD}-{HHmmss}-{SSS}-{xx}
  // kind 本身可能含 '-'（如 framework-transaction），使用贪婪前缀匹配
  const match = nodeId.match(/^(.+)-(\d{8})-(\d{6})-(\d{3})-([0-9a-f]{2})$/);
  if (!match) {
    return { kind: '', timestamp: 0, suffix: '' };
  }

  const [, kind, datePart, timePart, ms, suffix] = match;
  const dMatch = datePart.match(/^(\d{4})(\d{2})(\d{2})$/);
  const tMatch = timePart.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!dMatch || !tMatch) {
    return { kind, timestamp: 0, suffix };
  }

  const [, y, M, d] = dMatch;
  const [, H, m, s] = tMatch;
  const date = new Date(
    parseInt(y),
    parseInt(M) - 1,
    parseInt(d),
    parseInt(H),
    parseInt(m),
    parseInt(s),
    parseInt(ms)
  );

  return {
    kind,
    timestamp: date.getTime(),
    suffix,
  };
}

/**
 * 格式化时间戳为人类可读的日期时间字符串
 *
 * @param ts Unix 时间戳（毫秒）
 * @param locale 地区，默认 'zh-CN'
 * @returns 如 "2024年8月19日 10:30:25"
 */
export function formatDate(ts: number, locale = 'zh-CN'): string {
  return new Date(ts).toLocaleString(locale);
}
