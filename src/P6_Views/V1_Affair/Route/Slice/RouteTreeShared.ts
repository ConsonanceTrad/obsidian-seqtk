/**
 * RouteTreeShared — 线路模式左栏框架树的共享状态（线路左栏 ⇄ 委托面板）
 *
 * 与 design/FrameworkTreeShared 是**同构的两份**，不是同一份：两处的树虽然同源（同一批框架、
 * 同一套 buildFrameworkTree），但「在看哪一层、选中谁」是各自的观察状态 ——
 * 共用会让在一个视图里展开的枝干莫名其妙地出现在另一个视图里。
 *
 * 所以这里只服务线路模式，结构照抄设计那份（含 pendingDelegated 那段消抖逻辑，
 * 成因见 FrameworkTreeShared 的注释）：
 * - 线路视图的 `expandedLeft` 直接指向本模块的同一个 `Set` 实例
 * - `selectedFrameworkId` 转发到 `selectedId`
 * 于是视图里既有的用法保持不变，而左栏与委托面板天然同源。
 *
 * 委托本身仍是**全局互斥**的（见 DelegateRegistry）：线路与设计不会同时被委托出去。
 */

import { SimpleStore } from '../../../../P5_Data/Svelte/SimpleStore';
import { DELEGATE, type DelegateSource } from '../../../Special/Delegate/DelegateRegistry';
import { GET_RowMenu } from '../../../Special/Delegate/rowMenuRegistry';
import { NODE_KIND } from '../../../../P4_Nodes/NodeFacade';
import { buildFrameworkTree } from '../../Design/Tool/tree';
import { buildFrameLine, buildTreeItems } from '../../Design/Tool/viewModel';

export interface RouteTreeSnapshot {
    /** 是否处于委托状态（框架树在委托面板显示） */
    delegated: boolean;
    /** 当前选中的框架 nodeId */
    selectedId: string | null;
    /** 展开集合的版本号（Set 就地增删，用版本号作订阅触发依据） */
    expandedVersion: number;
}

export class RouteTreeShared {
    /** 左栏展开集合（线路视图与委托面板共用同一实例） */
    readonly expandedLeft = new Set<string>();

    private _selectedId: string | null = null;
    private _expandedVersion = 0;
    /** 上次关库时的委托意图（settings.delegatedOwner 的镜像，成因见 FrameworkTreeShared） */
    private _pendingDelegated = false;

    readonly store = new SimpleStore<RouteTreeSnapshot>({
        delegated: false,
        selectedId: null,
        expandedVersion: 0,
    });

    constructor() {
        // 登记处一动就说明「启动恢复」那段结束了：无条件清掉意图 ——
        // 恢复成功时意图与现状一致，被取消时正是该把左栏交还回去的时候
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

    /** 同步「上次的委托意图」（视图挂载时、意图被作废时调用） */
    SET_PendingDelegated(v: boolean): void {
        if (this._pendingDelegated === v) return;
        this._pendingDelegated = v;
        this.publish();
    }

    /** 左栏是否要让位（真委托中，或上次的委托正在接回） */
    get delegated(): boolean {
        return DELEGATE.isDelegated('route') || this._pendingDelegated;
    }

    set delegated(v: boolean) {
        if (v) DELEGATE.delegate('route');
        else DELEGATE.release('route');
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

/** 插件进程内的唯一实例 */
export const ROUTE_TREE = new RouteTreeShared();

/**
 * 线路来源：左栏的框架树被委托出去时，委托面板按这份描述渲染
 *
 * rowMenu 与 DESIGN_DELEGATE 同一做法：从 rowMenuRegistry 按来源取（本视图挂载时登记），
 * 于是委托面板里的行右键与左栏是**同一套**菜单；取不到（本视图从未打开过）则退回默认三项。
 */
export const ROUTE_DELEGATE: DelegateSource = {
    owner: 'route',
    title: '框架',
    childKind: NODE_KIND.TRANS,
    get expanded(): Set<string> {
        return ROUTE_TREE.expandedLeft;
    },
    getSelectedId: () => ROUTE_TREE.selectedId,
    setSelectedId: (nodeId) => {
        ROUTE_TREE.selectedId = nodeId;
    },
    markExpandedChanged: () => ROUTE_TREE.markExpandedChanged(),
    subscribe: (cb) => ROUTE_TREE.store.subscribe(cb),
    get rowMenu() {
        return GET_RowMenu('route');
    },
    buildItems: (ctx) => {
        const selectedId = ROUTE_TREE.selectedId;
        const roots = buildFrameworkTree(ctx.pipe, ctx.settings.topFrameworkOrder ?? []);
        return buildTreeItems(ctx.pipe, '', roots, ROUTE_TREE.expandedLeft, (node, flags) =>
            buildFrameLine(ctx.pipe, node, flags, selectedId === node.nodeId, ctx.overlayFor(node.nodeId)),
        );
    },
    emptyText: (ctx) =>
        buildFrameworkTree(ctx.pipe, ctx.settings.topFrameworkOrder ?? []).length === 0
            ? '暂无框架，可在事务设计中新建'
            : undefined,
    release: () => {
        // 委托标记由登记处摘牌即复位（delegated 是派生的）。展开与选中都保留 ——
        // 取消委托只是把树交还左栏，不该顺手丢掉用户的位置
    },
};

// 模块顶层注册：只要本模块被加载，恢复上次委托时就找得到线路来源
DELEGATE.register('route', () => ROUTE_DELEGATE);
