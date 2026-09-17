import {type NodeKindValue} from "./NodeKind";

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
        'AFFAIR_DIRECT'
    ],
    AFFAIR_DIRECT: [
        'AFFAIR_TARGET'
    ],
    AFFAIR_TARGET: [
        'AFFAIR_PROCESS',
        'AFFAIR_EVENT'
    ],
    AFFAIR_PROCESS: [
        'AFFAIR_PROCESS'
    ],
    AFFAIR_CHECK: [
        'AFFAIR_ITEM'
    ],
};

/** 根据父节点类型返回允许直接从属的子类型（未列出的父返回空数组） */
export const GET_AllowedChildKinds = (parentKind: NodeKindValue): NodeKindValue[] =>
    CHILD_KINDS_BY_PARENT[parentKind] ?? [];
