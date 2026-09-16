/**
 * TextTree — 文本树 ⇄ 节点树的解析与序列化
 *
 * 用途：把一大段缩进列表快速变成一棵节点树（提取投递），以及把节点树导出成可读/可编辑的
 * 文本（批量编辑、导出 md、模板制作）。两个方向共用同一套约定，因此可往返。
 *
 * ── 文本约定 ──
 * ```
 * - [ ] 构想名
 *   - [/] 方向名
 *     - [x] 目标名
 *       - [ ] 工序名
 *       - [ ] K:event 某事件
 * - [x] K:check 清单名
 *   - [x] 事项名
 * ```
 * - 缩进每级 **2 个空格**（tab 视作 2 空格），表示从属关系；**不允许跨级**（0 → 4 空格即错）
 * - `[ ]` `[/]` `[x]` `[-]` 分别表示 规划 / 进行 / 完成 / 放弃
 * - `K:<短名>` 显式指定类型（如 `K:event`、`K:factor`、`K:check`）；省略时按层级推断
 * - 类型推断（无前缀时）：顶层 = 构想，构想→方向→目标→工序（更深仍为工序），清单→事项；
 *   其余父类型无法安全推断，必须显式写 `K:`
 *
 * 本模块是纯逻辑：不接触数据层、不 import "obsidian"。
 */

import { NODE_KIND, type NodeKindValue } from '../../P4_Nodes/NodeKind/NodeKind';
import type { SeqtkState } from '../../P4_Nodes/NodeField/StateKeys';
import { NODE_KIND_LABELS } from '../../P4_Nodes/NodeKind/NodeLabel';

/** 缩进单位：2 个空格 */
const INDENT_UNIT = 2;

/** 状态 ↔ 复选框标记 */
const STATE_TO_MARK: Record<SeqtkState, string> = {
    plan: ' ',
    open: '/',
    done: 'x',
    drop: '-',
};

const MARK_TO_STATE: Record<string, SeqtkState> = {
    ' ': 'plan',
    '/': 'open',
    x: 'done',
    X: 'done',
    '-': 'drop',
};

/**
 * kind 短名表（K: 前缀用）
 *
 * 由 NODE_KIND 的 `簇_名` 形式派生为小写短名：`AFFAIR_EVENT` → `event`、
 * `EVIDENCE_FACTOR` → `factor`、`RUNTIME_EDIT_LOG` → `edit_log`。
 * 派生而非硬编码，新增 kind 时无需改这里。
 */
const SHORT_TO_KIND: Record<string, NodeKindValue> = {};
for (const raw of Object.values(NODE_KIND)) {
    const short = String(raw).split('_').slice(1).join('_').toLowerCase();
    SHORT_TO_KIND[short] = raw as NodeKindValue;
}

/** kind → 短名（序列化时使用；取不冲突的最短形式） */
const KIND_TO_SHORT: Record<string, string> = {};
for (const [short, kind] of Object.entries(SHORT_TO_KIND)) {
    if (!KIND_TO_SHORT[kind]) KIND_TO_SHORT[kind] = short;
}

/** 文本树节点（解析产物；children 已按缩进组装） */
export interface TextTreeNode {
    kind: NodeKindValue;
    state: SeqtkState;
    desc: string;
    /** 原始行号（1 起，便于报错定位） */
    line: number;
    children: TextTreeNode[];
}

/** 一条解析错误 */
export interface TextTreeIssue {
    /** 行号（1 起） */
    line: number;
    message: string;
}

export interface TextTreeParseResult {
    roots: TextTreeNode[];
    /** 解析期间的问题；非空时调用方应展示并让用户修正后再投递 */
    issues: TextTreeIssue[];
}

/**
 * 按层级与父类型推断 kind
 *
 * 返回 null 表示「无法安全推断」——调用方应要求显式 K: 前缀，
 * 而不是猜一个可能猜错的类型写进用户的库。
 */
function inferKind(parent: NodeKindValue | null): NodeKindValue | null {
    if (parent === null) return NODE_KIND.CONCEPT;
    switch (parent) {
        case NODE_KIND.CONCEPT:
            return NODE_KIND.DIRECT;
        case NODE_KIND.DIRECT:
            return NODE_KIND.TARGET;
        case NODE_KIND.TARGET:
        case NODE_KIND.PROCESS:
            return NODE_KIND.PROCESS;
        case NODE_KIND.CHECK:
            return NODE_KIND.ITEM;
        default:
            return null;
    }
}

/** 解析单行的正文部分：`[ ] K:xxx 名称` */
function parseLineBody(body: string): { state: SeqtkState; kindToken: string | null; desc: string } | null {
    const m = body.match(/^\[(.)\]\s*(.*)$/);
    if (!m) return null;
    const state = MARK_TO_STATE[m[1]];
    if (!state) return null;

    let rest = m[2].trim();
    let kindToken: string | null = null;
    const k = rest.match(/^K:([A-Za-z0-9_]+)\s+(.*)$/);
    if (k) {
        kindToken = k[1].toLowerCase();
        rest = k[2].trim();
    }
    return { state, kindToken, desc: rest };
}

