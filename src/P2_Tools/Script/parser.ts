/**
 * flow 脚本语法解析器（流程脚本域，LAD 渲染投影的事实源）
 *
 * ## 语法基线
 *
 * ```
 * #STF EVER                     约束指令：限制整个脚本的工作时间，可写多组
 * #ENF @20260921-0112           STF 是起、ENF 是止，也是循环与相对时间的基准
 * #EVER                         起止都不限的简写（不必写 STF+ENF 两行）
 *
 * REPT @R-D1 {                  分支指令 + 时间块
 *     AT @T-H9 DO @节点;        块内的时间条件作为内部基准向下传递
 * }
 * AT @T-H9-m12 DO^12 @节点;     单条语句省略 {}，用行末 ; 替代
 * ```
 *
 * - **分支指令**：`REPT`（循环）/ `AT [TO]`（时点或时段）/ `STEP`（阻塞点）/ `IF` / `NOT`
 * - **传送指令**：`JUMP` / `RECO` / `EXEC` / `DO[^优先级]`
 *
 * ## 时间语法（一律 `@` 开头）
 *
 * - 绝对时间戳 `@20261021-0112`（年月日-时分）
 * - 块内相对 `@T-H2`：指定时间块中的第 2 小时；外部无限制时以 STF 为基准
 * - 循环 `@R-D3`（每 3 天）、`@R-D1-H23`（每天的第 23 小时）
 * - 后缀 `:I` 倒数 / `:A` `:N` 工作·非工作时间 / `::N` 循环总次数上限
 *
 * `STF` 为 `EVER` 时，`AT` 与循环**没有基准可依**，这里只做记录、不作语义拒绝 ——
 * 「能不能跑」留给评估层判断，解析器不替它下结论。
 *
 * ## 符号分工
 *
 * - `#` 给脚本级声明（`#STF` / `#ENF` / `#EVER`）
 * - `@` 给时间表达式与节点引用
 *
 * `#EVER` 在 AST 里**展开成一对 STF/ENF**，下游不必再认一个特例。
 */

// ============================================================
// AST 类型
// ============================================================

/** 解析错误（行号 + 消息） */
export interface FlowParseError {
    line: number;
    message: string;
}

/** 周期单位：年 月 周 日 时 分 */
export type TimeUnit = 'Y' | 'M' | 'W' | 'D' | 'H' | 'm';

/** 一段「单位 + 数」，如 `H23` / `m12` */
export interface TimePart {
    unit: TimeUnit;
    /**
     * 数 —— 含义由它所在的表达式决定：
     * - 在 `T-`（块内偏移）里是**区间的右端点**：`H1` 是第 0~1 小时、`H9` 是第 8~9 小时
     * - 在 `R-`（循环）里既是**周期长度**也是**区间右端点**：`R-D3` 是「每 3 天、落在第 3 天」，
     *   也就是第 3 天的开始到结束；`R-D1` 就是每天。两件事在这里本就是同一件事。
     * 消费方据此把数展开成区间，而不是当成一个瞬时点。
     */
    n: number;
}

/** 时间后缀 —— 写在时间表达式结尾的限定 */
export interface TimeSuffix {
    /** `:I` 倒数（只能加在第二项及之后） */
    inverse?: true;
    /** `:A` 工作时间 / `:N` 非工作时间 */
    duty?: 'A' | 'N';
    /** `::N` 循环总次数上限 */
    limit?: number;
}

/** 绝对时间戳：`@20261021-0112` */
export interface TimeStamp {
    kind: 'stamp';
    /** `YYYYMMDD` */
    date: string;
    /** `HHmm` */
    time: string;
}

/** 块内相对：`@T-H9-m12` —— 指定时间块中的偏移 */
export interface TimeOffset {
    kind: 'offset';
    parts: TimePart[];
}

/** 循环：`@R-D1-H23` —— 外层是周期，内层是周期内的时间点 */
export interface TimeRepeat {
    kind: 'repeat';
    parts: TimePart[];
    suffix: TimeSuffix;
}

export type TimeExpr = TimeStamp | TimeOffset | TimeRepeat;

/** 约束指令（`#STF` / `#ENF`） */
export interface GuardClause {
    line: number;
    kind: 'STF' | 'ENF';
    /** `EVER` = 这一端不限制 */
    value: 'EVER' | TimeExpr;
}

/** 分支指令的种类 */
export type BranchKind = 'REPT' | 'AT' | 'STEP' | 'IF' | 'NOT';

/** 分支指令 */
export interface Branch {
    kind: BranchKind;
    /** 原始参数：REPT / AT 是时间表达式文本，STEP 是步骤名，IF / NOT 是条件文本 */
    arg: string;
    /** 解析出的时间表达式（REPT 与 AT 才有） */
    time?: TimeExpr;
    /** `AT … TO …` 的 TO 段 —— 有它就是时段，没有就是时点 */
    to?: string;
    toTime?: TimeExpr;
}

