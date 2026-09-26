/**
 * DelegateRegistry — 委托的全局登记处（互斥）
 *
 * 「委托」= 把某个视图左栏的树交给侧栏显示。同一时刻**只允许一份委托**：
 * 新的委托到来时，旧的委托先被释放（调用它的 release() → 来源视图复位委托标记、
 * 落点面板卸载），再登记新的。于是不会出现两份委托同时活着、两个面板抢同一份
 * 展开/选中，或旧面板停在来源已还原的状态上。
 *
 * 谁在读它：
 *   - FrameworkTreeShared：delegated 的读写转成本登记处的 acquire / release
 *   - 落点（中控台里那一节 / 独立视图 seqtk-delegated-tree）：订阅 store 决定渲染与否
 *   - DelegateTreeController：由 active 来源提供树、标题与行菜单
 *
 * 依赖方向是单向的：设计 / 模板的**来源实现** → 本模块。本模块只认下面这几个契约，
 * 不 import 任何具体视图（NodeEditHost 等一律 `import type`，运行时不留环）。
 */

import { SimpleStore } from '../../../P5_Data/Svelte/SimpleStore';
import type { App } from 'obsidian';
import type { ReactNode } from 'react';
import type { DataPipe } from '../../../P5_Data/CoPipe/DataPipe';
import type { PluginSettings } from '../../../P3_Settings/Settings';
import type { NodeKindValue } from '../../../P4_Nodes/NodeKind/NodeKind';
import type { NodeLineCtx } from '../../../P7_Render/Composition/C1_NodeLine/NodeLine';
import type { TreeNodeItem } from '../../../P7_Render/Composition/C2_Tree/NodeTree';
import type { LineOverlay } from '../../V1_Affair/Design/Tool/viewModel';
import type { NodeEditHost } from '../../V1_Affair/Design/Slice/actions';

/** 委托来源：设计 / 模板 / 线路 / 流程 / 查询 / 草稿各一份，全局互斥（同时只有一个被委托出去） */
export type DelegateOwner = 'design' | 'template' | 'route' | 'flow' | 'query' | 'draft';

/** 委托快照（落点据它决定「渲染谁的那一节」） */
export interface DelegateSnapshot {
    /** 当前被委托的来源；null = 没有委托 */
    owner: DelegateOwner | null;
    /** 变化计数（每次登记 / 释放递增；订阅方比它就知道是不是切换了） */
    version: number;
}

/**
 * 委托面板交给来源的能力（来源的菜单动作据此复用面板的就地编辑）
 *
 * 行内新建 / 重命名实现在 DelegateTreeController 里（与来源无关），
 * 来源只决定「菜单里有哪些项、各自的候选类型是什么」。
 */
export interface DelegateTreeHost {
    readonly app: App;
    readonly pipe: DataPipe;
    readonly settings: PluginSettings;
    /** 就地插一行「新建子节点」输入（类型由来源的 childKind 决定） */
    startCreateChild(ctx: NodeLineCtx): void;
    /** 就地插一行「新建根级节点」输入（面板空白处右键用；父级为空、层级 0） */
    startCreateRoot(): void;
    /** 进入行内重命名 */
    startRename(nodeId: string): void;
    /** 重算委托树 */
    recompute(): void;
    /** design/actions 的写操作宿主（归档、改名等复用同一套实现） */
    readonly editHost: NodeEditHost;
}

/** buildItems / emptyText 的入参：面板提供只读依赖，来源自己不持有它们 */
export interface DelegateTreeCtx {
    readonly pipe: DataPipe;
    readonly settings: PluginSettings;
    /** 行覆盖信息（正在行内重命名的行）；由面板提供 */
    readonly overlayFor: (nodeId: string) => LineOverlay;
}

/**
 * 自定义面板的宿主（非树来源用，如事务分发的月历）
 *
 * 依赖由落点给全，来源不持有它们 —— 来源视图关掉之后委托面板照样能用。
 */
