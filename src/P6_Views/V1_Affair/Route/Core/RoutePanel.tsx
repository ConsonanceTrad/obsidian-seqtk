/**
 * RoutePanel — 线路模式的渲染件
 *
 * 纯渲染：左栏框架树（NodeTreePane，与事务设计左栏同一个组件）+ 右栏「双向追索的关联树」。
 * 不 import obsidian、不触碰 NodeCache —— 两边都由 RouteView 算好。
 *
 * 右栏布局取舍：**不按层级缩进**。缩进会把"下游"读成"上游的下属"，而上下游是**方向**不是
 * 层级。改为每个节点之前加一条以箭头开头的行（`↑` 指向上游、`↓` 指向下游），那条行同时
 * 承担两件事：标出方向，并带上这条 route 边的描述 —— 也就是"为什么这两个框架有关联"的答案。
 */

import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Empty, Typography } from "antd";
import { useStore } from "../../../../P0_UI/useStore";
import { IconButton } from "../../../../P7_Render/Composition/C1_NodeLine/IconButton";
import { NodeTreePane } from "../../../../P7_Render/Composition/C2_Tree/NodeTreePane";
import { LINE_METRICS_LEFT, type NodeLineHost } from "../../../../P7_Render/Composition/C1_NodeLine/NodeLine";
import type { NodeTreeActions, TreeNodeItem } from "../../../../P7_Render/Composition/C2_Tree/NodeTree";
import type { DesignInlineCreating } from "../../Design/Core/DesignPanel";
import type { RouteTreeNode } from "../Slice/routeTree";
import type { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";

const { Title, Text } = Typography;

/** 线路模式状态（渲染件订阅的唯一来源） */
export interface RouteState {
    /** 缓存尚未就绪 */
    initializing: boolean;
    /** 左栏框架树：与事务设计左栏同一条渲染链（buildFrameworkTree / buildTreeItems / buildFrameLine） */
    leftItems: TreeNodeItem[];
    /** 左栏空态提示 */
    leftEmpty?: string;
    /** 左栏宽度（px） */
    leftWidth: number;
    /** 当前选中的框架 nodeId（null = 未选） */
    selectedId: string | null;
    /** 左栏框架树是否已委托到中控台侧栏 */
    delegated: boolean;
    /**
     * 行内编辑的两个态（透传给 NodeTreePane，由它画附加行与正文浮层）
     *
     * 与 design 那一侧同名同义：本视图把这两个态交给同一个行组件，才不必为线路视图
     * 单独写一遍输入框与浮层的渲染。
     */
    creating: DesignInlineCreating | null;
    bodyEditing: { nodeId: string; value: string } | null;
    /** 右栏空态提示（未选任何框架时） */
    rightEmpty?: string;
    /** 以选中框架为根的双向追索树；未选或该节点已消失时 null */
    tree: RouteTreeNode | null;
}

export interface RoutePanelProps {
    state: SimpleStore<RouteState>;
    host: NodeLineHost;
    /**
     * 左栏行的动作集合
     *
     * 由视图侧组装后整体传进来，而不是在这里按名接一堆回调 —— 拖拽那五个
     * （dragstart / dragover / dragleave / drop / dragend）与选中、展开是同一组行行为，
     * 由视图侧统一接到 design 那套处理上（见 Design/Slice/dragHandlers），
     * 这里只负责把动作原样交给行组件。
     */
    leftActions: NodeTreeActions;
    /** 左栏空白处右键（新建框架） */
    onFrameAreaContextMenu: (e: globalThis.MouseEvent) => void;
    /** 左栏的委托开关：进行 / 取消 */
    onToggleDelegate: () => void;
    /** 新建上游线路：别的框架 → 本框架 */
    onAddUpstream: () => void;
    /** 新建下游线路：本框架 → 别的框架 */
    onAddDownstream: () => void;
    /** 改一条线路的描述 */
    onEditRoute: (fromId: string, toId: string) => void;
    /** 删一条线路 */
    onRemoveRoute: (fromId: string, toId: string) => void;
    /** 左栏宽度拖完上报（视图侧防抖写回设置） */
    onWidthChange: (width: number) => void;
}

/**
 * 树的一节：方向行 + 本行 + 证据 + 同侧子树
 *
 * 方向行（`↑ 描述` / `↓ 描述`）只对"由某条 route 边接过来的节点"渲染，中心行没有边，
 * 所以没有方向行 —— 一眼就能看出整块从哪儿开始。
 */
function RouteNodeView(props: {
    node: RouteTreeNode;
    /** 本支方向：决定箭头朝向与继续画哪一侧；中心行不给 */
    side?: 'up' | 'down';
    isRoot?: boolean;
    /**
     * 是否继续画更深的一层
     *
     * 中心行传 false：它的两侧由外层按顺序分别画，这里再画一遍就会重复
     * （上游会同时出现在本行下方与「上游」那一段里）。
     */
    showChildren?: boolean;
    onEditRoute: (fromId: string, toId: string) => void;
    onRemoveRoute: (fromId: string, toId: string) => void;
    onAddUpstream?: () => void;
    onAddDownstream?: () => void;
}) {
    const { node, side } = props;
    /** 本行是否代表一条 route 边（中心行不是） */
    const hasEdge = node.edgeFrom !== null && node.edgeTo !== null;
    const showChildren = props.showChildren ?? true;
    /** 本支继续往下的那一层（中心行不给） */
    const children = !showChildren ? [] : (side === 'up' ? node.upstream : node.downstream);
    const truncated = showChildren
        && (side === 'up' ? node.upstreamTruncated : node.downstreamTruncated);
    const isUp = side === 'up';

    return (
        <div className="seqtk-route-node">
            {/* 方向行：箭头 + 这条边的描述。既是方向标记，也是与上一个节点的分割 */}
            {hasEdge && (
                <div className="seqtk-route-dir" data-dir={isUp ? 'up' : 'down'}>
                    <span className="seqtk-route-arrow" aria-hidden="true">{isUp ? '↑' : '↓'}</span>
                    <span className="seqtk-route-dir-desc">
                        {node.description
                            ? node.description
                            : <span className="seqtk-route-desc-empty">（未填描述）</span>}
                    </span>
                </div>
            )}

            <div className={`seqtk-route-line${props.isRoot ? ' seqtk-route-line-root' : ''}`}>
                <span className="seqtk-route-kind">{node.kindLabel}</span>
                <span className="seqtk-route-name" title={node.desc}>{node.desc}</span>
                <span className="seqtk-route-progress" title="本框架子树的进度聚合">{node.progress}</span>
                {props.isRoot && props.onAddUpstream && (
                    <Button size="small" className="seqtk-route-act" onClick={props.onAddUpstream}>
                        加上游
                    </Button>
                )}
                {props.isRoot && props.onAddDownstream && (
                    <Button size="small" className="seqtk-route-act" onClick={props.onAddDownstream}>
                        加下游
                    </Button>
                )}
                {hasEdge && (
                    <>
                        <Button
                            size="small"
                            type="text"
                            className="seqtk-route-act"
                            onClick={() => props.onEditRoute(node.edgeFrom!, node.edgeTo!)}
                        >
                            改描述
                        </Button>
                        <Button
                            size="small"
                            type="text"
                            danger
                            className="seqtk-route-act"
                            onClick={() => props.onRemoveRoute(node.edgeFrom!, node.edgeTo!)}
                        >
                            删除
                        </Button>
                    </>
                )}
            </div>

            {/* 本框架的直接证据：既不参与 route 也不参与 follows，但「链为什么成立」要看它 */}
            {node.evidence.length > 0 && (
                <ul className="seqtk-route-evidence">
                    {node.evidence.map((e) => (
                        <li key={e.nodeId}>
                            <span className="seqtk-route-evidence-kind">{e.kindLabel}</span>
                            <span className="seqtk-route-evidence-name" title={e.desc}>{e.desc}</span>
                        </li>
                    ))}
                </ul>
            )}

            {truncated && (
                <div className="seqtk-route-truncated">
                    更深的{isUp ? '上游' : '下游'}已省略（已达层数上限）
                </div>
            )}

            {children.map((c) => (
                <RouteNodeView
                    key={`${isUp ? 'up' : 'down'}:${c.edgeFrom}->${c.edgeTo}`}
                    node={c}
                    side={side}
                    onEditRoute={props.onEditRoute}
                    onRemoveRoute={props.onRemoveRoute}
                />
            ))}
        </div>
    );
}

export function RoutePanel(props: RoutePanelProps) {
    const { state, host, onWidthChange } = props;
    const {
        initializing, leftItems, leftEmpty, leftWidth, delegated,
        rightEmpty, creating, bodyEditing, tree,
    } = useStore(state);

    // 左栏宽度：拖动期间直接改 DOM（不经 React），松手才上报 —— 每帧重渲整棵树会拖慢手感
    const paneRef = useRef<HTMLDivElement>(null);
    const dragFrom = useRef<{ x: number; width: number } | null>(null);

    const onHandleDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
        dragFrom.current = { x: e.clientX, width: paneRef.current?.offsetWidth ?? leftWidth };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }, [leftWidth]);

    const onHandleMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
        const from = dragFrom.current;
        const pane = paneRef.current;
        if (!from || !pane) return;
        const next = `${from.width + (e.clientX - from.x)}px`;
        pane.style.width = next;
        pane.style.flexBasis = next;
    }, []);

    const onHandleUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
        if (!dragFrom.current) return;
        dragFrom.current = null;
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
        onWidthChange(paneRef.current?.offsetWidth ?? leftWidth);
    }, [leftWidth, onWidthChange]);

    const left = (
        <NodeTreePane
            className="seqtk-split-left"
            paneRef={paneRef}
            paneStyle={{ width: leftWidth, flexBasis: leftWidth }}
            onPaneContextMenu={(e) => {
                if ((e.target as HTMLElement).closest('.seqtk-frame-item')) return;
                e.preventDefault();
                props.onFrameAreaContextMenu(e.nativeEvent);
            }}
            title="框架"
            titleExtra={
                /* 委托开关收在标题末尾：与事务设计左栏同一位置、同一套图标语义 */
                <IconButton
                    className={"seqtk-icon-btn seqtk-delegate-btn" + (delegated ? " is-active" : "")}
                    // chevrons-left = 把树送到左侧栏；chevrons-right = 收回本栏
                    icon={delegated ? "chevrons-right" : "chevrons-left"}
                    tip={delegated ? "取消委托（框架树交还此栏）" : "委托到中控台侧栏"}
                    host={host}
                    onClick={() => props.onToggleDelegate()}
                />
            }
            items={leftItems}
            metrics={LINE_METRICS_LEFT}
            actions={props.leftActions}
            host={host}
            rowClass="seqtk-frame-item"
            emptyText={initializing ? '正在加载缓存…' : leftEmpty}
            creating={creating}
            bodyEditing={bodyEditing}
        />
    );

    const right = (
        <div className="seqtk-pane">
            <div className="seqtk-board-titlebar">
                <Title level={5} className="seqtk-split-title">线路关联</Title>
                <Text className="seqtk-route-hint">↑ 上游 → 本框架 → 下游 ↓</Text>
            </div>
            {rightEmpty || !tree ? (
                <Empty description={rightEmpty ?? '请在左侧选择框架'} />
            ) : (
                // 顺序即方向：上游在前、本框架居中、下游在后 —— 不靠缩进表达层级
                <div className="seqtk-route-tree">
                    {tree.upstream.map((c) => (
                        <RouteNodeView
                            key={`up:${c.edgeFrom}->${c.edgeTo}`}
                            node={c}
                            side="up"
                            onEditRoute={props.onEditRoute}
                            onRemoveRoute={props.onRemoveRoute}
                        />
                    ))}

                    {/* 中心行：只画自己（+ 自己的证据），两侧由上下两段分别画 */}
                    <RouteNodeView
                        node={tree}
                        isRoot
                        showChildren={false}
                        onEditRoute={props.onEditRoute}
                        onRemoveRoute={props.onRemoveRoute}
                        onAddUpstream={props.onAddUpstream}
                        onAddDownstream={props.onAddDownstream}
                    />

                    {tree.downstream.map((c) => (
                        <RouteNodeView
                            key={`down:${c.edgeFrom}->${c.edgeTo}`}
                            node={c}
                            side="down"
                            onEditRoute={props.onEditRoute}
                            onRemoveRoute={props.onRemoveRoute}
                        />
                    ))}
                </div>
            )}
        </div>
    );

    return (
        <div className={"seqtk-split" + (delegated ? " seqtk-split-delegated" : "")}>
            {/* 委托期间左栏与把手都不渲染：委托的目的正是把空间让给右栏 */}
            {!delegated && (
                <>
                    {left}

                    {/* 双栏比例把手：与事务设计左栏同一种交互 */}
                    <div
                        className="seqtk-split-handle"
                        role="separator"
                        aria-orientation="vertical"
                        onPointerDown={onHandleDown}
                        onPointerMove={onHandleMove}
                        onPointerUp={onHandleUp}
                        onPointerCancel={onHandleUp}
                    />
                </>
            )}

            <div className="seqtk-split-right">{right}</div>
        </div>
    );
}
