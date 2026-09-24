/**
 * flowTreeShared — 流程设计左栏脚本列表的共享状态（左栏 ⇄ 委托面板）
 *
 * 与 design/FrameworkTreeShared、route/RouteTreeShared 是**同构的几份**，不是同一份：
 * 三处的树同源但「在看谁、选中谁」是各自的观察状态，共用会让一个视图里的选中莫名其妙地
 * 出现在另一个视图里。所以这里只服务流程设计，结构照抄线路那份（含 pendingDelegated
 * 那段消抖逻辑，成因见 RouteTreeShared）。
 *
 * 与线路的差别只有一处：流程脚本是**扁平列表**（没有父子层级），所以没有展开集合 ——
 * `expanded` 恒为空、`markExpandedChanged` 是空操作，委托面板里只是永远不出现折叠方块。
 *
 * 委托本身仍是**全局互斥**的（见 DelegateRegistry）。
 */

import { SimpleStore } from '../../../../P5_Data/Svelte/SimpleStore';
import { DELEGATE, type DelegateSource } from '../../../Special/Delegate/DelegateRegistry';
import { GET_RowMenu } from '../../../Special/Delegate/rowMenuRegistry';
import { GET_CategoryOfNode, NODE_KIND } from '../../../../P4_Nodes/NodeKind/NodeKind';
import type { NodeKindValue } from '../../../../P4_Nodes/NodeKind/NodeKind';
import { NODE_KIND_LABELS } from '../../../../P4_Nodes/NodeKind/NodeLabel';

/** 左栏一行的脚本（文件名即 nodeId；kind 一并带上是给保存用的，理由见 FlowScriptItem 的字段注释） */
export interface FlowScriptItem {
    nodeId: string;
    /** 脚本 kind（SCRIPT_FLOW）：保存时要它，拿不到就会静默失败 */
    kind: NodeKindValue;
    desc: string;
}

export interface FlowTreeSnapshot {
    /** 是否处于委托状态（脚本列表在委托面板显示） */
    delegated: boolean;
    /** 当前选中的脚本 nodeId */
    selectedId: string | null;
    /**
     * 脚本列表快照
     *
     * 为什么不在这里即时 `GET_ByKind`：脚本属**文件基准通道**（SCRIPT 大类），
     * 根本不进活跃缓存，`GET_ByKind` 恒返回空数组 —— 那个空看起来跟「一个脚本都没有」
     * 一模一样。它只能**异步扫描**得到，所以由视图拉取后写进快照，这里只负责发布。
     * 这样 `buildItems` 仍是同步的，委托面板的既有契约不必改。
     */
    items: FlowScriptItem[];
}

/** 扁平列表没有展开概念；给一个共享的空集合（面板会读它，不宜每次返回新对象） */
const NO_EXPANDED = new Set<string>();

export class FlowTreeShared {
    private _selectedId: string | null = null;
    private _items: FlowScriptItem[] = [];
    /** 上次关库时的委托意图（settings.delegatedOwner 的镜像，成因见 RouteTreeShared） */
    private _pendingDelegated = false;

    readonly store = new SimpleStore<FlowTreeSnapshot>({ delegated: false, selectedId: null, items: [] });

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

    /** 当前脚本列表快照 */
    get items(): FlowScriptItem[] {
        return this._items;
    }

    /** 换一批脚本（异步扫描的结果；同时会广播，左栏与委托面板都会重渲染） */
    SET_Items(items: FlowScriptItem[]): void {
        this._items = items;
        this.publish();
    }

    /** 选中脚本的 kind；没选中（或列表还没拉回来）时为 null */
    GET_SelectedKind(): NodeKindValue | null {
        return this._items.find((i) => i.nodeId === this._selectedId)?.kind ?? null;
    }

    /** 同步「上次的委托意图」（视图挂载时、意图被作废时调用） */
    SET_PendingDelegated(v: boolean): void {
        if (this._pendingDelegated === v) return;
        this._pendingDelegated = v;
        this.publish();
    }

    /** 左栏是否要让位（真委托中，或上次的委托正在接回） */
    get delegated(): boolean {
        return DELEGATE.isDelegated('flow') || this._pendingDelegated;
    }

    set delegated(v: boolean) {
        if (v) DELEGATE.delegate('flow');
        else DELEGATE.release('flow');
    }

    private publish(): void {
        this.store.set({ delegated: this.delegated, selectedId: this._selectedId, items: this._items });
    }
}

/** 插件进程内的唯一实例 */
export const FLOW_TREE = new FlowTreeShared();

/**
 * 流程设计来源：左栏的脚本列表被委托出去时，委托面板按这份描述渲染
 *
 * `buildItems` 只用面板给的 pipe（与左栏的 BUILD_ScriptRows 同一份数据），**不依赖视图实例** ——
 * 委托的用意正是把左栏省掉，那时来源视图未必开着。
 *
 * rowMenu 与 ROUTE_DELEGATE 同一做法：从 rowMenuRegistry 按来源取（视图挂载时登记），
 * 于是委托面板里的行右键与左栏是**同一套**菜单；取不到（视图从未打开过）则退回面板的默认三项。
 */
export const FLOW_DELEGATE: DelegateSource = {
    owner: 'flow',
    title: '流程脚本',
    childKind: NODE_KIND.FLOW,
    get expanded(): Set<string> {
        return NO_EXPANDED;
    },
    getSelectedId: () => FLOW_TREE.selectedId,
    setSelectedId: (nodeId) => {
        FLOW_TREE.selectedId = nodeId;
    },
    markExpandedChanged: () => {
        // 扁平列表没有展开态，无需广播
    },
    subscribe: (cb) => FLOW_TREE.store.subscribe(cb),
    get rowMenu() {
        return GET_RowMenu('flow');
    },
    buildItems: (ctx) => {
        const selectedId = FLOW_TREE.selectedId;
        // 读的是异步拉回来的快照，不是缓存 —— 脚本不在缓存里（见 FlowTreeSnapshot.items）
        return FLOW_TREE.items.map(({ nodeId, kind, desc }) => ({
            line: {
                nodeId,
                // 扁平列表：全部是顶级行，没有父子关系
                parentId: '',
                depth: 0,
                kind,
                category: GET_CategoryOfNode(kind),
                label: NODE_KIND_LABELS[kind],
                desc,
                hasChildren: false,
                expanded: false,
                inExpandedTree: false,
                selected: selectedId === nodeId,
                showsOpenButton: true,
            },
            children: [],
        }));
    },
    emptyText: (ctx) => (FLOW_TREE.items.length === 0 ? '暂无流程脚本' : undefined),
    release: () => {
        // 委托标记由登记处摘牌即复位（delegated 是派生的）。选中保留 ——
        // 取消委托只是把列表交还左栏，不该顺手丢掉用户的位置
    },
};

// 模块顶层注册：只要本模块被加载，恢复上次委托时就找得到流程设计来源
DELEGATE.register('flow', () => FLOW_DELEGATE);
