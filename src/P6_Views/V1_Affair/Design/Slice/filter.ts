/**
 * design/filter — 设计视图右栏的复合条件检索
 *
 * 形态仿 Obsidian 搜索的筛选器：条件可增删，多条之间是**与**（全部满足才命中）。
 * 字段覆盖节点的各种属性（名称 / 标签 / 状态 / 类型 / 来源…）。
 *
 * 文本字段用**模糊匹配**（子序列：`xlf` 命中「系统流程」），枚举字段用精确相等 ——
 * 类型 / 状态这类值域是闭的，模糊只会把「状态」和「附加状态」搅在一起。
 * 「正则名称」留给需要精确形状的场合，走真正的正则。
 *
 * 本文件是**纯判定**：不碰数据面、不认识树结构，只回答「这个节点的这些字段是否满足这些条件」。
 * 树的裁剪（保留命中行的父链）在 viewState 里，条件状态的持有在 DesignView 里。
 *
 * 功能增补指引:
 * - 想支持新字段 → 在 FilterField 加一项、FILTER_FIELDS 加一行、FIELD_Values 加一个 case
 * - 新字段若值域封闭 → 一并补进 EXACT_FIELDS
 */

import { NODE_KIND_LABELS } from '../../../../P4_Nodes/NodeFacade';
// 值域与中文名一律取 StateKeys（项目惯例，见 SettingsTab / Propagation）
import {
    ESTATE_VALUES,
    EVENT_NATURE_LABELS,
    EVENT_NATURE_VALUES,
    NODE_ESTATE_LABELS,
    NODE_STATE_LABELS,
    STATE_VALUES,
} from '../../../../P4_Nodes/NodeField/StateKeys';
import type { SeqtkNode } from '../../../../P4_Nodes/Node';

/** 可检索的字段（「属性」下拉里的每一项） */
export type FilterField =
    | 'desc'
    | 'descRegex'
    | 'tags'
    | 'kind'
    | 'state'
    | 'estate'
    | 'nature'
    | 'at'
    | 'from'
    | 'body';

/** 值域封闭的字段：判精确相等，不做模糊 */
const EXACT_FIELDS: ReadonlySet<FilterField> = new Set<FilterField>(['kind', 'state', 'estate', 'nature']);

/** 单个筛选条件 —— value 为空串时不参与判定（等价于这一条没填） */
export interface FilterCondition {
    field: FilterField;
    value: string;
}

/** 字段元数据：界面据此渲染「属性」下拉与对应的值控件 */
export interface FilterFieldMeta {
    field: FilterField;
    label: string;
    /** 取值受限的字段给出候选项；留空表示自由文本 */
    options?: { value: string; label: string }[];
    placeholder?: string;
}

const KIND_OPTIONS = Object.entries(NODE_KIND_LABELS).map(([value, label]) => ({ value, label }));

/** 「属性」下拉的全部字段（顺序即界面顺序，常用的排前面） */
export const FILTER_FIELDS: FilterFieldMeta[] = [
    { field: 'desc', label: '名称', placeholder: '模糊匹配，如 xlf 命中「系统流程」' },
    { field: 'descRegex', label: '正则名称', placeholder: '精确形状，如 ^测试|草案$' },
    { field: 'tags', label: '标签', placeholder: '任一标签模糊匹配…' },
    { field: 'kind', label: '类型', options: KIND_OPTIONS },
    {
        field: 'state',
        label: '状态',
        options: STATE_VALUES.map((v) => ({ value: v, label: NODE_STATE_LABELS[v] })),
    },
    {
        field: 'estate',
        label: '附加状态',
        options: ESTATE_VALUES.map((v) => ({ value: v, label: NODE_ESTATE_LABELS[v] })),
    },
    {
        field: 'nature',
        label: '事件性质',
        options: EVENT_NATURE_VALUES.map((v) => ({ value: v, label: EVENT_NATURE_LABELS[v] })),
    },
    { field: 'at', label: '时间点', placeholder: '模糊匹配…' },
    { field: 'from', label: '来源', placeholder: '模糊匹配…' },
    { field: 'body', label: '正文', placeholder: '模糊匹配…' },
];

/** 取字段的待匹配文本（可多值：标签这类是列表，命中任一即可） */
function FIELD_Values(data: SeqtkNode, body: string, field: FilterField): string[] {
    // nature / at / estate 等字段只出现在部分 kind 上，类型里不是公共成员，按记录读
    const d = data as Record<string, any>;
    switch (field) {
        case 'desc':
            return [data.desc ?? ''];
        case 'tags':
            return (data.tags ?? []) as string[];
        case 'kind':
            return [data.kind];
        case 'state':
            return d.state ? [String(d.state)] : [];
        case 'estate':
            return d.estate ? [String(d.estate)] : [];
        case 'nature':
            return d.nature ? [String(d.nature)] : [];
        case 'at':
            return d.at ? [String(d.at)] : [];
        case 'from':
            return d.from ? [String(d.from)] : [];
        case 'body':
            return [body];
        default:
            return [];
    }
}

/**
 * 模糊匹配：needle 的字符按顺序出现在 haystack 里即可，不要求连续
 *
 * `xlf` → 命中「系统流程」；`abc` → 命中 `a-b-c`。精确子串是它的特例（连续出现必有序出现），
 * 所以不必分两套 —— 想收紧时把关键词写长一点就行。大小写不敏感。
 */
export function FUZZY_Includes(haystack: string, needle: string): boolean {
    const h = haystack.toLowerCase();
    const n = needle.toLowerCase();
    if (!n) return true;
    let from = 0;
    for (const ch of n) {
        const at = h.indexOf(ch, from);
        if (at === -1) return false;
        from = at + 1;
    }
    return true;
}

/**
 * 判定一个节点是否满足全部条件
 *
 * 空条件列表视为「没有筛选」，全部命中。单条条件 value 为空串时跳过（正在输入的中间态
 * 不该把列表清空）。正则名称写错语法时那一条判为不命中，错误交给调用方（见 FILTER_RegexError）。
 */
export function MATCH_Conditions(data: SeqtkNode, body: string, conditions: FilterCondition[]): boolean {
    for (const cond of conditions) {
        const value = cond.value.trim();
        if (!value) continue;
        if (cond.field === 'descRegex') {
            const re = COMPILE_Regex(value);
            if (!re) return false;
            if (!re.test(data.desc ?? '')) return false;
            continue;
        }
        const texts = FIELD_Values(data, body, cond.field);
        const hit = EXACT_FIELDS.has(cond.field)
            ? texts.some((t) => t === value)
            : texts.some((t) => FUZZY_Includes(t, value));
        if (!hit) return false;
    }
    return true;
}

/** 编译正则；语法错返回 null（调用方据此提示，不抛异常打断渲染） */
export function COMPILE_Regex(pattern: string): RegExp | null {
    try {
        return new RegExp(pattern, 'i');
    } catch {
        return null;
    }
}

/** 条件里是否有写错的正则（界面用来把那一行标红） */
export function FILTER_RegexError(conditions: FilterCondition[]): FilterCondition | undefined {
    return conditions.find((c) => c.field === 'descRegex' && c.value.trim() && !COMPILE_Regex(c.value.trim()));
}

/** 是否处于「有实质筛选」的状态（决定标题栏上的按钮是否高亮） */
export function HAS_ActiveFilter(conditions: FilterCondition[]): boolean {
    return conditions.some((c) => c.value.trim() !== '');
}
