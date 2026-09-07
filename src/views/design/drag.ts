/**
 * design/drag — 设计视图拖拽排序引擎切片
 *
 * 从 DesignView 拆出的拖拽「判定 + 执行 + 状态清理」逻辑:
 * 落点解析(resolveDropTarget)、合法性判定(canDrop / canDropToFrameworkBlank)、
 * 移动执行(moveChildInFollows / moveTopInOrder / moveChildAcrossParents)、
 * 指示清理(clearDropIndicators)与右键取消安装(installDragCancelHandler)。
 * DOM 行上的 dragstart/dragover/drop 事件绑定保留在 DesignView 的行渲染中,
 * 本文件只负责纯逻辑与落盘副作用。
 *
 * 功能增补指引:
 * - 调整拖拽可落点规则 → 改 canDrop / canDropToFrameworkBlank
 * - 调整排序持久化方式 → 改 moveChildInFollows / moveTopInOrder
 */

import type { DesignView } from '../DesignView';
import type { NodeKind } from '../../types/index';
import { getAllowedChildKinds, isFrameworkKind } from '../../types/index';
import { buildFrameworkTree } from './tree';

/** 证据类型（对象/条件/信息/状态）：可跨父拖拽随意更改从属 */
export const EVIDENCE_KINDS: NodeKind[] = ['factor', 'requirement', 'clue', 'snapshot'];

/** 解析拖拽落点：目标行（右栏 .seqtk-row / 左栏 .seqtk-frame-item）+ 三段式区域（上方=同级前、中心=子级末尾、下方=同级后）；顶级行 parentId 为空串 */
export function resolveDropTarget(e: DragEvent): { row: HTMLElement; nodeId: string; parentId: string; zone: 'above' | 'middle' | 'below' } | null {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.seqtk-row, .seqtk-frame-item');
  if (!el) return null;
  const nodeId = el.dataset.nodeId ?? '';
  const parentId = el.dataset.parentId ?? '';
  if (!nodeId) return null;
  const rect = el.getBoundingClientRect();
  const ratio = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0;
  const zone: 'above' | 'middle' | 'below' = ratio < 1 / 3 ? 'above' : ratio > 2 / 3 ? 'below' : 'middle';
  return { row: el, nodeId, parentId, zone };
}

/** 在同父 follows 中把 sourceId 移到 targetId 前/后，持久化并重渲染 */
export function moveChildInFollows(view: DesignView, parentId: string, sourceId: string, targetId: string, before: boolean): void {
  const parent = view.nodeCache.getNode(parentId);
  if (!parent) {
    // console.log('[SeqTK] moveChildInFollows: 父节点不存在', parentId);
    return;
  }
  const follows = [...(parent.follows ?? [])];
  const srcIdx = follows.indexOf(sourceId);
  // 数据不一致容错：source 不在父 follows 中（历史遗留/缺失）时跳过移除，仍按目标位置插入——
  // "添加到同级"始终生效，并顺带修复父 follows 数据
  if (srcIdx >= 0) follows.splice(srcIdx, 1);
  let insertAt = follows.indexOf(targetId);
  if (insertAt < 0) insertAt = follows.length;
  if (!before) insertAt += 1;
  follows.splice(insertAt, 0, sourceId);
  // console.log('[SeqTK] moveChildInFollows 新 follows=', follows);
  view.operationQueue.enqueue(
    () => view.nodeCache.updateNode(parentId, { follows, modify: new Date().toISOString() }),
    async () => { await view.fileManager.updateNode(parent.kind, parentId, { follows }); },
  );
  view.renderRight();
}

/**
 * 顶级框架排序：以当前渲染顺序（topFrameworkOrder + 未列入按创建时间）重建数组，
 * 将 sourceId 移到 targetId 前/后，更新 topOrder 并回调保存到 settings。
 */
