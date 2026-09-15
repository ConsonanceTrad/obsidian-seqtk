/**
 * 从属关系簇（affiliation）
 *
 * 框架 / 事务 / 证据节点之间通过双向标注建立从属：
 * 上级记录「有向直属下属」，下级记录「有向直属上级」，以支持高频双向查询。
 * 其余字段为扩展关系，按簇语义组合到具体节点类型时再收窄适用面。
 *
 * 本簇只声明"字段存在性与形状"，不决定某个 kind 是否拥有它——
 * 是否组合由 Nodes/* 的节点类型接口决定（本次不动）。
 */

export interface AffiliationFields {
    /** 有向直属下属（nodeId 列表）—— 上级标注其直属下级 */
    follows?: string[];
    /** 有向直属上级（nodeId）—— 下级标注其直属上级 */
    parent?: string;
    /** 无向关联（nodeId 列表）—— 互相引用的对等关系 */
    links?: string[];
    /** 标记插入（nodeId 列表）—— 由插入的标记节点记录其宿主链 */
    progress?: string[];
}
