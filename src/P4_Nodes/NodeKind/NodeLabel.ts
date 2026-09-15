
// ============================================================
// 中文标签
// ============================================================

import {type NodeCategoryValue, type NodeKindValue} from "./NodeKind";

/** 节点类型中文名 */
export const NODE_KIND_LABELS: Record<NodeKindValue, string> = {
    FRAMEWORK_TRANS: '事务框架',
    FRAMEWORK_INFO: '信息框架',
    FRAMEWORK_TEMP: '模板框架',
    AFFAIR_CONCEPT: '构想',
    AFFAIR_PROJECT: '项目',
    AFFAIR_DIRECT: '方向',
    AFFAIR_TARGET: '目标',
    AFFAIR_PROCESS: '工序',
    AFFAIR_CHECK: '清单',
    AFFAIR_ITEM: '事项',
    AFFAIR_EVENT: '事件',
    EVIDENCE_FACTOR: '对象',
    EVIDENCE_REQUEST: '条件',
    EVIDENCE_CLUE: '信息',
    EVIDENCE_SNAPSHOT: '状态',
    RUNTIME_EDIT_LOG: '编辑日志',
    RUNTIME_BEHAVE_LOG: '行为日志',
    RUNTIME_FLOW_LOG: '流程状态',
    SCRIPT_FLOW: '流程脚本',
    SCRIPT_EXEC: '执行脚本',
    SCRIPT_QUERY: '查询脚本',
};

/** 节点大类中文名 */
export const NODE_CATEGORY_LABELS: Record<NodeCategoryValue, string> = {
    FRAMEWORK: '框架',
    AFFAIR: '事务',
    EVIDENCE: '证据',
    RUNTIME: '运行',
    SCRIPT: '脚本',
    UNKNOWN : '外部'
};

