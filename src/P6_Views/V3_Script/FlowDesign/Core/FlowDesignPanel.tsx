/**
 * FlowDesignPanel — 流程设计视图的渲染件
 *
 * 纯渲染：左栏流程脚本列表 + 右栏外壳（模式切换 / 保存 / 内容容器）。
 *
 * LAD 编辑器（流投影 + 拖拽重排 + 命令式 DOM 构建）是深度命令式的 DOM 代码，
 * 因此本组件只提供容器（FlowHost），编辑器本体仍由 FlowView 渲染进去 ——
 * 与 CanvasBoardHost 对 cytoscape 的处理同一原则：命令式资源不进 React 渲染树。
 *
 * 两栏额外带 `seqtk-flow-pane`：`.seqtk-pane` 是六个面板共用的名字，在 styles.css 里
 * 没有定义 —— 直接补全会外溢到别的视图。本视图需要「栏高确定 + 内容区自己滚」，
 * 就用这个专用类把高度链接通，改动不外溢。
 *
 * 左栏宽度与设计 / 模板同一种交互：拖动期间由 usePaneResize 直接改 DOM，
 * 松手才进 state 并上报（视图负责防抖落盘）。
 *
 * 委托：左栏的脚本列表被委托出去后，左栏与把手都**不渲染**（委托的用意就是把空间让出去），
 * 取消委托在委托面板那一侧 —— 与线路 / 模板同一套语义。
 */