/**
 * 解析文本树
 *
 * 不抛异常：所有问题以 `issues` 返回（含行号），调用方据此提示用户。
 * 出现问题的行会被跳过，但其余行仍会被解析出来，便于用户边看边改。
 */
export function PARSE_TextTree(text: string): TextTreeParseResult {
    const roots: TextTreeNode[] = [];
    const issues: TextTreeIssue[] = [];
    /** 各层级最近一个节点（用于按缩进挂载） */
    const stack: TextTreeNode[] = [];

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const lineNo = i + 1;
        if (!raw.trim()) continue;

        // 缩进：tab 视作 2 空格，之后必须是 2 的倍数
        const expanded = raw.replace(/\t/g, '  ');
        const indent = expanded.match(/^ */)?.[0].length ?? 0;
        if (indent % INDENT_UNIT !== 0) {
            issues.push({ line: lineNo, message: `缩进应为 ${INDENT_UNIT} 的倍数（当前 ${indent} 个空格）` });
            continue;
        }
        const depth = indent / INDENT_UNIT;

        const bullet = expanded.slice(indent);
        if (!/^[-*]\s/.test(bullet)) {
            issues.push({ line: lineNo, message: '每行需以「- 」或「* 」开头' });
            continue;
        }

        const parsed = parseLineBody(bullet.slice(2).trim());
        if (!parsed) {
            issues.push({ line: lineNo, message: '缺少状态标记：应为「[ ]」「[/]」「[x]」或「[-]」' });
            continue;
        }

        // 跨级缩进：不能跳过中间层级
        if (depth > stack.length) {
            issues.push({
                line: lineNo,
                message: `缩进跳级：上一行层级为 ${stack.length}，本行直接到了 ${depth}`,
            });
            continue;
        }

        const parent = depth === 0 ? null : stack[depth - 1];
        let kind: NodeKindValue | null = null;
        if (parsed.kindToken) {
            kind = SHORT_TO_KIND[parsed.kindToken] ?? null;
            if (!kind) {
                issues.push({ line: lineNo, message: `未知的类型短名「K:${parsed.kindToken}」` });
                continue;
            }
        } else {
            kind = inferKind(parent?.kind ?? null);
            if (!kind) {
                issues.push({
                    line: lineNo,
                    message: `无法从上下文推断类型（父类型为 ${parent?.kind ?? '（顶层）'}），请显式写「K:<短名>」`,
                });
                continue;
            }
        }

        const node: TextTreeNode = {
            kind,
            state: parsed.state,
            desc: parsed.desc || '未命名',
            line: lineNo,
            children: [],
        };

        if (depth === 0) roots.push(node);
        else stack[depth - 1].children.push(node);

        stack.length = depth;
        stack[depth] = node;
    }

    return { roots, issues };
}

/** 序列化输入：一行的扁平信息（导出表格 / 调试用；序列化本身接受树） */
export interface TextTreeLine {
    depth: number;
    kind: NodeKindValue;
    state: SeqtkState;
    desc: string;
}

/**
 * 序列化为文本树
 *
 * 与 PARSE_TextTree 共用同一套约定，因此 `PARSE(SERIALIZE(树))` 还原同一棵树。
 *
 * 类型前缀只在**推断不出来**或**推断结果与本行不符**时才写。链路本身不必标注：
 * 起始链路由「进入时的层级 + 放置位置」表明，往下每一层都能由父层推断出来，
 * 所以正常的内容链（构想→方向→目标→工序、清单→事项）读起来干净；真正需要显式
 * 带上类型的，是**岔出链路**的那部分（如工序下挂事件、清单下挂快照）—— 那才是
 * 跨层级搬运时推断不出来的信息，且标在岔出那一层就够，更深层仍由它推断。
 */
export function SERIALIZE_TextTree(roots: TextTreeNode[]): string {
    const out: string[] = [];

    const visit = (node: TextTreeNode, depth: number, parentKind: NodeKindValue | null): void => {
        const indent = ' '.repeat(depth * INDENT_UNIT);
        const mark = STATE_TO_MARK[node.state] ?? ' ';
        const short = KIND_TO_SHORT[node.kind];
        const inferred = inferKind(parentKind);
        const needKind = inferred !== node.kind;
        const prefix = needKind && short ? `K:${short} ` : '';
        out.push(`${indent}- [${mark}] ${prefix}${node.desc}`);
        for (const child of node.children) visit(child, depth + 1, node.kind);
    };

    for (const root of roots) visit(root, 0, null);
    return out.join('\n');
}

