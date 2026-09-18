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
 *   - [x] 行动名 @start @field:reset @pos:0
 * ```
 * - 缩进每级 **2 个空格**（tab 视作 2 空格），表示从属关系；**不允许跨级**（0 → 4 空格即错）
 * - `[ ]` `[/]` `[x]` `[-]` 分别表示 规划 / 进行 / 完成 / 放弃
 * - `K:<短名>` 显式指定类型（如 `K:event`、`K:factor`、`K:check`）；省略时按层级推断
 * - `@` 开头的**行内指令**（前后须是空白或行首 / 行尾，可出现在名称的任意位置）：
 *   `@start` 该节点是插入起点、`@field:copy|reset|expected` 字段保留、`@pos:<n>` 插入位置。
 *   它们是模板插入细则的元标记 —— 不进节点名（插入时剥掉），但**原样留在文本里**，
 *   所以导出 / 解析往返不丢。
 * - 类型推断（无前缀时）：顶层 = 构想，构想→方向→目标→工序（更深仍为工序），清单→行动；
 *   其余父类型无法安全推断，必须显式写 `K:`
 *
 * 本模块是纯逻辑：不接触数据层、不 import "obsidian"。
 */

import { NODE_KIND, type NodeKindValue } from '../../P4_Nodes/NodeKind/NodeKind';
import { GET_AllowedChildKinds } from '../../P4_Nodes/NodeKind/NodeChildAllow';
import type { SeqtkState } from '../../P4_Nodes/NodeField/StateKeys';
import { NODE_KIND_LABELS } from '../../P4_Nodes/NodeKind/NodeLabel';

/** 缩进单位：2 个空格 */
const INDENT_UNIT = 2;

/** 状态 ↔ 复选框标记（设置页的「语法指南」也读它，改这里一处即全同步） */
export const STATE_TO_MARK: Record<SeqtkState, string> = {
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

// ============================================================
// 行内 @ 指令（模板插入细则的元标记）
// ============================================================

/** `@field` 的取值（插入时映射为数据层的 copy / reset / copyExpected） */
export type TextTreeFieldPolicy = 'copy' | 'reset' | 'expected';

/** 一个节点上解析出来的行内指令 */
export interface TextTreeInstr {
    /** `@start`：该节点是使用时那棵树的插入起点 */
    start?: boolean;
    /** `@field:<copy|reset|expected>`：字段保留策略 */
    field?: TextTreeFieldPolicy;
    /** `@pos:<n>`：插入位置（同级索引） */
    pos?: number;
}

/** 可用指令的说明（校验报错与补全候选共用，免得两处各写一遍） */
export const AT_TOKEN_HELP = '@start / @field:<copy|reset|expected> / @pos:<n>';

/**
 * 行内指令的匹配：指令前面是行首或空白，后面是空白或行尾
 *
 * 「空格 + @指令 + 空格」的写法让 `@` 出现在正常文本中间（如邮箱、`@某人`）时不会被误摘。
 */
const AT_TOKEN_RE = /(^|\s)@([A-Za-z][A-Za-z0-9_]*)(?::(\S+))?(?=\s|$)/g;

/**
 * 从名称里摘出行内 @ 指令
 *
 * - `name`：剥掉指令、收拢多余空白后的名称（指令不该进节点名）
 * - `ins`：解析结果；一个指令都没有时为 null
 * - `issues`：未知指令 / 非法取值 / 同类重复（重复的只取先写的那个）
 */
export function EXTRACT_AtTokens(
    desc: string,
    line = 0,
): { name: string; ins: TextTreeInstr | null; issues: TextTreeIssue[] } {
    const issues: TextTreeIssue[] = [];
    const ins: TextTreeInstr = {};
    let hit = false;

    const name = desc.replace(AT_TOKEN_RE, (_all, lead: string, rawName: string, rawValue?: string) => {
        const flag = rawName.toLowerCase();
        const value = rawValue?.toLowerCase();
        /** 同类指令只认第一条；重复的报问题并丢掉 */
        const first = (already: boolean): boolean => {
            if (already) {
                issues.push({ line, message: `重复的 @${flag}：同一节点只取先写的那个` });
                return false;
            }
            return true;
        };

        if (flag === 'start') {
            if (rawValue !== undefined) {
                issues.push({ line, message: '@start 不接受取值：写成 @start 即可' });
            } else if (first(!!ins.start)) {
                ins.start = true;
                hit = true;
            }
        } else if (flag === 'field') {
            if (value !== 'copy' && value !== 'reset' && value !== 'expected') {
                issues.push({ line, message: `@field 的取值只能是 copy / reset / expected（当前「${rawValue ?? ''}」）` });
            } else if (first(ins.field !== undefined)) {
                ins.field = value;
                hit = true;
            }
        } else if (flag === 'pos') {
            const n = Number(rawValue);
            if (rawValue === undefined || !Number.isInteger(n) || n < 0) {
                issues.push({ line, message: `@pos 需要一个非负整数（当前「${rawValue ?? ''}」）` });
            } else if (first(ins.pos !== undefined)) {
                ins.pos = n;
                hit = true;
            }
        } else {
            issues.push({ line, message: `未知的行内指令 @${rawName}（可用：${AT_TOKEN_HELP}）` });
        }
        return lead;                        // 连指令与其后的空白一起摘掉，只留前导空白
    });

    return { name: name.trim().replace(/\s{2,}/g, ' '), ins: hit ? ins : null, issues };
}

/** 剥掉行内指令后的名称（预览显示、插入建节点时用） */
export const STRIP_AtTokens = (desc: string): string => EXTRACT_AtTokens(desc).name;

/** 文本树节点（解析产物；children 已按缩进组装） */
export interface TextTreeNode {
    kind: NodeKindValue;
    state: SeqtkState;
    /** 名称**原样**保留（含行内 @ 指令），这样「导出 → 解析」往返不丢 */
    desc: string;
    /** 原始行号（1 起，便于报错定位） */
    line: number;
    children: TextTreeNode[];
    /** 行内 @ 指令（解析产物；没有指令时缺省） */
    ins?: TextTreeInstr;
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

        // 行内 @ 指令：摘出来记在节点上，名称仍保留原文（往返不丢）
        const extracted = EXTRACT_AtTokens(parsed.desc, lineNo);
        issues.push(...extracted.issues);

        const node: TextTreeNode = {
            kind,
            state: parsed.state,
            desc: parsed.desc || '未命名',
            line: lineNo,
            children: [],
        };
        if (extracted.ins) node.ins = extracted.ins;

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
 * 所以正常的内容链（构想→方向→目标→工序、清单→行动）读起来干净；真正需要显式
 * 带上类型的，是**岔出链路**的那部分（如工序下挂事件、清单下挂快照）—— 那才是
 * 跨层级搬运时推断不出来的信息，且标在岔出那一层就够，更深层仍由它推断。
 *
 * 名称按原文输出（含行内 @ 指令）：指令是文本带着的元信息，往返必须原样保留。
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

/** 预览里的一行 */
export interface TextTreePreviewRow {
    depth: number;
    /** 名称（已剥掉行内 @ 指令；指令另以徽章展示） */
    desc: string;
    kind: NodeKindValue;
    kindLabel: string;
    state: SeqtkState;
    /** 源文本行号（1 起）：预览上的交互据此回定位到编辑文本的哪一行 */
    line: number;
    /** 行内 @ 指令（有则渲染徽章） */
    ins?: TextTreeInstr;
}

/**
 * 供界面展示的扁平行：缩进层级 + kind（取分色用）+ 中文名 + 状态 + 源行号 + 行内指令
 *
 * 行号随解析结果一起来，所以预览上点到第几行，改的就是编辑文本里的第几行 —— 两者不会错位。
 */
export function PREVIEW_TextTree(roots: TextTreeNode[]): TextTreePreviewRow[] {
    const out: TextTreePreviewRow[] = [];
    const visit = (node: TextTreeNode, depth: number): void => {
        out.push({
            depth,
            desc: STRIP_AtTokens(node.desc),
            kind: node.kind,
            kindLabel: NODE_KIND_LABELS[node.kind],
            state: node.state,
            line: node.line,
            ...(node.ins ? { ins: node.ins } : {}),
        });
        for (const child of node.children) visit(child, depth + 1);
    };
    for (const root of roots) visit(root, 0);
    return out;
}

// ============================================================
// 类型链校验（模板专用）
// ============================================================

/**
 * 校验一棵文本树的「类型链」是否成立（逐层检查父类型允许的子类型）
 *
 * 与 PARSE_TextTree 的分工：解析只管**语法**（缩进 / 状态标记 / K: 短名 / 行内 @ 指令），
 * 类型链规则（NodeChildAllow）在这里单独校验 —— 模板要跨框架搬运，「语法对但链不成立」的
 * 结构一旦进了库只能靠人工收拾，所以要在插入前拦住。
 *
 * parentKind 的两种用法：
 * - 省略 / null → **不校验顶层**（编辑模板框架内容：模板框架下可放任意类型的模板单元）
 * - 传目标父类型 → 顶层必须能被该类型接纳（应用模板到某框架前的预检）
 *
 * @returns 问题列表（空 = 链成立）；`line` 为 1 起行号，与 PARSE 的 issues 同形态
 */
export function VALIDATE_TemplateTree(
    roots: TextTreeNode[],
    parentKind: NodeKindValue | null = null,
): TextTreeIssue[] {
    const issues: TextTreeIssue[] = [];

    const visit = (node: TextTreeNode, parent: NodeKindValue | null, isRoot: boolean): void => {
        if (parent !== null) {
            const allowed = GET_AllowedChildKinds(parent);
            if (!allowed.includes(node.kind)) {
                const allowText = allowed.length > 0
                    ? allowed.map((k) => NODE_KIND_LABELS[k]).join('、')
                    : '（不允许任何子节点）';
                issues.push({
                    line: node.line,
                    message: isRoot
                        ? `顶层类型「${NODE_KIND_LABELS[node.kind]}」不能插入此处：${NODE_KIND_LABELS[parent]} 下只允许 ${allowText}`
                        : `「${NODE_KIND_LABELS[node.kind]}」不能挂在「${NODE_KIND_LABELS[parent]}」下（该父级只允许 ${allowText}）`,
                });
            }
        }
        for (const child of node.children) visit(child, node.kind, false);
    };

    for (const root of roots) visit(root, parentKind, true);
    return issues;
}

/** 这棵树里是否有一处 `@start` */
function HAS_Start(nodes: TextTreeNode[]): boolean {
    for (const n of nodes) {
        if (n.ins?.start) return true;
        if (HAS_Start(n.children)) return true;
    }
    return false;
}

/**
 * 校验行内 @ 指令的组合规则（模板专用）
 *
 * - 多棵树（多分支）时，**每棵树**都必须用 `@start` 指明插入起点，否则不知道该从哪儿嵌
 * - 单棵树时 `@start` 可选（缺省 = 整棵树整体插入）
 */
export function VALIDATE_TemplateInstr(roots: TextTreeNode[]): TextTreeIssue[] {
    const issues: TextTreeIssue[] = [];
    if (roots.length <= 1) return issues;
    for (const root of roots) {
        if (HAS_Start([root])) continue;
        issues.push({ line: root.line, message: '多树模板：这棵树缺少 @start（多棵树时每棵都要指明插入起点）' });
    }
    return issues;
}

// ============================================================
// 键盘辅助（缩进 / 续行 / 预览上的状态切换）
// ============================================================

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

/**
 * 切换某一行的状态标记（预览上的状态圆点点击）
 *
 * 只认列表行的标记：**完成 → 规划**，其余（规划 / 进行 / 放弃）→ 完成 ——
 * 与设计视图行上状态圆点的单击同一口径。
 *
 * 行号来自同一份解析结果的 `line`，所以预览上点到哪一行，改的就是编辑文本里的哪一行；
 * 解析失败的行不在预览里，因此不会误改别的行。返回 null 表示那一行不是可切换的列表行。
 */
export function TOGGLE_TextTreeState(value: string, line: number): TextEditResult | null {
    if (!Number.isInteger(line) || line < 1) return null;
    const lines = value.split('\n');
    const idx = line - 1;
    if (idx >= lines.length) return null;

    const raw = lines[idx];
    const re = /^(\s*(?:[-*]\s+)?)\[([ xX/-])\]/;
    const m = re.exec(raw);
    if (!m) return null;
    const current = MARK_TO_STATE[m[2]];
    if (!current) return null;

    const next = current === 'done' ? 'plan' : 'done';
    lines[idx] = raw.replace(re, `$1[${STATE_TO_MARK[next]}]`);

    const joined = lines.join('\n');
    // 光标：落在这行行首（点在预览上时文本区并没有焦点，位置合法即可）
    const caret = lines.slice(0, idx).reduce((n, l) => n + l.length + 1, 0);
    return { value: joined, caret: Math.min(caret, joined.length) };
}
