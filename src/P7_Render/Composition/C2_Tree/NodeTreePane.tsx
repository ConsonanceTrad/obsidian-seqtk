/**
 * C2_Tree — 节点树栏（栏头 + NodeTreePanel）
 *
 * 「一棵树 + 它的栏头」在多个视图里是同一形态：事务设计左栏的框架树、被委托到中控台的
 * 同一棵树、模板模式的模板框架树与单元树，都是「栏标题（可带行末按钮）+ 树本体（含空态）」。
 * 此前每处各自装配一遍（标题行的元素建组、rowClass、空态、步距），本组件把它收成一处置，
 * 免得再出现第四份手抄。
 *
 * 与 NodeTreePanel 的分工：NodeTreePanel 只管树本体，本组件加「栏」这层外壳。栏的视觉差异
 * （边框 / 背景 / 高度分配）仍由 `className` 上的既有 class 决定，样式集中在 styles.css ——
 * 于是 `.seqtk-split-left .seqtk-inline-add`、`.seqtk-delegated-tree .seqtk-tree` 这类
 * 后代选择器继续生效，无需改动样式。
 *
 * 契约（见 P7_Render/Render.md）：只接 props、只发回调；不 import "obsidian"；
 * 不读写数据层。
 */

import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { NodeTreePanel } from "./NodeTreePanel";
import type { NodeTreeProps } from "./NodeTree";

/**
 * 栏标识（左栏 / 右栏）
 *
 * 「这棵树在哪一栏」是装配层把栏信息捆进回调时用的标识 —— 树的 props 里没有它
 * （组件不需要知道自己在哪一栏，见 DesignPanel 的 bindActions），所以类型与树栏组件
 * 同处，各视图共用这一份，而不是每处再写一遍字面量联合。
 */
export type TreeSide = "left" | "right";

/** 树的 props 原样透传；栏容器与树容器的 class 分开命名（前者是栏，后者是栏内的树） */
export interface NodeTreePaneProps extends Omit<NodeTreeProps, "className"> {
    /** 栏容器 class（栏的视觉与以栏为起点的后代选择器都挂在它上面，如 `seqtk-split-left`） */
    className: string;
    /**
     * 栏容器 inline style
     *
     * 双栏比例把手拖动期间**直接改宽度**（不经 React，理由见 DesignPanel），初值也得由
     * 调用方给定，因此 style 透传到栏容器上，而不是让调用方在栏外包一层 div。
     */
    paneStyle?: CSSProperties;
    /** 栏容器 ref（同上：比例把手要直接操作这个元素） */
    paneRef?: RefObject<HTMLDivElement>;
    /** 栏空白区右键；行自身的 contextmenu 已 stopPropagation，能冒泡到栏的都是空白 */
    onPaneContextMenu?: (e: ReactMouseEvent<HTMLDivElement>) => void;
    /** 栏标题；不传则不渲染标题行 */
    title?: string;
    /** 标题行末尾内容（图标按钮等），由调用方注入 */
    titleExtra?: ReactNode;
    /** 树容器附加 class（对应 NodeTreePanel 的 `className`） */
    treeClassName?: string;
}

export function NodeTreePane({
    className,
    paneStyle,
    paneRef,
    onPaneContextMenu,
    title,
    titleExtra,
    treeClassName,
    ...tree
}: NodeTreePaneProps) {
    return (
        <div
            ref={paneRef}
            className={className}
            style={paneStyle}
            onContextMenu={onPaneContextMenu}
        >
            {title !== undefined && (
                <div className="seqtk-split-title">
                    <span className="seqtk-split-title-text">{title}</span>
                    {titleExtra}
                </div>
            )}

            <NodeTreePanel {...tree} className={treeClassName} />
        </div>
    );
}
