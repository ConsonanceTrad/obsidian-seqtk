/**
 * DraftDelegate — 事务分发的委托来源（非树左栏，走 renderPanel）
 *
 * 草稿左栏是月历 + 当日列表，不是节点树 —— 委托出去时落点整块渲染
 * `DraftCalendarPanel`（与主视图左栏**同一份组件**），标题与「取消委托」
 * 由落点外壳给（见 DelegatedCustomPanel）。
 *
 * 状态与主视图共用 `DRAFT_STATE`（一个 store 两处渲染，天然同步）；
 * 动作由 FlowDraftView 挂载时注入 —— 视图不在场时降级为提示
 * （月历的每个动作都要数据装载，脱离视图逻辑没法空转）。
 */

import { createElement } from 'react';
import { Notice } from 'obsidian';
import { SimpleStore } from '../../P5_Data/Svelte/SimpleStore';
import { NODE_KIND } from '../../P4_Nodes/NodeKind/NodeKind';
import { DELEGATE, type DelegateSource } from '../Special/Delegate/DelegateRegistry';
import { DraftCalendarPanel, type DraftCalendarActions, type FlowDraftState } from './FlowDraftPanel';

/** 委托面板与主视图共用的草稿状态 */
export const DRAFT_STATE = new SimpleStore<FlowDraftState>({
    selectedDate: '',
    markedDates: [],
    dayDrafts: [],
    selectedDraftId: null,
    title: '未新建',
    saveState: '',
    hasDraft: false,
    delegated: false,
    leftPaneWidth: 0,
});

/** 月历动作（FlowDraftView 挂载时注入；解挂时清空） */
let calActions: DraftCalendarActions | null = null;

export function SET_DraftCalendarActions(a: DraftCalendarActions | null): void {
    calActions = a;
}

/** 视图不在场时的降级：点了就提醒，不装作能干活 */
const FALLBACK_ACTIONS: DraftCalendarActions = {
    onPickDate: () => void new Notice('请先打开事务分发视图'),
    onCreateOnDate: () => void new Notice('请先打开事务分发视图'),
    onSelectDraft: () => void new Notice('请先打开事务分发视图'),
    onDraftContextMenu: () => void new Notice('请先打开事务分发视图'),
};

/** 月历左栏没有树形结构：展开集合恒空 */
const NO_EXPANDED = new Set<string>();

export const DRAFT_DELEGATE: DelegateSource = {
    owner: 'draft',
    title: '事务分发',
    childKind: NODE_KIND.DRAFT,
    get expanded(): Set<string> {
        return NO_EXPANDED;
    },
    getSelectedId: () => null,
    setSelectedId: () => {
        // 月历的「选中」是日期，不是节点 —— 树接口不适用
    },
    markExpandedChanged: () => {
        // 没有展开态
    },
    subscribe: (cb) => DRAFT_STATE.subscribe(cb),
    buildItems: () => [],
    emptyText: () => undefined,
    renderPanel: () =>
        createElement(DraftCalendarPanel, {
            state: DRAFT_STATE,
            actions: calActions ?? FALLBACK_ACTIONS,
        }),
    release: () => {
        // 选中日期与草稿位置保留 —— 取消委托只是把月历交还主视图
    },
};

// 模块顶层注册：恢复上次委托时找得到草稿来源
DELEGATE.register('draft', () => DRAFT_DELEGATE);