/** 传送指令 */
export type Transfer =
    | { kind: 'JUMP'; target: string }                   // 跳转到另一流程（`脚本id.流程号` 可跨脚本）
    | { kind: 'RECO'; target?: string }                  // 恢复到跳转前流程
    | { kind: 'EXEC'; script?: string }                  // 启动执行脚本
    | { kind: 'DO'; nodeId: string; priority?: number }; // 递送执行结果；`^N` 是推送优先级

/** 一条语句：分支指令 +（可选）时间块 + 同一行的传送指令 */
export interface Statement {
    line: number;
    branch: Branch;
    /** 花括号时间块里的语句；用行末 `;` 的单条语句这里为空 */
    block: Statement[];
    /** 是否用了花括号 —— 序列化据此还原形状 */
    braced: boolean;
    /** 同一行的传送指令 */
    transfers: Transfer[];
}

/** 完整流程脚本 */
export interface FlowScript {
    guards: GuardClause[];
    statements: Statement[];
    errors: FlowParseError[];
}

// ============================================================
// 词法
// ============================================================

/** 绘图符号：LAD 示例里的引导符与连接线，解析前一律剥掉 */
const DECOR = /[║│●├└─┌┐┘┬┴┼→←]/g;

/** 剥掉绘图符号与多余空白，留下真正的内容 */
function stripDecor(line: string): string {
    return line.replace(DECOR, ' ').replace(/\s+/g, ' ').trim();
}

const BRANCH_KINDS = ['REPT', 'AT', 'STEP', 'IF', 'NOT'] as const;
const TRANSFER_KINDS = ['JUMP', 'RECO', 'EXEC', 'DO'] as const;

/** 按已知指令名切出开头那个词（要求后面跟空白或到头，免得 `AT` 吃掉 `ATT`） */
function takeHead(text: string, kinds: readonly string[]): { head: string; rest: string } | null {
    for (const k of kinds) {
        if (text === k) return { head: k, rest: '' };
        if (text.startsWith(k + ' ')) return { head: k, rest: text.slice(k.length + 1).trim() };
    }
    return null;
}

/** 取开头一个非空白词 */
function takeToken(text: string): string | null {
    const m = text.trim().match(/^(\S+)/);
    return m ? m[1] : null;
}

/**
 * 把「自由文本参数 + 后续传送指令」切开
 *
 * `IF` / `NOT` 的条件是自由文本（`@节点.state == done` 里带空格），没法靠分词判断到哪儿
 * 结束 —— 只能找**第一个像传送指令开头的词**。这与上一版解析器的做法一致。
 */
function splitAtTransfer(text: string): { cond: string; rest: string } {
    const re = new RegExp(`\\s+(?=(?:${TRANSFER_KINDS.join('|')})\\b)`);
    const m = text.search(re);
    if (m < 0) return { cond: text.trim(), rest: '' };
    return { cond: text.slice(0, m).trim(), rest: text.slice(m).trim() };
}

// ============================================================
// 时间语法
// ============================================================

/** 解析 `H23` / `m12` 这样的单段 */
function parsePart(seg: string): TimePart | null {
    const m = seg.match(/^([YMWDHm])(\d+)$/);
    return m ? { unit: m[1] as TimeUnit, n: Number(m[2]) } : null;
}

/** 解析 `H9-m12` 这样的多段（至少一段；任一段不成形就整体失败） */
function parseParts(rest: string): TimePart[] | null {
    const segs = rest.split('-').filter((s) => s !== '');
    if (segs.length === 0) return null;
    const parts: TimePart[] = [];
    for (const seg of segs) {
        const p = parsePart(seg);
        if (!p) return null;
        parts.push(p);
    }
    return parts;
}

/**
 * 解析一个时间表达式：`@20261021-0112` / `@T-H9-m12` / `@R-D1-H23::12`
 *
 * 不以 `@` 开头、或形状不认识就返回 null（由调用方决定怎么报错）。
 */
