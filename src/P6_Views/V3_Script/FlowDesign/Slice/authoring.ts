/**
 * flowDesign/authoring — 「拖入组件」到 AST 的构造
 *
 * LAD 面板上拖一个组件进来，要问用户几个字段、把新的指令塞进 AST、再序列化写回脚本。
 * 本切片管的就是这一段：**入参是 AST 里的语句或语句列表**，而不是 DOM ——
 * 渲染与落点在渲染侧。
 *
 * 拖入的语义按指令分两类：
 * - 分支指令（REPT / AT / STEP / IF / NOT）→ **新建一条语句**
 * - 传送指令（JUMP / RECO / EXEC / DO）→ **追加到已有语句**（默认最后一条）
 *
 * 切片契约（见 P6_Views/Views.md）：以 host 为第一参数、只认识 Slice/host 的接口。
 */

import { Notice } from 'obsidian';
import { FlowPromptModal } from './modals';
import { parseTimeExpr } from '../../../../P2_Tools/Script/parser';
import type { FlowDesignHost } from './host';
import type { Branch, Statement, Transfer } from '../../../../P2_Tools/Script/parser';

/** 分支指令名 —— 拖入这类组件是「新建一条语句」 */
export const BRANCH_KINDS = ['REPT', 'AT', 'STEP', 'IF', 'NOT'] as const;

/** 传送指令名 —— 拖入这类组件是「追加到某条语句」 */
export const TRANSFER_KINDS = ['JUMP', 'RECO', 'EXEC', 'DO'] as const;

/** 是不是分支指令 */
export function IS_BranchKind(type: string): boolean {
    return (BRANCH_KINDS as readonly string[]).includes(type);
}

/** 是不是传送指令 */
export function IS_TransferKind(type: string): boolean {
    return (TRANSFER_KINDS as readonly string[]).includes(type);
}

/**
 * 指令 → 面板显示名
 *
 * 面板与拖入后的提示文案共用一份，避免两处各写一遍中文而对不上。
 * 键就是拖拽时写进 dataTransfer 的类型名。
 */
export const KIND_LABELS: Record<string, string> = {
    REPT: 'REPT 循环',
    AT: 'AT 时点/时段',
    STEP: 'STEP 阻塞',
    IF: 'IF 条件成立',
    NOT: 'NOT 条件不成立',
    JUMP: 'JUMP 跳转',
    RECO: 'RECO 恢复',
    EXEC: 'EXEC 执行',
    DO: 'DO 递送',
};

/**
 * 给新语句挑一个行号
 *
 * `Statement.line` 语义上是「它原先在脚本的第几行」，用来做错误定位与稳定标识。
 * 面板上新建的语句不来自任何一行，所以取「现有最大行号 + 1」—— 保证唯一、单调，
 * 且序列化回脚本后（下次解析）仍是自洽的数值。
 */
function nextLine(statements: Statement[]): number {
    let max = 0;
    const walk = (list: Statement[]): void => {
        for (const s of list) {
            max = Math.max(max, s.line);
            walk(s.block);
        }
    };
    walk(statements);
    return max + 1;
}

/** 校验一个 @ 时间表达式，不合法就提示并返回 null */
function checkTime(host: FlowDesignHost, raw: string, what: string): string | null {
    if (parseTimeExpr(raw)) return raw;
    new Notice(`${what}要写成 @ 开头的时间，如 @R-D1 / @T-H9 / @20260924-0112`);
    void host;
    return null;
}

