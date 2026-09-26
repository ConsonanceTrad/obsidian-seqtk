/**
 * DataPipe — 数据交换统一门面（按 kind 通道分流）
 *
 * 依赖注入 fileManager / cache / queue，向视图层提供唯一的读写入口：
 *
 * 写（EXEC_Mutation）：
 * - 缓存 kind（FRAMEWORK/AFFAIR/EVIDENCE）→ 快队列立即更新缓存（渲染基准）
 *   + 慢序列（OperationQueue.FileQueue 防抖）写回源文件
 * - 文件基准 kind（SCRIPT/RUNTIME）→ 不碰缓存，直接对源文件执行（防抖直写）
 *
 * 读/订阅：
 * - 缓存 kind → SUB_ActiveView 订阅活跃 store（或经 NodeCache 查询）
 * - 文件基准 kind → READ_FileView 直读文件（含正文）
 * - 弃置（归档）视图 → ARCHIVE_Refresh 全量更新 + SUB_ArchiveView 订阅
 *
 * 磁盘与缓存的对账（SYNC_FromFiles → VERIFY_WithDisk）为指纹驱动：
 * 由装配层在 onReady 阶段调用一次，指纹一致的文件不读取、不解析。
 *
 * 扩展点：create / route / Trash 归档移动等操作由对应操作口业务层
 * 先完成文件侧与缓存侧动作后接入（Mutation 见 ViewToCache.ts）。
 */

import type { NodeFileManager } from '../MdFile/NodeFileManager';
import type { NodeCache } from '../SQLite/Cache/NodeCache';
import type { RawQueryResult } from '../SQLite/Cache/SqliteCache';
import type { OperationQueue } from '../Queue/OperationQueue';
import type { Unsubscriber } from '../Svelte/SimpleStore';
import type { PluginSettings } from '../../P3_Settings/Settings';
import type { NodeKindValue, NodeRuntimeKindValue } from '../../P4_Nodes/NodeKind/NodeKind';
import type { SeqtkNode, NodeFile } from '../../P4_Nodes/Node';
import { GET_FileByPath } from '../MdFile/PathTools/PathParse';
import { LogStore } from '../Log/LogStore';
import { EVENTS } from '../../P1_Register/Event';
import type { FileChangeListener } from '../../P1_Register/Event';
import { IS_CacheKind } from './KindChannel';
import { COMPUTE_Propagation } from '../../P4_Nodes/NodeField/Propagation';
import type { SeqtkState } from '../../P4_Nodes/NodeField/StateKeys';
import { BUILD_CacheSide, type Mutation } from './Pipes/ViewToCache';
import { BUILD_FileSide } from './Pipes/CacheToFile';
import { READ_FileView } from './Pipes/FileToView';
import { SUB_ActiveView, SUB_ArchiveView } from './Pipes/CacheToView';
import { SYNC_CacheFromFiles } from './Pipes/FileToCache';

/** DataPipe 依赖 */
export interface DataPipeDeps {
    fileManager: NodeFileManager;
    cache: NodeCache;
    queue: OperationQueue;
    /** settings：供写回路径登记（自触发抑制）与 Queue 防抖参数 */
    settings: PluginSettings;
}

export class DataPipe {
    /** 日志写入编排（RUNTIME 日志节点按日聚合；文件基准通道，不进缓存） */
    private logStore: LogStore;

    constructor(private deps: DataPipeDeps) {
        this.logStore = new LogStore(deps.fileManager);
    }

    /**
     * 追加一条日志（RUNTIME_EDIT_LOG / RUNTIME_BEHAVE_LOG / RUNTIME_FLOW_LOG）
     *
     * 排队写入不等待落盘；审计流水不做业务拦截，失败仅记控制台。
     */
    LOG_Append(kind: NodeRuntimeKindValue, text: string): void {
        this.logStore.APPEND(kind, text);
    }

    /** 自身写回中的文件路径集合（vault 事件据此忽略，防回环） */
    private pendingPaths = new Set<string>();