export function moveTopInOrder(view: DesignView, sourceId: string, targetId: string, before: boolean): void {
  const roots = buildFrameworkTree(view.nodeCache, view.topOrder);
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
 * 拖拽落点判定（三段式区域）：
 * - above/below（上方/下方）→ 添加到同级（目标前/后）
 * - middle（中心）→ 添加到目标子级末尾（目标作为新父）
 * 跨父/跨级约束：证据类型可随意；event 仅限框架与目标（target）之间；其余按层级规则。
 */
export function canDrop(
  view: DesignView,
  source: { sourceId: string; parentId: string },
  target: { nodeId: string; parentId: string; zone: 'above' | 'middle' | 'below' },
): boolean {
  if (target.nodeId === source.sourceId) return false;
  const src = view.nodeCache.getNode(source.sourceId);
  if (!src) return false;

  // 中心：成为目标节点的子级（新父 = target，插入子列表末尾）
  if (target.zone === 'middle') {
    const targetKind = view.nodeCache.getNode(target.nodeId)?.kind;
    if (!targetKind) return false;
    if (EVIDENCE_KINDS.includes(src.kind as NodeKind)) return true;
    if (src.kind === 'event') return isFrameworkKind(targetKind) || targetKind === 'target';
    return getAllowedChildKinds(targetKind).includes(src.kind);
  }

  // 上方/下方：目标父集合中目标前/后（同父排序 / 跨父按类型约束）
  if (target.parentId === source.parentId) return true;
  const srcParentKind = view.nodeCache.getNode(source.parentId)?.kind;
  const tgtParentKind = view.nodeCache.getNode(target.parentId)?.kind;
  if (EVIDENCE_KINDS.includes(src.kind as NodeKind)) return true;
  if (src.kind === 'event') {
    const isFramework = (k: NodeKind | undefined): boolean => !!k && isFrameworkKind(k);
    return (isFramework(srcParentKind) && tgtParentKind === 'target')
      || (srcParentKind === 'target' && isFramework(tgtParentKind));
  }
  return false;
}

/**
 * 空白落点判定：source 可否改为选中框架的直属子节点（仅对容许目标为框架的类型生效）。
 * 证据任意；event 仅框架；其余按选中框架的 getChildKinds 层级规则。未选中框架（总览）不生效。
 */
export function canDropToFrameworkBlank(view: DesignView, source: { sourceId: string; parentId: string }): boolean {
  const fwId = view.selectedFrameworkId;
  if (!fwId) return false;
  const fw = view.nodeCache.getNode(fwId);
  if (!fw) return false;
  const src = view.nodeCache.getNode(source.sourceId);
  if (!src) return false;
  if (EVIDENCE_KINDS.includes(src.kind as NodeKind)) return true;
  if (src.kind === 'event') return isFrameworkKind(fw.kind);
  return getAllowedChildKinds(fw.kind).includes(src.kind);
}

/**
 * 跨父移动：旧父 follows 移除 sourceId → 新父 follows 在目标行前/后插入 → source 节点 parent 更新，
 * 三者均走 OperationQueue（缓存立即 + MD 延迟写盘）；展开新父并重渲染。
 */
export function moveChildAcrossParents(
  view: DesignView,
  sourceParentId: string,
  sourceId: string,
  targetParentId: string,
  targetId: string,
  before: boolean,
): void {
  const srcParent = view.nodeCache.getNode(sourceParentId);
  if (srcParent) {
    const oldFollows = [...(srcParent.follows ?? [])];
    const i = oldFollows.indexOf(sourceId);
    if (i >= 0) {
      oldFollows.splice(i, 1);
      view.operationQueue.enqueue(
        () => view.nodeCache.updateNode(sourceParentId, { follows: oldFollows, modify: new Date().toISOString() }),
        async () => { await view.fileManager.updateNode(srcParent.kind, sourceParentId, { follows: oldFollows }); },
      );
    }
  }
  const tgtParent = view.nodeCache.getNode(targetParentId);
  if (tgtParent) {
    const newFollows = [...(tgtParent.follows ?? [])];
    let insertAt = newFollows.indexOf(targetId);
    if (insertAt < 0) insertAt = newFollows.length;
    if (!before) insertAt += 1;
    newFollows.splice(insertAt, 0, sourceId);
    view.operationQueue.enqueue(
      () => view.nodeCache.updateNode(targetParentId, { follows: newFollows, modify: new Date().toISOString() }),
      async () => { await view.fileManager.updateNode(tgtParent.kind, targetParentId, { follows: newFollows }); },
    );
  }
  const src = view.nodeCache.getNode(sourceId);
  if (src) {
    view.operationQueue.enqueue(
      () => view.nodeCache.updateNode(sourceId, { parent: targetParentId, modify: new Date().toISOString() }),
      async () => { await view.fileManager.updateNode(src.kind, sourceId, { parent: targetParentId }); },
    );
  }
  // 展开新父（右栏拖拽）并刷新视图
  view.expandedRight.add(targetParentId);
  view.renderRight();
}

/** 清除左右栏所有拖拽指示样式（含右栏空白落点指示） */
export function clearDropIndicators(view: DesignView): void {
  for (const root of [view.leftEl, view.rightEl]) {
    root.removeClass('seqtk-drop-blank');
    root.querySelectorAll('.seqtk-drop-before, .seqtk-drop-after, .seqtk-drop-child, .seqtk-drop-invalid')
      .forEach((el) => {
        el.removeClass('seqtk-drop-before');
        el.removeClass('seqtk-drop-after');
        el.removeClass('seqtk-drop-child');
        el.removeClass('seqtk-drop-invalid');
      });
  }
}

/**
 * 拖拽中右键取消处理器安装（document contextmenu，捕获阶段）：
 * 阻止默认菜单并清理拖拽状态。返回处理器引用，供 onClose 时 removeEventListener。
 */
export function installDragCancelHandler(view: DesignView): (e: MouseEvent) => void {
  const handler = (e: MouseEvent): void => {
    if (!view.dragSource) return;
    e.preventDefault();
    e.stopPropagation();
    view.dragSource = null;
    clearDropIndicators(view);
    view.leftEl.querySelectorAll('.seqtk-dragging').forEach((el) => el.removeClass('seqtk-dragging'));
    view.rightEl.querySelectorAll('.seqtk-dragging').forEach((el) => el.removeClass('seqtk-dragging'));
  };
  document.addEventListener('contextmenu', handler, true);
  return handler;
}
