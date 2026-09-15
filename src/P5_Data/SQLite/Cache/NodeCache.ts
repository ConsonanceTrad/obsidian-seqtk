/**
 * NodeCache — 双层查询缓存（活跃缓存 / 弃置缓存）+ 响应式 store
 *
 * 缓存分层（生命周期不同）：
 * - activeCache（活跃缓存）：仅包含 open: true 的未归档节点，编辑/查询视图的渲染基准。
 * - archiveCache（弃置缓存）：仅包含 open: false 的归档节点，
 *   仅供回收视图；不随启动创建/校验，只在打开回收视图时经 ARCHIVE_Refresh
 *   做一次全量更新（平时只读）。
 *
 * 启动流程（两段式，装配见 P1_Register/Data.ts）：
 * - onload：INIT_Sql + LOAD_ActiveDb（读持久化字节 → 立即可读，但**未对账**）
 * - onReady：VERIFY_WithDisk（指纹对账 + 差异扫描）→ MARK_Verified（开闸）
 *
 * 校验状态（两个独立标志）：
 * - isInitialized：缓存已有可用数据（加载成功 或 对账完成）
 * - isVerified：已与磁盘对账完成，写入闸门打开
 * 组合：加载成功 = true/false；冷启动 = false/false；对账完成 = true/true
 *
 * 职责：
 * - 指纹驱动的磁盘对账（VERIFY_WithDisk）：指纹一致的文件不读取、不解析
 * - 归档动作（置 open: false）只写文件并从 active 移除，不写 archive
 * - 关系查询、按类型/状态查询、模糊搜索走 SQLite（active）
 * - route 线路关联独立于 frontmatter：写时双库同步（archive 就绪时），
 *   查询以 archive（含全部）为准
 * - archive 全量更新由 ARCHIVE_Refresh 提供（回收视图打开时调用）
 *
 * 与 MD 文件的关系（参见 doc/数据定义与持久化/关联缓存.md）：
 * - MD 文件是事实来源
 * - 数据库仅做查询加速，可从 MD 全量重建
 *
 * 命名：方法统一「全大写操作_行为」（store/字段保持小写）。
 */

import { SimpleStore } from '../../Svelte/SimpleStore';
import type { SeqtkNode } from '../../../P4_Nodes/Node';
import type { NodeKindValue } from '../../../P4_Nodes/NodeKind/NodeKind';
import type { SeqtkState } from '../../../P4_Nodes/NodeField/StateKeys';
import { GET_CacheKinds } from '../../CoPipe/KindChannel';
import { IS_SameFingerprint } from '../../FileFingerprint';
import { SqliteCache } from './SqliteCache';
import type { NodeFileManager } from '../../MdFile/NodeFileManager';

/** 树形节点 — 供后续操作口使用 */
export interface TreeNode {
  nodeId: string;
  data: SeqtkNode;
  children: TreeNode[];
  depth: number;
  expanded: boolean;
}

export class NodeCache {
  /** 活跃缓存：仅 open: true 的未归档节点（编辑视图渲染基准） */
  private activeCache: SqliteCache;
  /** 弃置缓存：仅 open: false 的归档节点（仅供回收视图；懒建 + 打开时全量更新） */
  private archiveCache: SqliteCache;

  /** wasm 字节缓存：active 启动初始化时存入，供 archive 首次使用时懒初始化 */
  private wasmBinary: ArrayBuffer | null = null;

  /** active 缓存是否已有可用数据（加载成功 或 对账完成） */
  private _initialized = false;

  /** 是否已与磁盘对账完成（写入闸门开关） */
  private _verified = false;

  /** SimpleStore：活跃缓存节点快照（nodeId → SeqtkNode） */
  readonly activeStore: SimpleStore<Map<string, SeqtkNode>> = new SimpleStore(new Map());

  /** SimpleStore：弃置缓存节点快照（含归档，回收视图订阅） */
  readonly archiveStore: SimpleStore<Map<string, SeqtkNode>> = new SimpleStore(new Map());

  constructor(activeCache?: SqliteCache, archiveCache?: SqliteCache) {
    this.activeCache = activeCache ?? new SqliteCache();
    this.archiveCache = archiveCache ?? new SqliteCache();
  }

  /** active 缓存是否已有可用数据 */
  get isInitialized(): boolean {
    return this._initialized;
  }

  /** 是否已与磁盘对账完成（对账前写入被闸门拒绝） */
  get isVerified(): boolean {
    return this._verified;
  }

