/**
 * design/drag — 拖拽的「执行」切片
 *
 * 判定（落点解析 / 能否落）已迁到 `P7_Render/Composition/C2_Tree/drag.ts`（纯逻辑，不接触
 * 数据层，`EVIDENCE_KINDS` 也在那里）。本文件只保留**需要写数据**的部分：同父排序、
 * 顶级排序、跨父移动 —— 仍以 `view` 为第一参数，但它们经 **pipe.EXEC_Mutation** 落盘，
 * 不再直连 nodeCache / fileManager / operationQueue。
 *
 * 事件绑定不再在这里（原来的 dragstart/dragover/drop 挂在行 DOM 上）：现在由 P7_Render 的
 * 行组件发出回调，`DesignView` 接住、判定后，把「移动意图」交给这里的函数执行。
 *
 * 指示清理（原 clearDropIndicators / installDragCancelHandler）也不再需要：行上的拖拽
 * 指示由 `NodeLineData.dragging` / `dropHint` 驱动，清状态即清指示。
 */

import type { DesignView } from '../Core/Design';
import { buildFrameworkTree } from '../Tool/tree';

/** 在同父 follows 中把 sourceId 移到 targetId 前/后，持久化并重渲染 */
export function moveChildInFollows(view: DesignView, parentId: string, sourceId: string, targetId: string, before: boolean): void {
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
export function moveTopInOrder(view: DesignView, sourceId: string, targetId: string, before: boolean): void {
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
 * 跨父移动：旧父 follows 移除 sourceId → 新父 follows 在目标行前/后插入 → source 节点
 * parent 更新，三者各为一条 update 写意图（缓存立即 + MD 延迟写盘）；展开新父并重渲染。
 */
export function moveChildAcrossParents(
  view: DesignView,
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
  const src = view.pipe.GET_Node(sourceId);
  if (src) {
    view.pipe.EXEC_Mutation({
      op: 'update',
      kind: src.kind,
      nodeId: sourceId,
      updates: { parent: targetParentId, modify: new Date().toISOString() },
    });
  }
  // 展开新父（右栏拖拽）并刷新视图
  view.expandedRight.add(targetParentId);
  view.renderRight();
}
