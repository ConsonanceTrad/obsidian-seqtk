/**
 * design/tree — 设计视图树构建纯函数
 *
 * 从 DesignView 拆出的「节点 → 树」构建逻辑,不依赖任何 DOM / UI 状态,
 * 只依赖 **DataPipe 只读门面**与排序参数,可在左栏(renderLeft)、右栏(renderRight)、
 * 总览(renderAllOverview)与拖拽排序(moveTopInOrder)间复用。
 *
 * 数据面（见 P6_Views/Views.md 边界判据）：形参是 DataPipe 而非 NodeCache，
 * 本模块不接触 fileManager / operationQueue。
 *
 * 功能增补指引:
 * - 新增树形聚合(如按某类型分组)→ 在此新增 buildXxxTree 函数并在 view 侧调用
 * - 调整排序规则 → 改 sortByFollows / buildFrameworkTree 的顶级排序段
 */

import { NODE_KIND } from '../../../../P4_Nodes/NodeFacade';
import type { DataPipe } from '../../../../P5_Data/CoPipe/DataPipe';
import type { NodeKind, SeqtkNode } from '../../../../P4_Nodes/NodeFacade';
import { isFrameworkKind } from '../../../../P4_Nodes/NodeFacade';

/** 树形节点 */
export interface TreeNode {
  nodeId: string;
  data: SeqtkNode;
  children: TreeNode[];
}

/** 框架树：顶级 = 无框架父节点的框架（仅事务框架），递归子框架；不渲染信息框架 */
export function buildFrameworkTree(pipe: DataPipe, topOrder: string[]): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const kind of [NODE_KIND.TRANS] as NodeKind[]) {
    for (const { nodeId, data } of pipe.GET_ByKind(kind)) {
      const parent = pipe.GET_Parent(nodeId);
      const parentData = parent ? pipe.GET_Node(parent.nodeId) : undefined;
      if (parentData && isFrameworkKind(parentData.kind)) continue;
      roots.push(buildFrameworkNode(pipe, nodeId, data));
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

/**
 * 模板框架树：顶级 = 无框架父节点的模板框架，递归子框架
 *
 * 与 buildFrameworkTree 只差取哪些 kind（设计视图左栏要事务框架，模板模式要模板框架）；
 * 层级与子级排序口径一致（子级按父 follows，顶级按创建时间 —— 模板库不参与
 * settings.topFrameworkOrder 那套顶级排序）。
 */
export function buildTemplateTree(pipe: DataPipe): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const { nodeId, data } of pipe.GET_ByKind(NODE_KIND.TEMP)) {
    const parent = pipe.GET_Parent(nodeId);
    const parentData = parent ? pipe.GET_Node(parent.nodeId) : undefined;
    if (parentData && isFrameworkKind(parentData.kind)) continue;
    roots.push(buildFrameworkNode(pipe, nodeId, data));
  }
  return roots.sort((a, b) => (a.data.create ?? '').localeCompare(b.data.create ?? ''));
}

/** 递归构建框架子树（仅框架类型子节点，排除信息框架；按 nodeId 去重防重复渲染） */
export function buildFrameworkNode(pipe: DataPipe, nodeId: string, data: SeqtkNode): TreeNode {
  const seen = new Set<string>();
  const children = pipe
    .GET_Children(nodeId)
    .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } =>
      !!c.data && isFrameworkKind(c.data.kind) && c.data.kind !== NODE_KIND.INFO && !seen.has(c.nodeId) && (seen.add(c.nodeId), true))
    .map((c) => buildFrameworkNode(pipe, c.nodeId, c.data));
  return { nodeId, data, children: sortByFollows(data, children) };
}

/** 递归构建树节点（所有类型子节点，按父节点 follows 顺序排序；按 nodeId 去重防重复渲染） */
export function buildNode(pipe: DataPipe, nodeId: string, data: SeqtkNode): TreeNode {
  const seen = new Set<string>();
  const children = pipe
    .GET_Children(nodeId)
    .filter((c): c is { kind: NodeKind; nodeId: string; data: SeqtkNode } =>
      !!c.data && !seen.has(c.nodeId) && (seen.add(c.nodeId), true))
    .map((c) => buildNode(pipe, c.nodeId, c.data));
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
