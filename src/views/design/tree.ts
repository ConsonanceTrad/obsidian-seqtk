/**
 * design/tree — 设计视图树构建纯函数
 *
 * 从 DesignView 拆出的「节点 → 树」构建逻辑,不依赖任何 DOM / UI 状态,
 * 只依赖 NodeCache 与排序参数,可在左栏(renderLeft)、右栏(renderRight)、
 * 总览(renderAllOverview)与拖拽排序(moveTopInOrder)间复用。
 *
 * 功能增补指引:
 * - 新增树形聚合(如按某类型分组)→ 在此新增 buildXxxTree 函数并在
 *   DesignView.renderRight 中调用
 * - 调整排序规则 → 改 sortByFollows / buildFrameworkTree 的顶级排序段
 */

import type { NodeCache } from '../../core/NodeCache';
import type { NodeKind, SeqtkNode } from '../../types/index';
import { isFrameworkKind } from '../../types/index';

/** 树形节点 */
export interface TreeNode {
  nodeId: string;
  data: SeqtkNode;
  children: TreeNode[];
}

/** 框架树：顶级 = 无框架父节点的框架（仅事务框架），递归子框架；不渲染信息框架 */
export function buildFrameworkTree(cache: NodeCache, topOrder: string[]): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const kind of ['framework-transaction'] as NodeKind[]) {
    for (const { nodeId, data } of cache.getByKind(kind)) {
      const parent = cache.getParent(nodeId);
      const parentData = parent ? cache.getNode(parent.nodeId) : undefined;
      if (parentData && isFrameworkKind(parentData.kind)) continue;
      roots.push(buildFrameworkNode(cache, nodeId, data));
    }
  }
  // 顶级排序：topFrameworkOrder 中出现的按数组顺序，未列入的（新框架）按创建时间排尾部
  const order = new Map(topOrder.map((id, i) => [id, i]));
  return roots.sort((a, b) => {
    const ia = order.get(a.nodeId);
    const ib = order.get(b.nodeId);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return (a.data.create ?? '').localeCompare(b.data.create ?? '');
  });
}

/** 递归构建框架子树（仅框架类型子节点，排除信息框架） */
export function buildFrameworkNode(cache: NodeCache, nodeId: string, data: SeqtkNode): TreeNode {
  const children = cache
    .getChildren(nodeId)
    .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } =>
      !!c.data && isFrameworkKind(c.data.kind) && c.data.kind !== 'framework-info')
    .map((c) => buildFrameworkNode(cache, c.nodeId, c.data));
  return { nodeId, data, children: sortByFollows(data, children) };
}

/** 构想树（顶级 = 所有 concept） */
export function buildConceptTree(cache: NodeCache): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const { nodeId, data } of cache.getByKind('concept')) {
    roots.push(buildNode(cache, nodeId, data));
  }
  return roots.sort((a, b) => (a.data.create ?? '').localeCompare(b.data.create ?? ''));
}

/** 清单树（顶级 = 所有 checklist） */
export function buildChecklistTree(cache: NodeCache): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const { nodeId, data } of cache.getByKind('checklist')) {
    roots.push(buildNode(cache, nodeId, data));
  }
  return roots.sort((a, b) => (a.data.create ?? '').localeCompare(b.data.create ?? ''));
}

/** 递归构建树节点（所有类型子节点，按父节点 follows 顺序排序） */
export function buildNode(cache: NodeCache, nodeId: string, data: SeqtkNode): TreeNode {
  const children = cache
    .getChildren(nodeId)
    .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } => !!c.data)
    .map((c) => buildNode(cache, c.nodeId, c.data));
  return { nodeId, data, children: sortByFollows(data, children) };
}

/** 按父节点 follows 数组顺序排序；未列出的子节点按创建时间排后 */
export function sortByFollows<T extends { nodeId: string }>(parent: SeqtkNode, items: T[]): T[] {
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
