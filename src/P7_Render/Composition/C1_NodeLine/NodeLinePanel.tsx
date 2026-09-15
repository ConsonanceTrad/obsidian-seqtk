/**
 * C1_NodeLine — 节点行组件（画面元素的唯一来源）
 *
 * 命名说明：本目录中 `NodeLine.ts` 是行的**契约**（数据 / 动作 / 宿主能力 / 几何，
 * 纯类型无运行时代码），本文件是行的**渲染件**。渲染件沿用本项目 `.tsx` 侧的
 * `XxxPanel` 惯例（同 `DesignPanel.tsx` / `LogPanel.tsx`），避免用 `View` 后缀 ——
 * 本项目里 `View` 专指 `ItemView` 子类（视图层），混用会误导。
 *
 * 本组件是「节点行长什么样」的唯一定义处：徽章分色、描述、正文预览、预期属性徽章、
 * 打开按钮、状态圆点、折叠方块，以及行上的树标记（`data-tree-row` 等）与几何
 * （缩进、父列 x）全部在这里产生。视图层只注入 `NodeLineData` 并接住回调。
 *
 * 契约（见 P7_Render/Render.md）：
 * - 只接收 props、只发出回调；回调参数只有 `NodeLineCtx` 与原生事件，不回传 DOM
 * - **不 import "obsidian"**：宿主 API（`setTooltip` / `setIcon`）经 `NodeLineProps.host`
 *   注入，未注入时对应能力静默降级
 * - 业务数据一律不在这里读写：展开/选中/右键/拖拽都只上抛
 *
 * 元素与 class 与命令式实现逐项对齐（`.seqtk-row` / `.seqtk-frame-item` /
 * `.seqtk-kind-badge` / `.seqtk-body-preview` / `.seqtk-expected-badge` /
 * `.seqtk-open-btn` / `.seqtk-state-dot`），保证视觉零回归。
 *
 * 例外：转角方块（原 `.seqtk-collapse-mark`）不再由本组件渲染 —— 它的位置取决于
 * 父列竖线，而那是引导线浮层的实测几何。本组件只通过 COLLAPSE_ATTR 声明
 * 「这一行要不要画、画在行角还是父列竖线上」，绘制交给 GuideOverlay。
 */

import { GET_KindClass } from "../../../P4_Nodes/NodeKind/KindColors";
import { GET_SourceLabel } from "../../../P4_Nodes/NodeField/AttriGroup/External";
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import {
    COLLAPSE_ATTR,
    DEPTH_ATTR,
    FIRST_ATTR,
    LAST_ATTR,
    NODE_ID_ATTR,
    PARENT_ID_ATTR,
    TREE_ROW_ATTR,
    GET_LineCtx,
    GET_LineIndent,
    type NodeLineProps,
} from "./NodeLine";

/** 打开按钮的固定文案（组件自身的 UI 文案，不需要调用方注入） */
const OPEN_BUTTON_TIP = "在右侧打开";