export function parseTimeExpr(raw: string): TimeExpr | null {
    const s = raw.trim();
    if (!s.startsWith('@')) return null;
    let body = s.slice(1);

    // 后缀：`::N`（总次数）写在最后；`:` 单后缀（倒数 / 工作性质）在它之前。
    // 两者可以并存，例如 `@R-D1-H2:I::12`
    const suffix: TimeSuffix = {};
    const mLimit = body.match(/::(\d+)$/);
    if (mLimit) {
        suffix.limit = Number(mLimit[1]);
        body = body.slice(0, body.length - mLimit[0].length);
    }
    const mOne = body.match(/:([IAN])$/i);
    if (mOne) {
        const c = mOne[1].toUpperCase();
        if (c === 'I') suffix.inverse = true;
        else suffix.duty = c as 'A' | 'N';
        body = body.slice(0, body.length - mOne[0].length);
    }

    // 循环：`R-D1` / `R-D1-H23`
    if (/^R-/i.test(body)) {
        const parts = parseParts(body.slice(2));
        return parts ? { kind: 'repeat', parts, suffix } : null;
    }
    // 块内相对：`T-H9-m12`
    if (/^T-/i.test(body)) {
        const parts = parseParts(body.slice(2));
        return parts ? { kind: 'offset', parts } : null;
    }
    // 绝对时间戳：`YYYYMMDD-HHmm`
    const m = body.match(/^(\d{8})-(\d{2,4})$/);
    if (m) return { kind: 'stamp', date: m[1], time: m[2] };
    return null;
}

/** 时间后缀只能加在第二项及之后（`@R-D1:I` 这种没有意义） */
function suffixPlacementError(t: TimeExpr): string | null {
    if (t.kind !== 'repeat') return null;
    const hasOne = t.suffix.inverse || t.suffix.duty !== undefined;
    return hasOne && t.parts.length < 2 ? '时间后缀 :I / :A / :N 只能加在第二项及之后' : null;
}

// ============================================================
// 解析器
// ============================================================

/** 解析流程脚本文本为 AST（不抛异常，错误收集进 errors） */
export function parseFlowScript(source: string): FlowScript {
    const script: FlowScript = { guards: [], statements: [], errors: [] };
    const lines = source.split('\n');
    let i = 0;

    const err = (line: number, message: string): void => {
        script.errors.push({ line, message });
    };

    /** 解析一段语句序列；碰到 `}` 或文件尾就返回 */
    const parseBlock = (inBlock: boolean): Statement[] => {
        const out: Statement[] = [];
        while (i < lines.length) {
            const lineNo = i + 1;
            const text = stripDecor(lines[i]);
            i++;
            if (text === '' || text.startsWith('//')) continue;

            if (text === '}') {
                if (!inBlock) err(lineNo, '多余的 }');
                return out;
            }

            // ---- 脚本级约束：只在顶层 ----
            if (text.startsWith('#')) {
                if (inBlock) {
                    err(lineNo, '约束指令只能写在脚本开头，不能放进时间块');
                    continue;
                }
                if (/^#EVER$/i.test(text)) {
                    // 起止都不限的简写：展开成一对，下游不必再认一个特例
                    script.guards.push({ line: lineNo, kind: 'STF', value: 'EVER' });
                    script.guards.push({ line: lineNo, kind: 'ENF', value: 'EVER' });
                    continue;
                }
                const g = parseGuard(text, lineNo, err);
                if (g) script.guards.push(g);
                continue;
            }

            // ---- 语句 ----
            const stmt = parseStatement(text, lineNo, err);
            if (!stmt) continue;

            // 时间块：`REPT @R-D1 {` 同行开括号，或下一行单独一个 `{`
            if (text.endsWith('{')) {
                stmt.braced = true;
                stmt.block = parseBlock(true);
            } else if (i < lines.length && stripDecor(lines[i]) === '{') {
                i++;
                stmt.braced = true;
                stmt.block = parseBlock(true);
            }
            out.push(stmt);
        }
        if (inBlock) err(lines.length, '时间块缺少收尾的 }');
        return out;
    };

    script.statements = parseBlock(false);
    return script;
}

