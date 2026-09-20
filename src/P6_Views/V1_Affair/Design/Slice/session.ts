/**
 * design/session — 设计视图会话切片
 *
 * 从 DesignView 拆出的「可记忆的界面状态」持久化：左栏宽度、两栏树滚动位置、
 * 展开集合与选中框架的落盘（防抖与立即两档）。
 *
 * 约定:
 * - 本文件函数以 view(DesignView 实例)为第一参数,只读写 view 上公开的状态
 *   （settings / leftWidth / persistTimer / persistSettings / containerEl / expandedRight）
 * - 写盘时机只有两档：立即（persistNow，关库与关视图时）与 600ms 防抖（schedulePersist），
 *   调用方不得另起计时器
 * - 视图类保留 FLUSH_Session 一行转发，使「关库前把最后一次变更落盘」仍只有一个入口
 *
 * 功能增补指引:
 * - 新增需要跨会话记住的界面状态 → 在此加字段读写，并在 persistNow 中登记
 */

import { FRAMEWORK_TREE } from './FrameworkTreeShared';
import type { DesignView } from '../Core/Design';

/** 左栏宽度的默认值与取值范围（与 DesignPanel 的拖动上限保持一致） */
export const LEFT_PANE_DEFAULT = 280;
export const LEFT_PANE_MIN = 160;
export const LEFT_PANE_MAX = 640;

/** 防抖写回的等待时间（拖动过程与连续展开不频繁落盘） */
const PERSIST_DEBOUNCE_MS = 600;

/**
 * 立即把会话状态写回设置（不防抖）
 *
 * 供插件卸载时调用：schedulePersist 有防抖，而关库时 Obsidian 直接卸载插件，
 * onBeforeUnmount 未必会被调用，最后一次变更就可能丢掉。
 */
export function persistNow(view: DesignView): void {
    view.settings.leftPaneWidth = view.leftWidth;
    view.settings.expandedFrameworkIds = [...FRAMEWORK_TREE.expandedLeft];
    view.settings.expandedRightIds = [...view.expandedRight];
    // 会话状态：重开库时按这几项把视图恢复成关库前的样子。
    // 注意这里**不写** delegatedOwner —— 那是全局单值（谁被委托），与「哪个视图开着」无关，
    // 由 Special/Delegate/DelegateSession 统一负责（见那边的 PERSIST_Delegate）：写两处
    // 既有重复的风险，也让「新增来源时该照哪一处抄」变得没人说得清。
    view.settings.selectedFrameworkId = FRAMEWORK_TREE.selectedId;
    view.persistSettings?.();
}

/** 防抖写回：拖动过程与连续展开不会频繁落盘 */
export function schedulePersist(view: DesignView): void {
    if (view.persistTimer !== null) window.clearTimeout(view.persistTimer);
    view.persistTimer = window.setTimeout(() => {
        view.persistTimer = null;
        persistNow(view);
    }, PERSIST_DEBOUNCE_MS);
}

/** 左栏宽度变更（由渲染件在拖动结束后上报） */
export function setLeftWidth(view: DesignView, width: number): void {
    const clamped = Math.min(Math.max(Math.round(width), LEFT_PANE_MIN), LEFT_PANE_MAX);
    if (clamped === view.leftWidth) return;
    view.leftWidth = clamped;
    schedulePersist(view);
}

/**
 * 绑定树容器的滚动记录器
 *
 * 用事件委托（捕获阶段）而不是给每棵树挂监听：树容器由 P7_Render 渲染，
 * 视图层不该去它内部找元素、更不该在重渲后重挂。判断是哪一栏靠 closest，
 * 与 DesignPanel 里其它“按栏分派”的写法一致。
 *
 * 以工厂形式返回，是因为它要挂成视图上的箭头函数字段；字段初始化器先于
 * constructor 体执行，故工厂内只捕获 view 引用，字段要等事件触发时再读。
 */
export function bindTreeScroll(view: DesignView): (e: Event) => void {
    return (e: Event): void => {
        const el = e.target as HTMLElement | null;
        if (!el || !el.classList || !el.classList.contains('seqtk-tree')) return;
        if (el.closest('.seqtk-split-left')) view.settings.treeScrollLeft = el.scrollTop;
        else view.settings.treeScrollRight = el.scrollTop;
        schedulePersist(view);
    };
}

/** 把两栏树容器滚回上次的位置（树渲染完成后再设，早了会被内容高度归零冲掉） */
export function restoreTreeScroll(view: DesignView): void {
    const left = view.settings.treeScrollLeft;
    const right = view.settings.treeScrollRight;
    if (!left && !right) return;
    window.requestAnimationFrame(() => {
        const root = view.containerEl;
        const trees = Array.from(root.querySelectorAll<HTMLElement>('.seqtk-tree'));
        for (const el of trees) {
            const want = el.closest('.seqtk-split-left') ? left : right;
            if (want) el.scrollTop = want;
        }
    });
}