export function NodeLinePanel({
    data,
    metrics,
    rowClass = "seqtk-row",
    actions,
    host,
}: NodeLineProps) {
    const ctx = GET_LineCtx(data);
    const rowRef = useRef<HTMLDivElement | null>(null);

    // 宿主能力注入：把 JSX 上标注的 data-tip / data-icon 交给调用方提供的
    // setTooltip / setIcon。用属性标注而非逐元素 ref，是为了让 badge 这类数量可变的
    // 元素也能统一处理，同时不违反 hooks 规则。
    useEffect(() => {
        const root = rowRef.current;
        if (!root || !host) return;
        if (host.setTooltip) {
            root.querySelectorAll<HTMLElement>("[data-tip]").forEach((el) => {
                const text = el.dataset.tip;
                if (text) host.setTooltip?.(el, text);
            });
        }
        if (host.setIcon) {
            root.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
                const icon = el.dataset.icon;
                if (icon) {
                    el.replaceChildren();
                    host.setIcon?.(el, icon);
                }
            });
        }
    }, [host, data]);

    const indent = GET_LineIndent(data.depth, metrics);

    /** 转角方块该画在哪；null = 本行不需要方块（交给浮层统一绘制） */
    const collapseKind: "top" | "mid" | null =
        data.hasChildren && !data.expanded ? (data.inExpandedTree ? "mid" : "top") : null;

    const cls = [rowClass];
    if (data.selected) cls.push("seqtk-frame-item-active");
    if (data.hasChildren && data.expanded) cls.push("seqtk-row-expanded");
    if (data.inExpandedTree) cls.push("seqtk-row-in-expanded");
    if (data.dropHint) cls.push(`seqtk-drop-${data.dropHint}`);
    if (data.dragging) cls.push("seqtk-dragging");

    // 注意：不再在这里写 --seqtk-parent-x —— 父列位置是实测几何，由引导线浮层
    // 量行后写回（见 C2_Tree/GuideOverlay）。行自己再算一遍就会出现两个答案。
    const style = {
        paddingLeft: `${indent}px`,
    } as CSSProperties;

    return (
        <div
            ref={rowRef}
            className={cls.join(" ")}
            style={style}
            {...{
                [TREE_ROW_ATTR]: "",
                [NODE_ID_ATTR]: data.nodeId,
                [PARENT_ID_ATTR]: data.parentId,
                [DEPTH_ATTR]: String(data.depth),
                // 类型也写到行上：拖拽判落点要按类型判断，从 DOM 读比回查缓存快得多
                "data-kind": data.kind,
                // 有子且未展开才需要方块；在展开祖先链内则坐在父列竖线上
                ...(collapseKind ? { [COLLAPSE_ATTR]: collapseKind } : {}),
            }}
            data-first={data.isFirst ? "1" : undefined}
            data-last={data.isLast ? "1" : undefined}
            draggable={(data.draggable && !data.editing) || undefined}
            onClick={data.hasChildren ? () => actions?.onToggle?.(ctx) : undefined}
            onContextMenu={
                actions?.onContextMenu ? (e) => actions.onContextMenu?.(ctx, e.nativeEvent) : undefined
            }
            onDragStart={
                actions?.onDragStart ? (e) => actions.onDragStart?.(ctx, e.nativeEvent) : undefined
            }
            onDragEnd={
                actions?.onDragEnd ? (e) => actions.onDragEnd?.(ctx, e.nativeEvent) : undefined
            }
            onDragOver={
                actions?.onDragOver ? (e) => actions.onDragOver?.(ctx, e.nativeEvent) : undefined
            }
            onDragLeave={
                actions?.onDragLeave ? (e) => actions.onDragLeave?.(ctx, e.nativeEvent) : undefined
            }
            onDrop={actions?.onDrop ? (e) => actions.onDrop?.(ctx, e.nativeEvent) : undefined}
        >

            <span className={`seqtk-kind-badge ${GET_KindClass(data.kind)}`}>{data.label}</span>

            <span className="seqtk-desc" data-tip={data.descTooltip}>
                {data.desc}
            </span>

            {data.bodyPreview && (
                <span className="seqtk-body-preview" data-tip={data.bodyPreviewTooltip}>
                    {data.bodyPreview}
                </span>
            )}

            <span className="seqtk-spacer" />

            {(data.badges ?? []).map((badge, i) => (
                <span key={i} className="seqtk-expected-badge" data-tip={badge.tooltip}>
                    {badge.icon ? `${badge.icon} ${badge.text}` : badge.text}
                </span>
            ))}

            {/* 外部信息源：行内只出一个链接图标（条目数与地址都不铺在行上，
                否则会撑爆布局），悬浮列出全部条目；点击由调用方处理（单项直跳 / 多项弹列表） */}
            {(data.sources?.length ?? 0) > 0 && (
                <button
                    className="seqtk-source-badge"
                    data-icon="link"
                    data-tip={data.sources!.map((s) => GET_SourceLabel(s)).join("\n")}
                    onClick={(e) => {
                        e.stopPropagation();
                        actions?.onSourcesClick?.(ctx, e.nativeEvent);
                    }}
                />
            )}

            {data.showsOpenButton && (
                <button
                    className="seqtk-open-btn"
                    data-icon="right-arrow"
                    data-tip={OPEN_BUTTON_TIP}
                    onClick={(e) => {
                        e.stopPropagation();
                        actions?.onSelect?.(ctx);
                    }}
                />
            )}

            {data.showsState && (
                <button
                    className={`seqtk-state-dot state-${data.state ?? "plan"}`}
                    data-tip={data.stateTooltip}
                    onClick={(e) => {
                        e.stopPropagation();
                        actions?.onStateClick?.(ctx);
                    }}
                    onContextMenu={
                        actions?.onStateContextMenu
                            ? (e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  actions.onStateContextMenu?.(ctx, e.nativeEvent);
                              }
                            : undefined
                    }
                />
            )}

            {data.editing?.mode === "rename" && (
                <InlineRenameOverlay
                    initial={data.editing.value}
                    rowRef={rowRef}
                    onCommit={(value) => actions?.onInlineCommit?.(ctx, value)}
                    onCancel={() => actions?.onInlineCancel?.(ctx)}
                />
            )}
        </div>
    );
}

