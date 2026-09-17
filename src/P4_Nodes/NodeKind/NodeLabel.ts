
// ============================================================
// 中文标签
// ============================================================

import {GET_CategoryOfNode, IS_NodeKind, type NodeCategoryValue, type NodeKindValue} from "./NodeKind";

/** 出厂默认的类型中文名：下面两张表都从它派生，避免同一个默认值写两遍 */
const BUILTIN_KIND_LABELS: Record<NodeKindValue, string> = {
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

/**
 * 出厂默认值（只读）
 *
 * 与下面那张"当前生效"的表分开存：用户改过的名字会就地覆盖生效表，
 * 默认值得留在别处，「恢复默认」才有据可依。
 */
export const DEFAULT_KIND_LABELS: Readonly<Record<NodeKindValue, string>> = {...BUILTIN_KIND_LABELS};

/**
 * 节点类型中文名 —— **当前生效值**
 *
 * 这是一张"活的"表：插件启动与设置页保存时，由 APPLY_KindLabels 按用户配置就地覆盖。
 * 界面各处（徽章 / 右键菜单 / 行内新建下拉 / Tag / 导入预览 / 回收站 …）直接读它即可，
 * 不必各自去问设置 —— 这也正是选"就地改写一张表"而不是 `GET_KindLabel(kind)` 取值函数的原因：
 * 三十多处读取点因此一行都不用改。
 *
 * 类型的**短码**（KIND_TO_SHORT，如 K:Idea）是文件格式的一部分，不在这里、也不可配置。
 */
export const NODE_KIND_LABELS: Record<NodeKindValue, string> = {...BUILTIN_KIND_LABELS};

/** 节点大类中文名（不可配置；设置页拿它当分组标题） */
export const NODE_CATEGORY_LABELS: Record<NodeCategoryValue, string> = {
    FRAMEWORK: '框架',
    AFFAIR: '事务',
    EVIDENCE: '证据',
    RUNTIME: '运行',
    SCRIPT: '脚本',
    UNKNOWN : '外部'
};

/**
 * 用用户配置刷新 NODE_KIND_LABELS
 *
 * 必须先整体还原为默认、再套用覆盖：这样"把某个类型改回默认（或把输入框清空）"才真的生效，
 * 否则上一轮运行的旧值会残留在这张全局表里。
 * 空串、纯空白、非字符串一律当作"用默认值"；不属于任何已知类型的键直接忽略。
 */
export function APPLY_KindLabels(overrides?: Record<string, string> | null): void {
    for (const kind of Object.keys(BUILTIN_KIND_LABELS) as NodeKindValue[]) {
        NODE_KIND_LABELS[kind] = BUILTIN_KIND_LABELS[kind];
    }
    if (!overrides) return;
    for (const [kind, label] of Object.entries(overrides)) {
        if (!IS_NodeKind(kind)) continue;
        const text = typeof label === 'string' ? label.trim() : '';
        if (text) NODE_KIND_LABELS[kind] = text;
    }
}

/**
 * 设置页的分组顺序（与 NODE_KIND 的声明顺序一致；UNKNOWN 下没有真实类型，不列）
 *
 * 不含 FRAMEWORK：三个框架类型在界面上统一显示「框架」，区分它们只是为了确定出现位置与用途，
 * 而且从不同时出现在同一处 —— 没有可配置的差异，因此不进设置页。
 */
const KIND_LABEL_GROUP_ORDER: NodeCategoryValue[] = ['AFFAIR', 'EVIDENCE', 'RUNTIME', 'SCRIPT'];

/** 设置页的一组类型名：大类名做标题 + 组内类型与各自的默认名 */
export interface KindLabelGroup {
    category: NodeCategoryValue;
    title: string;
    kinds: { kind: NodeKindValue; defaultLabel: string }[];
}

/**
 * 设置页用：按大类分组的类型清单
 *
 * 大类名本身不可配置，但正好用来分组 —— 21 个类型平铺成一列太难找。
 */
export function GET_KindLabelGroups(): KindLabelGroup[] {
    const all = Object.keys(BUILTIN_KIND_LABELS) as NodeKindValue[];
    return KIND_LABEL_GROUP_ORDER.map((category) => ({
        category,
        title: NODE_CATEGORY_LABELS[category],
        kinds: all
            .filter((kind) => GET_CategoryOfNode(kind) === category)
            .map((kind) => ({kind, defaultLabel: BUILTIN_KIND_LABELS[kind]})),
    })).filter((group) => group.kinds.length > 0);
}
