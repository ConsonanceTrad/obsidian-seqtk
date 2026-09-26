/**
 * Log/buildState — 扫描结果 → 视图状态（纯函数切片）
 *
 * 切片契约（见 P6_Views/Views.md）：纯函数、不 import 视图类、不触碰数据层。
 * 输入是 `SCAN_Files` 的产物 `NodeFile[]`，输出是渲染件消费的 `LogViewState`。
 *
 * 日志节点按日聚合（`RUNTIME_FLOW_LOG-20260926.md`），所以分组维度是
 * 「类型 × 日期」：左栏先选类型再选日期，右栏出该日条目。
 */

import { NODE_KIND, type NodeRuntimeKindValue } from "../../../../P4_Nodes/NodeKind/NodeKind";
import { NODE_KIND_LABELS } from "../../../../P4_Nodes/NodeKind/NodeLabel";
import type { NodeFile } from "../../../../P4_Nodes/Node";
import {
    dateKeyFromLogNodeId,
    logDateLabel,
    parseLogBody,
    type LogEntry,
} from "../../../../P2_Tools/Parse/LogLine";

/** 三类日志的展示顺序：行为 → 流程 → 编辑（人最关心自己做了什么，再看系统） */
export const LOG_KINDS: NodeRuntimeKindValue[] = [
    NODE_KIND.BEHAVE_LOG,
    NODE_KIND.FLOW_LOG,
    NODE_KIND.EDIT_LOG,
];

/** 右栏一条日志 */
export interface LogEntryRow extends LogEntry {
    /** 所属日期键（搜索命中时供标题显示） */
    dateKey: string;
}

/** 左栏一类日志 */
export interface LogKindGroup {
    kind: NodeRuntimeKindValue;
    label: string;
    /** 该类下的日期键（降序，新日在前） */
    dates: string[];
}

export interface LogViewState {
    /** 左栏：类型 × 日期 */
    groups: LogKindGroup[];
    selectedKind: NodeRuntimeKindValue | '';
    selectedDate: string;
    /** 右栏：选中日期的条目（最新在上），已按搜索词过滤 */
    entries: LogEntryRow[];
    search: string;
    emptyText: string;
}

/** 视图持有的选择态（buildState 的输入） */
export interface LogSelection {
    kind: NodeRuntimeKindValue | '';
    date: string;
    search: string;
}

/**
 * 构建视图状态
 *
 * 选择态缺省时自动落位：第一个类型、该类型最新的日期 ——
 * 打开视图直接看到最近的日志，不用先点两下。
 */
export function BUILD_LogState(files: NodeFile[], sel: LogSelection): LogViewState {
    const byKind = new Map<NodeRuntimeKindValue, Map<string, LogEntryRow[]>>();
    for (const f of files) {
        const kind = f.data.kind as NodeRuntimeKindValue;
        const dateKey = dateKeyFromLogNodeId(f.nodeId);
        if (!dateKey) continue;
        let dates = byKind.get(kind);
        if (!dates) byKind.set(kind, (dates = new Map()));
        const rows = parseLogBody(f.body).map((e) => ({ ...e, dateKey }));
        dates.set(dateKey, [...(dates.get(dateKey) ?? []), ...rows]);
    }

    const groups: LogKindGroup[] = LOG_KINDS.map((kind) => ({
        kind,
        label: NODE_KIND_LABELS[kind] ?? kind,
        dates: [...(byKind.get(kind)?.keys() ?? [])].sort().reverse(),
    }));

    const selectedKind = sel.kind && byKind.has(sel.kind) ? sel.kind : (groups.find((g) => g.dates.length > 0)?.kind ?? '');
    const kindGroup = groups.find((g) => g.kind === selectedKind);
    const selectedDate = sel.date && kindGroup?.dates.includes(sel.date)
        ? sel.date
        : (kindGroup?.dates[0] ?? '');

    const raw = (selectedKind && selectedDate)
        ? (byKind.get(selectedKind)?.get(selectedDate) ?? [])
        : [];

    const search = sel.search.trim().toLowerCase();
    const entries = raw
        .filter((e) => !search || e.text.toLowerCase().includes(search))
        .slice()
        .reverse();

    let emptyText: string;
    if (files.length === 0) emptyText = '暂无日志';
    else if (!selectedKind) emptyText = '暂无日志';
    else if (raw.length === 0) emptyText = '该日没有日志条目';
    else if (entries.length === 0) emptyText = '没有匹配的日志条目';
    else emptyText = '';

    return { groups, selectedKind, selectedDate, entries, search: sel.search, emptyText };
}

/** 日期键的显示形式（供面板复用，避免面板各自拼字符串） */
export const FORMAT_LogDate = logDateLabel;
