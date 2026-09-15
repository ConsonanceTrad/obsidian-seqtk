/**
 * FlowDesignPanel — 流程设计视图的渲染件
 *
 * 纯渲染：左栏流程脚本列表 + 右栏外壳（模式切换 / 保存 / 内容容器）。
 *
 * LAD 编辑器（母线投影 + 拖拽重排 + 递归渲染）是深度命令式的 DOM 代码，
 * 因此本组件只提供容器（FlowHost），编辑器本体仍由 FlowView 渲染进去 ——
 * 与 CanvasBoardHost 对 cytoscape 的处理同一原则：命令式资源不进 React 渲染树。
 */

import { Button, Empty, List, Tag, Typography } from "antd";
import { useEffect, useRef } from "react";
import { useStore } from "../../P0_UI/useStore";
import type { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";

const { Title, Text } = Typography;

/** 左栏脚本条目 */
export interface FlowScriptRow {
    nodeId: string;
    desc: string;
    kindLabel: string;
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
    /** 右栏内容区空态提示（未选脚本时） */
    contentEmpty?: string;
}

export interface FlowDesignPanelProps {
    state: SimpleStore<FlowDesignState>;
    onSelectScript: (nodeId: string) => void;
    /** 脚本行右键（nodeId=null 表示左栏空白处） */
    onScriptContextMenu: (nodeId: string | null, e: globalThis.MouseEvent) => void;
    onToggleMode: () => void;
    onSave: () => void;
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
    const { state, onSelectScript, onToggleMode, onSave } = props;
    const { initializing, scripts, currentScriptId, mode, contentEmpty } = useStore(state);

    const left = (
        <div className="seqtk-pane">
            <Title level={5} className="seqtk-split-title">流程脚本</Title>
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
                            <Tag>{s.kindLabel}</Tag>
                            <Text>{s.desc}</Text>
                        </List.Item>
                    )}
                />
            )}
        </div>
    );

    const right = (
        <div className="seqtk-pane">
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
        // 左栏空白右键：新建脚本
        <div
            className="seqtk-split"
            onContextMenu={(e) => {
                if ((e.target as HTMLElement).closest('.seqtk-flow-item')) return;
                props.onScriptContextMenu(null, e.nativeEvent);
            }}
        >
            <div className="seqtk-split-left">{left}</div>
            <div className="seqtk-split-right">{right}</div>
        </div>
    );
}
