/**
 * C2_Tree — 节点树组件（递归渲染行与子树，含引导线浮层）
 *
 * 左栏「框架树」与右栏「节点树」是**同一个组件**的两份 props：是否用卡片包裹（行数据里的
 * `carded`）、步距（metrics）、行基础 class（rowClass）、拖拽语义（actions）全部由调用方
 * 注入，因此不再需要各写一套渲染逻辑。
 *
 * 本组件接管的东西：递归结构、行的排布、卡片嵌套、引导线浮层、行内新建 / 正文编辑
 * 的插入位置。调用方只注入 `TreeNodeItem[]`（含已按展开状态填充的 children）与回调。
 *
 * 契约（见 P7_Render/Render.md）：只接 props、只发回调；不 import "obsidian"；
 * 不读写数据层。
 */

import { useRef } from "react";
import { NodeLinePanel } from "../C1_NodeLine/NodeLinePanel";
import type { NodeLineActions, NodeLineHost, NodeLineMetrics } from "../C1_NodeLine/NodeLine";
import { GuideOverlay } from "./GuideOverlay";
import { NodeInlineAddPanel } from "./NodeInlineAddPanel";
import { InlineBodyPanel } from "./InlineBodyPanel";
import type {
    NodeInlineBody,
    NodeInlineCreating,
    NodeTreeActions,
    NodeTreeProps,
    TreeNodeItem,
} from "./NodeTree";

/** 递归渲染一个节点：行 → 行下正文编辑 → 子树 → 子列表末尾的附加行（逐层包卡片） */
function TreeNodeView({
    item,
    metrics,
    rowClass,
    actions,
    host,
    creating,
    bodyEditing,
}: {
    item: TreeNodeItem;
    metrics: NodeLineMetrics;
    rowClass: string;
    actions?: NodeTreeActions;
    host?: NodeLineHost;
    creating?: NodeInlineCreating | null;
    bodyEditing?: NodeInlineBody | null;
}) {
    const { line, children } = item;
    const ctx = { nodeId: line.nodeId, parentId: line.parentId, depth: line.depth };

    // 行下正文编辑：只在目标行之后渲染一份
    const bodyEditor =
        bodyEditing?.nodeId === line.nodeId ? (
            <InlineBodyPanel
                value={bodyEditing.value}
                onCommit={(body) => actions?.onBodyCommit?.(line.nodeId, body)}
                onCancel={() => actions?.onBodyCancel?.(line.nodeId)}
            />
        ) : null;

    // 子列表末尾的附加行：仅当本节点展开时（未展开的子列表不可见）
    const childAdder =
        creating && creating.parentId === line.nodeId && line.expanded ? (
            <NodeInlineAddPanel
                key={creating.seq ?? 0}
                kinds={creating.kinds}
                kind={creating.kind}
                depth={creating.depth}
                metrics={metrics}
                onCommit={(kind, name) => actions?.onCreateCommit?.(line.nodeId, kind, name)}
                onCancel={() => actions?.onCreateCancel?.(line.nodeId)}
                onKindChange={(kind) => actions?.onCreateKindChange?.(line.nodeId, kind)}
                repeat={creating.repeat}
                onRepeatChange={(repeat) => actions?.onCreateRepeatChange?.(line.nodeId, repeat)}
            />
        ) : null;

    const content = (
        <>
            <NodeLinePanel
                data={line}
                metrics={metrics}
                rowClass={rowClass}
                actions={actions as NodeLineActions | undefined}
                host={host}
            />
            {bodyEditor}
            {children.map((child) => (
                <TreeNodeView
                    key={child.line.nodeId}
                    item={child}
                    metrics={metrics}
                    rowClass={rowClass}
                    actions={actions}
                    host={host}
                    creating={creating}
                    bodyEditing={bodyEditing}
                />
            ))}
            {childAdder}
        </>
    );

    // 框架节点：行与展开内容一起包进卡片（层层套卡片）
    return line.carded ? <div className="seqtk-fw-card">{content}</div> : content;
}

export function NodeTreePanel({
    items,
    metrics,
    actions,
    host,
    rowClass = "seqtk-row",
    className,
    emptyText,
    guides = true,
    rootParentId = "",
    creating,
    bodyEditing,
}: NodeTreeProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);

    return (
        <div ref={rootRef} className={className ? `seqtk-tree ${className}` : "seqtk-tree"}>
            {items.length === 0 && emptyText && !creating && <div className="seqtk-empty">{emptyText}</div>}

            {items.map((item) => (
                <TreeNodeView
                    key={item.line.nodeId}
                    item={item}
                    metrics={metrics}
                    rowClass={rowClass}
                    actions={actions}
                    host={host}
                    creating={creating}
                    bodyEditing={bodyEditing}
                />
            ))}

            {/* 根列表末尾的附加行：判据是该列表的根父 id，不是空串（右栏的根是框架 id） */}
            {creating && creating.parentId === rootParentId && (
                <NodeInlineAddPanel
                    key={creating.seq ?? 0}
                    kinds={creating.kinds}
                    kind={creating.kind}
                    depth={creating.depth}
                    metrics={metrics}
                    /* 父 id 必须是这一层的根父（右栏是框架 id）：写死空串会把节点建到顶层去 */
                    onCommit={(kind, name) => actions?.onCreateCommit?.(rootParentId, kind, name)}
                    onCancel={() => actions?.onCreateCancel?.(rootParentId)}
                    onKindChange={(kind) => actions?.onCreateKindChange?.(rootParentId, kind)}
                    repeat={creating.repeat}
                    onRepeatChange={(repeat) => actions?.onCreateRepeatChange?.(rootParentId, repeat)}
                />
            )}

            {guides && <GuideOverlay containerRef={rootRef} metrics={metrics} />}
        </div>
    );
}
