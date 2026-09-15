/**
 * 事件/时点簇（event）
 *
 * 描述"事件性质"与"状态快照时点"语义：
 * - nature：仅 event 节点，temp=临时派发，retro=事后补录
 * - at：仅 snapshot 状态节点，记录状态对应的 ISO 时间，与节点 create 时间独立
 *
 * 本簇把两个"只出现在单一 kind"的字段归拢一处，便于未来若某 kind 复用
 * 时直接组合；不决定适用 kind。
 */

import type {EventNature} from "../StateKeys";

export interface EventFields {
    /** 事件性质：temp（临时派发）/ retro（事后补录），仅 event 节点 */
    nature?: EventNature;
    /** 时间点：状态对应的 ISO 时间，仅 snapshot 节点使用，与 create 独立 */
    at?: string;
}