/**
 * 行内重命名覆盖层（原 design/inline.ts 的 beginInlineRename 做法，改为组件化）
 *
 * - 不动行内任何元素：行高与布局零变化，不遮挡下方内容
 * - 绝对定位在行内末尾，从类型徽章右缘覆盖到行尾（保留徽章可见）
 * - Enter 提交 / Esc 取消 / 点「确认 | 取消」按钮；点到外部不打断（不做失焦提交）。
 *   提交值只上抛，是否落盘由调用方决定
 */
function InlineRenameOverlay({
    initial,
    rowRef,
    onCommit,
    onCancel,
}: {
    initial: string;
    rowRef: RefObject<HTMLDivElement | null>;
    onCommit: (value: string) => void;
    onCancel: () => void;
}) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const doneRef = useRef(false);

    // 挂载后测量一次：左边界取类型徽章右缘（徽章靠左且行不换行，此值在编辑期间稳定）
    //
    // 设的是**覆盖层自身**的 left，而不是输入框的 —— 覆盖范围（类型徽章右缘 → 行尾）
    // 由覆盖层承担，输入框在层内 flex:1 撑满。此前把 left 设在 input 上，而 input 并非
    // absolute，那个值根本不生效：覆盖层只剩内容宽度，输入框跟着缩了水。
    useLayoutEffect(() => {
        const input = inputRef.current;
        const row = rowRef.current;
        if (!input) return;
        const overlay = input.closest<HTMLElement>(".seqtk-inline-edit-overlay");
        const badge = row?.querySelector<HTMLElement>(".seqtk-kind-badge");
        const left =
            badge && row
                ? `${badge.getBoundingClientRect().right - row.getBoundingClientRect().left + 4}px`
                : `${parseFloat(row?.style.paddingLeft ?? "") || 8}px`;
        if (overlay) overlay.style.left = left;
        input.focus();
        input.select();
    }, [rowRef]);

    const finish = (save: boolean): void => {
        if (doneRef.current) return;
        doneRef.current = true;
        if (save) onCommit((inputRef.current?.value ?? "").trim());
        else onCancel();
    };

    return (
        <span
            className="seqtk-inline-edit-overlay"
            // 编辑期间阻止行级单击/双击（不触发展开 / 再次编辑）
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
        >
            <input
                ref={inputRef}
                className="seqtk-inline-edit-input"
                defaultValue={initial}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                        finish(true);
                    } else if (e.key === "Escape") {
                        e.stopPropagation();
                        finish(false);
                    }
                }}
                // 不做失焦提交：点到外部不打断本次编辑（用「确认 / 取消」按钮或 Esc 结束）
            />
            {/* 按钮让到输入框下方、靠右 —— 输入框继续独占第一行，覆盖范围不变 */}
            <span className="seqtk-inline-edit-actions">
                <button type="button" className="seqtk-inline-edit-btn" title="确认（Enter）" onClick={() => finish(true)}>
                    ✓
                </button>
                <button type="button" className="seqtk-inline-edit-btn" title="取消（Esc）" onClick={() => finish(false)}>
                    ✕
                </button>
            </span>
        </span>
    );
}
