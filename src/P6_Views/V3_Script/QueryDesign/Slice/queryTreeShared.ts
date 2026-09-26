/**
 * queryTreeShared — 查询设计左栏脚本树的共享状态（左栏 ⇄ 委托面板）
 *
 * 与 design/FrameworkTreeShared、flow/flowTreeShared 是**同构的几份**，不是同一份
 * （展开 / 选中各看各的，共用会互相串台）。差别：查询脚本是**层级树**（parent 归属
 * 形成分组），所以这里带展开集合 —— 结构照模板那份（TemplateTreeShared）。
 *
 * 分组口径（全部脚本类型通用，见 P2_Tools/Script/scriptTree）：有同类子脚本的是
 * **分组**（徽章显示「分组」），叶子是**脚本实体**（正文承载 SQL）。
 *
 * 数据口径：脚本属**文件基准通道**，不进缓存 —— 列表只能异步扫描（SCAN_Files），
 * 由视图拉取后写进快照，`buildItems` 保持同步。
 */

import { SimpleStore } from '../../../../P5_Data/Svelte/SimpleStore';
import { DELEGATE, type DelegateSource, type DelegateTreeCtx } from '../../../Special/Delegate/DelegateRegistry';
import { GET_RowMenu } from '../../../Special/Delegate/rowMenuRegistry';
import { GET_CategoryOfNode, NODE_KIND, type NodeKindValue } from '../../../../P4_Nodes/NodeKind/NodeKind';
import { NODE_KIND_LABELS } from '../../../../P4_Nodes/NodeKind/NodeLabel';
import { BUILD_ScriptTree, SCRIPT_GROUP_LABEL, type ScriptTreeSource } from '../../../../P2_Tools/Script/scriptTree';
import type { TreeNodeItem } from '../../../../P7_Render/Composition/C2_Tree/NodeTree';

/** 左栏一行的查询脚本（扫描结果的一项） */
export type QueryScriptItem = ScriptTreeSource;

export interface QueryTreeSnapshot {
    /** 是否处于委托中（脚本树在委托面板显示） */
    delegated: boolean;
    selectedId: string | null;
    /** 扫描快照（脚本不在缓存里，只能异步拉，理由见 FlowTreeSnapshot.items） */
    items: QueryScriptItem[];
}

export class QueryTreeShared {
    readonly expanded = new Set<string>();
    private _selectedId: string | null = null;
    private _items: QueryScriptItem[] = [];
    private _expandedVersion = 0;
    /** 上次关库时的委托意图（成因见 RouteTreeShared） */
    private _pendingDelegated = false;

    readonly store = new SimpleStore<QueryTreeSnapshot>({ delegated: false, selectedId: null, items: [] });

    constructor() {
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

    get items(): QueryScriptItem[] {
        return this._items;
    }

    /** 换一批脚本（异步扫描结果；左栏与委托面板同此快照） */
    SET_Items(items: QueryScriptItem[]): void {
        this._items = items;
        this.publish();
    }

    /** 展开集合被就地改动后广播（Set 无法比较，用版本号触发订阅） */
    markExpandedChanged(): void {
        this._expandedVersion++;
        this.publish();
    }

    SET_PendingDelegated(v: boolean): void {
        if (this._pendingDelegated === v) return;
        this._pendingDelegated = v;
        this.publish();
    }

    get delegated(): boolean {
        return DELEGATE.isDelegated('query') || this._pendingDelegated;
    }

    set delegated(v: boolean) {
        if (v) DELEGATE.delegate('query');
        else DELEGATE.release('query');
    }

    private publish(): void {
        this.store.set({ delegated: this.delegated, selectedId: this._selectedId, items: this._items });
    }
}

/** 插件进程内的唯一实例 */
export const QUERY_TREE = new QueryTreeShared();

/** 脚本树 → 委托面板的 TreeNodeItem（递归；分组徽章显示「分组」） */
export function BUILD_QueryTreeItems(ctx: DelegateTreeCtx): TreeNodeItem[] {
    const tree = BUILD_ScriptTree(QUERY_TREE.items);
    const walk = (nodes: ReturnType<typeof BUILD_ScriptTree>, parentId: string, depth: number): TreeNodeItem[] =>
        nodes.map((n) => ({
            line: {
                nodeId: n.nodeId,
                parentId,
                depth,
                kind: n.kind as NodeKindValue,
                category: GET_CategoryOfNode(n.kind as NodeKindValue),
                label: n.isGroup ? SCRIPT_GROUP_LABEL : (NODE_KIND_LABELS[n.kind as NodeKindValue] ?? n.kind),
                desc: n.desc,
                hasChildren: n.children.length > 0,
                expanded: QUERY_TREE.expanded.has(n.nodeId),
                inExpandedTree: depth > 0,
                selected: QUERY_TREE.selectedId === n.nodeId,
                showsOpenButton: true,
            },
            children: walk(n.children, n.nodeId, depth + 1),
        }));
    return walk(tree, '', 0);
}

/**
 * 查询设计来源：左栏的查询脚本树被委托出去时，委托面板按这份描述渲染
 *
 * 行菜单从 rowMenuRegistry 取（视图挂载时登记），与左栏同一套；
 * 取不到（视图从未打开）则退回面板默认三项。
 */
export const QUERY_DELEGATE: DelegateSource = {
    owner: 'query',
    title: '查询脚本',
    childKind: NODE_KIND.QUERY,
    get expanded(): Set<string> {
        return QUERY_TREE.expanded;
    },
    getSelectedId: () => QUERY_TREE.selectedId,
    setSelectedId: (nodeId) => {
        QUERY_TREE.selectedId = nodeId;
    },
    markExpandedChanged: () => QUERY_TREE.markExpandedChanged(),
    subscribe: (cb) => QUERY_TREE.store.subscribe(cb),
    get rowMenu() {
        return GET_RowMenu('query');
    },
    buildItems: (ctx) => BUILD_QueryTreeItems(ctx),
    emptyText: () => (QUERY_TREE.items.length === 0 ? '暂无查询脚本' : undefined),
    release: () => {
        // 委托标记由登记处摘牌即复位；展开与选中保留（取消委托不丢位置）
    },
};

// 模块顶层注册：恢复上次委托时找得到查询设计来源
DELEGATE.register('query', () => QUERY_DELEGATE);
