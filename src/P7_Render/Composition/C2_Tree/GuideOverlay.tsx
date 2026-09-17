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
 * 除了线，本层还负责两样东西（都用同一套实测几何，不另算一遍）：
 * - 转角方块
 * - 顶级展开行的「粗黑段」：它原先是行的 ::before，但浮层绘制在行之上（有意：线要盖住行的
 *   hover 背景），那条 1px 细线正好压在黑段中段把它冲淡，看上去只剩半条宽。
 *   移进本层后与细线同一坐标系，且画在细线之后，粗细过渡才是真正的"粗接细"。
 *
 * 重绘时机：
 * - 每次组件提交后同步重绘（useLayoutEffect 无依赖）——行增删/展开折叠后必定已经提交
 * - 容器尺寸变化（ResizeObserver）、窗口缩放、容器滚动时异步重绘（兜底）
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { NodeLineMetrics } from "../C1_NodeLine/NodeLine";
import { COLLAPSE_ATTR, DEPTH_ATTR, GUIDE_INSET, LAST_ATTR, TREE_ROW_ATTR } from "../C1_NodeLine/NodeLine";
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

/** 粗黑段宽度（px）；它比 1px 细线粗一档，左端 = GUIDE_INSET − LEAD_HALF 才能与细线同心 */
const LEAD_WIDTH = 2;
const LEAD_HALF = LEAD_WIDTH / 2;

/** 顶级展开行的粗黑段（容器坐标系：左端 x、顶边 y、高度） */
interface GuideLead {
    x: number;
    y: number;
    h: number;
}

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

/** 两次黑段列表是否等价（比位置与高度）—— 同 SAME_Boxes 的理由：redraw 每次都会新建数组 */
function SAME_Leads(a: GuideLead[], b: GuideLead[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].x !== b[i].x || a[i].y !== b[i].y || a[i].h !== b[i].h) return false;
    }
    return true;
}

export function GuideOverlay({ containerRef, metrics }: GuideOverlayProps) {
    const [d, setD] = useState("");
    /** 转角方块（容器坐标系左上角） */
    const [boxes, setBoxes] = useState<{ x: number; y: number }[]>([]);
    /** 顶级展开行的粗黑段 */
    const [leads, setLeads] = useState<GuideLead[]>([]);
    const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
    const rafRef = useRef(0);
    /** 重绘闸门的窗口计数（见 redraw 入口） */
    const guardRef = useRef({ windowStart: 0, count: 0, warned: false });

    /**
     * 量行 → 算 path / 方块 / 黑段 → 写状态
     *
     * 各类状态写入都必须做到「值不变就不触发重渲」：本函数由无依赖的 useLayoutEffect
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
            // 空树：线、方块、黑段都要收干净 —— 只清 path 会留下上一个框架的方块与黑段
            // （渲染条件看的是三者，任一非空就还会画出那一层 SVG）
            setD("");
            setBoxes((prev) => (prev.length === 0 ? prev : []));
            setLeads((prev) => (prev.length === 0 ? prev : []));
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
        const nextLeads: GuideLead[] = [];
        input.forEach((row, i) => {
            const g = geo[i];
            const el = rows[i];

            // 转角方块：位置本就是这个几何量的一部分，由浮层统一画，
            // 免得行自己再算一遍出现两个答案。
            const kind = el.getAttribute(COLLAPSE_ATTR);
            if (kind === "top") {
                // 顶级行：方块在行左上角
                nextBoxes.push({ x: row.left + BOX_INSET, y: row.top + BOX_INSET });
            } else if (kind === "mid" && g && g.parentX !== null) {
                // 展开祖先链内的行：方块坐在父列竖线上（行中心高度）
                nextBoxes.push({ x: g.parentX - BOX_HALF, y: g.midY - BOX_HALF });
            }

            // 粗黑段：只给顶级（depth 0）里"展开且不在展开祖先链内"的行 ——
            // 判据与原先那条 CSS 选择器完全一致（.seqtk-row-expanded:not(.seqtk-row-in-expanded)）。
            // 中心对齐细线（GUIDE_INSET），所以左端要退半个自宽。
            if (row.depth !== 0) return;
            if (!el.classList.contains("seqtk-row-expanded")) return;
            if (el.classList.contains("seqtk-row-in-expanded")) return;
            //
            // 卡片内的行：黑段如今画在浮层里，不再被卡片的 overflow 按圆角裁掉，
            // 上端于是会在卡片圆角处"探头"。让出一段即可绕开 —— 卡片圆角是 6px，
            // 取 4px 留余量。上端让了、下端也得让同样一段：只让上端会让黑段看着上短下长、
            // 与卡片的关系不对称，所以两端各退 CARD_RADIUS_INSET。
            // 卡片外的行不受影响（cardInset = 0，仍从行顶到行底）。
            //
            const CARD_RADIUS_INSET = 4;
            const cardInset = el.closest(".seqtk-fw-card") !== null ? CARD_RADIUS_INSET : 0;
            const leadHeight = row.height - cardInset * 2;
            if (leadHeight <= 0) return;
            nextLeads.push({
                x: row.left + GUIDE_INSET - LEAD_HALF,
                y: row.top + cardInset,
                h: leadHeight,
            });
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
        setLeads((prev) => (SAME_Leads(prev, nextLeads) ? prev : nextLeads));
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

    if (!d && boxes.length === 0 && leads.length === 0) return null;

    return (
        <svg className="seqtk-guides" aria-hidden="true" width={size.w} height={size.h}>
            <path d={d} />
            {/* 粗黑段画在细线**之后**：由粗段盖住细线，交替处才是「粗接细」；
                反过来的话细线会把黑段中段冲淡（它在 DOM 层时就是这样"只剩半条"的） */}
            {leads.map((l, i) => (
                <rect
                    key={`lead-${i}`}
                    className="seqtk-guide-lead"
                    x={l.x}
                    y={l.y}
                    width={LEAD_WIDTH}
                    height={l.h}
                />
            ))}
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