  /** archive 是否已就绪（首次 ARCHIVE_Refresh 后为 true） */
  get archiveReady(): boolean {
    return this.archiveCache.isReady;
  }

  /** 活跃缓存访问（编辑视图默认数据源） */
  get db(): SqliteCache {
    return this.activeCache;
  }

  /** 弃置缓存访问（回收视图；仅 archiveReady 后可用） */
  get archiveDb(): SqliteCache {
    return this.archiveCache;
  }

  /** 活跃缓存节点总数（未归档） */
  get size(): number {
    return this.activeCache.GET_Count();
  }

  /** 弃置缓存节点总数（归档；archive 未就绪时为 0） */
  get archiveSize(): number {
    return this.archiveReady ? this.archiveCache.GET_Count() : 0;
  }

  // ============================================================
  // 初始化
  // ============================================================

  /**
   * 初始化 sql.js 运行时（仅 active；wasm 字节缓存在实例上，
   * 供 archive 首次 ARCHIVE_Refresh 时懒初始化）
   */
  async INIT_Sql(wasmBinary?: ArrayBuffer): Promise<void> {
    if (wasmBinary) this.wasmBinary = wasmBinary;
    if (this.activeCache.isReady) return;
    await this.activeCache.INIT_Sql(this.wasmBinary ?? undefined);
  }

  /** archive 懒初始化（幂等；wasm 字节来自启动时的缓存） */
  private async ENSURE_Archive(): Promise<void> {
    if (this.archiveCache.isReady) return;
    await this.archiveCache.INIT_Sql(this.wasmBinary ?? undefined);
  }

  /**
   * 从持久化字节恢复活跃缓存 — onload 阶段调用
   *
   * 加载成功后缓存立即可读（视图秒开），但**尚未与磁盘对账**：写入闸门保持
   * 关闭，直到 VERIFY_WithDisk + MARK_Verified。字节不可用时抛出，由调用方
   * 降级（保持空库，交给 onReady 的全量对账填充）。
   */
  LOAD_ActiveDb(bytes: Uint8Array): void {
    this.activeCache.LOAD_Db(bytes);
    this._initialized = true;
    this._verified = false;
    this.REFRESH_Active();
  }

  /** 标记「已与磁盘对账完成」——打开写入闸门 */
  MARK_Verified(): void {
    this._verified = true;
  }

  /**
   * 重置活跃缓存 — 手动「重建查询缓存」用
   *
   * 清空内存库并关闭写入闸门，随后必须调用 VERIFY_WithDisk 全量重灌：
   * 库已空 → 所有文件指纹均为「未知」→ 逐个重读，等价于冷启动重建。
   */
  RESET_Active(): void {
    const ids = this.activeCache.GET_AllNodes().map((i) => i.nodeId);
    this.activeCache.WITH_Transaction(() => {
      for (const id of ids) {
        this.activeCache.REMOVE_Node(id);
      }
    });
    this._initialized = false;
    this._verified = false;
    this.REFRESH_Active();
  }

  /** 导出活跃缓存字节（用于持久化） */
  EXPORT_ActiveDb(): Uint8Array {
    return this.activeCache.EXPORT_Db();
  }

  /** 导出弃置缓存字节（用于持久化；archive 未就绪时抛出明确错误） */
  EXPORT_ArchiveDb(): Uint8Array {
    if (!this.archiveCache.isReady) {
      throw new Error('[SeqTK] NodeCache.EXPORT_ArchiveDb: archive cache not initialized');
    }
    return this.archiveCache.EXPORT_Db();
  }

  /**
   * 写入闸门 — 对账完成前拒绝一切外部写入
   *
   * 加载持久化缓存后缓存已可读，但可能落后于磁盘；若此时放行写入，会出现
   * 「用落后快照的字段覆盖磁盘上的外部改动」。故对账完成前拒绝写入。
   *
   * 注意：内部对账流程（VERIFY_WithDisk / ARCHIVE_Refresh）直接操作
   * SqliteCache 层，不经过此闸门，因此不会自锁。
   */
  private ASSERT_Writable(): void {
    if (!this._verified) {
      throw new Error('[SeqTK] 缓存校验尚未完成，写操作已暂缓，请稍候重试');
    }
  }

