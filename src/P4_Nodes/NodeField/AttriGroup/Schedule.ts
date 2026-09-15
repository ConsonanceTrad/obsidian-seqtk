/**
 * 预期/排程簇（schedule）
 *
 * 描述节点在时间维度上的"预期"语义（计划何时完成/发生、按什么周期重复、
 * 整体跨度如何）。旧注释适用面：expectedTime/expectedRepeat 仅事务节点，
 * expectedSpan 仅框架节点。本簇只声明形状，不决定适用 kind。
 */

export interface ScheduleFields {
    /** 预期时间：ISO 日期/时间，描述事务预期何时完成或发生 */
    expectedTime?: string;
    /** 预期重复：循环规则字符串，描述事务预期重复周期 */
    expectedRepeat?: string;
    /** 预期时间段：起止 ISO 时间，描述框架整体预期跨度 */
    expectedSpan?: { from?: string; to?: string };
}
