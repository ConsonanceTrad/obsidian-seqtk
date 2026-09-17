/**
 * RoutePanel — 线路模式的渲染件
 *
 * 纯渲染：左栏框架选择区 + 右栏（标题栏 / 连线开关 / 复合信息 / 白板容器）。
 * 不 import obsidian、不触碰 NodeCache —— CanvasBoard 与全部画布操作由 RouteView 掌管。
 */

import { Button, Empty, List, Tag, Typography } from "antd";
import { useStore } from "../../../../P0_UI/useStore";
import { CanvasBoardHost } from "../../../../P7_Render/Structure/S3_Board/CanvasBoardHost";
import type { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";

const { Title, Text } = Typography;

/** 左栏框架条目 */
export interface RouteFrameRow {
    nodeId: string;
    desc: string;
    kindLabel: string;
}

/** 线路模式状态（渲染件订阅的唯一来源） */
export interface RouteState {
    /** 缓存尚未就绪 */
    initializing: boolean;
    /** 左栏：事务框架 + 信息框架 */
    frameworks: RouteFrameRow[];
    /** 当前选中的框架 nodeId（null = 未选） */
    selectedId: string | null;
    /** 临时渲染到画布的框架（本次打开中，右键加入） */
    tempIds: string[];
    /** 连线模式是否开启 */
    linkingMode: boolean;
    /** 右栏空态提示（未选任何框架时） */
    rightEmpty?: string;
    /** 复合信息：选中框架子树状态聚合文本 */
    infoText: string;
}

export interface RoutePanelProps {
    state: SimpleStore<RouteState>;
    onSelect: (nodeId: string) => void;
    onToggleTemp: (nodeId: string) => void;
    onToggleLinking: () => void;
    /** 左栏空白处右键（新建框架） */
    onFrameAreaContextMenu: (e: globalThis.MouseEvent) => void;
    /** 白板空白处右键（新建顶层事务） */
    onBoardContextMenu: (e: globalThis.MouseEvent) => void;
    onContainerReady: (container: HTMLDivElement) => void;
    onContainerDispose: () => void;
}

export function RoutePanel(props: RoutePanelProps) {
    const { state, onSelect, onToggleTemp, onToggleLinking } = props;
    const { initializing, frameworks, selectedId, tempIds, linkingMode, rightEmpty, infoText } =
        useStore(state);

    const tempSet = new Set(tempIds);

    const left = (
        <div className="seqtk-pane">
            <Title level={5} className="seqtk-split-title">框架</Title>
            {initializing ? (
                <Empty description="正在加载缓存…" />
            ) : frameworks.length === 0 ? (
                <Empty description="暂无框架（右键此处新建）" />
            ) : (
                <List
                    size="small"
                    dataSource={frameworks}
                    renderItem={(f) => (
                        <List.Item
                            className={
                                'seqtk-frame-item'
                                + (f.nodeId === selectedId ? ' seqtk-frame-item-active' : '')
                                + (tempSet.has(f.nodeId) ? ' seqtk-frame-item-temp' : '')
                            }
                            onClick={() => onSelect(f.nodeId)}
                            onContextMenu={(e) => {
                                if (f.nodeId === selectedId) return;
                                e.preventDefault();
                                e.stopPropagation();
                                onToggleTemp(f.nodeId);
                            }}
                        >
                            <Tag>{f.kindLabel}</Tag>
                            <Text>{f.desc}</Text>
                        </List.Item>
                    )}
                />
            )}
        </div>
    );

    const right = (
        <div className="seqtk-pane">
            <div className="seqtk-board-titlebar">
                <Title level={5} className="seqtk-split-title">线路图</Title>
                <Button
                    size="small"
                    type={linkingMode ? 'primary' : 'default'}
                    onClick={onToggleLinking}
                >
                    {linkingMode ? '退出连线' : '连线模式'}
                </Button>
            </div>
            {infoText && <div className="seqtk-route-info-text">{infoText}</div>}
            {rightEmpty ? (
                <Empty description={rightEmpty} />
            ) : (
                <CanvasBoardHost
                    onContainerReady={props.onContainerReady}
                    onContainerDispose={props.onContainerDispose}
                    onContextMenu={(e) => props.onBoardContextMenu(e.nativeEvent)}
                />
            )}
        </div>
    );

    return (
        // 左栏空白右键：新建框架（点在 .seqtk-frame-item 上的由行自身的处理接管）
        <div
            className="seqtk-split"
            onContextMenu={(e) => {
                if ((e.target as HTMLElement).closest('.seqtk-frame-item')) return;
                // 白板区的右键由 CanvasBoardHost 自己处理（stopPropagation 不在此处做）
                props.onFrameAreaContextMenu(e.nativeEvent);
            }}
        >
            <div className="seqtk-split-left">{left}</div>
            <div className="seqtk-split-right">{right}</div>
        </div>
    );
}