  /**
   * 弃置缓存全量更新 — 打开回收视图时调用一次
   *
   * 扫描缓存 kind 的归档节点（open: false），清空并重灌 archiveCache，
   * 完成后刷新 archiveStore。启动与平时不触发。
   */
  async ARCHIVE_Refresh(fileManager: NodeFileManager): Promise<void> {
    await this.ENSURE_Archive();

    const nodeFiles = await fileManager.scan.SCAN_ByKinds(GET_CacheKinds());
    const archived = nodeFiles.filter((nf) => nf.data.open === false);
    const existingIds = this.archiveCache.GET_AllNodes().map((i) => i.nodeId);

    this.archiveCache.WITH_Transaction(() => {
      for (const id of existingIds) {
        this.archiveCache.REMOVE_Node(id);
      }
      for (const nf of archived) {
        this.archiveCache.UPSERT_Node(nf.nodeId, nf.data, nf.body);
      }
    });

    this.REFRESH_Archive();
  }

  /** 从 activeCache 构建响应式快照 */
  private REFRESH_Active(): void {
    const snapshot = new Map<string, SeqtkNode>();
    for (const item of this.activeCache.GET_AllNodes()) {
      snapshot.set(item.nodeId, item.data);
    }
    this.activeStore.set(snapshot);
  }

  /** 从 archiveCache 构建响应式快照（archive 就绪时） */
  private REFRESH_Archive(): void {
    if (!this.archiveCache.isReady) return;
    const snapshot = new Map<string, SeqtkNode>();
    for (const item of this.archiveCache.GET_AllNodes()) {
      snapshot.set(item.nodeId, item.data);
    }
    this.archiveStore.set(snapshot);
  }

  // ============================================================
  // 读取操作（默认活跃缓存；弃置版本以 Archive 后缀提供）
  // ============================================================

  /** 按 nodeId 精确查找节点（活跃缓存，仅未归档） */
  GET_Node(nodeId: string): SeqtkNode | undefined {
    return this.activeCache.GET_Node(nodeId) ?? undefined;
  }

  /** 按 nodeId 精确查找节点（弃置缓存，含归档；未就绪返回 undefined） */
  GET_NodeArchive(nodeId: string): SeqtkNode | undefined {
    if (!this.archiveCache.isReady) return undefined;
    return this.archiveCache.GET_Node(nodeId) ?? undefined;
  }

  /** 按 nodeId 查找节点类型（活跃缓存） */
  GET_NodeKind(nodeId: string): NodeKindValue | undefined {
    return this.activeCache.GET_Node(nodeId)?.kind;
  }

  /** 获取某类型的所有节点（活跃缓存） */
  GET_ByKind(kind: NodeKindValue): { nodeId: string; data: SeqtkNode }[] {
    return this.activeCache.GET_ByKind(kind).map((item) => ({ nodeId: item.nodeId, data: item.data }));
  }

  /** 获取某类型的所有节点（弃置缓存，含归档；未就绪返回空） */
  GET_ByKindArchive(kind: NodeKindValue): { nodeId: string; data: SeqtkNode }[] {
    if (!this.archiveCache.isReady) return [];
    return this.archiveCache.GET_ByKind(kind).map((item) => ({ nodeId: item.nodeId, data: item.data }));
  }

  /** 获取某过程状态的所有节点（活跃缓存） */
  GET_ByState(state: SeqtkState): { nodeId: string; data: SeqtkNode }[] {
    return this.activeCache.GET_ByState(state).map((item) => ({ nodeId: item.nodeId, data: item.data }));
  }

  /** 获取某启用状态的所有节点（活跃缓存） */
  GET_ByOpen(open: boolean): { nodeId: string; data: SeqtkNode }[] {
    return this.activeCache.GET_ByOpen(open).map((item) => ({ nodeId: item.nodeId, data: item.data }));
  }

  /** 弃置节点全列表（回收视图数据源；未就绪返回空） */
  GET_AllNodesArchive(): { nodeId: string; data: SeqtkNode }[] {
    if (!this.archiveCache.isReady) return [];
    return this.archiveCache.GET_AllNodes().map((item) => ({ nodeId: item.nodeId, data: item.data }));
  }

  /**
   * 模糊搜索节点（匹配 desc / tags / body，活跃缓存）
   */
  SEARCH_Nodes(query: string, limit = 100): { nodeId: string; data: SeqtkNode }[] {
    return this.activeCache.SEARCH_Nodes(query, limit).map((item) => ({ nodeId: item.nodeId, data: item.data }));
  }

