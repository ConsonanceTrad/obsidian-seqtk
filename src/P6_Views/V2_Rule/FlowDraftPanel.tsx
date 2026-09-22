/**
 * FlowDraftPanel — 流程草稿视图的渲染件
 *
 * 纯渲染：左栏**日历**（选日期）+ 右栏工具栏（加时点 / 加时段 / 排序 / 保存状态）+ 清单容器。
 *
 * 为什么左栏是日历而不是列表：「一份草稿 = 一天」是这份数据的骨架，按日期找比按标题找
 * 更贴近它的用法。有草稿的日子在日历上打点，点一下就切过去；同一天有多份时，
 * 它们列在日历下方，右栏工具栏也提供一个下拉。
 *
 * 日历是自绘的（不引 antd Calendar）：这里只需要「月份翻页 + 选中 + 打点」，
 * 自绘既省掉对 antd 版本差异的依赖，也不掺进它自带的那套日期逻辑。
 *
 * 清单（一条一行：时间 + 说明 + 关联节点）是命令式 DOM，因此本组件只提供容器，
 * 渲染与编辑仍由 FlowDraftView 掌管 —— 与 FlowDesign 的 FlowHost 同一原则。
 */

import { Button, Select } from "antd";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../../P0_UI/useStore";
import type { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";

/** 草稿条目 */
export interface FlowDraftRow {
    id: string;
    title: string;
    /** 副标题：条目数（日期已在日历上体现，不必重复） */
    meta: string;
}

/** 流程草稿状态（渲染件订阅的唯一来源） */
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
}

export interface FlowDraftPanelProps {
    state: SimpleStore<FlowDraftState>;
    /** 在日历上选一个日期 */
    onPickDate: (date: string) => void;
    /** 在选中日期新建一份草稿 */
    onCreateOnDate: () => void;
    onSelectDraft: (id: string) => void;
    onDraftContextMenu: (id: string, e: globalThis.MouseEvent) => void;
    /** 加一个时点条目 */
    onAddPoint: () => void;
    /** 加一个时段条目 */
    onAddSpan: () => void;
    /** 按时点 / 时段起点重排 */
    onSortByTime: () => void;
    onListReady: (container: HTMLDivElement) => void;
    onListDispose?: () => void;
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

/** 某月 1 号是这一周的第几格（0 = 周一） */
function firstWeekdayIndex(d: Date): number {
    return (new Date(d.getFullYear(), d.getMonth(), 1).getDay() + 6) % 7;
}

/**
 * 自绘月历：‹ › 翻月、点日期选中、有草稿的日子打点
 *
 * 显示的月份由内部游标控制；选中的日期换到别的月时（比如从别处切过来），游标跟着翻过去。
 */
function MonthCalendar({ selected, marked, onPickDate }: {
    selected: string;
    marked: string[];
    onPickDate: (date: string) => void;
}) {
    const sel = parseYmd(selected);
    const [cursor, setCursor] = useState(() => new Date(sel.getFullYear(), sel.getMonth(), 1));

    // 选中日期落入别的月 → 翻到那个月（同月就不动，免得打断用户正在翻的页）
    useEffect(() => {
        const d = parseYmd(selected);
        setCursor((c) => (c.getFullYear() === d.getFullYear() && c.getMonth() === d.getMonth()
            ? c
            : new Date(d.getFullYear(), d.getMonth(), 1)));
    }, [selected]);

    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const lead = firstWeekdayIndex(cursor);
    const days = new Date(year, month + 1, 0).getDate();
    const markedSet = new Set(marked);
    const now = new Date();
    const todayKey = ymd(now.getFullYear(), now.getMonth(), now.getDate());

    const cells: (string | null)[] = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(ymd(year, month, d));

    const shift = (delta: number): void => setCursor(new Date(year, month + delta, 1));

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
                {cells.map((key, i) => key === null
                    ? <span key={`blank-${i}`} className="seqtk-draft-cal-blank" />
                    : (
                        <button
                            key={key}
                            className={
                                'seqtk-draft-cal-day'
                                + (key === selected ? ' seqtk-draft-cal-day-sel' : '')
                                + (key === todayKey ? ' seqtk-draft-cal-day-today' : '')
                            }
                            onClick={() => onPickDate(key)}
                            title={key}
                        >
                            {Number(key.slice(8))}
                            {markedSet.has(key) && <span className="seqtk-draft-cal-dot" />}
                        </button>
                    ))}
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

export function FlowDraftPanel(props: FlowDraftPanelProps) {
    const { state, onCreateOnDate, onSelectDraft } = props;
    const { selectedDate, markedDates, dayDrafts, selectedDraftId, title, saveState, hasDraft } = useStore(state);

    const left = (
        <div className="seqtk-pane">
            <div className="seqtk-split-title">流程草稿</div>
            <MonthCalendar selected={selectedDate} marked={markedDates} onPickDate={props.onPickDate} />
            <div className="seqtk-draft-cal-actions">
                <Button size="small" type="primary" onClick={onCreateOnDate}>+ 在这天新建</Button>
            </div>
            {dayDrafts.length === 0 ? (
                <div className="seqtk-draft-cal-empty">这一天还没有草稿</div>
            ) : (
                <div className="seqtk-draft-cal-list">
                    {dayDrafts.map((d) => (
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
                            <span className="seqtk-draft-list-meta">{d.meta}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    const right = (
        <div className="seqtk-pane">
            <div className="seqtk-draft-toolbar">
                <span className={'seqtk-draft-toolbar-title' + (hasDraft ? '' : ' seqtk-draft-toolbar-title-dim')}>
                    {selectedDate} · {title}
                </span>
                {/* 同一天有多份时才需要选择器 —— 只有一份时它只是噪音 */}
                {dayDrafts.length > 1 && (
                    <Select
                        size="small"
                        style={{ minWidth: 130 }}
                        value={selectedDraftId ?? undefined}
                        onChange={(id: string) => onSelectDraft(id)}
                        options={dayDrafts.map((d) => ({ value: d.id, label: d.title }))}
                    />
                )}
                {hasDraft && (
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
                <span className="seqtk-draft-save-state">{saveState}</span>
            </div>
            <ListHost onReady={props.onListReady} onDispose={props.onListDispose} />
        </div>
    );

    return (
        <div className="seqtk-split">
            <div className="seqtk-split-left">{left}</div>
            <div className="seqtk-split-right">{right}</div>
        </div>
    );
}
