/**
 * C2_Tree — 拖拽落点解析与合法性判定（纯逻辑，不接触数据层）
 *
 * 从 P6_Views/design/drag.ts 迁入并解耦：原实现以 `DesignView` 为第一参数、直接读
 * `view.nodeCache` 与 `view.selectedFrameworkId`；这里改为只依赖一个最小的查询接口
 * `DragQuery`（由调用方注入），本层因此不 import 数据层、也不依赖任何视图对象。
 *
 * 拆分原则（见 P7_Render/Render.md）：
 * - **判定**（落点 / 能否落）在本层：纯规则 + 读 DOM 上的 `data-*`，无副作用
 * - **执行**（改 follows / parent、写盘、重排）在调用方：本层只回传意图，由注入的
 *   `NodeTreeActions` 回调去落实
 */

import { NODE_KIND, getAllowedChildKinds, isFrameworkKind } from "../../../P4_Nodes/NodeFacade";
import type { NodeKindValue } from "../../../P4_Nodes/NodeKind/NodeKind";

/** 证据类型（对象 / 条件 / 信息 / 状态）：可跨父拖拽随意更改从属 */
export const EVIDENCE_KINDS: NodeKindValue[] = [
    NODE_KIND.FACTOR,
    NODE_KIND.REQUEST,
    NODE_KIND.CLUE,
    NODE_KIND.SNAPSHOT,
];

/** 拖拽源（由调用方在 dragstart 时记录） */
export interface DragSource {
    sourceId: string;
    parentId: string;
    /** 源节点类型：拖拽开始时取一次，判定热路径不再回查缓存 */
    kind?: NodeKindValue;
}

/** 落点：目标行 + 三段式区域（上方=同级前、中心=子级末尾、下方=同级后） */
export interface DropTarget {
    /** 目标行元素（调用方如需高亮可读它的 `data-*`） */
    row: HTMLElement;
    nodeId: string;
    parentId: string;
    zone: "above" | "middle" | "below";
    /** 目标行类型（读行上的 data-kind）：热路径据此判断，同样不回查缓存 */
    kind?: NodeKindValue;
}

/** 判定所需的最小查询能力（由调用方注入） */
export interface DragQuery {
    /** 读节点类型 */
    kindOf(nodeId: string): NodeKindValue | undefined;
    /** 当前选中的框架 id（空白落点用；未选中返回 null） */
    selectedFrameworkId(): string | null;
}

/**
 * 解析拖拽落点：读目标行上的 `data-node-id` / `data-parent-id` / `data-kind`（行组件写入），
 * 按鼠标在行内的纵向比例分三段：上 1/3 = 同级前、中 1/3 = 子级末尾、下 1/3 = 同级后。
 */
export function resolveDropTarget(e: DragEvent): DropTarget | null {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".seqtk-row, .seqtk-frame-item");
    if (!el) return null;
    const nodeId = el.dataset.nodeId ?? "";
    const parentId = el.dataset.parentId ?? "";
    if (!nodeId) return null;
    const rect = el.getBoundingClientRect();
    const ratio = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0;
    const zone: DropTarget["zone"] = ratio < 1 / 3 ? "above" : ratio > 2 / 3 ? "below" : "middle";
    // 类型与 id 一样随行携带：判落点因此不必回查缓存
    const kind = (el.dataset.kind as NodeKindValue | undefined) || undefined;
    return { row: el, nodeId, parentId, zone, kind };
}

/**
 * 落点合法性：
 * - above / below（同级前 / 后）→ 添加到同级；跨父时按类型规则约束
 * - middle（中心）→ 作为目标节点的子级（插入其子列表末尾）
 * 约束：证据类型可随意；event 仅限框架与「目标」之间；其余按允许子类型规则。
 */
/**
 * 某类型能否成为某父类型的直接子
 *
 * 「变更归属」的候选列表与拖拽的「中心落点」共用这一条判定 —— 两处各写一套，
 * 就会出现「拖不进去、却能从候选列表里选出来」的不一致。
 * 规则：证据类型随处可挂；事件只在框架与「目标」之间；其余按允许子类型表。
 */
export function canBeChildOf(parentKind: NodeKindValue, childKind: NodeKindValue): boolean {
    if (EVIDENCE_KINDS.includes(childKind)) return true;
    if (childKind === NODE_KIND.EVENT) {
        return isFrameworkKind(parentKind) || parentKind === NODE_KIND.TARGET;
    }
    return getAllowedChildKinds(parentKind).includes(childKind);
}

export function canDrop(q: DragQuery, source: DragSource, target: DropTarget): boolean {
    if (target.nodeId === source.sourceId) return false;
    // 类型优先取拖拽源 / 目标行随身携带的那一份（源在 dragstart 时算好，目标行渲染时写进 DOM）。
    // 判落点是热路径 —— 鼠标每动一次都要对经过的行判一次 —— 所以这里不再回查缓存，
    // 只有两侧都缺类型（非行元素 / 老数据）时才退化为一次查询。
    const srcKind = source.kind ?? q.kindOf(source.sourceId);
    if (!srcKind) return false;

    // 中心：成为目标节点的子级
    if (target.zone === "middle") {
        const targetKind = target.kind ?? q.kindOf(target.nodeId);
        if (!targetKind) return false;
        return canBeChildOf(targetKind, srcKind);
    }

    // 上方 / 下方：同级
    if (target.parentId === source.parentId) return true;
    if (EVIDENCE_KINDS.includes(srcKind)) return true;
    if (srcKind === NODE_KIND.EVENT) {
        const srcParentKind = q.kindOf(source.parentId);
        const tgtParentKind = q.kindOf(target.parentId);
        const isFramework = (k: NodeKindValue | undefined): boolean => !!k && isFrameworkKind(k);
        return (
            (isFramework(srcParentKind) && tgtParentKind === NODE_KIND.TARGET) ||
            (srcParentKind === NODE_KIND.TARGET && isFramework(tgtParentKind))
        );
    }
    return false;
}

/**
 * 空白落点判定：source 可否改为「当前选中框架」的直属子节点
 * （仅对容许目标为框架的类型生效；证据任意、event 仅框架、其余按层级规则）
 */
export function canDropToFrameworkBlank(q: DragQuery, source: DragSource): boolean {
    const fwId = q.selectedFrameworkId();
    if (!fwId) return false;
    const fwKind = q.kindOf(fwId);
    if (!fwKind) return false;
    const srcKind = q.kindOf(source.sourceId);
    if (!srcKind) return false;
    return canBeChildOf(fwKind, srcKind);
}

/** 拖拽指示 class（由行组件按 dropHint props 渲染；此处给出状态与 class 的对应） */
export const DROP_HINT_CLASS: Record<DropTarget["zone"] | "invalid", string> = {
    above: "seqtk-drop-before",
    below: "seqtk-drop-after",
    middle: "seqtk-drop-child",
    invalid: "seqtk-drop-invalid",
};
