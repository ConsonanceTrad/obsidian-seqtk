/**
 * 日志条目行 —— 格式工具（纯函数，不依赖 obsidian）
 *
 * RUNTIME 日志节点（RUNTIME_EDIT_LOG / RUNTIME_BEHAVE_LOG / RUNTIME_FLOW_LOG）
 * **按日聚合**：一个节点文件装一天的流水，文件名即 `${kind}-${YYYYMMDD}`。
 * 正文是追加式条目列表，每条一行：
 *
 *   - HH:mm:ss 描述（节点引用写 [[nodeId]]）
 *
 * 为什么时刻不带日期：日期已在文件名（与 desc）里，行内重复既冗余又容易不一致。
 * 行格式刻意保持「一行一条、无嵌套」—— 将来脚本或自动化解析时只需一个正则。
 */

/** 一条日志 */
export interface LogEntry {
    /** 时刻 HH:mm:ss */
    time: string;
    /** 单行描述 */
    text: string;
}

/** 当前时刻 HH:mm:ss */
export function nowLogTime(d: Date = new Date()): string {
    const H = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    const s = d.getSeconds().toString().padStart(2, '0');
    return `${H}:${m}:${s}`;
}

/** 日期键 YYYYMMDD（按日聚合的文件名后缀） */
export function logDateKey(d: Date = new Date()): string {
    const y = d.getFullYear().toString();
    const M = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${y}${M}${day}`;
}

/** 日期键的显示形式：20260926 → 2026-09-26 */
export function logDateLabel(dateKey: string): string {
    const m = dateKey.match(/^(\d{4})(\d{2})(\d{2})$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : dateKey;
}

/** 按日聚合的节点 id（即文件名，不含 .md） */
export function logNodeId(kind: string, dateKey: string): string {
    return `${kind}-${dateKey}`;
}

/** 从日志节点 id 提取日期键（无日期后缀时返回空串） */
export function dateKeyFromLogNodeId(nodeId: string): string {
    const m = nodeId.match(/-(\d{8})$/);
    return m ? m[1] : '';
}

/** 条目 → 行 */
export function serializeLogLine(entry: LogEntry): string {
    return `- ${entry.time} ${entry.text}`;
}

const LOG_LINE_RE = /^- (\d{2}:\d{2}:\d{2}) (.*)$/;

/** 正文 → 条目列表（容错：忽略空行与不合规行） */
export function parseLogBody(body: string): LogEntry[] {
    const entries: LogEntry[] = [];
    for (const raw of body.split('\n')) {
        const m = raw.match(LOG_LINE_RE);
        if (m) entries.push({ time: m[1], text: m[2] });
    }
    return entries;
}