    /** 视图写意图：按 kind 通道分流执行（缓存 kind 双队列 / 文件基准防抖直写） */
    EXEC_Mutation(m: Mutation): void {
        const fileSide = this.GUARD_FileSide(m, BUILD_FileSide(m));
        if (IS_CacheKind(m.kind)) {
            const cacheSide = BUILD_CacheSide(m);
            this.deps.queue.enqueue(
                () => cacheSide(this.deps.cache),
                () => fileSide(this.deps.fileManager),
            );
        } else {
            // 文件基准：不更新缓存，防抖直写源文件
            this.deps.queue.enqueueFileOp(() => fileSide(this.deps.fileManager));
        }
    }

    /**
     * 批量删除（级联删除的等价出口）
     *
     * 语义与逐条 EXEC_Mutation({op:'remove'}) 一致，但保持原先「一次批量缓存 + 一次批量文件」
     * 的队列语义（级联删除依赖该节奏，逐条排队会改变落盘时序）。
     */
    EXEC_RemoveMany(targets: { kind: NodeKindValue; nodeId: string }[]): void {
        this.deps.queue.enqueueCacheBatch(targets.map((t) => () => this.deps.cache.REMOVE_Node(t.nodeId)));
        this.deps.queue.enqueueFileBatch(
            targets.map((t) => async () => { await this.deps.fileManager.delete.DELETE_Node(t.kind, t.nodeId); }),
        );
    }

    /**
     * 级联删除子树（缓存侧**单次** REMOVE_NodeTree）
     *
     * 与 EXEC_RemoveMany 的区别：后者逐条 REMOVE_Node，只覆盖活跃库、且每条各刷一次快照。
     * 子树含**已归档后代**时不可用它（缓存会残留，回收视图仍显示已删节点），
     * 故模板单元的级联删除走本方法：一次清 active + archive 两库后代，且只触发一次快照刷新。
     * 文件侧仍按 targets 批量删除。
     */
    EXEC_RemoveTree(nodeId: string, targets: { kind: NodeKindValue; nodeId: string }[]): void {
        this.deps.queue.enqueueCacheBatch([() => this.deps.cache.REMOVE_NodeTree(nodeId)]);
        this.deps.queue.enqueueFileBatch(
            targets.map((t) => async () => { await this.deps.fileManager.delete.DELETE_Node(t.kind, t.nodeId); }),
        );
    }

    /**
     * 视图新建意图（独立异步入口，不与同步的 EXEC_Mutation 混用）
     *
     * 语义：文件侧先建（nodeId 由文件侧生成）→ 维护父节点 follows 双向 → 缓存侧 ADD_Node。
     * 文件必须先行的原因：nodeId 源自文件侧，且缓存以文件为准。
     * 展开状态与跳转等**视图态**不在此处理（由调用方按栏决定），本方法只负责数据面。
     */
    async EXEC_Create(input: {
        kind: NodeKindValue;
        /** 完整的节点数据（与文件侧落盘内容一致） */
        data: SeqtkNode;
        body?: string;
        /** 父节点 id：非空时把新节点追加进父的 follows（缓存立即 + 文件慢序列） */
        parentId?: string;
    }): Promise<string> {
        const body = input.body ?? '';
        const nodeId = await this.deps.fileManager.write.CREATE_Node(input.kind, input.data, body);

        if (input.parentId) {
            const parentId = input.parentId;
            const parent = this.deps.cache.GET_Node(parentId);
            if (parent) {
                const follows = [...(parent.follows ?? []), nodeId];
                this.deps.queue.enqueue(
                    () => this.deps.cache.UPDATE_Node(parentId, { follows }),
                    async () => { await this.deps.fileManager.update.UPDATE_Node(parent.kind, parentId, { follows }); },
                );
            }
        }

        this.deps.queue.enqueueCacheOp(() => this.deps.cache.ADD_Node(nodeId, input.data, body));
        return nodeId;
    }