export interface DelegatePanelHost {
    readonly app: App;
    readonly pipe: DataPipe;
    readonly settings: PluginSettings;
    /** 取消委托（释放登记处并收掉落点面板） */
    cancel(): void;
}

/**
 * 委托来源（每个来源一份单例实例）
 *
 * 状态（展开 / 选中）由来源持有 —— 委托面板与来源视图改的是同一份，
 * 因此两处天然一致，不需要同步代码。其余依赖一律由面板作为入参传入，
 * 来源便不持有 pipe / settings。
 */
export interface DelegateSource {
    readonly owner: DelegateOwner;
    /** 委托面板那一节的标题（「框架」/「模板框架」） */
    readonly title: string;
    /** 面板里就地新建子节点用的类型 */
    readonly childKind: NodeKindValue;
    /** 展开集合（与来源视图共用同一个实例） */
    readonly expanded: Set<string>;
    getSelectedId(): string | null;
    setSelectedId(nodeId: string): void;
    /** 展开集合被就地改动后广播：来源视图与委托面板各自重算 */
    markExpandedChanged(): void;
    /**
     * 来源状态的订阅通道：来源视图那边改了展开 / 选中，面板据此重算
     *
     * 面板只认来源，不去订阅具体视图的 store，因此通道由来源给出。
     */
    subscribe(cb: () => void): () => void;
    /** 待渲染的树 */
    buildItems(ctx: DelegateTreeCtx): TreeNodeItem[];
    /** 树为空时的文案 */
    emptyText(ctx: DelegateTreeCtx): string | undefined;
    /**
     * 自定义面板内容（非树左栏用：如事务分发的月历、查询编辑器）
     *
     * 给了它就整块替换落点的树渲染（标题与「取消委托」按钮仍由落点提供）。
     * 树来源不给；给它的来源 `buildItems` 返回空数组即可（接口保持必填，落点不必分叉判定）。
     */
    renderPanel?(host: DelegatePanelHost): ReactNode;
    /**
     * 来源视图的 viewType（面板里点「在右侧打开」时回到它）
     *
     * 由**视图**在自己的 onMounted 里赋值，而不是在这里写常量：本模块不该 import 各具体
     * 视图（会成环，见文件头的依赖方向说明），而视图自己当然知道自己是哪种类型。
     * 未赋值时该按钮只做选中、不跳转 —— 将来加一个来源而忘了赋值，退化成原来的行为，不会出错。
     */
    viewType?: string;
    /**
     * 行右键菜单：给了就整份由来源决定（如模板那四项），
     * 不给则用面板的默认三项（新建子节点 / 重命名 / 归档）
     */
    rowMenu?(host: DelegateTreeHost, ctx: NodeLineCtx, event: MouseEvent): void;
    /**
     * 空白处右键菜单：与来源视图左栏的空白菜单**同口径**
     *
     * 不给则用面板的默认两项（新建根级节点 + 从磁盘刷新）—— 现有两个来源
     * （设计 / 模板）的空白菜单正好就是这两项，所以都走默认；
     * 将来出现别的视图，若它的空白菜单不一样，在这里给一份即可。
     */
    blankMenu?(host: DelegateTreeHost, event: MouseEvent): void;
    /** 被抢占或取消时由来源自己执行的收尾（复位委托标记、写回设置…） */
    release(): void;
}

export class DelegateRegistry {
    /** 落点订阅它：owner 变化即渲染 / 卸载对应的一节 */
    readonly store = new SimpleStore<DelegateSnapshot>({ owner: null, version: 0 });

    private source: DelegateSource | null = null;
    /** 按来源注册的工厂：视图侧只报「我要委托哪个来源」时用 */
    private readonly factories = new Map<DelegateOwner, () => DelegateSource>();
    private version = 0;
    private _settled = false;
    /**
     * 「委托意图变了」的回调（装配层注册，用于把状态写回设置）
     *
     * **只在 delegate / release 上触发**，不在 acquire / NOTIFY 这类内部动作上触发。
     * 这一点是关键：若把落盘挂在 store 的订阅上，启动期那些内部触发会带着「active 还是 null」
     * 把刚从磁盘读进来的值当场冲掉 —— 曾经就这么踩过：读到 design，紧接着被写成 null，
     * 等 onReady 去恢复时已经晚了。
     */
    private onIntentChanged: (() => void) | null = null;

