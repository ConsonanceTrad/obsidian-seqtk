/**
 * design/drag — 拖拽的「执行」切片
 *
 * 判定（落点解析 / 能否落）已迁到 `P7_Render/Composition/C2_Tree/drag.ts`（纯逻辑，不接触
 * 数据层，`EVIDENCE_KINDS` 也在那里）。本文件只保留**需要写数据**的部分：同父排序、
 * 顶级排序、跨父移动 —— 它们经 **pipe.EXEC_Mutation** 落盘，不直连 nodeCache / fileManager /
 * operationQueue。
 *
 * 第一参数按需取接口：同父排序与跨父移动只要 `NodeEditHost`；顶级排序还要读写 `topOrder`，
 * 故那一个收 `TreeEditHost`（见 Slice/treeEditHost）。抽成接口后，线路模式的左栏框架树
 * 能复用这整套行为。
 *
 * 事件绑定不再在这里（原来的 dragstart/dragover/drop 挂在行 DOM 上）：现在由 P7_Render 的
 * 行组件发出回调，视图接住、判定后，把「移动意图」交给这里的函数执行。
 *
 * 指示清理（原 clearDropIndicators / installDragCancelHandler）也不再需要：行的「正在拖拽」
 * 由 `NodeLineData.dragging` 表达；落点提示由 design/dragHandlers 直接切行上的 class
 * （见该切片文件头），两者都不需要单独的清理钩子。
 */

import type { NodeEditHost } from './actions';
import type { TreeEditHost } from './treeEditHost';
import { buildFrameworkTree } from '../Tool/tree';

/** 在同父 follows 中把 sourceId 移到 targetId 前/后，持久化并重渲染 */
export function moveChildInFollows(view: NodeEditHost, parentId: string, sourceId: string, targetId: string, before: boolean): void {
  const parent = view.pipe.GET_Node(parentId);
  if (!parent) return;
  const follows = [...(parent.follows ?? [])];
  const srcIdx = follows.indexOf(sourceId);
  // 数据不一致容错：source 不在父 follows 中（历史遗留/缺失）时跳过移除，仍按目标位置插入——
  // "添加到同级"始终生效，并顺带修复父 follows 数据
  if (srcIdx >= 0) follows.splice(srcIdx, 1);
  let insertAt = follows.indexOf(targetId);
  if (insertAt < 0) insertAt = follows.length;
  if (!before) insertAt += 1;
  follows.splice(insertAt, 0, sourceId);
  view.pipe.EXEC_Mutation({
    op: 'update',
    kind: parent.kind,
    nodeId: parentId,
    updates: { follows, modify: new Date().toISOString() },
  });
  view.renderRight();
}

/**
 * 顶级框架排序：以当前渲染顺序（topFrameworkOrder + 未列入按创建时间）重建数组，
 * 将 sourceId 移到 targetId 前/后，更新 topOrder 并回调保存到 settings。
 */
export function moveTopInOrder(view: TreeEditHost, sourceId: string, targetId: string, before: boolean): void {
  const roots = buildFrameworkTree(view.pipe, view.topOrder);
  const order = roots.map((r) => r.nodeId);
  const srcIdx = order.indexOf(sourceId);
  if (srcIdx < 0) return;
  order.splice(srcIdx, 1);
  let insertAt = order.indexOf(targetId);
  if (insertAt < 0) insertAt = order.length;
  if (!before) insertAt += 1;
  order.splice(insertAt, 0, sourceId);
  view.topOrder = order;
  view.onTopOrderChange?.(order);
  view.renderLeft();
}

/**
 * 跨父移动：旧父 follows 移除 sourceId → 新父 follows 在目标行前/后插入 → 展开新父并重渲染
 *
 * 只动**涉及的那两个父**的 follows，不写被移动节点自己 —— 归属只由父侧记录（父 → 子单向，
 * 见 AffiliationFields），所以这里也不需要更新 source 的 parent 字段（那个字段已废弃）。
 */
export function moveChildAcrossParents(
  view: NodeEditHost,
  sourceParentId: string,
  sourceId: string,
  targetParentId: string,
  targetId: string,
  before: boolean,
): void {
  const srcParent = view.pipe.GET_Node(sourceParentId);
  if (srcParent) {
    const oldFollows = [...(srcParent.follows ?? [])];
    const i = oldFollows.indexOf(sourceId);
    if (i >= 0) {
      oldFollows.splice(i, 1);
      view.pipe.EXEC_Mutation({
        op: 'update',
        kind: srcParent.kind,
        nodeId: sourceParentId,
        updates: { follows: oldFollows, modify: new Date().toISOString() },
      });
    }
  }
  const tgtParent = view.pipe.GET_Node(targetParentId);
  if (tgtParent) {
    const newFollows = [...(tgtParent.follows ?? [])];
    let insertAt = newFollows.indexOf(targetId);
    if (insertAt < 0) insertAt = newFollows.length;
    if (!before) insertAt += 1;
    newFollows.splice(insertAt, 0, sourceId);
    view.pipe.EXEC_Mutation({
      op: 'update',
      kind: tgtParent.kind,
      nodeId: targetParentId,
      updates: { follows: newFollows, modify: new Date().toISOString() },
    });
  }
  // 展开新父（右栏拖拽）并刷新视图
  view.expandedRight.add(targetParentId);
  view.renderRight();
}
