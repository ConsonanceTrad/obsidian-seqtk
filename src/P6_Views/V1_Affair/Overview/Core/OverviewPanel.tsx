/**
 * OverviewPanel — 证据总览视图的渲染件
 *
 * 纯渲染：标题栏（标题 + 连线模式开关）+ 白板容器。
 * 不 import obsidian、不触碰 NodeCache —— CanvasBoard 的生命周期与全部画布操作
 * 都由 OverviewView 经回调掌管（命令式库不进 React 渲染树）。
 */

import { Button, Typography } from "antd";
import { useStore } from "../../../../P0_UI/useStore";
import { CanvasBoardHost } from "../../../../P7_Render/Structure/S3_Board/CanvasBoardHost";
import type { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";

const { Title } = Typography;

/** 证据总览状态（渲染件订阅的唯一来源） */
export interface OverviewState {
    /** 连线模式是否开启 */
    linkingMode: boolean;
}

export interface OverviewPanelProps {
    state: SimpleStore<OverviewState>;
    onToggleLinking: () => void;
    onContainerReady: (container: HTMLDivElement) => void;
    onContainerDispose: () => void;
    /** 白板空白处右键（已转成原生事件，供 Obsidian Menu.showAtMouseEvent 使用） */
    onBlankContextMenu: (e: globalThis.MouseEvent) => void;
}

export function OverviewPanel(props: OverviewPanelProps) {
    const { linkingMode } = useStore(props.state);

    return (
        <div className="seqtk-design-view">
            <div className="seqtk-board-titlebar">
                <Title level={5} className="seqtk-split-title">证据总览</Title>
                <Button
                    size="small"
                    type={linkingMode ? 'primary' : 'default'}
                    onClick={props.onToggleLinking}
                >
                    {linkingMode ? '退出连线' : '连线模式'}
                </Button>
            </div>
            <CanvasBoardHost
                onContainerReady={props.onContainerReady}
                onContainerDispose={props.onContainerDispose}
                onContextMenu={(e) => props.onBlankContextMenu(e.nativeEvent)}
            />
        </div>
    );
}
