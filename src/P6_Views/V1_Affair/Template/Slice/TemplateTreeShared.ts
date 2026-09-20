/**
 * TemplateTreeShared — 模板左栏的共享状态（模板视图 ⇄ 委托面板）
 *
 * 与 design/FrameworkTreeShared 同构，理由也一样：模板左栏的模板框架树可以被
 * 「委托」到侧栏显示，两处必须始终一致，因此**展开集合与选中不放视图实例**，
 * 而放这里：它是插件进程内的单一事实源（模板视图与委托面板共用同一实例）。
 *
 * 委托本身是全局互斥的（见 Special/Delegate/DelegateRegistry），它的**持久化**统一由
 * Special/Delegate/DelegateSession 负责 —— 本模块只管把状态广播出去，不碰 settings。
 */

import { SimpleStore } from '../../../../P5_Data/Svelte/SimpleStore';
import { DELEGATE } from '../../../Special/Delegate/DelegateRegistry';

export interface TemplateTreeSnapshot {
    /** 当前选中的模板框架 nodeId */
    selectedId: string | null;
    /**
     * 是否处于委托状态（委托面板在显示这棵树）
     *
     * **必须进快照**：视图靠订阅通道才知道「该收左栏 / 该交还左栏」。少了它，从委托面板
     * 那侧取消委托时本视图收不到任何变化 —— 那一刻 selectedId 与 expandedVersion 都没动，
     * 于是左栏会一直让着位。design / route 那两份快照都带着它。
     */
    delegated: boolean;
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
        delegated: false,
        expandedVersion: 0,
    });

    /**
     * 上次关库时的委托意图（settings.delegatedOwner 指向 template 的镜像，由视图写入）
     *
     * 与 FrameworkTreeShared 里那份同源同理：启动瞬间登记处必然是空的，只看它左栏会先按
     * 未委托铺出来、随后才跳到委托态。模板来源如今也跨重启恢复（见 DelegateSession），
     * 这道预留因此同样必要。
     */
    private _pendingDelegated = false;

    constructor() {
        // 登记处的变化（委托建立 / 释放 / 易主）→ 转成本模块的广播。
        // 同时**无条件**清掉意图：登记处一动就说明「启动恢复」那段已经结束 ——
        // 恢复成功时意图与现状一致，被取消 / 作废时正是该把左栏交还回去的时候
        DELEGATE.store.subscribe(() => {
            this._pendingDelegated = false;
            this.publish();
        });
    }

    get selectedId(): string | null {
        return this._selectedId;
    }

    set selectedId(v: string | null) {
        if (this._selectedId === v) return;
        this._selectedId = v;
        this.publish();
    }

    /**
     * 同步「上次的委托意图」（视图挂载时、以及意图被作废时调用）
     *
     * 与 FrameworkTreeShared 的同名方法一致：共享状态源自己不认识 settings，由视图转达。
     */
    SET_PendingDelegated(v: boolean): void {
        if (this._pendingDelegated === v) return;
        this._pendingDelegated = v;
        this.publish();
    }

    /**
     * 模板左栏是否要让位（真委托中，或上次的委托正在接回）
     *
     * 派生自登记处，全局互斥因此自然成立；并上意图是为了消掉启动瞬间那一下闪烁。
     */
    get delegated(): boolean {
        return DELEGATE.isDelegated('template') || this._pendingDelegated;
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
            delegated: this.delegated,
            expandedVersion: this._expandedVersion,
        });
    }
}

/** 插件进程内的唯一实例 */
export const TEMPLATE_TREE = new TemplateTreeShared();
