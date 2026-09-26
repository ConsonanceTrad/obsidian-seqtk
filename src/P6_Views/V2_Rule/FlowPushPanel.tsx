/**
 * FlowPushPanel — 流程推送视图的渲染件
 *
 * 纯渲染：不含业务逻辑，不 import obsidian，不触碰 NodeCache。
 * 逻辑侧见同目录 FlowPush.ts；重算与提醒在 PushRuntime。
 *
 * ①C 形态：顶部**聚焦指示器**（当前活跃项 / 下一件预告），
 * 下方流程勾选 + 当日完整序列。完成项原位保留打勾样式，过时刻未完成原样不动
 * —— 不弱化、不催促（丢弃哲学：日终清空，不积压不追责）。
 */

import { useState } from "react";
import { Alert, Button, Checkbox, List, Tag, Typography } from "antd";
import { useStore } from "../../P0_UI/useStore";
import type { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";
import type { PushItemView, PushRuntimeState } from "./PushRuntime";

const { Text } = Typography;

/** 任务时间窗的显示：`HH:mm~HH:mm`；条件推送带「条件」前缀 */
function windowText(t: PushItemView): string {
    if (!t.winFrom || !t.winTo) return '未排期';
    const hhmm = (s: string): string => s.slice(9);
    return t.mode === 'condition'
        ? `条件 · ${hhmm(t.winFrom)}~${hhmm(t.winTo)}`
        : `${hhmm(t.winFrom)}~${hhmm(t.winTo)}`;
}

export interface FlowPushPanelProps {
    state: SimpleStore<PushRuntimeState>;
    onToggleScript: (scriptId: string, enabled: boolean) => void;
    onComplete: (nodeId: string) => void;
    onRefresh: () => void;
}

export function FlowPushPanel({ state, onToggleScript, onComplete, onRefresh }: FlowPushPanelProps) {
    const s = useStore(state);

    /** 同刻并行的活跃条目数（含当前这件；严格同 winFrom） */
    const activeCount = s.active
        ? s.items.filter((t) => !t.done && t.winFrom === s.active!.winFrom).length
        : 0;

    /** 顶部聚焦指示器 */
    const focus = (
        <div className="seqtk-push-focus">
            {s.active ? (
                <>
                    <div className="seqtk-push-focus-row">
                        <Tag className={`seqtk-push-time seqtk-push-time-${s.active.mode}`}>{windowText(s.active)}</Tag>
                        <Text strong className="seqtk-push-focus-desc">{s.active.nodeDesc}</Text>
                        <Button size="small" type="primary" onClick={() => onComplete(s.active!.nodeId)}>完成</Button>
                    </div>
                    <div className="seqtk-push-focus-sub">
                        <Text type="secondary">{s.active.scriptDesc}</Text>
                        {activeCount > 1 && <Text type="secondary">· 另有 {activeCount - 1} 件同刻</Text>}
                    </div>
                </>
            ) : s.upcoming ? (
                <div className="seqtk-push-focus-row">
                    <Text type="secondary">下一件</Text>
                    <Tag className={`seqtk-push-time seqtk-push-time-${s.upcoming.mode}`}>{s.upcoming.winFrom.slice(9)}</Tag>
                    <Text strong className="seqtk-push-focus-desc">{s.upcoming.nodeDesc}</Text>
                </div>
            ) : (
                <Text type="secondary">{s.emptyText || '今天没有推送任务'}</Text>
            )}
        </div>
    );

    /** 流程勾选（多流程并行；勾选状态落 Settings） */
    const scripts = s.scripts.length > 0 && (
        <div className="seqtk-push-scripts">
            {s.scripts.map((x) => (
                <Checkbox
                    key={x.nodeId}
                    checked={x.enabled}
                    onChange={(e) => onToggleScript(x.nodeId, e.target.checked)}
                >
                    {x.desc}
                </Checkbox>
            ))}
            <Button size="small" onClick={onRefresh}>刷新</Button>
        </div>
    );

    /** 序列行（组条目带单元清单：展开看、逐项完成；全完成自动折叠） */
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
    const toggleGroup = (key: string): void => {
        setExpandedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const renderRow = (t: PushItemView) => {
        const isGroup = t.units.length > 0;
        const key = `${t.scriptId}|${t.line}|${t.nodeId}|${t.winFrom}`;
        // 全部单元完成 → 自动折叠（完成态本身就是答案，不必再摊开清单）
        const expanded = isGroup && !t.done && expandedGroups.has(key);
        return (
            <List.Item className={t.done ? 'seqtk-push-item-row is-done' : 'seqtk-push-item-row'}>
                <div className="seqtk-push-task">
                    <div className="seqtk-push-task-head">
                        <Tag className={`seqtk-push-time seqtk-push-time-${t.mode}`}>{windowText(t)}</Tag>
                        {isGroup && (
                            <Tag>{t.units.filter((u) => !u.done).length}/{t.units.length} 项行动</Tag>
                        )}
                        <Text strong delete={t.done}>{t.nodeDesc}</Text>
                        {t.priority !== undefined && <Tag>^{t.priority}</Tag>}
                        {t.scriptDesc && <Tag>{t.scriptDesc}</Tag>}
                        {isGroup ? (
                            <Button size="small" className="seqtk-push-done-btn" onClick={() => toggleGroup(key)}>
                                {expanded ? '收起' : '展开'}
                            </Button>
                        ) : !t.done && (
                            <Button size="small" className="seqtk-push-done-btn" onClick={() => onComplete(t.nodeId)}>
                                完成
                            </Button>
                        )}
                    </div>
                    {expanded && (
                        <div className="seqtk-push-units">
                            {t.units.map((u) => (
                                <div key={u.nodeId} className={u.done ? 'seqtk-push-unit is-done' : 'seqtk-push-unit'}>
                                    <Text delete={u.done}>{u.desc}</Text>
                                    {u.subtreeSize > 1 && <Text type="secondary">含 {u.subtreeSize} 项</Text>}
                                    {!u.done && (
                                        <Button size="small" onClick={() => onComplete(u.nodeId)}>完成</Button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                    {t.notes.map((n, i) => (
                        <div key={`note-${i}`} className="seqtk-push-item seqtk-push-note">
                            <Text type="secondary">·</Text> {n}
                        </div>
                    ))}
                </div>
            </List.Item>
        );
    };

    return (
        <div className="seqtk-push-view">
            {focus}
            {scripts}

            {s.errors.map((e) => (
                <Alert key={e} type="error" showIcon message={e} />
            ))}

            {s.items.length === 0 && s.unscheduled.length === 0 && s.errors.length === 0 && (
                <div className="seqtk-empty">{s.emptyText}</div>
            )}

            <List size="small" dataSource={s.items} renderItem={renderRow} />

            {s.unscheduled.length > 0 && (
                <>
                    <div className="seqtk-push-section">未排期（时间未展开，不算今天的事）</div>
                    <List size="small" dataSource={s.unscheduled} renderItem={renderRow} />
                </>
            )}
        </div>
    );
}
