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
 * 委托是**全局互斥**的：谁在委托、谁被抢占，一律由 DelegateRegistry 说了算
 * （见 Special/Delegate/DelegateRegistry）。本模块的 `delegated` 不再自己存，
 * 而是派生自登记处（owner === 'design'），并把登记处的变化转发成自己的广播 ——
 * 既有的订阅方（设计视图 / 委托面板 / 中控台）不必知道登记处的存在。
 *
 * 设计来源的委托描述（DESIGN_DELEGATE）也住在本文件：它就是「设计左栏这棵树」，
 * 与共享状态本就是同一件事。模块顶层把它注册给登记处 —— main.ts 恢复上次的委托
 * （settings.delegatedOwner）时正是靠这份注册才找得到来源。
 */

import { SimpleStore } from '../../../../P5_Data/Svelte/SimpleStore';
import { DELEGATE, type DelegateSource } from '../../../Special/Delegate/DelegateRegistry';
import { GET_RowMenu } from '../../../Special/Delegate/rowMenuRegistry';
import { NODE_KIND } from '../../../../P4_Nodes/NodeFacade';
import { buildFrameworkTree } from '../Tool/tree';
import { buildFrameLine, buildTreeItems } from '../Tool/viewModel';

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
    private _expandedVersion = 0;
    /**
     * 上次关库时的委托意图（settings.delegatedOwner 指向 design 的镜像，由视图写入）
     *
     * 启动瞬间登记处必然是空的 —— 委托要等 onReady → 对账 → START_Delegate 才接回，
     * 而视图的 onOpen 在工作区恢复时就跑了。只看登记处，左栏与把手会先按「未委托」
     * 铺出来、随后才跳到委托态，那就是进入视图时闪的那一下（与中控台预留面板目录同源）。
     * 意图若最终没兑现（来源没恢复出来），main 会清掉设置并 NOTIFY，视图随即重新同步。
     */
    private _pendingDelegated = false;

    /** 委托面板与相关视图订阅它 */
    readonly store = new SimpleStore<FrameworkTreeSnapshot>({
        delegated: false,
        selectedId: null,
        expandedVersion: 0,
    });

    constructor() {
        // 登记处的变化（委托建立 / 释放 / 易主）→ 转成本模块的广播：
        // 订阅方只认这一条通道，不必各自去订阅登记处。
        // 同时**无条件**清掉意图：登记处一动就说明「启动恢复」那段已经结束 ——
        // 恢复成功时意图与现状一致，被取消 / 作废时正是该把左栏交还回去的时候。
        // （原先这里写的是「只在恢复成功时清」，于是取消委托后意图留了下来，左栏再也不回来）
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
     * 与 delegated 的关系：那个是「现在真在委托（或正要接回）」，本方法把「上次关库时
     * 在委托」这条外部信息喂进来 —— 共享状态源自己不认识 settings，只能由视图转达。
     */
    SET_PendingDelegated(v: boolean): void {
        if (this._pendingDelegated === v) return;
        this._pendingDelegated = v;
        this.publish();
    }

    /**
     * 设计视图左栏是否要让位（真委托中，或上次的委托正在接回）
     *
     * 派生自登记处，全局互斥因此自然成立；并上意图是为了消掉启动瞬间那一下闪烁。
     */
    get delegated(): boolean {
        return DELEGATE.isDelegated('design') || this._pendingDelegated;
    }

    set delegated(v: boolean) {
        if (v) DELEGATE.delegate('design');
        else DELEGATE.release('design');
    }

    /** 展开集合被就地修改后调用，通知订阅者重算树 */
    markExpandedChanged(): void {
        this._expandedVersion++;
        this.publish();
    }

    private publish(): void {
        this.store.set({
            delegated: this.delegated,
            selectedId: this._selectedId,
            expandedVersion: this._expandedVersion,
        });
    }
}

/** 插件进程内的唯一实例（主插件只会有一个实例） */
export const FRAMEWORK_TREE = new FrameworkTreeShared();

/**
 * 设计来源：左栏的框架树被委托出去时，委托面板按这份描述渲染
 *
 * rowMenu 从 Special/Delegate/rowMenuRegistry 按来源取（视图挂载时登记、卸载时撤销）：
 * 视图在着，用的就是与未委托时**同一套**菜单；视图从未打开过则取不到，面板退回默认三项。
 */
export const DESIGN_DELEGATE: DelegateSource = {
    owner: 'design',
    title: '框架',
    childKind: NODE_KIND.TRANS,
    get expanded(): Set<string> {
        return FRAMEWORK_TREE.expandedLeft;
    },
    getSelectedId: () => FRAMEWORK_TREE.selectedId,
    setSelectedId: (nodeId) => {
        FRAMEWORK_TREE.selectedId = nodeId;
    },
    markExpandedChanged: () => FRAMEWORK_TREE.markExpandedChanged(),
    subscribe: (cb) => FRAMEWORK_TREE.store.subscribe(cb),
    // getter 而不是固定值：登记是视图挂载时才发生的，视图从未打开过就取不到，
    // 面板据此退回默认三项（见 DelegateTreeController.showRowMenu）
    get rowMenu() {
        return GET_RowMenu('design');
    },
    buildItems: (ctx) => {
        const selectedId = FRAMEWORK_TREE.selectedId;
        const roots = buildFrameworkTree(ctx.pipe, ctx.settings.topFrameworkOrder ?? []);
        return buildTreeItems(ctx.pipe, '', roots, FRAMEWORK_TREE.expandedLeft, (node, flags) =>
            buildFrameLine(ctx.pipe, node, flags, selectedId === node.nodeId, ctx.overlayFor(node.nodeId)),
        );
    },
    emptyText: (ctx) =>
        buildFrameworkTree(ctx.pipe, ctx.settings.topFrameworkOrder ?? []).length === 0
            ? '暂无框架，可在事务设计中新建'
            : undefined,
    release: () => {
        // 委托标记由登记处摘牌即复位（delegated 是派生的），此处无需再做别的：
        // 展开与选中都保留 —— 取消委托只是把树交还左栏，不该顺手丢掉用户的位置
    },
};

// 模块顶层注册：只要本模块被加载（main.ts 就加载它），恢复上次委托时就找得到设计来源
DELEGATE.register('design', () => DESIGN_DELEGATE);
