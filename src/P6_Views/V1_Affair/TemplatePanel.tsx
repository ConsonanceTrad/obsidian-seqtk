/**
 * TemplatePanel — 模板模式的渲染件
 *
 * 纯渲染：不含业务逻辑，不 import obsidian，不触碰 NodeCache / FileManager。
 * 数据经 state（SimpleStore）进来，操作经回调上抛给 TemplateView。
 *
 * 布局：DualPane 双栏 —— 左栏模板框架列表；右栏选中框架的模板单元管理。
 */

import { Button, Empty, List, Tag, Typography } from "antd";
import { useStore } from "../../P0_UI/useStore";
import { DualPane } from "../../P7_Render/Structure/S1_Container/DualPane";
import type { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";

const { Title, Text } = Typography;

/** 框架条目（左栏列表 / 右栏子框架行共用） */
export interface TemplateFrameworkRow {
    nodeId: string;
    desc: string;
    /** 类型徽章文案 */
    kindLabel: string;
}

/** 模板单元行（右栏，已按展开状态扁平化） */
export interface TemplateUnitRow {
    nodeId: string;
    kindLabel: string;
    desc: string;
    /** 缩进层级（顶层为 0） */
    depth: number;
    hasChildren: boolean;
    expanded: boolean;
    /** 顶层单元提供 应用 / 编辑 / 删除；子级只提供 打开 */
    isTop: boolean;
}

/** 模板视图状态（渲染件订阅的唯一来源） */
export interface TemplateState {
    /** 缓存尚未就绪 */
    initializing: boolean;
    /** 左栏：全部模板框架 */
    frameworks: TemplateFrameworkRow[];
    /** 当前选中框架 nodeId（null = 未选） */
    selectedId: string | null;
    /** 选中框架的展示名 */
    selectedDesc: string;
    /** 右栏：选中框架下的子模板框架 */
    subFrameworks: TemplateFrameworkRow[];
    /** 右栏：扁平化的模板单元行 */
    unitRows: TemplateUnitRow[];
    /** 右栏空态提示（无选中 / 无单元时） */
    rightEmpty?: string;
}

export interface TemplatePanelProps {
    state: SimpleStore<TemplateState>;
    onSelect: (nodeId: string) => void;
    onToggleExpand: (nodeId: string) => void;
    onCollapseAll: () => void;
    onCreateUnit: () => void;
    onCreateSubFramework: () => void;
    onCreateRootTemplate: () => void;
    onApply: (nodeId: string) => void;
    onOpenFile: (nodeId: string) => void;
    onDelete: (nodeId: string) => void;
}

export function TemplatePanel(props: TemplatePanelProps) {
    const { state, onSelect, onToggleExpand, onCollapseAll } = props;
    const {
        initializing, frameworks, selectedId, selectedDesc,
        subFrameworks, unitRows, rightEmpty,
    } = useStore(state);

    const left = (
        <div className="seqtk-pane">
            <Title level={5} className="seqtk-split-title">模板框架</Title>
            {initializing ? (
                <Empty description="正在加载缓存…" />
            ) : frameworks.length === 0 ? (
                <div className="seqtk-pane-empty">
                    <Empty description="暂无模板框架" />
                    <Button size="small" onClick={props.onCreateRootTemplate}>新建模板框架</Button>
                </div>
            ) : (
                <List
                    size="small"
                    dataSource={frameworks}
                    renderItem={(f) => (
                        <List.Item
                            className={`seqtk-frame-item${f.nodeId === selectedId ? ' seqtk-frame-item-active' : ''}`}
                            onClick={() => onSelect(f.nodeId)}
                        >
                            <Tag>{f.kindLabel}</Tag>
                            <Text>{f.desc}</Text>
                        </List.Item>
                    )}
                />
            )}
        </div>
    );

    let rightBody;
    if (initializing) {
        rightBody = <Empty description="正在加载缓存…" />;
    } else if (selectedId === null) {
        rightBody = <Empty description="在左侧选择一个框架" />;
    } else if (rightEmpty) {
        rightBody = <Empty description={rightEmpty} />;
    } else {
        rightBody = (
            <>
                <Title level={5} className="seqtk-split-title">模板框架 · {selectedDesc}</Title>
                <div className="seqtk-toolbar">
                    <Button size="small" onClick={props.onCreateUnit}>新建模板单元</Button>
                    <Button size="small" onClick={props.onCreateSubFramework}>新建子模板框架</Button>
                    <Button size="small" onClick={onCollapseAll}>收起全部</Button>
                </div>

                {subFrameworks.map((fw) => (
                    <div className="seqtk-row" key={fw.nodeId}>
                        <Tag>{fw.kindLabel}</Tag>
                        <Text>{fw.desc}</Text>
                        <span className="seqtk-spacer" />
                        <Button size="small" onClick={() => onSelect(fw.nodeId)}>管理</Button>
                    </div>
                ))}

                {unitRows.map((u) => (
                    <div
                        className="seqtk-row seqtk-unit-row"
                        key={u.nodeId}
                        style={{ paddingLeft: `${10 + u.depth * 18}px` }}
                        onClick={u.hasChildren ? () => onToggleExpand(u.nodeId) : undefined}
                    >
                        <span className="seqtk-unit-mark">
                            {u.hasChildren ? (u.expanded ? '▾' : '▸') : ''}
                        </span>
                        <Tag>{u.kindLabel}</Tag>
                        <Text title={u.nodeId}>{u.desc}</Text>
                        <span className="seqtk-spacer" />
                        {u.isTop ? (
                            <>
                                <Button size="small" onClick={() => props.onApply(u.nodeId)}>应用</Button>
                                <Button size="small" onClick={() => props.onOpenFile(u.nodeId)}>编辑</Button>
                                <Button size="small" danger onClick={() => props.onDelete(u.nodeId)}>删除</Button>
                            </>
                        ) : (
                            <Button size="small" onClick={() => props.onOpenFile(u.nodeId)}>打开</Button>
                        )}
                    </div>
                ))}
            </>
        );
    }

    return <DualPane left={left} right={<div className="seqtk-pane">{rightBody}</div>} />;
}
