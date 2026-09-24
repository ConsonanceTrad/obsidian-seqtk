/**
 * QueryDesignPanel — 查询设计视图的渲染件
 *
 * 左栏：SQL 编辑区 + 执行 + 表结构速查；右栏：结果表格。
 * 纯渲染：不含业务逻辑，不 import obsidian、不触碰数据层。逻辑侧见同目录 QueryDesign.ts。
 *
 * 结果表格用 antd Table 而不是自绘：列是**动态**的（来自 SELECT 的列名），
 * 自绘就得自己处理列宽、横向滚动、表头对齐 —— 那些正是 Table 已经做好的事。
 */

import { Alert, Button, Table } from "antd";
import { useStore } from "../../P0_UI/useStore";
import { DualPane } from "../../P7_Render/Structure/S1_Container/DualPane";
import type { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";

/** 结果表格的一行 —— 键是列名，值原样来自 sql.js */
export type QueryRow = Record<string, unknown>;

/** 表结构速查的一条 */
export interface QueryTableHint {
    table: string;
    /** 字段名，按建表顺序 */
    columns: string[];
}

/** 查询设计状态（渲染件订阅的唯一来源） */
export interface QueryDesignState {
    /** 编辑区里的 SQL 原文 */
    sql: string;
    /** 结果列名（空 = 还没跑或跑挂了） */
    columns: string[];
    rows: QueryRow[];
    /** 结果是否因到达上限而被截断 */
    truncated: boolean;
    /** 错误原文（空串 = 无错）。原样显示，不改写 */
    error: string;
    /** 最近一次执行的文案（空 = 还没跑过） */
    ranAt: string;
    /** 正在执行 */
    busy: boolean;
    /** 查询缓存是否就绪（未就绪时执行按钮禁用，并说明原因） */
    ready: boolean;
}

export interface QueryDesignPanelProps {
    state: SimpleStore<QueryDesignState>;
    onSqlChange: (sql: string) => void;
    onRun: () => void;
    onReset: () => void;
}

/**
 * 两张表的字段速查
 *
 * 选「直接写 SQL」就意味着使用者得知道表名与字段名 —— 不给这张表，这个界面
 * 等于让人盲写。字段与 SqliteCache 的 SCHEMA 一一对应，两处改动要一起走。
 */
const TABLE_HINTS: QueryTableHint[] = [
    {
        table: 'nodes',
        columns: [
            'id', 'kind', 'desc', 'open', 'source', 'created_at', 'modified_at',
            'state', 'estate', 'clear', 'tags', 'indicators', 'pmarks', 'nature',
            'at', 'expected_time', 'expected_repeat', 'expected_span', 'sources', 'body',
        ],
    },
    {
        table: 'relations',
        columns: ['from_id', 'rel', 'to_id', 'description'],
    },
];

/**
 * 单元格：只把 NULL 挑出来单独标记（SQL 里 NULL 与空串是两回事，混在一起看会误判）
 *
 * 超长值的截断与悬停全文交给 antd Table 的 `ellipsis` —— 它按「是否溢出」判定，
 * 比按字符数猜更准，也不必自己算宽度。
 */
function CellValue({ v }: { v: unknown }) {
    if (v === null || v === undefined) return <span className="seqtk-query-null">NULL</span>;
    return <>{String(v)}</>;
}

export function QueryDesignPanel({ state, onSqlChange, onRun, onReset }: QueryDesignPanelProps) {
    const s = useStore(state);

    const left = (
        <div className="seqtk-pane seqtk-query-left">
            <div className="seqtk-split-title">查询脚本</div>
            <textarea
                className="seqtk-query-editor"
                spellCheck={false}
                placeholder="SELECT id, kind, desc FROM nodes LIMIT 20"
                value={s.sql}
                onChange={(e) => onSqlChange(e.target.value)}
                onKeyDown={(e) => {
                    // Ctrl/Cmd + Enter 执行 —— 手不用离开键盘
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        onRun();
                    }
                }}
            />
            <div className="seqtk-query-actions">
                <Button size="small" type="primary" onClick={onRun} disabled={!s.ready || s.busy}>
                    {s.busy ? '执行中…' : '执行'}
                </Button>
                <Button size="small" onClick={onReset} title="把编辑区恢复成起始语句">重置</Button>
                <span className="seqtk-query-ran">{s.ranAt}</span>
            </div>
            {!s.ready && (
                <div className="seqtk-query-hint-warn">查询缓存尚未就绪，稍候再执行。</div>
            )}
            <details className="seqtk-query-schema">
                <summary>表结构速查（只读：语句需以 SELECT / WITH 开头）</summary>
                {TABLE_HINTS.map((t) => (
                    <div key={t.table} className="seqtk-query-schema-table">
                        <div className="seqtk-query-schema-name">{t.table}</div>
                        <div className="seqtk-query-schema-cols">{t.columns.join(' · ')}</div>
                    </div>
                ))}
            </details>
        </div>
    );

    const right = (
        <div className="seqtk-pane">
            <div className="seqtk-query-result-head">
                <span className="seqtk-split-title">查询结果</span>
                {s.columns.length > 0 && (
                    <span className="seqtk-query-count">
                        {s.rows.length} 行 · {s.columns.length} 列
                        {s.truncated ? ` · 已截断（仅取前 ${s.rows.length} 行）` : ''}
                    </span>
                )}
            </div>
            {s.error
                ? (
                    <Alert
                        type="error"
                        showIcon
                        message="语句执行失败"
                        description={<pre className="seqtk-query-error">{s.error}</pre>}
                    />
                )
                : s.columns.length === 0
                    ? <div className="seqtk-empty">{s.ranAt ? '这条语句没有返回任何列' : '写一条 SELECT 语句，按「执行」（或 Ctrl+Enter）查看结果'}</div>
                    : s.rows.length === 0
                        ? <div className="seqtk-empty">语句跑通了，但没有匹配的行</div>
                        : (
                            <Table
                                size="small"
                                bordered
                                rowKey={(_r, i) => String(i)}
                                scroll={{ x: 'max-content', y: 'calc(100vh - 260px)' }}
                                pagination={false}
                                dataSource={s.rows}
                                columns={s.columns.map((c) => ({
                                    title: c,
                                    dataIndex: c,
                                    key: c,
                                    ellipsis: true,
                                    render: (v: unknown) => <CellValue v={v} />,
                                }))}
                            />
                        )}
        </div>
    );

    return <DualPane left={left} right={right} />;
}
