
// ============================================================
// 中文标签
// ============================================================

/**
 * 类型与大类的显示名
 *
 * 这个模块要解决的就一件事：**同一批类型名要在三十多处界面上显示，还得允许用户改**。
 * 因此拆成四样东西，各司其职：
 *
 *   BUILTIN_KIND_LABELS  出厂默认值（本文件私有 —— 默认值只写一遍的单一来源）
 *   DEFAULT_KIND_LABELS  默认值的只读快照：设置页的 placeholder、「恢复默认」的依据
 *   NODE_KIND_LABELS     **当前生效值**：界面各处读的就是这张表
 *   APPLY_KindLabels()   按用户配置就地刷新上面那张生效表
 *
 * 为什么是"就地改写一张表"，而不是 `GET_KindLabel(kind)` 之类的取值函数：
 * 读取点有三十多处（徽章 / 右键菜单 / 行内新建下拉 / Tag / 导入预览 / 回收站 …），
 * 就地覆盖让它们一行都不用改，也不必各自去问设置。
 *
 * 什么时候刷新：插件启动读盘之后、以及设置页每次落盘前后 —— 调用点集中在一处，
 * 见 P3_Settings/Settings.ts 的 Load_Setting 与 Save_Setting。改写不会主动重绘已经打开的
 * 视图（那是 React 那侧的事），所以设置页明说"改完需要重开视图（或重载插件）"。
 *
 * 不在这里、也不可配置的东西：
 *   - 类型的**短码**（KIND_TO_SHORT，如 K:Idea）—— 它是文件格式的一部分，改了会读不懂既有文件；
 *   - 节点文件里存的**类型值**（ASCII 枚举）—— 所以改显示名是纯显示层行为，不触碰数据。
 */

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
    // 「行动」而非「事项」：与「事件」读音太近，列表里一眼分不清
    AFFAIR_ITEM: '行动',
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
 * 界面各处直接读它即可，不必各自去问设置（理由见文件头）。
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
 * 调用点只有两处，都在 P3_Settings/Settings.ts：读盘后的 Load_Setting、落盘前的 Save_Setting
 * （落盘前也刷一次，是为了让"存下来的"与"界面上生效的"始终是同一份名字）。
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
 * 大类名本身不可配置，但正好用来分组 —— 十几个类型平铺成一列太难找。
 * 只列 KIND_LABEL_GROUP_ORDER 里的大类（即不含框架，理由见上）。
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
