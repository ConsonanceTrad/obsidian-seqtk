/**
 * 节点字段目录表（运行时）— NodeField 的出口之一
 *
 * 类型形状由各簇接口（Affiliation/StateFields/Schedule/Event/Meaning）
 * 组合决定；本表把"字段名 → 元信息（label/cluster/appliesTo）"集中为
 * 单一运行时来源，供未来 YAML 读写默认值、校验、UI 表单生成、diff 使用。
 *
 * 互锁：FieldName 由各簇接口的键派生（keyof 聚合），FIELD_META 用
 * satisfies Record<FieldName, FieldMeta> 约束——补一个簇字段必须同时
 * 补目录条目（缺键/多键都会在编译期报错），杜绝两处漂移。
 *
 * 风格仿 NodeKind.ts（值空间常量 + Record 表 + 查询函数）与
 * NodeChildAllow.ts（表 + GET_* 查询）。appliesTo 依据旧版注释的
 * 适用面填写，仅对适用面明确的 kind 收窄；未填表示"暂不约束"，
 * 具体适用由 Nodes/* 组合时的类型决定（不在此重复强制）。
 */

import type {NodeKindValue} from "../NodeKind/NodeKind";
import type {AffiliationFields} from "./AttriGroup/Affiliation";
import type {State} from "./AttriGroup/State";
import type {ScheduleFields} from "./AttriGroup/Schedule";
import type {EventFields} from "./AttriGroup/Event";
import type {MeaningFields} from "./AttriGroup/Meaning";
import type {ExternalFields} from "./AttriGroup/External";

/** 全部字段名（由各簇接口键聚合，单一类型来源） */
export type FieldName =
    | keyof AffiliationFields
    | keyof State
    | keyof ScheduleFields
    | keyof EventFields
    | keyof MeaningFields
    | keyof ExternalFields;

/** 字段簇类别 */
export type FieldCluster =
    | 'affiliation'  // 从属关系
    | 'state'        // 过程/附加状态
    | 'schedule'     // 预期时间/重复/跨度
    | 'event'        // 事件性质 / 快照时点
    | 'meaning'      // 清空/标签/指标/流程属性
    | 'external';    // 外部信息源（节点体系之外的材料）

/** 单个字段的元信息 */
export interface FieldMeta {
    /** 中文展示名 */
    label: string;
    /** 所属簇 */
    cluster: FieldCluster;
    /** 适用 kind（收窄；未填 = 暂不约束，见文件头说明） */
    appliesTo?: NodeKindValue[];
}

/**
 * 字段目录表。键由 FieldName 穷尽约束：
 * satisfies Record<FieldName, FieldMeta> 会拒绝缺键与多余键。
 */
export const FIELD_META = {
    // ── affiliation 从属关系 ──
    follows: {label: '直属下属', cluster: 'affiliation'},
    parent: {label: '直属上级', cluster: 'affiliation'},
    links: {label: '无向关联', cluster: 'affiliation'},
    progress: {label: '标记插入', cluster: 'affiliation'},
    // ── state 过程状态 ──
    state: {label: '过程状态', cluster: 'state'},
    estate: {label: '附加状态', cluster: 'state'},
    // ── schedule 预期/排程 ──
    expectedTime: {label: '预期时间', cluster: 'schedule'},
    expectedRepeat: {label: '预期重复', cluster: 'schedule'},
    expectedSpan: {label: '预期时间段', cluster: 'schedule'},
    // ── event 事件/时点 ──
    nature: {label: '事件性质', cluster: 'event', appliesTo: ['AFFAIR_EVENT']},
    at: {label: '时间点', cluster: 'event', appliesTo: ['EVIDENCE_SNAPSHOT']},
    // ── meaning 表意/标注 ──
    clear: {label: '条件清空', cluster: 'meaning'},
    tags: {label: '标签', cluster: 'meaning'},
    indicators: {label: '指标', cluster: 'meaning'},
    pmarks: {label: '流程属性', cluster: 'meaning'},
    // ── external 外部信息源 ──
    sources: {label: '外部信息源', cluster: 'external'},
} satisfies Record<FieldName, FieldMeta>;

/** 获取某个簇下的全部字段名（仿 GET_NodeKindsByCategory） */
export function GET_FieldsOfCluster(cluster: FieldCluster): FieldName[] {
    return (Object.keys(FIELD_META) as FieldName[])
        .filter(name => FIELD_META[name].cluster === cluster);
}
