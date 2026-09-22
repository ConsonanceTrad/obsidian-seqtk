/**
 * AST → 脚本文本序列化（逆向转换的基础：解析→序列化往返保持语义）
 *
 * 输出与解析器**严格对称**：花括号块还原成 `{ … }`、单条语句还原成行末 `;`、
 * 时间表达式与 `^优先级` 原样拼回。解析器只看符号、不看缩进，所以这里用缩进把
 * 层次写清楚，既好读也不影响往返。
 */

import type { FlowScript, GuardClause, Statement, Branch, Transfer, TimeExpr } from './parser';

/** 时间表达式 → 文本 */
export function timeText(t: TimeExpr): string {
    switch (t.kind) {
        case 'stamp':
            return `@${t.date}-${t.time}`;
        case 'offset':
            return `@T-${t.parts.map((p) => `${p.unit}${p.n}`).join('-')}`;
        case 'repeat': {
            let s = `@R-${t.parts.map((p) => `${p.unit}${p.n}`).join('-')}`;
            if (t.suffix.inverse) s += ':I';
            if (t.suffix.duty) s += `:${t.suffix.duty}`;
            if (t.suffix.limit !== undefined) s += `::${t.suffix.limit}`;
            return s;
        }
    }
}

/** 约束指令 → 文本 */
export function guardText(g: GuardClause): string {
    return `#${g.kind} ${g.value === 'EVER' ? 'EVER' : timeText(g.value)}`;
}

/**
 * 分支指令 → 文本（不含块）
 *
 * `REPT` 与 `AT` 的时间**优先取结构化字段 `time`**，`arg` 只在没有 `time` 时兜底 ——
 * 两者本是同一个东西的两份，编辑只改 `time`；这里若读 `arg`，就会出现「改了时间但文本没变」。
 * `STEP` / `IF` / `NOT` 的参数不是时间表达式，只有 `arg` 一份，直接用。
 */
export function branchText(b: Branch): string {
    switch (b.kind) {
        case 'REPT': return `REPT ${b.time ? timeText(b.time) : b.arg}`;
        case 'AT': {
            const at = b.time ? timeText(b.time) : b.arg;
            const to = b.toTime ? timeText(b.toTime) : b.to;
            return to !== undefined ? `AT ${at} TO ${to}` : `AT ${at}`;
        }
        case 'STEP': return `STEP ${b.arg}`;
        case 'IF': return `IF ${b.arg}`;
        case 'NOT': return `NOT ${b.arg}`;
    }
}

/** 传送指令 → 文本 */
export function transferText(t: Transfer): string {
    switch (t.kind) {
        case 'JUMP': return t.target ? `JUMP ${t.target}` : 'JUMP';
        case 'RECO': return t.target !== undefined ? `RECO ${t.target}` : 'RECO';
        case 'EXEC': return t.script !== undefined ? `EXEC ${t.script}` : 'EXEC';
        case 'DO': return t.priority !== undefined ? `DO^${t.priority} @${t.nodeId}` : `DO @${t.nodeId}`;
    }
}

/** 序列化一条语句（连带它的时间块） */
function statementText(s: Statement, indent: string): string[] {
    const head = indent + [branchText(s.branch), ...s.transfers.map(transferText)].join(' ');
    if (!s.braced) return [head + ';'];
    const out = [head + ' {'];
    for (const child of s.block) out.push(...statementText(child, indent + '    '));
    out.push(indent + '}');
    return out;
}

/** 序列化完整流程脚本为文本 */
export function serializeFlowScript(script: FlowScript): string {
    const out: string[] = [];
    for (const g of script.guards) out.push(guardText(g));
    // 约束与语句之间空一行：与示例的版面一致，也让两段各自的边界一眼可见
    if (script.guards.length > 0 && script.statements.length > 0) out.push('');
    for (const s of script.statements) out.push(...statementText(s, ''));
    return out.join('\n');
}