/** 由节点树（含 children）拍平为扁平行（导出表格 / 调试用） */
export function FLATTEN_Tree(nodes: TextTreeNode[], depth = 0): TextTreeLine[] {
    const out: TextTreeLine[] = [];
    for (const n of nodes) {
        out.push({ depth, kind: n.kind, state: n.state, desc: n.desc });
        if (n.children.length > 0) out.push(...FLATTEN_Tree(n.children, depth + 1));
    }
    return out;
}

/** 全部已知的类型短名（供设置界面 / 提示文案展示） */
export const GET_KindShortNames = (): { short: string; kind: NodeKindValue }[] =>
    Object.entries(SHORT_TO_KIND).map(([short, kind]) => ({ short, kind }));
/** 供界面展示的扁平行：缩进层级 + kind（取分色用）+ 中文名 + 状态 */
export function PREVIEW_TextTree(
    roots: TextTreeNode[],
): { depth: number; desc: string; kind: NodeKindValue; kindLabel: string; state: SeqtkState }[] {
    return FLATTEN_Tree(roots).map((l) => ({
        depth: l.depth,
        desc: l.desc,
        kind: l.kind,
        kindLabel: NODE_KIND_LABELS[l.kind],
        state: l.state,
    }));
}

/** 缩进 / 续行的文本变换结果 */
export interface TextEditResult {
    value: string;
    /** 落定后的光标位置 */
    caret: number;
}


/** 空行补出的语法头：未开始状态 + 待填名称 */
const SYNTAX_HEAD = '- [ ] ';

/**
 * 整行加 / 减一级缩进（纯变换，返回新文本与光标位置）
 *
 * 手感对齐 Obsidian 自带编辑器：Tab 缩进、Ctrl+Shift+Tab（也接受 Shift+Tab）反缩进，
 * 选区跨多行时整块处理。只动行首 —— 光标停在行中时也照样缩进整行，
 * 否则用 Tab 缩进得先把光标挪到行首，反而更慢。
 *
 * 若某行只有空白，缩进后顺手补上 `- [ ] ` 语法头：敲 Tab 再直接打名字，
 * 比每次手打列表符省事得多，这就是「语法辅助」。
 */
export function INDENT_TextLine(
    value: string,
    selectionStart: number,
    selectionEnd: number,
    outdent: boolean,
): TextEditResult {
    const start = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
    const endIdx = value.indexOf('\n', selectionEnd);
    const end = endIdx === -1 ? value.length : endIdx;
    const block = value.slice(start, end);

    const unit = ' '.repeat(INDENT_UNIT);
    const lines = block.split('\n').map((line) => {
        if (outdent) {
            // 只减一级：不足一级的（含整行无缩进）一律清掉行首空白
            if (line.startsWith(unit)) return line.slice(unit.length);
            return line.replace(/^ +/, '');
        }
        const indented = unit + line;
        return indented.trim().length === 0 ? indented + SYNTAX_HEAD : indented;
    });

    const replacement = lines.join('\n');
    const next = value.slice(0, start) + replacement + value.slice(end);

    // 光标：本行内的偏移随该行的增减平移；多行时用整块差值近似，够用且不会跑到末行
    const line = block.split('\n')[0] ?? '';
    const firstAfter = (lines[0] ?? '').slice(0, line.length + unit.length);
    const firstDelta = firstAfter.length - line.length;
    const caretInLine = selectionStart - start;
    const caret = start + Math.max(0, Math.min(caretInLine + Math.max(0, firstDelta), firstAfter.length));

    return { value: next, caret: Math.max(start, Math.min(caret, next.length)) };
}

/**
 * 在光标处续写同级语法头（Enter），返回 null 表示不该接管
 *
 * 与 Obsidian 列表一致：回车后新行沿用本行的缩进与状态标记，名称留空等输入。
 * 但**本行名称本来就是空**时不续写 —— 否则连敲回车会一直续下去，退不出列表。
 * 非列表行、以及有选区的场合都不接管，交给默认行为。
 */
export function CONTINUE_TextLine(
    value: string,
    caret: number,
    selectionEnd: number,
): TextEditResult | null {
    if (caret !== selectionEnd) return null;

    const lineStart = value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
    const lineEndIdx = value.indexOf('\n', caret);
    const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const line = value.slice(lineStart, lineEnd);

    const m = /^(\s*)(- \[[ x/-]\] )?(.*)$/.exec(line);
    if (!m) return null;
    const [, indent, head, desc] = m;
    if (!head) return null;                 // 不是列表行 → 默认行为
    if ((desc ?? '').trim() === '') return null; // 空条目再回车 → 退出列表

    const insert = '\n' + indent + head;
    const next = value.slice(0, caret) + insert + value.slice(caret);
    return { value: next, caret: caret + insert.length };
}
