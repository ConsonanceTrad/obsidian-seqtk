/**
 * FlowPushPanel — 流程推送视图的渲染件
 *
 * 纯渲染：不含业务逻辑，不 import obsidian，不触碰 NodeCache。
 * 逻辑侧见同目录 FlowPush.ts。
 */

import { Alert, Button, List, Select, Tag, Typography } from "antd";
import { useStore } from "../../P0_UI/useStore";
import type { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";

const { Text } = Typography;

/** 推送内容块 */
export interface PushTaskItemView {
    kind: string;
    text: string;
}

/** 一条推送任务 */
export interface PushTaskView {
    time: string;
    nodeType: string;
    label: string;
    items: PushTaskItemView[];
}

/** 可选流程脚本 */
export interface FlowPushScriptOption {
    nodeId: string;
    desc: string;
}

/** 流程推送状态（渲染件订阅的唯一来源） */
export interface FlowPushState {
    scripts: FlowPushScriptOption[];
    /** 当前选中的流程脚本 nodeId（空串 = 未选） */
    scriptId: string;
    /** 解析错误（有则优先展示，不展示 tasks） */
    errors: string[];
    tasks: PushTaskView[];
    /** 空态文案（无选中 / 脚本不存在 / 无任务时） */
    emptyText?: string;
}

export interface FlowPushPanelProps {
    state: SimpleStore<FlowPushState>;
    onSelect: (scriptId: string) => void;
    onRefresh: () => void;
}

export function FlowPushPanel({ state, onSelect, onRefresh }: FlowPushPanelProps) {
    const s = useStore(state);

    return (
        <div className="seqtk-push-view">
            <div className="seqtk-push-toolbar">
                <Select
                    size="small"
                    style={{ flex: 1, minWidth: 0 }}
                    value={s.scriptId || undefined}
                    placeholder="（选择流程脚本）"
                    onChange={onSelect}
                    options={s.scripts.map((x) => ({ value: x.nodeId, label: x.desc }))}
                />
                <Button size="small" onClick={onRefresh}>刷新</Button>
            </div>

            {s.errors.map((e) => (
                <Alert key={e} type="error" showIcon message={e} />
            ))}

            {s.emptyText && s.errors.length === 0 && (
                <div className="seqtk-empty">{s.emptyText}</div>
            )}

            <List
                size="small"
                dataSource={s.tasks}
                renderItem={(t) => (
                    <List.Item>
                        <div className="seqtk-push-task">
                            <div className="seqtk-push-task-head">
                                <Tag className={`seqtk-push-time seqtk-push-time-${t.nodeType}`}>{t.time}</Tag>
                                {t.label && <Text strong>{t.label}</Text>}
                            </div>
                            {t.items.map((it, i) => (
                                <div key={i} className="seqtk-push-item">
                                    <Text type="secondary">{it.kind}</Text> {it.text}
                                </div>
                            ))}
                        </div>
                    </List.Item>
                )}
            />
        </div>
    );
}
