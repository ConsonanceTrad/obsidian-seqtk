/**
 * QueryDesignPanel — 查询设计的渲染件
 *
 * 纯渲染：不含业务逻辑，不 import obsidian，不触碰数据层。
 * 逻辑侧见同目录 QueryDesign.ts；树状态在 ../Slice/queryTreeShared.ts。
 *
 * 布局：左栏 = 查询脚本树（NodeTreePane，与设计 / 模板同一套行模型），
 * 右栏 = SQL 输入 + 语法检查。执行走按钮，结果在模态框里看（不在右栏常驻）。
 * 双栏把手与委托让位复用统一框架（usePaneResize + seqtk-split 骨架）。
 */

import { useMemo, useState } from "react";
import { Alert, Button, Empty, Input, Modal, Table, Tag, Typography } from "antd";
import { useStore } from "../../../../P0_UI/useStore";
import { usePaneResize, PANE_WIDTH_DEFAULT } from "../../../../P0_UI/usePaneResize";
import { NodeTreePane } from "../../../../P7_Render/Composition/C2_Tree/NodeTreePane";
import { IconButton } from "../../../../P7_Render/Composition/C1_NodeLine/IconButton";
import { LINE_METRICS_LEFT, type NodeLineHost } from "../../../../P7_Render/Composition/C1_NodeLine/NodeLine";
import type { SimpleStore } from "../../../../P5_Data/Svelte/SimpleStore";
import type { RawQueryResult } from "../../../../P5_Data/SQLite/Cache/SqliteCache";
import type { QueryScriptItem } from "../Slice/queryTreeShared";
import type { NodeTreeActions, TreeNodeItem } from "../../../../P7_Render/Composition/C2_Tree/NodeTree";

const { Text } = Typography;

/** 查询设计状态（渲染件订阅的唯一来源） */
export interface QueryDesignState {
    /** 脚本快照（扁平，树由它组装） */
    items: QueryScriptItem[];
    /** 左栏树行 */
    leftItems: TreeNodeItem[];
    scriptId: string;
    scriptDesc: string;
    sql: string;
    /** 语法检查结果：null = 通过（或还没查过，看 checked） */
    checkError: string | null;
    checked: boolean;
    /** 执行结果（模态框内容） */
    result: RawQueryResult | null;
    resultOpen: boolean;
    runError: string;
    busy: boolean;
    ready: boolean;
    delegated: boolean;
    leftPaneWidth: number;
}

/** 视图转发的动作 */
export interface QueryDesignActions {
    select: (nodeId: string) => void;
    toggle: (nodeId: string) => void;
    contextMenu: (nodeId: string, e: MouseEvent) => void;
    blankContextMenu: (e: MouseEvent) => void;
    sqlChange: (sql: string) => void;
    save: () => void;
    check: () => void;
    run: () => void;
    closeResult: () => void;
    toggleDelegate: () => void;
    setLeftWidth: (width: number) => void;
}

export interface QueryDesignPanelProps {
    state: SimpleStore<QueryDesignState>;
    actions: QueryDesignActions;
    host: NodeLineHost;
}

/** 树组件回调 → 视图动作（行内新建/重命名不接：新建走右键菜单） */
function bindTree(a: QueryDesignActions): NodeTreeActions {
    return {
        onToggle: (ctx) => a.toggle(ctx.nodeId),
        onSelect: (ctx) => a.select(ctx.nodeId),
        onContextMenu: (ctx, e) => a.contextMenu(ctx.nodeId, e),
        onInlineCommit: () => {},
        onInlineCancel: () => {},
        onCreateCommit: () => {},
        onCreateCancel: () => {},
        onCreateKindChange: () => {},
        onCreateRepeatChange: () => {},
    };
}

