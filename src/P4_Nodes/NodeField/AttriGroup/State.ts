/**
 * 状态簇（state）
 *
 * 描述节点的"过程进展"语义。仅拥有状态的节点 kind 组合本簇
 * （旧注释适用面：框架、事务），本簇只声明形状，不决定适用 kind。
 *
 * 值域类型复用 ./State（单一来源，不在此重复定义取值）。
 */

import type {SeqtkState, SeqtkEstate} from "../StateKeys";

export interface State {
    /** 过程状态：plan（规划）/ open（进行）/ done（完成）/ drop（放弃） */
    state?: SeqtkState;
    /** 附加状态：normal（正常）/ hold（搁置）/ blocked（阻塞） */
    estate?: SeqtkEstate;
}