/** 弹窗问出分支指令需要的字段并构造它；用户放弃则回调拿到 null */
function promptBranch(host: FlowDesignHost, type: string, done: (b: Branch | null) => void): void {
    const ask = (fields: { label: string; defaultValue: string }[], build: (v: string[]) => Branch | null): void => {
        new FlowPromptModal(host.app, fields, (vals) => done(build(vals)));
    };
    switch (type) {
        case 'REPT':
            ask([{ label: '循环条件（如 @R-D1）', defaultValue: '@R-D1' }], ([raw]) => {
                const t = checkTime(host, raw.trim(), 'REPT 的条件');
                return t ? { kind: 'REPT', arg: t, time: parseTimeExpr(t) ?? undefined } : null;
            });
            return;
        case 'AT':
            // 两块：起点；结束留空就是「一个区间」，填了就是「从一个区间跨到另一个区间」
            new FlowPromptModal(host.app, [
                { label: 'AT 时间（如 @T-H9 / @20260924-0112）', defaultValue: '@T-H9' },
                { label: 'TO 时间（留空 = 只到这一处）', defaultValue: '' },
            ], ([atRaw, toRaw]) => {
                const at = checkTime(host, atRaw.trim(), 'AT 的时间');
                if (!at) { done(null); return; }
                const to = toRaw.trim();
                if (!to) { done({ kind: 'AT', arg: at, time: parseTimeExpr(at) ?? undefined }); return; }
                const toOk = checkTime(host, to, 'AT … TO 的时间');
                if (!toOk) { done(null); return; }
                done({ kind: 'AT', arg: at, time: parseTimeExpr(at) ?? undefined, to: toOk, toTime: parseTimeExpr(toOk) ?? undefined });
            }).open();
            return;
        case 'STEP':
            ask([{ label: '步骤名（如 S91）', defaultValue: '' }], ([name]) => (name ? { kind: 'STEP', arg: name } : null));
            return;
        case 'IF':
        case 'NOT':
            ask([{ label: `${type} 条件（如 @节点.state == done）`, defaultValue: '' }], ([cond]) => (
                cond ? { kind: type === 'IF' ? 'IF' : 'NOT', arg: cond } : null
            ));
            return;
        default:
            done(null);
    }
}

/** 拖入分支指令：在语句列表末尾新建一条语句 */
export function ADD_StatementByDrop(host: FlowDesignHost, type: string, statements: Statement[]): void {
    promptBranch(host, type, (branch) => {
        if (!branch) return;
        statements.push({ line: nextLine(statements), branch, block: [], braced: false, transfers: [] });
        host.commitAst();
    });
}

/** 拖入传送指令：追加到指定语句末尾（调用方通常给最后一条） */
export function ADD_TransferByDrop(host: FlowDesignHost, type: string, statement: Statement | undefined): void {
    if (!statement) {
        new Notice('先放一个分支指令（如 AT），再往里加传送指令');
        return;
    }
    const push = (t: Transfer): void => {
        statement.transfers.push(t);
        host.commitAst();
    };
    const ask = (label: string, build: (v: string) => Transfer | null): void => {
        new FlowPromptModal(host.app, [{ label, defaultValue: '' }], ([v]) => {
            const t = build(v.trim());
            if (t) push(t);
        }).open();
    };
    switch (type) {
        case 'RECO':
            // 不写目标 = 回到上一层，与 JUMP 对称
            push({ kind: 'RECO' });
            return;
        case 'JUMP':
            // 跨脚本用 `脚本节点id.流程号` 引用，原样收下
            ask('JUMP 目标（如 脚本id.流程号）', (v) => (v ? { kind: 'JUMP', target: v } : null));
            return;
        case 'EXEC':
            new FlowPromptModal(host.app, [{ label: 'EXEC 脚本（可留空）', defaultValue: '' }], ([v]) => {
                push(v.trim() ? { kind: 'EXEC', script: v.trim() } : { kind: 'EXEC' });
            }).open();
            return;
        case 'DO':
            // 两块：节点引用（必填）、推送优先级（可留空 = 不指定）
            new FlowPromptModal(host.app, [
                { label: 'DO 节点引用（如 @AFFAIR_CONCEPT-…）', defaultValue: '' },
                { label: '推送优先级（可留空；可写负数）', defaultValue: '' },
            ], ([refRaw, prioRaw]) => {
                const ref = refRaw.trim().replace(/^@/, '');
                if (!ref) { new Notice('DO 需要节点引用'); return; }
                const prio = prioRaw.trim();
                if (!prio) { push({ kind: 'DO', nodeId: ref }); return; }
                const n = Number(prio);
                if (!Number.isFinite(n)) { new Notice('优先级要写数字（可带负号）'); return; }
                push({ kind: 'DO', nodeId: ref, priority: n });
            }).open();
            return;
        default:
            return;
    }
}
