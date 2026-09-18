import {type NodeKindValue} from "./NodeKind";

/**
 * 各类型允许直接从属的子类型（拖拽、行内新建、模板套用的共同口径）
 *
 * **事件（AFFAIR_EVENT）是例外**：它不占层级 —— 框架、构想、方向、目标、工序下都能挂。
 * 所以下面每个事务层级都列了它；新增事务层级时别忘了同样加上，否则那一层就只能靠
 * 行内新建硬塞（拖拽与模板会拒，显得前后不一致）。
 *
 * 清单（AFFAIR_CHECK）与信息框架（FRAMEWORK_INFO）暂时没有事件入口。
 */
const CHILD_KINDS_BY_PARENT: Partial<Record<NodeKindValue, NodeKindValue[]>> = {
    FRAMEWORK_TRANS: [
        'FRAMEWORK_TRANS',
        'AFFAIR_CONCEPT',
        'AFFAIR_CHECK',
        'AFFAIR_EVENT',
        'EVIDENCE_FACTOR',
        'EVIDENCE_REQUEST',
        'EVIDENCE_CLUE',
        'EVIDENCE_SNAPSHOT'
    ],
    FRAMEWORK_INFO: [
        'FRAMEWORK_INFO',
        'EVIDENCE_FACTOR',
        'EVIDENCE_REQUEST',
        'EVIDENCE_CLUE',
        'EVIDENCE_SNAPSHOT'
    ],
    AFFAIR_CONCEPT: [
        'AFFAIR_DIRECT',
        'AFFAIR_EVENT'
    ],
    AFFAIR_DIRECT: [
        'AFFAIR_TARGET',
        'AFFAIR_EVENT'
    ],
    AFFAIR_TARGET: [
        'AFFAIR_PROCESS',
        'AFFAIR_EVENT'
    ],
    AFFAIR_PROCESS: [
        'AFFAIR_PROCESS',
        'AFFAIR_EVENT'
    ],
    AFFAIR_CHECK: [
        'AFFAIR_ITEM'
    ],
};

/** 根据父节点类型返回允许直接从属的子类型（未列出的父返回空数组） */
export const GET_AllowedChildKinds = (parentKind: NodeKindValue): NodeKindValue[] =>
    CHILD_KINDS_BY_PARENT[parentKind] ?? [];
