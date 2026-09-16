/**
 * C2_Tree — 树形引导线的几何计算（纯函数，与 DOM 无关）
 *
 * 从 P6_Views/design/guides.ts 迁来并纯化：输入是「行的矩形 + 层级的兄弟语义」，
 * 输出是一条 SVG path 的 `d`。之所以先抽成纯函数：便于单独推理与测试，也让浮层
 * 组件（GuideOverlay）只负责"量 DOM / 设属性"这两件与 React 相关的事。
 *
 * 画法（每行一条 L 形，相邻行自然接续成连续竖线）：
 *   竖线 x = 行左缘 + GUIDE_INSET + (depth-1)·step；横笔终点 = 本行左缘 + base + depth·step
 *
 * 竖线基准 GUIDE_INSET 当前为 0：竖线贴着行左缘（此前是 4px，往左收了一段）。
 * 它同时是转角方块的水平基准，所以线与方块永远同轴。横笔终点仍落在内容缩进处，
 * 否则笔尖会停在半空。
 *   竖笔   从「父行中心」下探到「本行中心（末子收尾 └）或本行底（非末子）」
 *   横笔   在「本行中心」高度上由父列画到内容列
 *
 * 为何末子止于行中心即可收尾：树是深度优先顺序渲染，末子之后不会再出现同层兄弟，
 * 因此父列到本行中心就已画完；非末子的竖笔拉到底部，由下一个兄弟的竖笔接续。
 *
 * 列基准取「各自行的左边缘」：父子行左缘一致时两者正好相差一个 step；子行嵌在
 * 框架卡片内（左缘更靠右）时横笔自然变长 —— 卡片嵌套无需单独适配。
 *
 * 坐标约定：`left` / `top` 都已换算成**相对树容器内容原点**（调用方负责减去容器
 * rect 的边框与滚动位移），因此本函数只做纯算术。
 */

import { GUIDE_INSET, type NodeLineMetrics } from "../C1_NodeLine/NodeLine";

/** 一行在容器坐标系里的矩形 + 该行在兄弟中的位置语义 */
export interface GuideRowInput {
    /** 层级（0 = 根行，不画线） */
    depth: number;
    /** 行左边缘 x（相对容器内容原点） */
    left: number;
    /** 行顶边 y（相对容器内容原点） */
    top: number;
    /** 行高 */
    height: number;
    /** 是否为其父的最后一个子（竖笔在本行中心收尾） */
    isLast: boolean;
}

/**
 * 计算整棵树的引导线 path。
 *
 * 行必须按**深度优先**顺序传入（即 DOM 中的出现顺序），因为父行由 `depth` 栈推导：
 * 遇到 depth = d 的行时，栈中 depth = d-1 的项就是它的父行。
 */

/** 一行的引导线几何（容器坐标系） */
export interface GuideRowGeometry {
    /** 父列竖线的 x；depth 0 没有父列，为 null */
    parentX: number | null;
    /** 本行内容列 x（横笔终点） */
    contentX: number;
    /** 本行左缘（容器坐标系）—— 调用方据此把 parentX 换算成「相对本行」的偏移 */
    left: number;
    /** 竖笔起点 y（父行中心） */
    fromY: number;
    /** 竖笔终点 y（末子收在本行中心，否则拉到底交给下一个兄弟） */
    toY: number;
    /** 横笔 y（本行中心） */
    midY: number;
}

/**
 * 计算每行的引导线几何
 *
 * 抽出来的原因：引导线（SVG path）与转角方块（行内的 CSS 变量）必须用**同一套实测几何**。
 * 此前方块另按 depth 纯算，在框架卡片嵌套处会漏掉卡片的内缩量，于是方块偏到右边 ——
 * 同一个「父列在哪」不能有两个答案。
 *
 * 行必须按深度优先顺序传入（与 DOM 出现顺序一致）。
 */
export function GET_GuideGeometry(rows: GuideRowInput[], m: NodeLineMetrics): GuideRowGeometry[] {
    const stack: GuideRowInput[] = [];
    const out: GuideRowGeometry[] = [];

    for (const row of rows) {
        stack[row.depth] = row;
        stack.length = row.depth + 1;

        const parent = row.depth > 0 ? stack[row.depth - 1] : undefined;
        // 竖线：贴行左缘再往右让开 GUIDE_INSET（比内容基准更靠左，避免紧贴文字影响观感）。
        // 该基量对所有层级一视同仁；卡片嵌套时由 parent.left 的实测差异自然适配。
        const parentX = parent ? parent.left + GUIDE_INSET + (row.depth - 1) * m.step : null;
        const contentX = row.left + m.base + row.depth * m.step;
        const midY = row.top + row.height / 2;

        out.push({
            parentX,
            contentX,
            left: row.left,
            fromY: parent ? parent.top + parent.height / 2 : 0,
            toY: row.isLast ? midY : row.top + row.height,
            midY,
        });
    }

    return out;
}

export function GET_GuidePath(rows: GuideRowInput[], m: NodeLineMetrics): string {
    const d: string[] = [];

    for (const g of GET_GuideGeometry(rows, m)) {
        if (g.parentX === null) continue;
        // 竖笔：父行中心 → 本行中心（末子）或本行底（未完，交给下一个兄弟接续）
        d.push(`M ${g.parentX} ${g.fromY} V ${g.toY}`);
        // 横笔：父列 → 内容列（在本行中心高度）
        d.push(`M ${g.parentX} ${g.midY} H ${g.contentX}`);
    }

    return d.join(" ");
}
