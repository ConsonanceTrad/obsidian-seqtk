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
import { NODE_KIND_LABELS } from '../../../../P4_Nodes/NodeKind/NodeLabel';

export interface FlowTreeSnapshot {
    /** 是否处于委托状态（脚本列表在委托面板显示） */
    delegated: boolean;
    /** 当前选中的脚本 nodeId */
    selectedId: string | null;
}

/** 扁平列表没有展开概念；给一个共享的空集合（面板会读它，不宜每次返回新对象） */
const NO_EXPANDED = new Set<string>();

export class FlowTreeShared {
    private _selectedId: string | null = null;
    /** 上次关库时的委托意图（settings.delegatedOwner 的镜像，成因见 RouteTreeShared） */
    private _pendingDelegated = false;

    readonly store = new SimpleStore<FlowTreeSnapshot>({ delegated: false, selectedId: null });

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
        return DELEGATE.isDelegated('flow') || this._pendingDelegated;
    }

    set delegated(v: boolean) {
        if (v) DELEGATE.delegate('flow');
        else DELEGATE.release('flow');
    }

    private publish(): void {
        this.store.set({ delegated: this.delegated, selectedId: this._selectedId });
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
        return ctx.pipe.GET_ByKind(NODE_KIND.FLOW).map(({ nodeId, data }) => ({
            line: {
                nodeId,
                // 扁平列表：全部是顶级行，没有父子关系
                parentId: '',
                depth: 0,
                kind: data.kind,
                category: GET_CategoryOfNode(data.kind),
                label: NODE_KIND_LABELS[data.kind],
                desc: data.desc,
                hasChildren: false,
                expanded: false,
                inExpandedTree: false,
                selected: selectedId === nodeId,
                showsOpenButton: true,
            },
            children: [],
        }));
    },
    emptyText: (ctx) => (ctx.pipe.GET_ByKind(NODE_KIND.FLOW).length === 0 ? '暂无流程脚本' : undefined),
    release: () => {
        // 委托标记由登记处摘牌即复位（delegated 是派生的）。选中保留 ——
        // 取消委托只是把列表交还左栏，不该顺手丢掉用户的位置
    },
};

// 模块顶层注册：只要本模块被加载，恢复上次委托时就找得到流程设计来源
DELEGATE.register('flow', () => FLOW_DELEGATE);
