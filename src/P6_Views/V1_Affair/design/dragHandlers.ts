/**
 * design/dragHandlers — 设计视图拖拽事件切片
 *
 * 从 DesignView 拆出的拖拽事件处理：dragstart / dragover / drop 与「拖到右栏空白」那一组，
 * 外加「拖拽中右键取消」的全局监听工厂。
 *
 * 约定:
 * - 本文件函数以 view(DesignView 实例)为第一参数,只读写 view 上公开的状态
 *   （pipe / selectedFrameworkId / dragSource / draggingId / dropHint / dropBlank / refresh）
 * - 判定用 P7_Render/Composition/C2_Tree/drag（纯逻辑），执行用 design/drag（写数据）——
 *   本文件只负责「接住 DOM 事件 → 判定 → 转交」，不自己写数据、不碰节点树
 * - 落点提示走 view.dropHint（viewState 把它转成行覆盖信息），组件据此画指示线
 *
 * 功能增补指引:
 * - 新增一种拖拽（如拖到时间轴）→ 在此加一组 dragover/drop，并复用同一套判定函数
 */

import type { NodeLineCtx, NodeLineDropHint } from '../../../P7_Render/Composition/C1_NodeLine/NodeLine';
import {
    canDrop as canDropByTarget,
    canDropToFrameworkBlank,
    resolveDropTarget,
    type DragQuery,
} from '../../../P7_Render/Composition/C2_Tree/drag';
import { moveChildAcrossParents, moveChildInFollows, moveTopInOrder } from './drag';
import type { TreeSide } from '../DesignPanel';
import type { DesignView } from '../Design';

/** 判定所需的最小查询能力（注入给 C2_Tree/drag） */
export function dragQuery(view: DesignView): DragQuery {
    return {
        kindOf: (nodeId) => view.pipe.GET_Node(nodeId)?.kind,
        selectedFrameworkId: () => view.selectedFrameworkId,
    };
}

export function onDragStart(view: DesignView, ctx: NodeLineCtx, e: DragEvent): void {
    view.dragSource = { sourceId: ctx.nodeId, parentId: ctx.parentId, kind: view.pipe.GET_Node(ctx.nodeId)?.kind };
    const dt = e.dataTransfer;
    if (dt) {
        dt.setData('text/plain', JSON.stringify(view.dragSource));
        dt.effectAllowed = 'move';
    }
    view.draggingId = ctx.nodeId;
    view.refresh();
}

export function onDragEnd(view: DesignView): void {
    view.dragSource = null;
    view.draggingId = null;
    clearDropHint(view);
}

export function onDragOver(view: DesignView, ctx: NodeLineCtx, side: TreeSide, e: DragEvent): void {
    const source = view.dragSource;
    if (!source) return;
    e.preventDefault();
    const target = resolveDropTarget(e);
    if (!target) return;
    let hint: NodeLineDropHint | null = null;
    if (side === 'left') {
        // 左栏仅同父同级排序：上方→目标前、下方→目标后；中心（子级）与跨父/跨级驳回
        const ok = target.parentId === source.parentId && target.nodeId !== source.sourceId && target.zone !== 'middle';
        hint = ok ? (target.zone === 'above' ? 'before' : 'after') : 'invalid';
    } else if (canDropByTarget(dragQuery(view), source, target)) {
        hint = target.zone === 'above' ? 'before' : target.zone === 'below' ? 'after' : 'child';
    } else {
        hint = 'invalid';
    }
    if (e.dataTransfer) e.dataTransfer.dropEffect = hint === 'invalid' ? 'none' : 'move';
    setDropHint(view, target.nodeId, hint);
    void ctx;
}

export function onDrop(view: DesignView, ctx: NodeLineCtx, side: TreeSide, e: DragEvent): void {
    const source = view.dragSource;
    void ctx;
    clearDropHint(view);
    if (!source) return;
    e.preventDefault();
    const target = resolveDropTarget(e);
    if (!target) return;

    if (side === 'left') {
        if (target.zone !== 'middle' && target.parentId === source.parentId && target.nodeId !== source.sourceId) {
            const before = target.zone === 'above';
            if (source.parentId) moveChildInFollows(view, source.parentId, source.sourceId, target.nodeId, before);
            else moveTopInOrder(view, source.sourceId, target.nodeId, before);
        }
    } else if (canDropByTarget(dragQuery(view), source, target)) {
        if (target.zone === 'middle') {
            moveChildAcrossParents(view, source.parentId, source.sourceId, target.nodeId, '', false);
        } else {
            const before = target.zone === 'above';
            if (target.parentId === source.parentId) {
                moveChildInFollows(view, source.parentId, source.sourceId, target.nodeId, before);
            } else {
                moveChildAcrossParents(view, source.parentId, source.sourceId, target.parentId, target.nodeId, before);
            }
        }
    }
    view.dragSource = null;
    view.draggingId = null;
    view.refresh();
}

/** 拖到右栏空白：改为选中框架的直属子节点 */
export function onBlankDragOver(view: DesignView, e: DragEvent): void {
    const source = view.dragSource;
    if (!source || !canDropToFrameworkBlank(dragQuery(view), source)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    clearDropHint(view);
    if (!view.dropBlank) {
        view.dropBlank = true;
        view.refresh();
    }
}

export function onBlankDragLeave(view: DesignView, e: DragEvent): void {
    // 只有真正离开窗口（relatedTarget 为空）才清理，避免在栏内子元素间移动时闪烁
    if (e.relatedTarget) return;
    if (!view.dropBlank) return;
    view.dropBlank = false;
    view.refresh();
}

export function onBlankDrop(view: DesignView, e: DragEvent): void {
    const source = view.dragSource;
    if (!source || !canDropToFrameworkBlank(dragQuery(view), source)) return;
    e.preventDefault();
    view.dropBlank = false;
    moveChildAcrossParents(view, source.parentId, source.sourceId, view.selectedFrameworkId!, '', false);
    view.dragSource = null;
    view.draggingId = null;
    view.refresh();
}

export function setDropHint(view: DesignView, nodeId: string, hint: NodeLineDropHint | null): void {
    if (!hint) return clearDropHint(view);
    if (view.dropHint?.nodeId === nodeId && view.dropHint.hint === hint) return;
    view.dropHint = { nodeId, hint };
    view.refresh();
}

export function clearDropHint(view: DesignView): void {
    if (!view.dropHint) return;
    view.dropHint = null;
    view.refresh();
}

/**
 * 绑定「拖拽进行中右键」监听器
 *
 * 以工厂形式返回，是因为它要挂成视图上的箭头函数字段；字段初始化器先于 constructor 体执行，
 * 故工厂内只捕获 view 引用，字段要等事件触发时再读。
 */
export function bindDocumentContextMenu(view: DesignView): (e: MouseEvent) => void {
    return (e: MouseEvent): void => {
        if (!view.dragSource) return;
        e.preventDefault();
        e.stopPropagation();
        view.dragSource = null;
        view.draggingId = null;
        view.dropBlank = false;
        clearDropHint(view);
    };
}
