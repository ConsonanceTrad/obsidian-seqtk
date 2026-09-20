/**
 * design/dragHandlers — 拖拽事件切片
 *
 * 从视图拆出的拖拽事件处理：dragstart / dragover / drop 与「拖到右栏空白」那一组，
 * 外加「拖拽中右键取消」的全局监听工厂。
 *
 * 约定:
 * - 本文件函数以 host(TreeEditHost 实例)为第一参数 —— 原先收 DesignView，
 *   但只用到 pipe / containerEl / selectedFrameworkId / dragSource / draggingId / refresh
 *   这几个成员，抽成接口（见 Slice/treeEditHost）后线路模式的左栏框架树可直接复用
 * - **落点提示不进视图状态**：行上的 `seqtk-drop-*` 与右栏空白的 `seqtk-drop-blank` 由本文件
 *   直接切 class。拖拽期间每帧走全量 refresh 重建整棵树，既拖不跟手（树越大越明显），
 *   也会让提示在相邻行之间一加一删地闪。C2_Tree 的落点契约本就允许调用方读 `target.row`
 *   自行高亮（见 C2_Tree/drag 里 DropTarget 的注释），这里走的正是那条路。
 * - **光标恒为 move**：不可放置只用行内配色（`seqtk-drop-invalid`）表达。
 *   在 none / move 之间来回切，光标就会在「禁止」与「移动」之间闪。
 * - 判定用 P7_Render/Composition/C2_Tree/drag（纯逻辑），执行用 design/drag（写数据）——
 *   本文件只负责「接住 DOM 事件 → 判定 → 转交」，不自己写数据、不碰节点树
 *
 * 功能增补指引:
 * - 新增一种拖拽（如拖到时间轴）→ 在此加一组 dragover/drop，并复用同一套判定函数
 */

import type { NodeLineCtx, NodeLineDropHint } from '../../../../P7_Render/Composition/C1_NodeLine/NodeLine';
import {
    DROP_HINT_CLASS,
    canDrop as canDropByTarget,
    canDropToFrameworkBlank,
    resolveDropTarget,
    type DragQuery,
} from '../../../../P7_Render/Composition/C2_Tree/drag';
import { moveChildAcrossParents, moveChildInFollows, moveTopInOrder } from './drag';
import type { TreeSide } from '../Core/DesignPanel';
import type { TreeEditHost } from './treeEditHost';

/** 落点提示 class 全清单（清理时一次摘掉，避免残留） */
const HINT_CLASSES = Object.values(DROP_HINT_CLASS);

/** 提示语义 → class（before/after/child 与 zone 名不同名，这里做一次显式对应） */
const HINT_CLASS: Record<NodeLineDropHint, string> = {
    before: DROP_HINT_CLASS.above,
    after: DROP_HINT_CLASS.below,
    child: DROP_HINT_CLASS.middle,
    invalid: DROP_HINT_CLASS.invalid,
};

/** 右栏空白高亮 class（与 DesignPanel 的右栏容器对应） */
const BLANK_CLASS = 'seqtk-drop-blank';

/**
 * 拖拽期间的命令式状态（切片私有，不落到 host 上）
 *
 * - `row`：当前带提示 class 的行；`blank`：当前高亮的右栏容器
 * - `raf`：dragover 的同帧合并句柄 —— 鼠标每动一次都量几何、切 class 没有必要
 */
interface HintState {
    row: HTMLElement | null;
    blank: HTMLElement | null;
    raf: number;
}
const HINTS = new WeakMap<TreeEditHost, HintState>();

function hintState(host: TreeEditHost): HintState {
    let st = HINTS.get(host);
    if (!st) {
        st = { row: null, blank: null, raf: 0 };
        HINTS.set(host, st);
    }
    return st;
}

/** 判定所需的最小查询能力（注入给 C2_Tree/drag） */
export function dragQuery(host: TreeEditHost): DragQuery {
    return {
        kindOf: (nodeId) => host.pipe.GET_Node(nodeId)?.kind,
        selectedFrameworkId: () => host.selectedFrameworkId,
    };
}

/** 摘掉行/空白提示（拖拽结束、离开整行、落点失效时调用） */
export function clearDropHint(host: TreeEditHost): void {
    const st = hintState(host);
    if (st.raf) {
        cancelAnimationFrame(st.raf);
        st.raf = 0;
    }
    if (st.row) {
        st.row.classList.remove(...HINT_CLASSES);
        st.row = null;
    }
    if (st.blank) {
        st.blank.classList.remove(BLANK_CLASS);
        st.blank = null;
    }
}

/** 把提示挂到目标行上；同一行同一个提示不重复动 DOM */
function applyRowHint(host: TreeEditHost, row: HTMLElement, hint: NodeLineDropHint | null): void {
    const st = hintState(host);
    if (!hint) {
        if (st.row === row) {
            row.classList.remove(...HINT_CLASSES);
            st.row = null;
        }
        return;
    }
    const cls = HINT_CLASS[hint];
    if (st.row === row && row.classList.contains(cls)) return;
    if (st.row && st.row !== row) st.row.classList.remove(...HINT_CLASSES);
    row.classList.add(cls);
    st.row = row;
}

/** 右栏空白高亮：直接切容器 class */
function applyBlankHint(host: TreeEditHost, on: boolean): void {
    const st = hintState(host);
    if (on) {
        if (st.blank) return;
        const pane = host.containerEl.querySelector<HTMLElement>('.seqtk-split-right');
        if (!pane) return;
        pane.classList.add(BLANK_CLASS);
        st.blank = pane;
        return;
    }
    if (!st.blank) return;
    st.blank.classList.remove(BLANK_CLASS);
    st.blank = null;
}

