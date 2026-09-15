/**
 * 表意/标注簇（meaning）
 *
 * 承载节点"含义层面的修饰信息"：是否可条件清空、标签、指标、流程属性。
 * 旧注释适用面：clear 仅清单/事项；tags 框架/事务/证据；indicators 事务；
 * pmarks 标记（且为必填语义，见旧 MarkNode 收窄）。本簇只声明形状，
 * 具体必填/适用由组合它的节点类型接口决定。
 */

import type {SeqtkIndicator} from "../StateKeys";

export interface MeaningFields {
    /** 条件清空启用 — 此清单或事项是否支持被恢复到 open 状态 */
    clear?: boolean;
    /** 标签 — 描述节点特性的一系列短词 */
    tags?: string[];
    /** 指标 — 数个数字或布尔量，可通过配置脚本控制实现复杂变化 */
    indicators?: SeqtkIndicator[];
    /** 流程属性 — 键值对，标记节点的流程属性 */
    pmarks?: Record<string, string>;
}
