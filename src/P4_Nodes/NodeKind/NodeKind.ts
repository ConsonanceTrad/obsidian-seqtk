const FRAMEWORK = {
    TRANS : 'FRAMEWORK_TRANS',
    INFO : 'FRAMEWORK_INFO',
    TEMP : 'FRAMEWORK_TEMP',
} as const;
const AFFAIR = {
    CONCEPT : 'AFFAIR_CONCEPT',
    DIRECT : 'AFFAIR_DIRECT',
    TARGET : 'AFFAIR_TARGET',
    PROCESS : 'AFFAIR_PROCESS',
    CHECK : 'AFFAIR_CHECK',
    ITEM : 'AFFAIR_ITEM',
    EVENT : 'AFFAIR_EVENT',
} as const;
const EVIDENCE = {
    FACTOR : 'EVIDENCE_FACTOR',
    REQUEST : 'EVIDENCE_REQUEST',
    CLUE : 'EVIDENCE_CLUE',
    SNAPSHOT : 'EVIDENCE_SNAPSHOT',
} as const;
const RUNTIME = {
    EDIT_LOG : 'RUNTIME_EDIT_LOG',
    BEHAVE_LOG : 'RUNTIME_BEHAVE_LOG',
    FLOW_LOG : 'RUNTIME_FLOW_LOG',
} as const;
const SCRIPT = {
    FLOW : 'SCRIPT_FLOW',
    EXEC : 'SCRIPT_EXEC',
    QUERY : 'SCRIPT_QUERY',
    DRAFT : 'SCRIPT_DRAFT',
} as const;

const NODE_CATEGORY_KIND = {
    FRAMEWORK : "FRAMEWORK",
    AFFAIR : "AFFAIR",
    EVIDENCE : "EVIDENCE",
    RUNTIME : "RUNTIME",
    SCRIPT : "SCRIPT",
    UNKNOWN : "UNKNOWN",
} as const;

// 导出类型
export const NODE_KIND = {
    ...FRAMEWORK,
    ...AFFAIR,
    ...EVIDENCE,
    ...RUNTIME,
    ...SCRIPT
} as const;

export type NodeFrameworkKindValue = typeof NODE_KIND[keyof typeof FRAMEWORK];
export type NodeAffairKindValue = typeof NODE_KIND[keyof typeof AFFAIR];
export type NodeEvidenceKindValue = typeof NODE_KIND[keyof typeof EVIDENCE];
export type NodeRuntimeKindValue = typeof NODE_KIND[keyof typeof RUNTIME];
export type NodeScriptKindValue = typeof NODE_KIND[keyof typeof SCRIPT];

export type NodeKindValue = typeof NODE_KIND[keyof typeof NODE_KIND];
export type NodeCategoryValue = typeof NODE_CATEGORY_KIND[keyof typeof NODE_CATEGORY_KIND];

// 构建映射表（只构建一次，提升性能）
const ALL_NODE_KINDS = Object.values(NODE_KIND) as NodeKindValue[];
const kindToCategoryMap = new Map<NodeKindValue, NodeCategoryValue>();
(Object.values(FRAMEWORK) as NodeKindValue[])
    .forEach(val =>
        kindToCategoryMap.set(val, NODE_CATEGORY_KIND.FRAMEWORK));
(Object.values(AFFAIR) as NodeKindValue[])
    .forEach(val =>
        kindToCategoryMap.set(val, NODE_CATEGORY_KIND.AFFAIR));
(Object.values(EVIDENCE) as NodeKindValue[])
    .forEach(val =>
        kindToCategoryMap.set(val, NODE_CATEGORY_KIND.EVIDENCE));
(Object.values(RUNTIME) as NodeKindValue[])
    .forEach(val =>
        kindToCategoryMap.set(val, NODE_CATEGORY_KIND.RUNTIME));
(Object.values(SCRIPT) as NodeKindValue[])
    .forEach(val =>
        kindToCategoryMap.set(val, NODE_CATEGORY_KIND.SCRIPT));

/** 字符串是否是标准类型 */
export const IS_NodeKind = (value: string): value is NodeKindValue =>
    ALL_NODE_KINDS.includes(value as NodeKindValue);

/** 字符串类型 -> 大类 */
export const IS_KindStr_BelongToCategory = (kind: string, category: NodeCategoryValue): boolean =>
    IS_NodeKind(kind) && kindToCategoryMap.get(kind) === category;

/** 判断一个类型是否属于特定大类（包括 UNKNOWN） */
export const IS_KindOfCategory = (kind: NodeKindValue, category: NodeCategoryValue): boolean =>
    kindToCategoryMap.get(kind) === category;

/** 根据细分类型获取所属大类 */
export const GET_CategoryOfNode = (kind: NodeKindValue): NodeCategoryValue =>
    kindToCategoryMap.get(kind) ?? NODE_CATEGORY_KIND.UNKNOWN;

/** 获取某个大类下的所有节点值 */
export function GET_NodeKindsByCategory(category: NodeCategoryValue): NodeKindValue[] {
    const result: NodeKindValue[] = [];
    for (const [kind, cat] of kindToCategoryMap) {
        if (cat === category) result.push(kind);
    }
    return result;
}