export function QueryDesignPanel({ state, actions, host }: QueryDesignPanelProps) {
    const s = useStore(state);
    const leftActions = useMemo(() => bindTree(actions), [actions]);
    const [leftWidth, setLeftWidth] = useState(s.leftPaneWidth || PANE_WIDTH_DEFAULT);
    const { paneRef, handleProps } = usePaneResize(leftWidth, (width) => {
        setLeftWidth(width);
        actions.setLeftWidth(width);
    });

    /** 语法检查状态条 */
    const checkBar = !s.scriptId ? null : s.checkError ? (
        <Alert type="error" showIcon message="语法检查未通过" description={<pre className="seqtk-query-error">{s.checkError}</pre>} />
    ) : s.checked ? (
        <Alert type="success" showIcon message="语法检查通过" />
    ) : null;

    const left = (
        <NodeTreePane
            className="seqtk-pane seqtk-query-tree"
            paneRef={paneRef}
            paneStyle={{ width: leftWidth, flexBasis: leftWidth }}
            onPaneContextMenu={(e) => {
                if ((e.target as HTMLElement).closest('.seqtk-frame-item')) return;
                e.preventDefault();
                actions.blankContextMenu(e.nativeEvent);
            }}
            title="查询脚本"
            titleExtra={
                /* 委托开关收在标题末尾：与设计 / 模板左栏同款；委托后左栏（含本按钮）让位 */
                <IconButton
                    className="seqtk-icon-btn seqtk-delegate-btn"
                    icon="chevrons-left"
                    tip="把脚本树委托到侧栏"
                    host={host}
                    onClick={() => actions.toggleDelegate()}
                />
            }
            items={s.leftItems}
            metrics={LINE_METRICS_LEFT}
            host={host}
            rowClass="seqtk-frame-item"
            emptyText={s.items.length === 0 ? '暂无查询脚本（右键此处新建）' : undefined}
            guides
            creating={null}
            actions={leftActions}
        />
    );

    const right = (
        <div className="seqtk-pane seqtk-query-right">
            <div className="seqtk-board-titlebar">
                <span className="seqtk-split-title">
                    {s.scriptId ? s.scriptDesc || '查询脚本' : '查询脚本'}
                </span>
                {s.scriptId && <Tag>{s.scriptId}</Tag>}
                <Button size="small" onClick={actions.save}>保存</Button>
                <Button size="small" onClick={actions.check}>语法检查</Button>
                <Button size="small" type="primary" loading={s.busy} disabled={!s.scriptId || !s.ready} onClick={actions.run}>
                    执行
                </Button>
            </div>
            {!s.scriptId ? (
                <Empty description="在左栏选一个查询脚本，或右键新建" />
            ) : (
                <>
                    <Input.TextArea
                        className="seqtk-query-editor"
                        value={s.sql}
                        onChange={(e) => actions.sqlChange(e.target.value)}
                        spellCheck={false}
                        autoSize={{ minRows: 12 }}
                        placeholder="SELECT id, kind, desc FROM nodes LIMIT 20"
                    />
                    {checkBar}
                    {!s.ready && <div className="seqtk-query-hint-warn">查询缓存尚未就绪，稍候再执行。</div>}
                    <Text type="secondary" className="seqtk-query-hint">
                        只读查询：语句需以 SELECT / WITH 开头。执行结果在弹窗中查看。
                    </Text>
                </>
            )}
        </div>
    );

    /** 执行结果模态框 */
    const resultModal = (
        <Modal
            open={s.resultOpen}
            onCancel={actions.closeResult}
            footer={null}
            width="min(880px, 92vw)"
            title={s.result ? `查询结果（${s.result.rows.length} 行${s.result.truncated ? '，已截断' : ''}）` : '查询结果'}
        >
            {s.runError ? (
                <Alert type="error" showIcon message="执行出错" description={<pre className="seqtk-query-error">{s.runError}</pre>} />
            ) : s.result ? (
                <>
                    <Table
                        size="small"
                        rowKey={(_, i) => String(i)}
                        columns={s.result.columns.map((c) => ({ title: c, dataIndex: c, ellipsis: true }))}
                        dataSource={s.result.rows}
                        pagination={false}
                        scroll={{ x: 'max-content' }}
                    />
                    {s.result.truncated && <Text type="secondary">结果超过行数上限，已截断显示。</Text>}
                </>
            ) : null}
        </Modal>
    );

    return (
        <div
            className={'seqtk-split' + (s.delegated ? ' seqtk-split-delegated' : '')}
            onContextMenu={(e) => {
                if (s.delegated) return;
                if ((e.target as HTMLElement).closest('.seqtk-frame-item')) return;
                actions.blankContextMenu(e.nativeEvent);
            }}
        >
            {/* 委托期间左栏与把手让位右栏（与设计 / 模板 / 流程一致） */}
            {!s.delegated && (
                <>
                    {left}
                    <div className="seqtk-split-handle" {...handleProps} />
                </>
            )}
            <div className="seqtk-split-right">{right}</div>
            {resultModal}
        </div>
    );
}
