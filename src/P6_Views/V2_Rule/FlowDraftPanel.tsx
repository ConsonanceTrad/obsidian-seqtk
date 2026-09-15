/**
 * FlowDraftPanel — 流程草稿视图的渲染件
 *
 * 纯渲染：左栏草稿列表 + 右栏工具栏（排序 / 加轴 / 加块 / 保存状态）+ 泳道板容器。
 *
 * 泳道板（横向泳道 + 块拖拽重排 / 跨轴移动）是深度命令式 DOM 代码，
 * 因此本组件只提供滚动容器（BoardHost），泳道渲染与拖拽仍由 FlowDraftView 掌管 ——
 * 与 CanvasBoardHost / FlowHost 同一原则：命令式资源不进 React 渲染树。
 */

import { Button, Empty, Typography } from "antd";
import { useEffect, useRef } from "react";
import { useStore } from "../../P0_UI/useStore";
import type { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";

const { Text } = Typography;

/** 左栏草稿条目 */
export interface FlowDraftRow {
    id: string;
    title: string;
    /** 轴数 */
    axes: number;
    /** 块数 */
    blocks: number;
}

/** 流程草稿状态（渲染件订阅的唯一来源） */
export interface FlowDraftState {
    drafts: FlowDraftRow[];
    selectedDraftId: string | null;
    /** 工具栏标题（未选中时为「流程草稿」） */
    title: string;
    /** 保存状态文案（"已保存 xx:xx" / "保存中…"） */
    saveState: string;
    /** 当前是否有选中草稿（决定工具栏按钮是否可用） */
    hasDraft: boolean;
}

export interface FlowDraftPanelProps {
    state: SimpleStore<FlowDraftState>;
    onCreateDraft: () => void;
    onSelectDraft: (id: string) => void;
    onDraftContextMenu: (id: string, e: globalThis.MouseEvent) => void;
    /** 左栏空白处右键（新建草稿） */
    onLeftBlankContextMenu: (e: globalThis.MouseEvent) => void;
    onSortByTime: (desc: boolean) => void;
    onAddAxis: () => void;
    onAddBlock: () => void;
    onBoardReady: (container: HTMLDivElement) => void;
    onBoardDispose?: () => void;
}

/** 泳道板承载层：只提供滚动容器 */
function BoardHost({ onReady, onDispose }: { onReady: (el: HTMLDivElement) => void; onDispose?: () => void }) {
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

    return <div className="seqtk-draft-board" ref={ref} />;
}

export function FlowDraftPanel(props: FlowDraftPanelProps) {
    const { state, onCreateDraft, onSelectDraft, onSortByTime } = props;
    const { drafts, selectedDraftId, title, saveState, hasDraft } = useStore(state);

    const left = (
        <div className="seqtk-pane">
            <div className="seqtk-split-title">流程草稿</div>
            <div>
                <Button size="small" onClick={onCreateDraft}>+ 新建草稿</Button>
            </div>
            {drafts.length === 0 ? (
                <Empty description="暂无草稿（点击上方新建）" />
            ) : (
                drafts.map((d) => (
                    <div
                        key={d.id}
                        className={'seqtk-draft-list-item' + (d.id === selectedDraftId ? ' seqtk-draft-list-item-active' : '')}
                        onClick={() => onSelectDraft(d.id)}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            props.onDraftContextMenu(d.id, e.nativeEvent);
                        }}
                    >
                        <span className="seqtk-draft-list-title">{d.title}</span>
                        <span className="seqtk-draft-list-meta">{d.axes} 轴 · {d.blocks} 块</span>
                    </div>
                ))
            )}
        </div>
    );

    const right = (
        <div className="seqtk-pane">
            <div className="seqtk-draft-toolbar">
                <span className={'seqtk-draft-toolbar-title' + (hasDraft ? '' : ' seqtk-draft-toolbar-title-dim')}>
                    {title}
                </span>
                {hasDraft && (
                    <>
                        <Button size="small" onClick={() => onSortByTime(false)} title="按各事件轴的起止时间对泳道升序重排（无时间的轴排尾部）">
                            时间 ↑
                        </Button>
                        <Button size="small" onClick={() => onSortByTime(true)} title="按各事件轴的起止时间对泳道降序重排">
                            时间 ↓
                        </Button>
                        <Button size="small" type="primary" onClick={props.onAddAxis}>+ 事件轴</Button>
                        <Button size="small" onClick={props.onAddBlock}>+ 顺序块</Button>
                        <span className="seqtk-draft-hint" aria-hidden="true" title="事件轴持有起止时间段（用于快速敲定时间）；块表示轴内执行顺序，可关联节点或输入文本" />
                    </>
                )}
                <span className="seqtk-draft-save-state">{saveState}</span>
            </div>
            <BoardHost onReady={props.onBoardReady} onDispose={props.onBoardDispose} />
            <Text type="secondary" style={{ display: 'none' }} />
        </div>
    );

    return (
        // 左栏空白右键：新建草稿（点在草稿行上的由行自身处理）
        <div
            className="seqtk-split"
            onContextMenu={(e) => {
                if ((e.target as HTMLElement).closest('.seqtk-draft-list-item')) return;
                if ((e.target as HTMLElement).closest('.seqtk-split-right')) return;
                props.onLeftBlankContextMenu(e.nativeEvent);
            }}
        >
            <div className="seqtk-split-left">{left}</div>
            <div className="seqtk-split-right">{right}</div>
        </div>
    );
}
