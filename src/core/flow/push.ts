/**
 * 流程推送 · 任务序列生成
 *
 * 由流程脚本（AST）在时间轴上实例化推送任务：
 * - at  → 单时刻任务
 * - span → 时段任务（起 → 止）
 * - repeat → 周期规则按天展开（近 N 天）
 * - when → 条件使能，内容在子节点（自身不推送）
 * 递归处理嵌套时间节点（when/span 内可再切分）。
 */

import type { FlowScript, FlowTimeNode, FlowContentBlock } from './parser';

/** 一条推送任务 */
export interface FlowPushTask {
  time: string; // 时刻或时段文本
  nodeType: 'at' | 'span' | 'repeat';
  label: string; // 节点名称
  items: FlowContentBlock[]; // 内容块清单（lst/task/...）
}

const pad = (v: number): string => String(v).padStart(2, '0');

function formatDate(d: Date): string {
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

/** 收集时间节点可推送的内容块：线路行 do 的输出内容（旧数据 node.contents 兼容并入） */
function collectPushItems(node: FlowTimeNode): FlowContentBlock[] {
  const items: FlowContentBlock[] = [];
  for (const line of node.lines) {
    for (const it of line.items) {
      if (it.type === 'if' && it.do !== undefined && it.contents) {
        items.push(...it.contents);
      }
    }
  }
  items.push(...node.contents);
  return items;
}

/** 由流程脚本生成任务序列（默认展开近 7 天的重复规则） */
export function generatePushTasks(script: FlowScript, days = 7): FlowPushTask[] {
  const tasks: FlowPushTask[] = [];

  const walk = (node: FlowTimeNode): void => {
    for (const child of node.children) walk(child);
    const items = collectPushItems(node);
    if (items.length === 0) return;
    switch (node.type) {
      case 'at':
        tasks.push({ time: node.time ?? '', nodeType: 'at', label: node.name ?? '', items });
        break;
      case 'span':
        tasks.push({
          time: `${node.from ?? ''} → ${node.to ?? ''}`,
          nodeType: 'span',
          label: node.name ?? '',
          items,
        });
        break;
      case 'repeat': {
        const today = new Date();
        for (let i = 0; i < days; i++) {
          const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
          tasks.push({
            time: `${formatDate(d)} ${node.time ?? ''}`,
            nodeType: 'repeat',
            label: node.name ?? '',
            items,
          });
        }
        break;
      }
      case 'when':
        // when 仅声明母线通断条件，内容在子节点
        break;
    }
  };

  for (const node of script.timeNodes) walk(node);
  tasks.sort((a, b) => a.time.localeCompare(b.time));
  return tasks;
}