  // ============================================================
  // Body（正文/描述）操作
  // ============================================================

  /** 获取节点正文（活跃缓存） */
  GET_NodeBody(nodeId: string): string {
    return this.activeCache.GET_Body(nodeId);
  }

  /** 获取节点正文（弃置缓存；未就绪返回空串） */
  GET_NodeBodyArchive(nodeId: string): string {
    if (!this.archiveCache.isReady) return '';
    return this.archiveCache.GET_Body(nodeId);
  }

  /** 设置节点正文缓存（仅活跃缓存；归档正文不随弃置缓存维护） */
  SET_NodeBody(nodeId: string, body: string): void {
    this.ASSERT_Writable();
    this.activeCache.SET_Body(nodeId, body);
  }

  // ============================================================
  // 关系查询（默认活跃缓存）
  // ============================================================

  /**
   * 获取某个父节点的所有直接子节点（follows 出边，活跃缓存）
   */
  GET_Children(parentNodeId: string): { kind?: NodeKindValue; nodeId: string; data?: SeqtkNode }[] {
    const result: { kind?: NodeKindValue; nodeId: string; data?: SeqtkNode }[] = [];
    for (const childId of this.activeCache.GET_Children(parentNodeId)) {
      const data = this.activeCache.GET_Node(childId);
      if (data) {
        result.push({ kind: data.kind, nodeId: childId, data });
      }
    }
    return result;
  }

  /** 获取节点的有向直属上级（parent 出边，活跃缓存） */
  GET_Parent(nodeId: string): { nodeId: string; data: SeqtkNode } | null {
    const parentId = this.activeCache.GET_Parent(nodeId);
    if (!parentId) return null;
    const data = this.activeCache.GET_Node(parentId);
    return data ? { nodeId: parentId, data } : null;
  }

  /** 获取节点的无向关联节点（links 出边，活跃缓存） */
  GET_Linked(nodeId: string): { nodeId: string; data: SeqtkNode }[] {
    const result: { nodeId: string; data: SeqtkNode }[] = [];
    for (const linkId of this.activeCache.GET_Links(nodeId)) {
      const data = this.activeCache.GET_Node(linkId);
      if (data) result.push({ nodeId: linkId, data });
    }
    return result;
  }

  /** 获取节点的标记插入（progress 出边，活跃缓存） */
  GET_ProgressOf(nodeId: string): { nodeId: string; data: SeqtkNode }[] {
    const result: { nodeId: string; data: SeqtkNode }[] = [];
    for (const markId of this.activeCache.GET_ProgressOf(nodeId)) {
      const data = this.activeCache.GET_Node(markId);
      if (data) result.push({ nodeId: markId, data });
    }
    return result;
  }

  /**
   * 递归收集指定节点的所有后代（深度优先，不含自身，活跃缓存）
   */
  COLLECT_Descendants(rootNodeId: string): { nodeId: string; kind: NodeKindValue; data: SeqtkNode }[] {
    const result: { nodeId: string; kind: NodeKindValue; data: SeqtkNode }[] = [];
    const traverse = (nodeId: string) => {
      for (const child of this.GET_Children(nodeId)) {
        if (!child.data) continue;
        result.push({ nodeId: child.nodeId, kind: child.data.kind, data: child.data });
        traverse(child.nodeId);
      }
    };
    traverse(rootNodeId);
    return result;
  }

  /**
   * 递归收集指定节点的所有后代（弃置缓存，含归档；未就绪返回空）
   */
  COLLECT_DescendantsArchive(rootNodeId: string): { nodeId: string; kind: NodeKindValue; data: SeqtkNode }[] {
    if (!this.archiveCache.isReady) return [];
    const result: { nodeId: string; kind: NodeKindValue; data: SeqtkNode }[] = [];
    const traverse = (nodeId: string) => {
      for (const childId of this.archiveCache.GET_Children(nodeId)) {
        const data = this.archiveCache.GET_Node(childId);
        if (!data) continue;
        result.push({ nodeId: childId, kind: data.kind, data });
        traverse(childId);
      }
    };
    traverse(rootNodeId);
    return result;
  }

  /** 沿 parent 链向上追溯，获取完整的祖先链（活跃缓存） */
  GET_ParentChain(nodeId: string): { nodeId: string; data: SeqtkNode }[] {
    const chain: { nodeId: string; data: SeqtkNode }[] = [];
    const visited = new Set<string>();
    let currentId = nodeId;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const parent = this.GET_Parent(currentId);
      if (!parent) break;
      chain.push(parent);
      currentId = parent.nodeId;
    }