    /**
     * 包裹文件侧闭包：写回期间登记目标路径（供 Event 自触发抑制），
     * 写回完成（含失败）后移除登记。
     */
    private GUARD_FileSide(
        m: Mutation,
        run: (file: NodeFileManager) => Promise<void>,
    ): (file: NodeFileManager) => Promise<void> {
        return async (file) => {
            const path = GET_FileByPath(m.kind, m.nodeId, this.deps.settings);
            this.pendingPaths.add(path);
            let ok = false;
            try {
                await run(file);
                ok = true;
            } finally {
                this.pendingPaths.delete(path);
                // 文件基准节点（脚本 / 日志）：自触发事件被抑制，订阅者收不到自己的写 ——
                // 写回成功后补发一次广播，列表快照靠它刷新（归档 / 删除后不刷新的根因）
                if (ok && !IS_CacheKind(m.kind)) {
                    EVENTS.NOTIFY_FileChange(m.kind, m.nodeId, m.op === 'remove' ? 'delete' : 'modify');
                }
            }
        };
    }

    /** 指定路径是否处于本 Pipe 写回中（Event 据此忽略自触发事件） */
    IS_Pending(filePath: string): boolean {
        return this.pendingPaths.has(filePath);
    }

    /** 订阅活跃缓存快照（编辑视图渲染基准） */
    SUB_ActiveView(cb: (map: Map<string, SeqtkNode>) => void): Unsubscriber {
        return SUB_ActiveView(this.deps.cache, cb);
    }

    /** 订阅弃置缓存快照（归档节点，回收视图基准） */
    SUB_ArchiveView(cb: (map: Map<string, SeqtkNode>) => void): Unsubscriber {
        return SUB_ArchiveView(this.deps.cache, cb);
    }

    /** 按 nodeId 查活跃缓存节点（文件基准类请用 READ_FileView；弃置类请用 GET_NodeArchive） */
    GET_Node(nodeId: string): SeqtkNode | undefined {
        return this.deps.cache.GET_Node(nodeId);
    }

    /**
     * 状态变更 + 传播编排（状态传播规则的第一个真实执行端）
     *
     * 把 nodeId 的状态改为 state，随后按 `settings.stateRules` 计算传播
     * （`COMPUTE_Propagation` 是纯函数，上下文在此从缓存取齐），一并写入被波及的
     * 后代 / 祖先。本体与传播变更都走 `EXEC_Mutation` 同一条写意图，缓存 + 文件两侧一致。
     */
    EXEC_StateChange(nodeId: string, state: SeqtkState): void {
        const node = this.deps.cache.GET_Node(nodeId);
        if (!node) return;

        // 祖先链（由近及远；多归属取全，防环用 seen）
        const ancestors: { nodeId: string; state: SeqtkState }[] = [];
        const seen = new Set<string>([nodeId]);
        let frontier = this.deps.cache.GET_Parents(nodeId);
        while (frontier.length > 0) {
            const next: string[] = [];
            for (const pid of frontier) {
                if (seen.has(pid)) continue;
                seen.add(pid);
                const p = this.deps.cache.GET_Node(pid);
                if (!p) continue;
                ancestors.push({ nodeId: pid, state: (p.state ?? 'plan') as SeqtkState });
                next.push(...this.deps.cache.GET_Parents(pid));
            }
            frontier = next;
        }

        // 后代（扁平，排除自身）
        const descendants = this.deps.cache.COLLECT_Descendants(nodeId)
            .filter((d) => d.nodeId !== nodeId)
            .map((d) => ({ nodeId: d.nodeId, state: (d.data.state ?? 'plan') as SeqtkState }));

        const changes = COMPUTE_Propagation(this.deps.settings.stateRules, {
            nodeId,
            state,
            ancestors,
            descendants,
            childrenOf: (pid) =>
                this.deps.cache.GET_Children(pid).map((c) => ({
                    nodeId: c.nodeId,
                    state: ((c.data as SeqtkNode | undefined)?.state ?? 'plan') as SeqtkState,
                })),
        });

        this.EXEC_Mutation({ op: 'update', kind: node.kind, nodeId, updates: { state } });
        for (const ch of changes) {
            const target = this.deps.cache.GET_Node(ch.nodeId);
            if (!target) continue;
            this.EXEC_Mutation({ op: 'update', kind: target.kind, nodeId: ch.nodeId, updates: { state: ch.state } });
        }
    }

