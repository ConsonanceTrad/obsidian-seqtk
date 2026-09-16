/**
 * C2_Tree — 引导线浮层（一层覆盖树容器的 SVG）
 *
 * 引导线不再由每一行各自拼装（行内绝对定位 span + 伪元素拼 linear-gradient + 硬编码
 * 上探长度 + 黑条遮盖），而是作为一层浮层按行的**实测几何**统一绘制。于是这里只做
 * 两件事：量行 → 交给 GET_GuidePath 算 path → 设到 SVG 上。
 *
 * 挂在容器末尾：线绘制在行之上，但列位置落在缩进空白处，不会压到行内容；这样行
 * hover 的背景也不会把线切断。`pointer-events: none` 保证不挡交互。
 *
 * 除了画线，它还负责把「父列相对本行的偏移」写回行的 CSS 变量（--seqtk-parent-x），
 * 供转角方块定位 —— 同一个几何量不重复计算，也就不会两处各说各话。
 *
 * 重绘时机：
 * - 每次组件提交后同步重绘（useLayoutEffect 无依赖）——行增删/展开折叠后必定已经提交
 * - 容器尺寸变化（ResizeObserver）、窗口缩放、容器滚动时异步重绘（兜底）
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { NodeLineMetrics } from "../C1_NodeLine/NodeLine";
import { COLLAPSE_ATTR, DEPTH_ATTR, LAST_ATTR, TREE_ROW_ATTR } from "../C1_NodeLine/NodeLine";
import { GET_GuideGeometry, GET_GuidePath, type GuideRowInput } from "./TreeGuides";

export interface GuideOverlayProps {
    /** 树容器（浮层渲染在它内部，作为最后一个子元素） */
    containerRef: RefObject<HTMLElement | null>;
    metrics: NodeLineMetrics;
}

/** 转角方块边长（与 CSS 里方块尺寸一致） */
const COLLAPSE_BOX = 4;
/** 顶级行的方块距行左上角的内缩 */
const BOX_INSET = 2;
/** 方块半径，用于把中心对准竖线 */
const BOX_HALF = COLLAPSE_BOX / 2;

/**
 * 自反馈闸门：时间窗口与窗口内允许的重绘次数
 *
 * 正常情形下重绘由「一次提交」或「尺寸 / 滚动」驱动，每帧最多一两次；
 * 一旦某个几何量在两次提交之间反复变化，就会变成
 * 「重绘 → 写状态 → 重新提交 → 再重绘」，一路撞上 React 的
 * Maximum update depth exceeded（#185，表现为整块视图闪退）。
 * 30 次 / 100ms 远高于真实交互频率，又远低于失控时的频率。
 */
const REDRAW_WINDOW_MS = 100;
const REDRAW_MAX_PER_WINDOW = 30;

/**
 * 两次方块列表是否等价（逐项比位置）
 *
 * 用于避免「新数组 = 状态变了」的误判：见 redraw 里的 setBoxes。
 */
export function SAME_Boxes(a: { x: number; y: number }[], b: { x: number; y: number }[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].x !== b[i].x || a[i].y !== b[i].y) return false;
    }
    return true;
}

