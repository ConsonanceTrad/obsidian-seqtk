/**
 * FlowDraftPanel — 事务分发视图的渲染件
 *
 * 纯渲染：不含业务逻辑，不 import obsidian，不触碰数据层。
 * 逻辑侧见同目录 FlowDraft.ts。
 *
 * 布局：左栏 = 月历 + 当日草稿列表（`DraftCalendarPanel`，委托面板复用同一份），
 * 右栏 = 选中草稿的条目清单。双栏把手与委托让位复用统一框架
 * （usePaneResize + seqtk-split 骨架），与设计 / 模板 / 流程 / 查询同一套交互。
 */

import { useEffect, useRef, useState } from "react";
import { Button, Select } from "antd";
import { useStore } from "../../P0_UI/useStore";
import { usePaneResize, PANE_WIDTH_DEFAULT } from "../../P0_UI/usePaneResize";
import { IconButton } from "../../P7_Render/Composition/C1_NodeLine/IconButton";
import type { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";
import type { NodeLineHost } from "../../P7_Render/Composition/C1_NodeLine/NodeLine";

/** 草稿条目 */
export interface FlowDraftRow {
    id: string;
    title: string;
    /** 副标题：条目数（日期已在日历上体现，不必重复） */
    meta: string;
}

/** 事务分发状态（渲染件订阅的唯一来源） */
export interface FlowDraftState {
    /** 当前选中的日期（YYYY-MM-DD） */
    selectedDate: string;
    /** 有草稿的日期（日历上打点用） */
    markedDates: string[];
    /** 选中日期下的草稿（同一天可以有多份） */
    dayDrafts: FlowDraftRow[];
    selectedDraftId: string | null;
    /** 工具栏标题（未选中草稿时为「未新建」） */
    title: string;
    /** 保存状态文案（"已保存 xx:xx" / "保存中…"） */
    saveState: string;
    /** 当前是否有选中草稿（决定工具栏按钮是否可用） */
    hasDraft: boolean;
    /** 委托中（左栏让位右栏） */
    delegated: boolean;
    /** 左栏宽度（0 = 用默认） */
    leftPaneWidth: number;
}

/** 月历侧的动作（主视图左栏与委托面板同一套） */
export interface DraftCalendarActions {
    onPickDate: (date: string) => void;
    onCreateOnDate: () => void;
    onSelectDraft: (id: string) => void;
    onDraftContextMenu: (id: string, e: globalThis.MouseEvent) => void;
}

export interface FlowDraftPanelProps {
    state: SimpleStore<FlowDraftState>;
    calendar: DraftCalendarActions;
    onToggleDelegate: () => void;
    onWidthChange: (width: number) => void;
    /** 加一个时点条目 */
    onAddPoint: () => void;
    /** 加一个时段条目 */
    onAddSpan: () => void;
    /** 按时点 / 时段起点重排 */
    onSortByTime: () => void;
    onListReady: (container: HTMLDivElement) => void;
    onListDispose?: () => void;
    host: NodeLineHost;
}

// ============================================================
// 日期小工具（只服务日历显示）
// ============================================================

const PAD = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` */
const ymd = (y: number, m: number, d: number): string => `${y}-${PAD(m + 1)}-${PAD(d)}`;

/** 表头从周一开始，与 firstWeekdayIndex 的算法对齐 */
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

/** 解析 `YYYY-MM-DD`；解不出就退回今天 */
function parseYmd(s: string): Date {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
}

/** 本月 1 号是周几（周一 = 0） */
function firstWeekdayIndex(d: Date): number {
    return (d.getDay() + 6) % 7;
}

/** 月历（纯显示 + 选日期） */
function MonthCalendar({ selected, marked, onPickDate }: {
    selected: string;
    marked: string[];
    onPickDate: (date: string) => void;
}) {
    const cur = parseYmd(selected);
    const [view, setView] = useState(() => new Date(cur.getFullYear(), cur.getMonth(), 1));
    const year = view.getFullYear();
    const month = view.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const lead = firstWeekdayIndex(view);
    const markedSet = new Set(marked);

    const shift = (delta: number): void => setView(new Date(year, month + delta, 1));

    return (
        <div className="seqtk-draft-cal">
            <div className="seqtk-draft-cal-head">
                <button className="seqtk-draft-icon-btn" onClick={() => shift(-1)} aria-label="上个月">‹</button>
                <span className="seqtk-draft-cal-title">{year} 年 {month + 1} 月</span>
                <button className="seqtk-draft-icon-btn" onClick={() => shift(1)} aria-label="下个月">›</button>
            </div>
            <div className="seqtk-draft-cal-grid">
                {WEEKDAYS.map((w) => (
                    <span key={w} className="seqtk-draft-cal-week">{w}</span>
                ))}
                {Array.from({ length: lead }, (_, i) => (
                    <span key={`blank-${i}`} className="seqtk-draft-cal-blank" />
                ))}
                {Array.from({ length: daysInMonth }, (_, i) => {
                    const day = i + 1;
                    const key = ymd(year, month, day);
                    return (
                        <button
                            key={key}
                            className={
                                'seqtk-draft-cal-day'
                                + (key === selected ? ' seqtk-draft-cal-day-active' : '')
                            }
                            onClick={() => onPickDate(key)}
                        >
                            {day}
                            {markedSet.has(key) && <span className="seqtk-draft-cal-dot" />}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/** 清单承载层：只提供容器，行由 FlowDraftView 渲染进去 */
function ListHost({ onReady, onDispose }: { onReady: (el: HTMLDivElement) => void; onDispose?: () => void }) {
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

    return <div className="seqtk-draft-list" ref={ref} />;
}

/**
 * 分发日历面板（左栏内容）
 *
 * 主视图左栏与委托面板共用这一份 —— 月历、当日列表与动作完全一致，
 * 委托只是把这块内容挪到侧栏显示。
 */
export function DraftCalendarPanel({ state, actions }: {
    state: SimpleStore<FlowDraftState>;
    actions: DraftCalendarActions;
}) {
    const { selectedDate, markedDates, dayDrafts, selectedDraftId } = useStore(state);
    return (
        <>
            <MonthCalendar selected={selectedDate} marked={markedDates} onPickDate={actions.onPickDate} />
            <div className="seqtk-draft-cal-actions">
                <Button size="small" type="primary" onClick={actions.onCreateOnDate}>+ 在这天新建</Button>
            </div>
            {dayDrafts.length === 0 ? (
                <div className="seqtk-draft-cal-empty">这一天还没有草稿</div>
            ) : (
                <div className="seqtk-draft-cal-list">
                    {dayDrafts.map((d) => (
                        <div
                            key={d.id}
                            className={'seqtk-draft-list-item' + (d.id === selectedDraftId ? ' seqtk-draft-list-item-active' : '')}
                            onClick={() => actions.onSelectDraft(d.id)}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                actions.onDraftContextMenu(d.id, e.nativeEvent);
                            }}
                        >
                            <span className="seqtk-draft-list-title">{d.title}</span>
                            <span className="seqtk-draft-list-meta">{d.meta}</span>
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}

export function FlowDraftPanel(props: FlowDraftPanelProps) {
    const { state, calendar, onListReady, onListDispose } = props;
    const s = useStore(state);

    const [leftWidth, setLeftWidth] = useState(s.leftPaneWidth || PANE_WIDTH_DEFAULT);
    const { paneRef, handleProps } = usePaneResize(leftWidth, (width) => {
        setLeftWidth(width);
        props.onWidthChange(width);
    });

    const left = (
        <div className="seqtk-pane">
            <div className="seqtk-board-titlebar">
                <span className="seqtk-split-title">事务分发</span>
                {/* 委托开关收在标题末尾（图标按钮）：与设计 / 模板 / 查询同一套 */}
                <IconButton
                    className="seqtk-icon-btn seqtk-delegate-btn"
                    icon="chevrons-left"
                    tip="把分发日历委托到侧栏"
                    host={props.host}
                    onClick={() => props.onToggleDelegate()}
                />
            </div>
            <DraftCalendarPanel state={state} actions={calendar} />
        </div>
    );

    const right = (
        <div className="seqtk-pane">
            <div className="seqtk-draft-toolbar">
                <span className={'seqtk-draft-toolbar-title' + (s.hasDraft ? '' : ' seqtk-draft-toolbar-title-dim')}>
                    {s.selectedDate} · {s.title}
                </span>
                {/* 同一天有多份时才需要选择器 —— 只有一份时它只是噪音 */}
                {s.dayDrafts.length > 1 && (
                    <Select
                        size="small"
                        style={{ minWidth: 130 }}
                        value={s.selectedDraftId ?? undefined}
                        onChange={(id: string) => calendar.onSelectDraft(id)}
                        options={s.dayDrafts.map((d) => ({ value: d.id, label: d.title }))}
                    />
                )}
                {s.hasDraft && (
                    <>
                        <Button size="small" onClick={props.onAddPoint} title="加一个时点条目">
                            + 时点
                        </Button>
                        <Button size="small" onClick={props.onAddSpan} title="加一个时段条目">
                            + 时段
                        </Button>
                        <Button size="small" onClick={props.onSortByTime} title="按时点 / 时段起点重排">
                            按时间排序
                        </Button>
                    </>
                )}
                <span className="seqtk-draft-save-state">{s.saveState}</span>
            </div>
            <ListHost onReady={onListReady} onDispose={onListDispose} />
        </div>
    );

    return (
        // 委托期间左栏与把手让位右栏（与其余视图一致）
        <div className={'seqtk-split' + (s.delegated ? ' seqtk-split-delegated' : '')}>
            {!s.delegated && (
                <>
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