    /** 按 nodeId 查弃置缓存节点（archive 未就绪返回 undefined） */
    GET_NodeArchive(nodeId: string): SeqtkNode | undefined {
        return this.deps.cache.GET_NodeArchive(nodeId);
    }

    /** 弃置节点全列表（回收视图数据源；archive 未就绪返回空） */
    GET_AllNodesArchive(): { nodeId: string; data: SeqtkNode }[] {
        return this.deps.cache.GET_AllNodesArchive();
    }

    // ============================================================
    // 查询门面（视图读取缓存节点的唯一入口；按实测被使用的集合补齐）
    // ============================================================

    /** 活跃缓存全量快照（白板类视图一次性收集数据；等价于原先直接读 activeStore.get()） */
    GET_ActiveView(): Map<string, SeqtkNode> {
        return this.deps.cache.activeStore.get();
    }

    /** 按类型取活跃节点 */
    GET_ByKind(kind: NodeKindValue): { nodeId: string; data: SeqtkNode }[] {
        return this.deps.cache.GET_ByKind(kind);
    }

    /** 取直接子节点（含 kind / data，视图可直接渲染） */
    GET_Children(parentNodeId: string): { kind?: NodeKindValue; nodeId: string; data?: SeqtkNode }[] {
        return this.deps.cache.GET_Children(parentNodeId);
    }

    /** 取父节点（顶级节点返回 null；树构建用）。多归属时给的是第一个，要全部用 GET_Parents */
    GET_Parent(nodeId: string): { nodeId: string; data: SeqtkNode } | null {
        return this.deps.cache.GET_Parent(nodeId);
    }

    /**
     * 取全部上级（follows 入边）—— 多归属下一个节点可以同时挂在多个父之下
     *
     * 归属只由父侧的 follows 记录，所以这里是反查；顶部节点返回空数组。
     */
    GET_Parents(nodeId: string): string[] {
        return this.deps.cache.GET_Parents(nodeId);
    }

    /** 取节点正文（缓存 kind） */
    GET_NodeBody(nodeId: string): string {
        return this.deps.cache.GET_NodeBody(nodeId);
    }

    /** 关键词检索（标题 / 正文） */
    SEARCH_Nodes(query: string, limit = 100): { nodeId: string; data: SeqtkNode }[] {
        return this.deps.cache.SEARCH_Nodes(query, limit);
    }

    /**
     * 跑一条只读 SQL（查询设计）
     *
     * 语句需以 `SELECT` / `WITH` 开头，否则抛错 —— 写操作会绕过 MD 事实源，
     * 详见 SqliteCache.QUERY_Raw 的说明。
     */
    QUERY_Sql(sql: string, params: unknown[] = [], limit = 500): RawQueryResult {
        return this.deps.cache.QUERY_Sql(sql, params, limit);
    }

    /** SQL 语法检查（试编译不执行）：null = 通过，否则是错误原文 */
    CHECK_Sql(sql: string): string | null {
        return this.deps.cache.CHECK_Sql(sql);
    }

    // ---- 文件基准节点的读写（SCRIPT / RUNTIME 通道） ----

    /**
     * 扫描指定 kind 的节点文件（读盘 + 解析，**异步**）
     *
     * 文件基准 kind（脚本 / 日志）**不进活跃缓存**，取它们只有这一条路：
     * 用 `GET_ByKind` 会得到空数组，而那个空看起来跟「一个都没有」一模一样 ——
     * 这正是流程设计左栏列不出脚本、保存静默失败的原因。
     *
     * 只返回**活跃**节点（`open !== false`）：归档（open: false）的不进列表 ——
     * 归档后不消失的话，界面刷新了也看不出变化。
     */
    async SCAN_Files(kinds: NodeKindValue[]): Promise<NodeFile[]> {
        const all = await this.deps.fileManager.scan.SCAN_ByKinds(kinds);
        return all.filter((f) => f.data.open !== false);
    }