import { Button, Empty, List, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../../../../P0_UI/useStore";
import { PANE_WIDTH_DEFAULT, usePaneResize } from "../../../../P0_UI/usePaneResize";
import type { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";

const { Title, Text } = Typography;

/** 左栏脚本条目 */
export interface FlowScriptRow {
    nodeId: string;
    desc: string;
    kindLabel: string;
    /** 层级深度（缩进用；根级 0） */
    depth: number;
    /** 分组（有同类子脚本）：徽章文本是「分组」，点击只展开/收起 */
    isGroup: boolean;
    hasChildren: boolean;
    expanded: boolean;
}

/** 流程设计状态（渲染件订阅的唯一来源） */
export interface FlowDesignState {
    /** 缓存尚未就绪 */
    initializing: boolean;
    /** 左栏：流程脚本列表 */
    scripts: FlowScriptRow[];
    /** 当前选中的脚本 nodeId */
    currentScriptId: string | null;
    /** 右栏模式 */
    mode: 'script' | 'lad';
    /** 左栏宽度（px；0 = 用默认值）。只在首次挂载时作为初值 */
    leftPaneWidth: number;
    /** 左栏脚本列表是否已委托到侧栏（true 时左栏让位） */
    delegated: boolean;
    /** 右栏内容区空态提示（未选脚本时） */
    contentEmpty?: string;
}

export interface FlowDesignPanelProps {
    state: SimpleStore<FlowDesignState>;
    onSelectScript: (nodeId: string) => void;
    /** 脚本行右键（nodeId=null 表示左栏空白处） */
    onScriptContextMenu: (nodeId: string | null, e: globalThis.MouseEvent) => void;
    /** 委托 / 取消委托 */
    onToggleDelegate: () => void;
    onToggleMode: () => void;
    onSave: () => void;
    /** 拖完把手后上报左栏宽度（视图防抖写回设置） */
    onWidthChange: (width: number) => void;
    /** 右栏内容容器就绪（FlowView 把脚本态 / LAD 态渲染进去） */
    onContentReady: (container: HTMLDivElement) => void;
    /** 容器卸载前（清理） */
    onContentDispose?: () => void;
}

/** 内容容器承载层：只提供 DOM 节点，字体 / 编辑逻辑由 FlowView 掌管 */
function FlowHost({ onReady, onDispose }: { onReady: (el: HTMLDivElement) => void; onDispose?: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const readyRef = useRef(onReady);
    const disposeRef = useRef(onDispose);
    readyRef.current = onReady;
    disposeRef.current = onDispose;

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        readyRef.current(el);
        return () => { disposeRef.current?.(); };
    }, []);

    return <div className="seqtk-flow-content" ref={ref} />;
}

export function FlowDesignPanel(props: FlowDesignPanelProps) {
    const { state, onSelectScript, onToggleDelegate, onToggleMode, onSave, onWidthChange } = props;
    const { initializing, scripts, currentScriptId, mode, leftPaneWidth, delegated, contentEmpty } = useStore(state);

    const [leftWidth, setLeftWidth] = useState(leftPaneWidth || PANE_WIDTH_DEFAULT);
    const { paneRef, handleProps } = usePaneResize(leftWidth, (width) => {
        setLeftWidth(width);
        onWidthChange(width);
    });

    const left = (
        <div className="seqtk-pane seqtk-flow-pane">
            <div className="seqtk-board-titlebar">
                <Title level={5} className="seqtk-split-title">流程脚本</Title>
                {/* 委托后左栏（连同本按钮）让位，取消委托在侧栏的委托面板里 —— 与线路 / 模板一致 */}
                <Button size="small" onClick={onToggleDelegate} title="把脚本列表委托到侧栏">
                    委托
                </Button>
            </div>
            {initializing ? (
                <Empty description="正在加载缓存…" />
            ) : scripts.length === 0 ? (
                <Empty description="暂无流程脚本（右键此处新建）" />
            ) : (
                <List
                    size="small"
                    dataSource={scripts}
                    renderItem={(s) => (
                        <List.Item
                            className={'seqtk-flow-item' + (s.nodeId === currentScriptId ? ' seqtk-flow-item-active' : '')}
                            onClick={() => onSelectScript(s.nodeId)}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                props.onScriptContextMenu(s.nodeId, e.nativeEvent);
                            }}
                        >
                            {/* 层级缩进 + 分组折叠方块（叶子给同宽占位保持对齐） */}
                            <span style={{ width: s.depth * 14, flex: '0 0 auto' }} />
                            {s.hasChildren ? (
                                <span className="seqtk-flow-twisty">{s.expanded ? '▾' : '▸'}</span>
                            ) : (
                                <span className="seqtk-flow-twisty" />
                            )}
                            <Tag>{s.kindLabel}</Tag>
                            <Text>{s.desc}</Text>
                        </List.Item>
                    )}
                />
            )}
        </div>
    );

    const right = (
        <div className="seqtk-pane seqtk-flow-pane">
            <div className="seqtk-board-titlebar">
                <Button size="small" onClick={onToggleMode}>
                    {mode === 'script' ? '切换到 LAD 程序' : '切换到脚本程序'}
                </Button>
                <Button size="small" type="primary" onClick={onSave}>保存</Button>
            </div>
            {contentEmpty ? (
                <Empty description={contentEmpty} />
            ) : (
                <FlowHost onReady={props.onContentReady} onDispose={props.onContentDispose} />
            )}
        </div>
    );

    return (
        // 左栏空白右键：新建脚本（委托期间左栏不在，就别再接管右键了）
        <div
            className={'seqtk-split' + (delegated ? ' seqtk-split-delegated' : '')}
            onContextMenu={(e) => {
                if (delegated) return;
                if ((e.target as HTMLElement).closest('.seqtk-flow-item')) return;
                props.onScriptContextMenu(null, e.nativeEvent);
            }}
        >
            {!delegated && (
                <>
                    {/* 宽度用内联样式给：拖动期 usePaneResize 直接改这两个值（.seqtk-split-left 是 flex:0 0 auto） */}
                    <div className="seqtk-split-left" ref={paneRef} style={{ width: leftWidth, flexBasis: leftWidth }}>
                        {left}
                    </div>

                    <div className="seqtk-split-handle" {...handleProps} />
                </>
            )}

            <div className="seqtk-split-right">{right}</div>
        </div>
    );
}
