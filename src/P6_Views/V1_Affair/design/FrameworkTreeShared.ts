/**
 * FrameworkTreeShared — 框架树的共享状态（设计视图左栏 ⇄ 委托面板）
 *
 * 左栏的框架树可以被「委托」到中控台侧栏显示。两处必须始终一致，因此
 * **展开集合与选中框架不放视图实例**，而放这里：它是插件进程内的单一事实源。
 *
 * 接线方式（关键）：设计视图并**不**改用自己的字段 ——
 * `DesignView.expandedLeft` 直接指向本模块的同一个 `Set` 实例，
 * `selectedFrameworkId` 是转发到 `selectedId` 的存取器。
 * 于是 `view.expandedLeft` / `view.selectedFrameworkId` 的全部既有用法保持不变，
 * 而两处的读写天然同源。
 *
 * 委托面板不是 DesignView 的子组件，需要独立的订阅通道，因此这里另有一个
 * SimpleStore 广播快照；DesignView 自己的重绘仍走它自己的 stateStore。
 */

import { SimpleStore } from '../../../P5_Data/Svelte/SimpleStore';

export interface FrameworkTreeSnapshot {
    /** 是否处于委托状态（框架树在委托面板显示） */
    delegated: boolean;
    /** 当前选中的框架 nodeId */
    selectedId: string | null;
    /**
     * 展开集合的版本号
     *
     * Set 是就地增删的，直接比较不便；用递增版本号作为订阅触发依据，
     * 消费方据此重新计算树（实际展开状态仍以 expandedLeft 为准）。
     */
    expandedVersion: number;
}

export class FrameworkTreeShared {
    /** 左栏展开集合（设计视图与委托面板共用同一实例） */
    readonly expandedLeft = new Set<string>();

    private _selectedId: string | null = null;
    private _delegated = false;
    private _expandedVersion = 0;

    /** 委托面板与相关视图订阅它 */
    readonly store = new SimpleStore<FrameworkTreeSnapshot>({
        delegated: false,
        selectedId: null,
        expandedVersion: 0,
    });

    get selectedId(): string | null {
        return this._selectedId;
    }

    set selectedId(v: string | null) {
        if (this._selectedId === v) return;
        this._selectedId = v;
        this.publish();
    }

    get delegated(): boolean {
        return this._delegated;
    }

    set delegated(v: boolean) {
        if (this._delegated === v) return;
        this._delegated = v;
        this.publish();
    }

    /** 展开集合被就地修改后调用，通知订阅者重算树 */
    markExpandedChanged(): void {
        this._expandedVersion++;
        this.publish();
    }

    /** 委托取消时清空展开（避免下次委托残留上一次的展开形态） */
    resetExpanded(): void {
        this.expandedLeft.clear();
        this.markExpandedChanged();
    }

    private publish(): void {
        this.store.set({
            delegated: this._delegated,
            selectedId: this._selectedId,
            expandedVersion: this._expandedVersion,
        });
    }
}

/** 插件进程内的唯一实例（主插件只会有一个实例） */
export const FRAMEWORK_TREE = new FrameworkTreeShared();