    /**
     * 订阅文件基准 kind（脚本 / 日志）的文件变化
     *
     * 文件基准视图靠它重拉列表；写回自身的自触发抑制已在事件源做过（IS_Pending），
     * 所以这里不必再过滤一遍。
     */
    SUB_FileChange(cb: FileChangeListener): Unsubscriber {
        return EVENTS.SUB_FileChange(cb);
    }

    /** 收集子孙节点（扁平，含自身） */
    COLLECT_Descendants(rootNodeId: string): { nodeId: string; kind: NodeKindValue; data: SeqtkNode }[] {
        return this.deps.cache.COLLECT_Descendants(rootNodeId);
    }

    /** 收集弃置后代（扁平，回收模式级联彻底删除用；archive 未就绪返回空） */
    COLLECT_DescendantsArchive(rootNodeId: string): { nodeId: string; kind: NodeKindValue; data: SeqtkNode }[] {
        return this.deps.cache.COLLECT_DescendantsArchive(rootNodeId);
    }

    /** 出边：本节点指向的目标（route 视图） */
    GET_RouteOutgoing(nodeId: string): { nodeId: string; desc?: string; data?: SeqtkNode }[] {
        return this.deps.cache.GET_RouteOutgoing(nodeId);
    }

    /** 入边：指向本节点的来源（route 视图） */
    GET_RouteIncoming(nodeId: string): { nodeId: string; desc?: string; data?: SeqtkNode }[] {
        return this.deps.cache.GET_RouteIncoming(nodeId);
    }

    // ---- 守卫：视图的空态与初始化判断 ----

    /** 缓存已有可用数据（加载成功或对账完成） */
    get isInitialized(): boolean {
        return this.deps.cache.isInitialized;
    }

    /** 已与磁盘对账完成（写入闸门打开） */
    get isVerified(): boolean {
        return this.deps.cache.isVerified;
    }

    /** 弃置缓存是否就绪（回收视图可用性） */
    get archiveReady(): boolean {
        return this.deps.cache.archiveReady;
    }

    /** 活跃缓存节点数 */
    get size(): number {
        return this.deps.cache.size;
    }

    /** 弃置缓存节点数 */
    get archiveSize(): number {
        return this.deps.cache.archiveSize;
    }

    // ============================================================
    // 插件数据目录文件（布局缓存等：视图不再直接触碰 vault.adapter）
    // ============================================================

    /** 读插件数据目录下的文本文件（不存在或失败返回 null） */
    async READ_DataFile(name: string): Promise<string | null> {
        const path = `${this.deps.fileManager.rootFolder}/${name}`;
        const adapter = this.deps.fileManager.adapter;
        try {
            if (!(await adapter.exists(path))) return null;
            return await adapter.read(path);
        } catch {
            return null;
        }
    }

    /** 写插件数据目录下的文本文件（目录缺失时先建，失败抛错由调用方决定是否忽略） */
    async WRITE_DataFile(name: string, content: string): Promise<void> {
        const path = `${this.deps.fileManager.rootFolder}/${name}`;
        const adapter = this.deps.fileManager.adapter;
        if (await adapter.exists(path)) {
            await adapter.write(path, content);
            return;
        }
        await this.deps.fileManager.ENSURE_RootFolder();
        await adapter.write(path, content);
    }

    /** 文件基准直读（脚本/日志，含正文） */
    READ_FileView(kind: NodeKindValue, nodeId: string): Promise<NodeFile | null> {
        return READ_FileView(this.deps.fileManager, kind, nodeId);
    }

    /** 弃置缓存全量更新（回收视图打开时调用一次） */
    ARCHIVE_Refresh(): Promise<void> {
        return this.deps.cache.ARCHIVE_Refresh(this.deps.fileManager);
    }

    /** 一致性校验：磁盘与缓存对账（指纹驱动，差异才读取解析） */
    SYNC_FromFiles(): Promise<boolean> {
        return SYNC_CacheFromFiles(this.deps.cache, this.deps.fileManager);
    }

    /** 卸载/退出前冲刷慢序列（确保文件全部落盘） */
    FLUSH(): Promise<void> {
        return this.deps.queue.flush();
    }
}
