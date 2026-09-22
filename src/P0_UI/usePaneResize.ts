/**
 * usePaneResize — 双栏比例把手（拖动改左栏宽度）
 *
 * 拖动期间**不**写 React 状态，直接改左栏元素的宽度；松手才一次性上报，由调用方决定
 * 怎么落盘（通常是防抖写设置）。
 *
 * 为什么不走 state：宽度进 state 会让整个组件每帧重渲（行组件与引导线浮层都在内）——
 * 既拖不跟手，也会把浮层推进「重绘 → 写状态 → 重绘」的自反馈里（React #185，
 * 表现为整块视图闪退）。直接改样式不经过 React，浮层只由它的 ResizeObserver 兜底重画。
 *
 * 现状说明：设计与模板各有一份逐字重复的相同实现、线路那份少了宽度夹取。
 * 本轮只让**流程设计**用上本 hook，那三处按约定暂不动（见计划的「对齐范围」）。
 */

import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** 左栏宽度限值（与设计 / 模板现用的值一致） */
export const PANE_WIDTH_MIN = 160;
export const PANE_WIDTH_MAX = 640;
export const PANE_WIDTH_DEFAULT = 280;

export interface HandleProps {
    role: "separator";
    "aria-orientation": "vertical";
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

export interface PaneResize {
    /** 挂到左栏元素上：拖动期直接改它的 width / flexBasis */
    paneRef: RefObject<HTMLDivElement>;
    /** 展开到把手元素上 */
    handleProps: HandleProps;
}

/**
 * @param width    左栏宽度；**只在首次渲染用来建立拖动基准**，之后由拖动自己维护
 *                 （所以拖动过程中它不必变化，也不会因此失准）
 * @param onCommit 松手时上报最终宽度
 */
export function usePaneResize(width: number, onCommit: (width: number) => void): PaneResize {
    const paneRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startX: number; startW: number } | null>(null);
    /** 拖动期间的权威宽度：拖动中 state 不更新，所以不能回头去读入参 */
    const widthRef = useRef(width);

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
        dragRef.current = { startX: e.clientX, startW: widthRef.current };
        e.currentTarget.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
        const from = dragRef.current;
        if (!from) return;
        const next = Math.min(
            Math.max(from.startW + (e.clientX - from.startX), PANE_WIDTH_MIN),
            PANE_WIDTH_MAX,
        );
        widthRef.current = next;
        const pane = paneRef.current;
        if (pane) {
            pane.style.width = `${next}px`;
            pane.style.flexBasis = `${next}px`;
        }
    };

    const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
        const dragging = dragRef.current !== null;
        dragRef.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
        // 没真拖动过就不上报（点在把手上也会触发 pointerdown/up 这一对）
        if (!dragging) return;
        onCommit(widthRef.current);
    };

    return {
        paneRef,
        handleProps: {
            role: "separator",
            "aria-orientation": "vertical",
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp,
        },
    };
}
