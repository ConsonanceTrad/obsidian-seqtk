/**
 * RecyclePanel — 回收模式的渲染件
 *
 * 纯渲染：不含业务逻辑，不 import obsidian，不触碰 NodeCache / FileManager。
 * 数据经 `state`（SimpleStore）进来，操作经回调上抛给 RecycleView。
 * 状态类型由逻辑侧 Recycle.ts 消费，两侧共享此处定义。
 */

import { Button, Empty, List, Tag, Typography } from "antd";
import { useStore } from "../../P0_UI/useStore";
import type { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";
import type { NodeKindValue } from "../../P4_Nodes/NodeKind/NodeKind";

const { Text } = Typography;

/** 单条归档节点 */
export interface RecycleRow {
    nodeId: string;
    kind: NodeKindValue;
    /** 节点展示名 */
    desc: string;
}

/** 按类型分组的归档节点 */
export interface RecycleGroup {
    kind: NodeKindValue;
    /** 类型展示名（NODE_KIND_LABELS） */
    label: string;
    items: RecycleRow[];
}

/** 回收视图状态（渲染件订阅的唯一来源） */
export interface RecycleState {
    /** 弃置缓存尚未就绪 */
    initializing: boolean;
    groups: RecycleGroup[];
    /** 归档节点总数 */
    total: number;
}

export interface RecyclePanelProps {
    state: SimpleStore<RecycleState>;
    onRestore: (nodeId: string, kind: NodeKindValue) => void;
    onDelete: (nodeId: string) => void;
    onRefresh: () => void;
}

export function RecyclePanel({ state, onRestore, onDelete, onRefresh }: RecyclePanelProps) {
    const { initializing, groups, total } = useStore(state);

    const toolbar = (
        <div className="seqtk-toolbar">
            <Button size="small" onClick={onRefresh} disabled={initializing}>
                刷新
            </Button>
            {!initializing && <Text type="secondary">共 {total} 个归档节点</Text>}
        </div>
    );

    if (initializing) {
        return (
            <div className="seqtk-recycle-view">
                {toolbar}
                <Empty description="正在加载归档缓存…" />
            </div>
        );
    }

    if (total === 0) {
        return (
            <div className="seqtk-recycle-view">
                {toolbar}
                <Empty description="暂无归档节点（可在设计/表格模式中右键归档）" />
            </div>
        );
    }

    return (
        <div className="seqtk-recycle-view">
            {toolbar}
            {groups.map((group) => (
                <div key={group.kind} className="seqtk-recycle-group">
                    <div className="seqtk-section-title">
                        {group.label}（{group.items.length}）
                    </div>
                    <List
                        size="small"
                        dataSource={group.items}
                        renderItem={(item) => (
                            <List.Item
                                actions={[
                                    <Button
                                        key="restore"
                                        size="small"
                                        onClick={() => onRestore(item.nodeId, item.kind)}
                                    >
                                        还原
                                    </Button>,
                                    <Button
                                        key="delete"
                                        size="small"
                                        danger
                                        onClick={() => onDelete(item.nodeId)}
                                    >
                                        彻底删除
                                    </Button>,
                                ]}
                            >
                                <Tag>{group.label}</Tag>
                                <Text title={item.nodeId}>{item.desc}</Text>
                            </List.Item>
                        )}
                    />
                </div>
            ))}
        </div>
    );
}