/** 解析一条约束指令（`#STF EVER` / `#ENF @20260921-0112`） */
function parseGuard(
    text: string,
    lineNo: number,
    err: (line: number, message: string) => void,
): GuardClause | null {
    const m = text.match(/^#(STF|ENF)\s*(.*)$/i);
    if (!m) {
        err(lineNo, `无法识别的约束指令：${text}`);
        return null;
    }
    const kind = m[1].toUpperCase() as 'STF' | 'ENF';
    const raw = m[2].trim();
    if (raw === '') {
        err(lineNo, `${kind} 需要值：EVER 或 @ 开头的时间`);
        return null;
    }
    if (/^EVER$/i.test(raw)) return { line: lineNo, kind, value: 'EVER' };

    const time = parseTimeExpr(raw);
    if (!time) {
        err(lineNo, `${kind} 的值要写 EVER 或 @ 开头的时间，收到：${raw}`);
        return null;
    }
    const placement = suffixPlacementError(time);
    if (placement) err(lineNo, placement);
    return { line: lineNo, kind, value: time };
}

/** 解析一条语句：分支指令 + 同一行的传送指令（块由调用方接续） */
function parseStatement(
    text: string,
    lineNo: number,
    err: (line: number, message: string) => void,
): Statement | null {
    // 去掉行末的 `;` 与 `{`（`{` 由调用方据此开块）
    const body = text.replace(/[;{]\s*$/, '').trim();

    const head = takeHead(body, BRANCH_KINDS);
    if (!head) {
        err(lineNo, `无法识别的语句：${text}`);
        return null;
    }

    let branch: Branch;
    /** 传送位的起点 */
    let tail = '';

    switch (head.head) {
        case 'REPT': {
            const arg = takeToken(head.rest);
            if (!arg) { err(lineNo, 'REPT 需要循环条件，如 REPT @R-D1'); return null; }
            const time = parseTimeExpr(arg);
            if (!time) { err(lineNo, `REPT 的条件要写成 @ 开头的时间，收到：${arg}`); return null; }
            const placement = suffixPlacementError(time);
            if (placement) err(lineNo, placement);
            branch = { kind: 'REPT', arg, time };
            tail = head.rest.slice(arg.length).trim();
            break;
        }
        case 'AT': {
            // `@时点` 或 `@时点 TO @时点`
            const m = head.rest.match(/^(\S+)(?:\s+TO\s+(\S+))?/i);
            if (!m) { err(lineNo, 'AT 需要一个时间，如 AT @20260924-0112'); return null; }
            const time = parseTimeExpr(m[1]);
            if (!time) { err(lineNo, `AT 的时间要写成 @ 开头，收到：${m[1]}`); return null; }
            const placement = suffixPlacementError(time);
            if (placement) err(lineNo, placement);
            branch = { kind: 'AT', arg: m[1], time };
            if (m[2]) {
                const toTime = parseTimeExpr(m[2]);
                if (!toTime) { err(lineNo, `AT … TO 的时间要写成 @ 开头，收到：${m[2]}`); return null; }
                branch.to = m[2];
                branch.toTime = toTime;
            }
            tail = head.rest.slice(m[0].length).trim();
            break;
        }
        case 'STEP': {
            const name = takeToken(head.rest);
            if (!name) { err(lineNo, 'STEP 需要步骤名，如 STEP S91'); return null; }
            branch = { kind: 'STEP', arg: name };
            tail = head.rest.slice(name.length).trim();
            break;
        }
        case 'IF':
        case 'NOT': {
            const split = splitAtTransfer(head.rest);
            if (!split.cond) { err(lineNo, `${head.head} 需要条件`); return null; }
            branch = { kind: head.head, arg: split.cond };
            tail = split.rest;
            break;
        }
        default:
            return null;
    }

    const transfers: Transfer[] = [];
    parseTransfers(tail, lineNo, transfers, err);
    return { line: lineNo, branch, block: [], braced: false, transfers };
}

/** 解析一串传送指令（可能一条都没有 —— 例如 `AT @X` 后面直接开块） */
function parseTransfers(
    text: string,
    lineNo: number,
    out: Transfer[],
    err: (line: number, message: string) => void,
): void {
    let rest = text;
    while (rest !== '') {
        const head = takeHead(rest, TRANSFER_KINDS);
        if (!head) {
            err(lineNo, `无法识别的传送指令：${rest}`);
            return;
        }
        rest = head.rest;
        switch (head.head) {
            case 'RECO':
                // 与 JUMP 对称：不写目标就是「回到上一层」
                out.push({ kind: 'RECO' });
                break;
            case 'JUMP': {
                const split = splitAtTransfer(rest);
                out.push({ kind: 'JUMP', target: split.cond });
                rest = split.rest;
                break;
            }
            case 'EXEC': {
                const split = splitAtTransfer(rest);
                // 脚本可省略：省略时由执行层决定跑什么
                out.push(split.cond ? { kind: 'EXEC', script: split.cond } : { kind: 'EXEC' });
                rest = split.rest;
                break;
            }
            case 'DO': {
                // `DO[^优先级] @节点id`
                let priority: number | undefined;
                let r = rest;
                const mp = r.match(/^\^\s*(-?\d+)\s*/);
                if (mp) {
                    priority = Number(mp[1]);
                    r = r.slice(mp[0].length);
                }
                const split = splitAtTransfer(r);
                const rawRef = split.cond.trim();
                if (!rawRef) { err(lineNo, 'DO 需要节点引用，如 DO @节点id'); return; }
                // 引用统一去掉前导 `@`：它在语法里只是「这是个引用」的记号
                const nodeId = rawRef.replace(/^@/, '');
                out.push(priority !== undefined ? { kind: 'DO', nodeId, priority } : { kind: 'DO', nodeId });
                rest = split.rest;
                break;
            }
            default:
                return;
        }
    }
}