    /** 注册意图变化回调（装配层启动时注入一次） */
    SET_OnIntentChanged(cb: (() => void) | null): void {
        this.onIntentChanged = cb;
    }

    /** 视图构造时登记自己的来源工厂（同一来源重复登记覆盖） */
    register(owner: DelegateOwner, factory: () => DelegateSource): void {
        this.factories.set(owner, factory);
    }

    /** 当前被委托的来源；null = 没有委托 */
    get active(): DelegateSource | null {
        return this.source;
    }

    get owner(): DelegateOwner | null {
        return this.source?.owner ?? null;
    }

    /**
     * 「启动恢复」是否已经尘埃落定（本次会话里登记处至少变化过一次）
     *
     * 落点用它区分「上次的委托马上要接回」与「上次的委托已作废 / 已被取消」——
     * 只看 settings.delegatedOwner 分辨不出来：取消委托后设置里仍留着来源，
     * 那时若还按「将要委托」预留，中控台的面板目录就再也回不来了。
     */
    get settled(): boolean {
        return this._settled;
    }

    isDelegated(owner: DelegateOwner): boolean {
        return this.source?.owner === owner;
    }

    /**
     * 按已登记的工厂委托某来源
     *
     * 同一来源已处于委托时不换实例 —— 落点的订阅是按 owner 判定的，
     * 换了实例它不会重挂，面板就会一直拿着旧对象（见 Hub.renderDelegateSection）。
     */
    delegate(owner: DelegateOwner): DelegateSource | null {
        if (this.source?.owner === owner) return this.source;
        const factory = this.factories.get(owner);
        if (!factory) return null;
        this.acquire(factory());
        // 用户的委托意图变了（建立）→ 通知装配层写回设置（见 onIntentChanged）。
        // 放在 acquire 之后而非 acquire 内部：acquire 也被落点面板的内部逻辑调用，
        // 那不是用户的意图动作
        this.onIntentChanged?.();
        return this.source;
    }

    /** 以现成的来源实例进入委托（互斥：不同来源先释放旧的；同一来源幂等） */
    acquire(source: DelegateSource): void {
        if (this.source?.owner === source.owner) return;
        if (this.source) this.release();
        this.source = source;
        this.publish();
    }

    /**
     * 释放委托
     *
     * owner 缺省 = 释放当前持有者；给了 owner 且不匹配则不动 ——
     * 别的来源不该把不属于自己的委托放掉（如模板视图卸载时，设计视图正委托着）。
     */
    release(owner?: DelegateOwner): void {
        const cur = this.source;
        if (!cur) return;
        if (owner && cur.owner !== owner) return;
        // 先摘牌再让来源收尾：release() 内部若回看登记处，看到的应是「已无委托」
        this.source = null;
        cur.release();
        this.publish();
        // 用户的委托意图变了（取消）→ 通知装配层写回设置（见 onIntentChanged）
        this.onIntentChanged?.();
    }

    /**
     * 通知订阅者重算（**不**改委托本身）
     *
     * 用于「委托之外的输入变了」：落点在中控台时，它会先按 settings.delegatedOwner 预留出位置，
     * 免得启动瞬间闪一次面板目录（见 HubView.renderDelegateSection）；而启动结束若发现来源
     * 根本没接回来，这份预留就作废了 —— 那时调用本方法，落点重算一次才会把目录放回来。
     */
    NOTIFY(): void {
        this.publish();
    }

    private publish(): void {
        // 只要登记处动过（建立 / 释放 / 易主 / NOTIFY），「启动恢复」这一段就算结束：
        // 之后再问到 settled 都该是「已落定」，落点不必再预留位置
        this._settled = true;
        this.store.set({ owner: this.source?.owner ?? null, version: ++this.version });
    }
}

/** 插件进程内的唯一实例 */
export const DELEGATE = new DelegateRegistry();
