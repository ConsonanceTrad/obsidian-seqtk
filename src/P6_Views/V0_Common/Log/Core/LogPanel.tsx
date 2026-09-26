/**
 * LogPanel — 日志阅览视图的渲染件
 *
 * 纯渲染：不含业务逻辑，不 import obsidian，不触碰数据层。
 * 逻辑侧见同目录 Log.ts；状态构建纯函数见 ../Slice/buildState.ts。
 *
 * 左栏：日志类型（展开其日期列表）；右栏：选中日期的条目（最新在上）+ 搜索。
 */

import { Button, Input, List, Tag, Typography } from "antd";
import { useStore } from "../../../../P0_UI/useStore";
import { DualPane } from "../../../../P7_Render/Structure/S1_Container/DualPane";
import { FORMAT_LogDate, type LogViewState } from "../Slice/buildState";
import type { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";
import type { NodeRuntimeKindValue } from "../../../../P4_Nodes/NodeKind/NodeKind";

const { Text } = Typography;

export interface LogPanelProps {
    /** 状态源（视图类重算后写入） */
    state: SimpleStore<LogViewState>;
    onSelectKind: (kind: NodeRuntimeKindValue) => void;
    onSelectDate: (date: string) => void;
    onSearch: (search: string) => void;
    onRefresh: () => void;
}

export function LogPanel({ state, onSelectKind, onSelectDate, onSearch, onRefresh }: LogPanelProps) {
    const s = useStore(state);

    const left = (
        <div className="seqtk-pane">
            <div className="seqtk-split-title">日志分类</div>
            {s.groups.map((g) => {
                const active = g.kind === s.selectedKind;
                return (
                    <div key={g.kind} className="seqtk-log-kind">
                        <div
                            className={active ? 'seqtk-log-kind-head is-active' : 'seqtk-log-kind-head'}
                            onClick={() => onSelectKind(g.kind)}
                        >
                            <span>{g.label}</span>
                            {g.dates.length > 0 && <Tag>{g.dates.length} 天</Tag>}
                        </div>
                        {active && (
                            <div className="seqtk-log-dates">
                                {g.dates.map((d) => (
                                    <div
                                        key={d}
                                        className={d === s.selectedDate ? 'seqtk-log-date is-active' : 'seqtk-log-date'}
                                        onClick={() => onSelectDate(d)}
                                    >
                                        {FORMAT_LogDate(d)}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );

    const right = (
        <div className="seqtk-pane">
            <div className="seqtk-log-toolbar">
                <div className="seqtk-split-title">
                    {s.selectedDate ? FORMAT_LogDate(s.selectedDate) : '日志条目'}
                </div>
                <Input.Search
                    allowClear
                    size="small"
                    placeholder="搜索日志"
                    value={s.search}
                    onChange={(e) => onSearch(e.target.value)}
                />
                <Button size="small" onClick={onRefresh}>刷新</Button>
            </div>
            {s.entries.length === 0 ? (
                <div className="seqtk-empty">{s.emptyText}</div>
            ) : (
                <List
                    size="small"
                    dataSource={s.entries}
                    renderItem={(e) => (
                        <List.Item className="seqtk-log-item">
                            <Text type="secondary" className="seqtk-log-time">{e.time}</Text>
                            <Text className="seqtk-log-text">{e.text}</Text>
                        </List.Item>
                    )}
                />
            )}
        </div>
    );

    return <DualPane left={left} right={right} />;
}
