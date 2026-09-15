/** 节点过程状态（适用：框架、事务） */
export const STATE_VALUES = [
    'plan',
    'open',
    'done',
    'drop'
] as const;
export type SeqtkState = (typeof STATE_VALUES)[number];

/** 节点附加状态（适用：框架、事务）— 描述部分节点的特殊进行状态标记 */
export const ESTATE_VALUES = ['normal', 'hold', 'blocked'] as const;
export type SeqtkEstate = (typeof ESTATE_VALUES)[number];

/** 指标值 — 数字或布尔量，使展示名或描述进行条件显示 */
export type SeqtkIndicator = number | boolean;

/**
 * 事件性质（仅 event 节点）
 *
 * - temp：临时事件 — 临时被派发的任务
 * - retro：补录事件 — 已经完成过的任务，事后补录
 */
export const EVENT_NATURE_VALUES = ['temp', 'retro'] as const;
export type EventNature = (typeof EVENT_NATURE_VALUES)[number];

/** 事件性质中文名 */
export const EVENT_NATURE_LABELS: Record<EventNature, string> = {
    temp: '临时',
    retro: '补录',
};

/** 过程状态中文名 */
export const NODE_STATE_LABELS: Record<SeqtkState, string> = {
    plan: '规划',
    open: '进行',
    done: '完成',
    drop: '放弃',
};

/** 附加状态中文名 */
export const NODE_ESTATE_LABELS: Record<SeqtkEstate, string> = {
    normal: '正常',
    hold: '搁置',
    blocked: '阻塞',
};

/** 过程状态流转：plan → open → done/drop，done 可重新打开 */
export const STATE_FLOW: Record<SeqtkState, SeqtkState[]> = {
    plan: ['open', 'drop'],
    open: ['done', 'drop'],
    done: ['open'],
    drop: [],
};

/** 获取某状态可流转到的下一状态列表 */
export function getNextStates(current: string): SeqtkState[] {
    return STATE_FLOW[current as SeqtkState] ?? [];
}

