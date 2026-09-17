/**
 * TemplateTreeShared — 模板左栏的共享状态（模板视图 ⇄ 委托面板）
 *
 * 与 design/FrameworkTreeShared 同构，理由也一样：模板左栏的模板框架树可以被
 * 「委托」到侧栏显示，两处必须始终一致，因此**展开集合与选中不放视图实例**，
 * 而放这里：它是插件进程内的单一事实源（模板视图与委托面板共用同一实例）。
 *
 * 委托本身是全局互斥的（见 Special/Delegate/DelegateRegistry）。本模块的 delegated
 * 派生自登记处，并把登记处的变化转发成自己的广播 —— 订阅方不必知道登记处的存在。
 */

import { SimpleStore } from '../../../../P5_Data/Svelte/SimpleStore';
import { DELEGATE } from '../../../Special/Delegate/DelegateRegistry';

export interface TemplateTreeSnapshot {
    /** 当前选中的模板框架 nodeId */
    selectedId: string | null;
    /**
     * 展开集合的版本号
     *
     * Set 是就地增删的，直接比较不便；用递增版本号作为订阅触发依据
     * （实际展开状态仍以 expanded 为准）。
     */
    expandedVersion: number;
}

export class TemplateTreeShared {
    /** 左栏展开集合（模板视图与委托面板共用同一实例） */
    readonly expanded = new Set<string>();

    private _selectedId: string | null = null;
    private _expandedVersion = 0;

    /** 模板视图与委托面板订阅它 */
    readonly store = new SimpleStore<TemplateTreeSnapshot>({
        selectedId: null,
        expandedVersion: 0,
    });

    constructor() {
        // 登记处的变化（委托建立 / 释放 / 易主）→ 转成本模块的广播
        DELEGATE.store.subscribe(() => this.publish());
    }

    get selectedId(): string | null {
        return this._selectedId;
    }

    set selectedId(v: string | null) {
        if (this._selectedId === v) return;
        this._selectedId = v;
        this.publish();
    }

    /** 模板左栏是否处于委托（派生自登记处，全局互斥因此自然成立） */
    get delegated(): boolean {
        return DELEGATE.isDelegated('template');
    }

    set delegated(v: boolean) {
        if (v) DELEGATE.delegate('template');
        else DELEGATE.release('template');
    }

    /** 展开集合被就地修改后调用，通知订阅者重算树 */
    markExpandedChanged(): void {
        this._expandedVersion++;
        this.publish();
    }

    private publish(): void {
        this.store.set({
            selectedId: this._selectedId,
            expandedVersion: this._expandedVersion,
        });
    }
}

/** 插件进程内的唯一实例 */
export const TEMPLATE_TREE = new TemplateTreeShared();