export function onDragStart(host: TreeEditHost, ctx: NodeLineCtx, e: DragEvent): void {
    host.dragSource = { sourceId: ctx.nodeId, parentId: ctx.parentId, kind: host.pipe.GET_Node(ctx.nodeId)?.kind };
    const dt = e.dataTransfer;
    if (dt) {
        dt.setData('text/plain', JSON.stringify(host.dragSource));
        dt.effectAllowed = 'move';
    }
    host.draggingId = ctx.nodeId;
    host.refresh();
}

export function onDragEnd(host: TreeEditHost): void {
    host.dragSource = null;
    host.draggingId = null;
    clearDropHint(host);
    // 拖拽期间的行/空白提示都是命令式加的 class，收尾刷一次让 React 的 className 与之一致
    host.refresh();
}

export function onDragOver(host: TreeEditHost, ctx: NodeLineCtx, side: TreeSide, e: DragEvent): void {
    const source = host.dragSource;
    if (!source) return;
    e.preventDefault();
    // 光标保持「可移动」：不可放置交给行内配色表达（见文件头说明）
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    // 同一帧内的多次 dragover 只处理最后一次：几何测量与 class 切换都不必按事件频率跑
    const st = hintState(host);
    if (st.raf) return;
    st.raf = requestAnimationFrame(() => {
        st.raf = 0;
        const src = host.dragSource;
        if (!src) return;
        const target = resolveDropTarget(e);
        if (!target) {
            clearDropHint(host);
            return;
        }
        let hint: NodeLineDropHint;
        if (side === 'left') {
            // 左栏仅同父同级排序：上方→目标前、下方→目标后；中心（子级）与跨父/跨级驳回
            const ok = target.parentId === src.parentId && target.nodeId !== src.sourceId && target.zone !== 'middle';
            hint = ok ? (target.zone === 'above' ? 'before' : 'after') : 'invalid';
        } else if (canDropByTarget(dragQuery(host), src, target)) {
            hint = target.zone === 'above' ? 'before' : target.zone === 'below' ? 'after' : 'child';
        } else {
            hint = 'invalid';
        }
        applyRowHint(host, target.row, hint);
    });
    void ctx;
}

/**
 * 离开某一行
 *
 * 行内子元素之间移动会连着触发 leave / over：只有指针真的离开带提示的那一行
 * （relatedTarget 不在行内）才摘提示，否则提示会一摘一挂地闪。
 */
export function onDragLeave(host: TreeEditHost, e: DragEvent): void {
    const st = hintState(host);
    const to = e.relatedTarget as Node | null;
    if (st.row && to && st.row.contains(to)) return;
    if (st.row) {
        st.row.classList.remove(...HINT_CLASSES);
        st.row = null;
    }
}

export function onDrop(host: TreeEditHost, ctx: NodeLineCtx, side: TreeSide, e: DragEvent): void {
    const source = host.dragSource;
    void ctx;
    clearDropHint(host);
    if (!source) return;
    e.preventDefault();
    const target = resolveDropTarget(e);
    if (!target) return;

    if (side === 'left') {
        if (target.zone !== 'middle' && target.parentId === source.parentId && target.nodeId !== source.sourceId) {
            const before = target.zone === 'above';
            if (source.parentId) moveChildInFollows(host, source.parentId, source.sourceId, target.nodeId, before);
            else moveTopInOrder(host, source.sourceId, target.nodeId, before);
        }
    } else if (canDropByTarget(dragQuery(host), source, target)) {
        if (target.zone === 'middle') {
            moveChildAcrossParents(host, source.parentId, source.sourceId, target.nodeId, '', false);
        } else {
            const before = target.zone === 'above';
            if (target.parentId === source.parentId) {
                moveChildInFollows(host, source.parentId, source.sourceId, target.nodeId, before);
            } else {
                moveChildAcrossParents(host, source.parentId, source.sourceId, target.parentId, target.nodeId, before);
            }
        }
    }
    host.dragSource = null;
    host.draggingId = null;
    host.refresh();
}

/** 拖到右栏空白：改为选中框架的直属子节点 */
export function onBlankDragOver(host: TreeEditHost, e: DragEvent): void {
    const source = host.dragSource;
    if (!source || !canDropToFrameworkBlank(dragQuery(host), source)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    clearDropHint(host);
    applyBlankHint(host, true);
}

export function onBlankDragLeave(host: TreeEditHost, e: DragEvent): void {
    // 只有真正离开窗口（relatedTarget 为空）才清理，避免在栏内子元素间移动时闪烁
    if (e.relatedTarget) return;
    applyBlankHint(host, false);
}

export function onBlankDrop(host: TreeEditHost, e: DragEvent): void {
    const source = host.dragSource;
    if (!source || !canDropToFrameworkBlank(dragQuery(host), source)) return;
    e.preventDefault();
    applyBlankHint(host, false);
    moveChildAcrossParents(host, source.parentId, source.sourceId, host.selectedFrameworkId!, '', false);
    host.dragSource = null;
    host.draggingId = null;
    host.refresh();
}

/**
 * 绑定「拖拽进行中右键」监听器
 *
 * 以工厂形式返回，是因为它要挂成视图上的箭头函数字段；字段初始化器先于 constructor 体执行，
 * 故工厂内只捕获 host 引用，字段要等事件触发时再读。
 */
export function bindDocumentContextMenu(host: TreeEditHost): (e: MouseEvent) => void {
    return (e: MouseEvent): void => {
        if (!host.dragSource) return;
        e.preventDefault();
        e.stopPropagation();
        host.dragSource = null;
        host.draggingId = null;
        clearDropHint(host);
    };
}
