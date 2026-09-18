/**
 * TextComplete — `@` 触发的语法补全（纯逻辑）
 *
 * 文本区 / 批量编辑弹窗里输入 `@` 即弹候选：**现有全部语法**（行内指令、类型短名、
 * 占位符、标签）都在这一张表里，按已输入的片段过滤，Enter 把当前候选补成完整片段。
 *
 * 与 TextTree 的分工：TextTree 负责「解析 / 序列化 / 键盘辅助」，这里只负责
 * 「光标处该不该弹、弹什么、补完长什么样」—— 三个纯函数，两处输入面共用，
 * 免得弹窗与文本区各写一套候选。
 */

import { GET_KindShortNames, type TextEditResult } from './TextTree';
import { NODE_KIND_LABELS } from '../../P4_Nodes/NodeKind/NodeLabel';
import { TEMPLATE_FRAMEWORK_NAME_TOKEN, TEMPLATE_PARENT_PREFIX } from './TempParse';

/** 一条补全候选 */
export interface TextTreeCompletion {
    /** 插进文本的完整片段（多数以空格收尾，便于接着写） */
    insert: string;
    /** 候选列表里显示的名字 */
    label: string;
    /** 一句话说明（右侧灰字） */
    detail: string;
}

/**
 * 候选表：`@` 之后的全部语法
 *
 * 行内指令排在最前（它们本来就是 `@` 开头的），其余按「常用程度」排：类型、占位、标签。
 * 类型短名由 NODE_KIND 派生（`GET_KindShortNames`），新增类型时不用改这里。
 */
export function COMPLETE_AtToken(query = ''): TextTreeCompletion[] {
    const all: TextTreeCompletion[] = [
        { insert: '@start ', label: '@start', detail: '这一行作为插入起点（多树模板每棵都要）' },
        { insert: '@field:copy ', label: '@field:copy', detail: '插入时复制状态 / 性质字段（默认）' },
        { insert: '@field:reset ', label: '@field:reset', detail: '插入时清空这些字段' },
        { insert: '@field:expected ', label: '@field:expected', detail: '连预期时间 / 重复 / 时长一起复制' },
        { insert: '@pos:0', label: '@pos:<n>', detail: '插入位置：同级第 n 个之后' },
        { insert: `${TEMPLATE_FRAMEWORK_NAME_TOKEN}`, label: TEMPLATE_FRAMEWORK_NAME_TOKEN, detail: '插入时替换为目标框架名' },
        { insert: `{{${TEMPLATE_PARENT_PREFIX}desc}}`, label: '{{p.字段}}', detail: '取插入处父节点的字段（desc / state …）' },
        { insert: '{{变量名:提示|默认值}}', label: '{{变量名:提示|默认值}}', detail: '插入时询问的占位（变量名自起）' },
        { insert: '#tag:', label: '#tag:标签', detail: '给这一项打标签' },
        ...GET_KindShortNames().map(({ short, kind }) => ({
            insert: `K:${short} `,
            label: `K:${short}`,
            detail: `指定类型：${NODE_KIND_LABELS[kind]}`,
        })),
    ];
    const q = query.toLowerCase();
    if (!q) return all;
    return all.filter((c) => c.label.toLowerCase().includes(q) || c.insert.toLowerCase().includes(q));
}

/** 光标处的补全上下文 */
export interface AtCompletion {
    /** `@` 的起始偏移 */
    start: number;
    /** 光标偏移（替换区间是 [start, end)） */
    end: number;
    /** `@` 之后已输入的过滤词（空 = 刚打完 `@`） */
    query: string;
    /** 候选（已按 query 过滤；非空） */
    items: TextTreeCompletion[];
}

/** `@` 之后允许的过滤词：短名 / 取值，遇到空白即结束 */
const AT_QUERY_RE = /@([A-Za-z0-9_:|.\-{}$]*)$/;

/**
 * 光标处是否该弹补全
 *
 * 只在「行首或前面是空白」的 `@` 之后触发 —— 邮箱、`@某人` 这类文本里的 `@` 不该被拦下。
 * 没有可用候选时也返回 null（没什么可补就不弹）。
 */
export function CONTEXT_AtCompletion(value: string, caret: number): AtCompletion | null {
    const before = value.slice(0, caret);
    const m = AT_QUERY_RE.exec(before);
    if (!m) return null;
    const start = caret - m[0].length;
    const prev = start > 0 ? value[start - 1] : '';
    if (prev && !/\s/.test(prev)) return null;

    const items = COMPLETE_AtToken(m[1]);
    if (items.length === 0) return null;
    return { start, end: caret, query: m[1], items };
}

/** 用候选替换光标处的 `@…`，返回新文本与光标（落在补全片段之后） */
export function APPLY_Completion(value: string, ctx: AtCompletion, item: TextTreeCompletion): TextEditResult {
    const next = value.slice(0, ctx.start) + item.insert + value.slice(ctx.end);
    return { value: next, caret: ctx.start + item.insert.length };
}