export function GuideOverlay({ containerRef, metrics }: GuideOverlayProps) {
    const [d, setD] = useState("");
    /** 转角方块（容器坐标系左上角） */
    const [boxes, setBoxes] = useState<{ x: number; y: number }[]>([]);
    const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
    const rafRef = useRef(0);
    /** 重绘闸门的窗口计数（见 redraw 入口） */
    const guardRef = useRef({ windowStart: 0, count: 0, warned: false });

    /**
     * 量行 → 算 path / 方块 → 写状态
     *
     * 三类状态写入都必须做到「值不变就不触发重渲」：本函数由无依赖的 useLayoutEffect
     * 驱动，每次提交后都跑，一旦某类状态每次都判为「变了」，就会重渲 → 再 redraw 的死循环。
     * 字符串（path）由 React 自己按值比较；对象与数组须自行比较后复用旧引用。
     */
    const redraw = useCallback(() => {
        // 自反馈闸门：上面的「值不变就不写」救不了「值每次都不一样」的情形 ——
        // 拖拽分栏把手改宽度时，几何在两次提交之间持续变化，于是
        // 重绘 → 写状态 → 重新提交 → 再重绘 会一路跑到 React 抛 #185，整块视图闪退。
        // 这里的窗口计数只做一件事：判定已进入自反馈就放弃本轮重绘（下帧自然还有机会）。
        const now = performance.now();
        const guard = guardRef.current;
        if (now - guard.windowStart > REDRAW_WINDOW_MS) {
            guard.windowStart = now;
            guard.count = 0;
        }
        if (guard.count >= REDRAW_MAX_PER_WINDOW) {
            if (!guard.warned) {
                guard.warned = true;
                console.warn(
                    '[SeqTK] 引导线重绘疑似自反馈，已跳过本轮重绘以避免 React 无限更新（#185）。' +
                        '如反复出现，请反馈本条消息与当时的操作。',
                );
            }
            return;
        }
        guard.count += 1;

        const container = containerRef.current;
        if (!container) return;

        const rows = Array.from(container.querySelectorAll<HTMLElement>(`[${TREE_ROW_ATTR}]`));
        if (rows.length === 0) {
            // 空树：线和方块都要收干净 —— 只清 path 会留下上一个框架的转角方块
            // （渲染条件看的是 d 与 boxes 两者，boxes 非空就还会画出那一层 SVG）
            setD("");
            setBoxes((prev) => (prev.length === 0 ? prev : []));
            return;
        }

        const cRect = container.getBoundingClientRect();
        // 浮层坐标系原点 = 容器 padding box 的内容原点：减去边框宽（clientLeft/Top），
        // 再加上滚动位移（绝对定位子元素随内容滚动，而 rect 已含滚动结果，故须补回）
        const ox = cRect.left + container.clientLeft - container.scrollLeft;
        const oy = cRect.top + container.clientTop - container.scrollTop;

        const input: GuideRowInput[] = rows.map((el) => {
            const r = el.getBoundingClientRect();
            return {
                depth: Number(el.getAttribute(DEPTH_ATTR) ?? "0"),
                left: r.left - ox,
                top: r.top - oy,
                height: r.height,
                isLast: el.getAttribute(LAST_ATTR) === "1",
            };
        });

        setD(GET_GuidePath(input, metrics));

        const geo = GET_GuideGeometry(input, metrics);
        const nextBoxes: { x: number; y: number }[] = [];
        input.forEach((row, i) => {
            const g = geo[i];
            const el = rows[i];

            // 注：此处曾把「父列竖线相对本行的水平偏移」写成行上的 CSS 变量 --seqtk-parent-x。
            // 该变量在样式表里已无任何读取方，留着等于「在重绘里改布局」——布局一变又要重绘，
            // 正是 React #205/#185 那类无限更新的燃料（表现为拖拽分栏把手时整块视图闪退）。故移除。

            // 转角方块：位置本就是这个几何量的一部分，由浮层统一画，
            // 免得行自己再算一遍出现两个答案。
            const kind = el.getAttribute(COLLAPSE_ATTR);
            if (!kind) return;
            if (kind === "top") {
                // 顶级行：方块在行左上角
                nextBoxes.push({ x: row.left + BOX_INSET, y: row.top + BOX_INSET });
            } else if (g && g.parentX !== null) {
                // 展开祖先链内的行：方块坐在父列竖线上（行中心高度）
                nextBoxes.push({ x: g.parentX - BOX_HALF, y: g.midY - BOX_HALF });
            }
        });
        //
        // 内容没变就复用旧数组。
        //
        // 这一步不能省：redraw 由「无依赖的 useLayoutEffect」驱动，每次提交后都会跑。
        // setD 传的是字符串，值相同 React 会跳过重渲；但数组是每次新建的，
        // 引用比较永远判定「变了」—— 于是重渲→再 redraw→再 setBoxes，直接撞上
        // React 的「Maximum update depth exceeded」（错误 #185）。
        //
        setBoxes((prev) => (SAME_Boxes(prev, nextBoxes) ? prev : nextBoxes));
        const w = container.clientWidth;
        const h = Math.max(container.scrollHeight, container.clientHeight);
        setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    }, [containerRef, metrics]);

    // 每次提交后同步重绘（行刚进出 DOM 时已可测量）
    useLayoutEffect(() => {
        redraw();
    });

    // 兜底：容器尺寸 / 窗口缩放 / 容器滚动时重绘（合并到同一帧）
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const schedule = (): void => {
            if (rafRef.current) return;
            rafRef.current = requestAnimationFrame(() => {
                rafRef.current = 0;
                redraw();
            });
        };
        const ro = new ResizeObserver(schedule);
        ro.observe(container);
        window.addEventListener("resize", schedule);
        container.addEventListener("scroll", schedule, { passive: true });
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
            ro.disconnect();
            window.removeEventListener("resize", schedule);
            container.removeEventListener("scroll", schedule);
        };
    }, [containerRef, redraw]);

    if (!d && boxes.length === 0) return null;

    return (
        <svg className="seqtk-guides" aria-hidden="true" width={size.w} height={size.h}>
            <path d={d} />
            {boxes.map((b, i) => (
                <rect
                    key={i}
                    className="seqtk-collapse-box"
                    x={b.x}
                    y={b.y}
                    width={COLLAPSE_BOX}
                    height={COLLAPSE_BOX}
                />
            ))}
        </svg>
    );
}