    return chain;
  }

  /** 沿 follows 边做环状引用检测（活跃缓存） */
  DETECT_Cycle(nodeId: string): string[] | null {
    return this.activeCache.DETECT_Cycle(nodeId);
  }

  // ============================================================
  // 线路关联（route，From/To + 描述，独立于节点 frontmatter）
  // ============================================================

  /**
   * 建立/更新 route 线路关联（双库同步；archive 未就绪时仅写 active，
   * 下次 ARCHIVE_Refresh 以磁盘数据重灌时不携带 route——route 属内存增强信息，
   * 若需长期保存由上层负责持久化）
   */
  ADD_Route(fromId: string, toId: string, description: string): void {
    this.ASSERT_Writable();
    this.activeCache.ADD_Route(fromId, toId, description);
    if (this.archiveCache.isReady) {
      this.archiveCache.ADD_Route(fromId, toId, description);
    }
  }

  /** 移除 route 线路关联 */
  REMOVE_Route(fromId: string, toId: string): void {
    this.ASSERT_Writable();
    this.activeCache.REMOVE_Route(fromId, toId);
    if (this.archiveCache.isReady) {
      this.archiveCache.REMOVE_Route(fromId, toId);
    }
  }

  /** route 查询基准：archive 就绪时以其为准（含全部节点的路线边），否则回退 active */
  private routeBase(): SqliteCache {
    return this.archiveCache.isReady ? this.archiveCache : this.activeCache;
  }

  /** 节点的 route 出边（From = 该节点） */
  GET_RouteOutgoing(nodeId: string): { nodeId: string; desc?: string; data?: SeqtkNode }[] {
    const base = this.routeBase();
    return base.GET_RouteOutgoing(nodeId).map((r) => ({
      nodeId: r.nodeId,
      desc: r.description,
      data: base.GET_Node(r.nodeId) ?? undefined,
    }));
  }

  /** 节点的 route 入边（To = 该节点） */
  GET_RouteIncoming(nodeId: string): { nodeId: string; desc?: string; data?: SeqtkNode }[] {
    const base = this.routeBase();
    return base.GET_RouteIncoming(nodeId).map((r) => ({
      nodeId: r.nodeId,
      desc: r.description,
      data: base.GET_Node(r.nodeId) ?? undefined,
    }));
  }

  // ============================================================
  // 写入操作
  // ============================================================

  /**
   * 添加节点到活跃缓存（仅维护 active）
   *
   * open: true → 写入 active；open: false（归档）→ 仅从 active 移除，
   * 不写 archive（归档内容由 ARCHIVE_Refresh 在打开回收视图时统一提供）。
   */
  ADD_Node(nodeId: string, data: SeqtkNode, body = ''): void {
    this.ASSERT_Writable();
    if (data.open !== false) {
      this.activeCache.UPSERT_Node(nodeId, data, body);
    } else {
      this.activeCache.REMOVE_Node(nodeId);
    }
    this.REFRESH_Active();
  }

  /**
   * 更新活跃缓存中的节点数据（部分更新）
   *
   * 归档节点不可在缓存中更新（回收视图操作走还原/删除流程）；
   * 更新后 open: false 时从 active 移除（不写 archive）。
   */
  UPDATE_Node(nodeId: string, updates: Partial<SeqtkNode>): void {
    this.ASSERT_Writable();
    const existing = this.activeCache.GET_Node(nodeId);
    if (!existing) return;

    const updated = { ...existing, ...updates } as SeqtkNode;
    const body = this.activeCache.GET_Body(nodeId);

    if (updated.open !== false) {
      this.activeCache.UPSERT_Node(nodeId, updated, body);
    } else {
      this.activeCache.REMOVE_Node(nodeId);
    }
    this.REFRESH_Active();
  }

  /** 从缓存中移除单个节点（active 必删；archive 就绪时一并删除防残留） */
  REMOVE_Node(nodeId: string): void {
    this.ASSERT_Writable();
    this.activeCache.REMOVE_Node(nodeId);
    if (this.archiveCache.isReady) {
      this.archiveCache.REMOVE_Node(nodeId);
      this.REFRESH_Archive();
    }
    this.REFRESH_Active();
  }

  /**
   * 从缓存中移除整个子树（级联删除，两库同步）
   *
   * 子树收集：active + archive（就绪时，含归档后代），确保完整删除。
   */
  REMOVE_NodeTree(rootNodeId: string): string[] {
    this.ASSERT_Writable();
    const removedIds = new Set<string>();
    for (const d of this.COLLECT_Descendants(rootNodeId)) removedIds.add(d.nodeId);
    if (this.archiveCache.isReady) {
      for (const d of this.COLLECT_DescendantsArchive(rootNodeId)) removedIds.add(d.nodeId);
    }
    removedIds.add(rootNodeId);

    for (const id of removedIds) {
      this.activeCache.REMOVE_Node(id);
      if (this.archiveCache.isReady) this.archiveCache.REMOVE_Node(id);
    }
    if (this.archiveCache.isReady) this.REFRESH_Archive();
    this.REFRESH_Active();
    return [...removedIds];
  }

  // ============================================================
  // 缓存校验（仅活跃缓存）
  // ============================================================

  /**
   * 与磁盘对账并修复活跃缓存（指纹驱动）— onReady 阶段调用
   *
   * 步骤：
   * 1. 列举缓存 kind 的节点文件（纯内存，零文件读取）
   * 2. 与缓存中保存的指纹比对，一致者直接跳过（不读、不解析）
   * 3. 库中多出的 id → 移除；磁盘多出的 / 指纹变化的 → 读取解析后写入
   *    （其中 open: false 的归档节点不写入活跃缓存）
   *
   * 冷启动（库为空）时等价于全量重建；有持久化缓存时通常零解析。
   * 无论有无差异，完成后都置 verified（打开写入闸门）。
   *
   * 弃置缓存不在此校验（回收视图打开时以 ARCHIVE_Refresh 全量更新）。
   *
   * @returns true 表示一致，false 表示有差异（已自动修复数据库）
   */
  async VERIFY_WithDisk(fileManager: NodeFileManager): Promise<boolean> {
    const entries = fileManager.scan.LIST_ByKinds(GET_CacheKinds());
    const known = this.activeCache.GET_Fingerprints();

    const diskIds = new Set(entries.map((e) => e.nodeId));
    const staleIds = [...known.keys()].filter((id) => !diskIds.has(id));
    const changed = entries.filter((e) => !IS_SameFingerprint(known.get(e.nodeId), e.fingerprint));

    const consistent = staleIds.length === 0 && changed.length === 0;

    if (!consistent) {
      // 只对差异文件读取解析（指纹一致的文件完全不碰）
      const parsed = await Promise.all(changed.map((e) => fileManager.scan.READ_Entry(e)));

      this.activeCache.WITH_Transaction(() => {
        for (const id of staleIds) {
          this.activeCache.REMOVE_Node(id);
        }
        for (let i = 0; i < changed.length; i++) {
          const nf = parsed[i];
          if (!nf) continue; // 解析失败 / kind 与路径不符：跳过（与扫描行为一致）
          if (nf.data.open !== false) {
            this.activeCache.UPSERT_Node(nf.nodeId, nf.data, nf.body, changed[i].fingerprint);
          } else {
            // 归档节点不留在活跃缓存（归档内容由 ARCHIVE_Refresh 提供）
            this.activeCache.REMOVE_Node(nf.nodeId);
          }
        }
      });

      this.REFRESH_Active();
    }

    // 对账完成：缓存可读且可信，打开写入闸门
    this._initialized = true;
    this._verified = true;

    return consistent;
  }

  // ============================================================
  // 树形构建（供后续操作口使用，基于活跃缓存）
  // ============================================================

  /** 构建以指定类型为根的树形结构（沿 follows 边） */
  BUILD_Tree(rootKind: NodeKindValue): TreeNode[] {
    const roots: TreeNode[] = [];
    const rootNodes = this.GET_ByKind(rootKind);
    for (const { nodeId, data } of rootNodes) {
      roots.push(this.BUILD_TreeNode(nodeId, data, 0));
    }
    return roots;
  }

  /** 递归构建树节点 */
  private BUILD_TreeNode(nodeId: string, data: SeqtkNode, depth: number): TreeNode {
    const children: TreeNode[] = [];
    for (const child of this.GET_Children(nodeId)) {
      if (!child.data) continue;
      children.push(this.BUILD_TreeNode(child.nodeId, child.data, depth + 1));
    }
    return { nodeId, data, children, depth, expanded: depth < 2 };
  }
}
