/**
 * NodeCache — 分层查询缓存（快速缓存 / 全量缓存）+ 响应式 store
 *
 * 缓存分层（考虑长期使用后的性能）：
 * - fastCache（快速缓存）：仅包含 open: true 的未归档节点，
 *   供不需要历史信息的编辑视图使用（数据量小、查询快）
 * - fullCache（全量缓存）：包含全部节点（含 open: false 的归档节点），
 *   供需要历史信息进行决策的视图使用
 *
 * 职责：
 * - 插件加载时扫描所有 MD 节点文件，分别写入两库
 * - 通过 SimpleStore 暴露快速缓存响应式快照（编辑视图订阅）
 * - 关系查询、按类型/状态查询、模糊搜索走 SQLite
 * - CRUD 操作（先更新数据库与快照，再由 OperationQueue 延迟写磁盘）
 * - 缓存一致性校验（verifyWithDisk）
 *
 * 与 MD 文件的关系（参见 doc/数据定义与持久化/关联缓存.md）：
 * - MD 文件是事实来源
 * - 数据库仅做查询加速，可从 MD 全量重建
 */

import { SimpleStore } from '../utils/SimpleStore';
import type {
  NodeKind,
  SeqtkNode,
  SeqtkState,
} from '../types/index';
import { SqliteCache } from './SqliteCache';
import type { NodeFileManager } from './NodeFileManager';

/** 树形节点 — 供后续操作口使用 */
export interface TreeNode {
  nodeId: string;
  data: SeqtkNode;
  children: TreeNode[];
  depth: number;
  expanded: boolean;
}

export class NodeCache {
  /** 快速缓存：仅 open: true 的未归档节点（编辑视图默认数据源） */
  private fastCache: SqliteCache;
  /** 全量缓存：全部节点（含归档，供历史/决策视图） */
  private fullCache: SqliteCache;

  /** 缓存是否已初始化完成 */
  private _initialized = false;

  /** SimpleStore：快速缓存节点快照（nodeId → SeqtkNode，用于触发响应式更新） */
  readonly nodeStore: SimpleStore<Map<string, SeqtkNode>> = new SimpleStore(new Map());

  /** SimpleStore：全量缓存节点快照（含归档，供回收/决策视图订阅） */
  readonly fullStore: SimpleStore<Map<string, SeqtkNode>> = new SimpleStore(new Map());

  constructor(fastCache?: SqliteCache, fullCache?: SqliteCache) {
    this.fastCache = fastCache ?? new SqliteCache();
    this.fullCache = fullCache ?? new SqliteCache();
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  /** 快速缓存访问（编辑视图默认数据源；持久化、事务等高级操作） */
  get db(): SqliteCache {
    return this.fastCache;
  }

  /** 全量缓存访问（历史/决策视图） */
  get fullDb(): SqliteCache {
    return this.fullCache;
  }

  /** 快速缓存中的节点总数（未归档） */
  get size(): number {
    return this.fastCache.count();
  }

  /** 全量缓存中的节点总数（含归档） */
  get fullSize(): number {
    return this.fullCache.count();
  }

  // ============================================================
  // 初始化
  // ============================================================

  /**
   * 初始化两个 sql.js 运行时（首次调用；wasm 字节可延迟到此时提供，实现懒加载）
   */
  async initSql(wasmBinary?: ArrayBuffer): Promise<void> {
    await Promise.all([
      this.fastCache.init(wasmBinary),
      this.fullCache.init(wasmBinary),
    ]);
  }

  /**
   * 加载持久化的两个数据库字节（从磁盘恢复查询缓存）
   *
   * @param fastBytes 快速缓存字节
   * @param fullBytes 全量缓存字节
   */
  loadDb(fastBytes: Uint8Array, fullBytes: Uint8Array): void {
    this.fastCache.load(fastBytes);
    this.fullCache.load(fullBytes);
  }

  /** 导出快速缓存字节（用于持久化） */
  exportFastDb(): Uint8Array {
    return this.fastCache.export();
  }

  /** 导出全量缓存字节（用于持久化） */
  exportFullDb(): Uint8Array {
    return this.fullCache.export();
  }

  /**
   * 初始化缓存 — 扫描所有 MD 节点文件，分流写入两个数据库
   *
   * MD 文件是事实来源，本方法在插件启动或根目录变更时调用。
   *
   * @param fileManager 文件管理器
   */
  async initialize(fileManager: NodeFileManager): Promise<void> {
    const nodeFiles = await fileManager.scanAllNodes();

    // 全量缓存：全部节点
    this.fullCache.withTransaction(() => {
      for (const nf of nodeFiles) {
        this.fullCache.upsertNode(nf.nodeId, nf.data, nf.body);
      }
    });

    // 快速缓存：仅 open: true 的未归档节点
    this.fastCache.withTransaction(() => {
      for (const nf of nodeFiles) {
        if (nf.data.open !== false) {
          this.fastCache.upsertNode(nf.nodeId, nf.data, nf.body);
        }
      }
    });

    // 标记缓存初始化完成（必须在 refreshStore 之前，否则订阅回调中 isInitialized 仍为 false）
    this._initialized = true;

    // 触发 store 更新 → 通知所有订阅者
    this.refreshStore();
  }

  /** 从两个缓存构建响应式快照 */
  private refreshStore(): void {
    const fastSnapshot = new Map<string, SeqtkNode>();
    for (const item of this.fastCache.getAllNodes()) {
      fastSnapshot.set(item.nodeId, item.data);
    }
    this.nodeStore.set(fastSnapshot);

    const fullSnapshot = new Map<string, SeqtkNode>();
    for (const item of this.fullCache.getAllNodes()) {
      fullSnapshot.set(item.nodeId, item.data);
    }
    this.fullStore.set(fullSnapshot);
  }

  // ============================================================
  // 读取操作（默认快速缓存；全量版本以 Full 后缀提供）
  // ============================================================

  /** 按 nodeId 精确查找节点（快速缓存，仅未归档） */
  getNode(nodeId: string): SeqtkNode | undefined {
    return this.fastCache.getNode(nodeId) ?? undefined;
  }

  /** 按 nodeId 精确查找节点（全量缓存，含归档） */
  getNodeFull(nodeId: string): SeqtkNode | undefined {
    return this.fullCache.getNode(nodeId) ?? undefined;
  }

  /** 按 nodeId 查找节点类型（快速缓存） */
  getNodeKind(nodeId: string): NodeKind | undefined {
    return this.fastCache.getNode(nodeId)?.kind;
  }

  /** 获取某类型的所有节点（快速缓存） */
  getByKind(kind: NodeKind): { nodeId: string; data: SeqtkNode }[] {
    return this.fastCache.getByKind(kind).map((item) => ({ nodeId: item.nodeId, data: item.data }));
  }

  /** 获取某类型的所有节点（全量缓存，含归档） */
  getByKindFull(kind: NodeKind): { nodeId: string; data: SeqtkNode }[] {
    return this.fullCache.getByKind(kind).map((item) => ({ nodeId: item.nodeId, data: item.data }));
  }

  /** 获取某过程状态的所有节点（快速缓存） */
  getByState(state: SeqtkState): { nodeId: string; data: SeqtkNode }[] {
    return this.fastCache.getByState(state).map((item) => ({ nodeId: item.nodeId, data: item.data }));
  }

  /** 获取某启用状态的所有节点（快速缓存） */
  getByOpen(open: boolean): { nodeId: string; data: SeqtkNode }[] {
    return this.fastCache.getByOpen(open).map((item) => ({ nodeId: item.nodeId, data: item.data }));
  }

  /** 全量节点列表（全量缓存，含归档） */
  getAllNodesFull(): { nodeId: string; data: SeqtkNode }[] {
    return this.fullCache.getAllNodes().map((item) => ({ nodeId: item.nodeId, data: item.data }));
  }

  /**
   * 模糊搜索节点（匹配 desc / tags / body，快速缓存）
   */
  search(query: string, limit = 100): { nodeId: string; data: SeqtkNode }[] {
    return this.fastCache.search(query, limit).map((item) => ({ nodeId: item.nodeId, data: item.data }));
  }

  // ============================================================
  // Body（正文/描述）操作
  // ============================================================

  /** 获取节点正文（快速缓存） */
  getNodeBody(nodeId: string): string {
    return this.fastCache.getBody(nodeId);
  }

  /** 获取节点正文（全量缓存，含归档） */
  getNodeBodyFull(nodeId: string): string {
    return this.fullCache.getBody(nodeId);
  }

  /** 设置节点正文缓存（两库同步；归档节点仅在 fullCache 中生效） */
  setNodeBody(nodeId: string, body: string): void {
    this.fastCache.setBody(nodeId, body);
    this.fullCache.setBody(nodeId, body);
  }

  // ============================================================
  // 关系查询（默认快速缓存）
  // ============================================================

  /**
   * 获取某个父节点的所有直接子节点（follows 出边，快速缓存）
   *
   * @param parentNodeId 父节点的 nodeId
   */
  getChildren(parentNodeId: string): { kind?: NodeKind; nodeId: string; data?: SeqtkNode }[] {
    const result: { kind?: NodeKind; nodeId: string; data?: SeqtkNode }[] = [];
    for (const childId of this.fastCache.getChildren(parentNodeId)) {
      const data = this.fastCache.getNode(childId);
      if (data) {
        result.push({ kind: data.kind, nodeId: childId, data });
      }
    }
    return result;
  }

  /**
   * 获取节点的有向直属上级（parent 出边，快速缓存）
   */
  getParent(nodeId: string): { nodeId: string; data: SeqtkNode } | null {
    const parentId = this.fastCache.getParent(nodeId);
    if (!parentId) return null;
    const data = this.fastCache.getNode(parentId);
    return data ? { nodeId: parentId, data } : null;
  }

  /**
   * 获取节点的无向关联节点（links 出边，快速缓存）
   */
  getLinked(nodeId: string): { nodeId: string; data: SeqtkNode }[] {
    const result: { nodeId: string; data: SeqtkNode }[] = [];
    for (const linkId of this.fastCache.getLinks(nodeId)) {
      const data = this.fastCache.getNode(linkId);
      if (data) result.push({ nodeId: linkId, data });
    }
    return result;
  }

  /**
   * 获取节点的标记插入（progress 出边，快速缓存）
   */
  getProgressOf(nodeId: string): { nodeId: string; data: SeqtkNode }[] {
    const result: { nodeId: string; data: SeqtkNode }[] = [];
    for (const markId of this.fastCache.getProgressOf(nodeId)) {
      const data = this.fastCache.getNode(markId);
      if (data) result.push({ nodeId: markId, data });
    }
    return result;
  }

  /**
   * 递归收集指定节点的所有后代（深度优先，不含自身，快速缓存）
   *
   * @param rootNodeId 根节点 nodeId
   */
  collectDescendants(rootNodeId: string): { nodeId: string; kind: NodeKind; data: SeqtkNode }[] {
    const result: { nodeId: string; kind: NodeKind; data: SeqtkNode }[] = [];
    const traverse = (nodeId: string) => {
      for (const child of this.getChildren(nodeId)) {
        if (!child.data) continue;
        result.push({ nodeId: child.nodeId, kind: child.data.kind, data: child.data });
        traverse(child.nodeId);
      }
    };
    traverse(rootNodeId);
    return result;
  }

  /**
   * 递归收集指定节点的所有后代（全量缓存，含归档）
   *
   * @param rootNodeId 根节点 nodeId
   */
  collectDescendantsFull(rootNodeId: string): { nodeId: string; kind: NodeKind; data: SeqtkNode }[] {
    const result: { nodeId: string; kind: NodeKind; data: SeqtkNode }[] = [];
    const traverse = (nodeId: string) => {
      for (const childId of this.fullCache.getChildren(nodeId)) {
        const data = this.fullCache.getNode(childId);
        if (!data) continue;
        result.push({ nodeId: childId, kind: data.kind, data });
        traverse(childId);
      }
    };
    traverse(rootNodeId);
    return result;
  }

  /**
   * 沿 parent 链向上追溯，获取完整的祖先链（快速缓存）
   *
   * @param nodeId 起始节点
   * @returns 祖先链（从近到远，不含起始节点自身）
   */
  getParentChain(nodeId: string): { nodeId: string; data: SeqtkNode }[] {
    const chain: { nodeId: string; data: SeqtkNode }[] = [];
    const visited = new Set<string>();
    let currentId = nodeId;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const parent = this.getParent(currentId);
      if (!parent) break;
      chain.push(parent);
      currentId = parent.nodeId;
    }

    return chain;
  }

  /**
   * 沿 follows 边做环状引用检测（快速缓存）
   *
   * @param nodeId 起点节点
   * @returns 环路径；无环返回 null
   */
  detectCycle(nodeId: string): string[] | null {
    return this.fastCache.detectCycle(nodeId);
  }

  // ============================================================
  // 线路关联（route，From/To + 描述，独立于节点 frontmatter）
  // ============================================================

  /** 建立/更新 route 线路关联（From → To，含描述） */
  addRoute(fromId: string, toId: string, description: string): void {
    this.fullCache.addRoute(fromId, toId, description);
    this.fastCache.addRoute(fromId, toId, description);
  }

  /** 移除 route 线路关联 */
  removeRoute(fromId: string, toId: string): void {
    this.fullCache.removeRoute(fromId, toId);
    this.fastCache.removeRoute(fromId, toId);
  }

  /** 节点的 route 出边（From = 该节点） */
  getRouteOutgoing(nodeId: string): { nodeId: string; desc?: string; data?: SeqtkNode }[] {
    return this.fullCache.getRouteOutgoing(nodeId).map((r) => ({
      nodeId: r.nodeId,
      desc: r.description,
      data: this.fullCache.getNode(r.nodeId) ?? undefined,
    }));
  }

  /** 节点的 route 入边（To = 该节点） */
  getRouteIncoming(nodeId: string): { nodeId: string; desc?: string; data?: SeqtkNode }[] {
    return this.fullCache.getRouteIncoming(nodeId).map((r) => ({
      nodeId: r.nodeId,
      desc: r.description,
      data: this.fullCache.getNode(r.nodeId) ?? undefined,
    }));
  }

  // ============================================================
  // 写入操作（两库同步，按 open 分流）
  // ============================================================

  /**
   * 添加节点到缓存（两库同步 + 快照）
   *
   * open: true → 快速与全量两库写入；open: false（归档）→ 仅全量库写入，
   * 并从快速库移除。
   */
  addNode(nodeId: string, data: SeqtkNode, body = ''): void {
    if (data.open !== false) {
      this.fastCache.upsertNode(nodeId, data, body);
    } else {
      this.fastCache.removeNode(nodeId);
    }
    this.fullCache.upsertNode(nodeId, data, body);
    this.refreshStore();
  }

  /**
   * 更新缓存中的节点数据（部分更新，两库同步）
   *
   * 从全量缓存读取 existing（保证归档节点也可更新）；
   * 更新后按 open 值分流快速库（open: false 时从快速库移除）。
   */
  updateNode(nodeId: string, updates: Partial<SeqtkNode>): void {
    const existing = this.fullCache.getNode(nodeId);
    if (!existing) return;

    const updated = { ...existing, ...updates } as SeqtkNode;
    const body = this.fullCache.getBody(nodeId);
    this.fullCache.upsertNode(nodeId, updated, body);

    if (updated.open !== false) {
      this.fastCache.upsertNode(nodeId, updated, body);
    } else {
      this.fastCache.removeNode(nodeId);
    }
    this.refreshStore();
  }

  /**
   * 从缓存中移除单个节点（两库删除）
   */
  removeNode(nodeId: string): void {
    this.fastCache.removeNode(nodeId);
    this.fullCache.removeNode(nodeId);
    this.refreshStore();
  }

  /**
   * 从缓存中移除整个子树（级联删除，两库同步）
   *
   * 子树结构从全量缓存收集（含归档后代），确保完整删除。
   *
   * @param rootNodeId 根节点 nodeId
   * @returns 所有被移除的 nodeId 列表
   */
  removeNodeTree(rootNodeId: string): string[] {
    const removedIds = this.collectDescendantsFull(rootNodeId).map((d) => d.nodeId);
    removedIds.push(rootNodeId);

    for (const id of removedIds) {
      this.fastCache.removeNode(id);
      this.fullCache.removeNode(id);
    }
    this.refreshStore();
    return removedIds;
  }

  // ============================================================
  // 缓存校验
  // ============================================================

  /**
   * 重新扫描磁盘文件，与两库比对一致性
   *
   * @returns true 表示一致，false 表示有差异（已自动修复数据库）
   */
  async verifyWithDisk(fileManager: NodeFileManager): Promise<boolean> {
    const diskNodes = await fileManager.scanAllNodes();
    const diskMap = new Map(diskNodes.map((nf) => [nf.nodeId, nf]));
    const openNodes = diskNodes.filter((nf) => nf.data.open !== false);

    let consistent = true;

    // ── 全量缓存对账 ──
    const fullIds = new Set(this.fullCache.getAllNodes().map((i) => i.nodeId));
    for (const nodeId of fullIds) {
      if (!diskMap.has(nodeId)) {
        console.warn(`[SeqTK] Full cache has node "${nodeId}" not found on disk. Removing.`);
        this.fullCache.removeNode(nodeId);
        this.fastCache.removeNode(nodeId);
        consistent = false;
      }
    }
    for (const [nodeId, nf] of diskMap) {
      const current = this.fullCache.getNode(nodeId);
      if (!current) {
        console.warn(`[SeqTK] Disk has node "${nodeId}" not in full cache. Adding.`);
        this.fullCache.upsertNode(nodeId, nf.data, nf.body);
        consistent = false;
      } else if (JSON.stringify(current) !== JSON.stringify(nf.data) || this.fullCache.getBody(nodeId) !== nf.body) {
        this.fullCache.upsertNode(nodeId, nf.data, nf.body);
        consistent = false;
      }
    }

    // ── 快速缓存对账（仅 open 节点） ──
    const openMap = new Map(openNodes.map((nf) => [nf.nodeId, nf]));
    const fastIds = new Set(this.fastCache.getAllNodes().map((i) => i.nodeId));
    for (const nodeId of fastIds) {
      if (!openMap.has(nodeId)) {
        this.fastCache.removeNode(nodeId);
        consistent = false;
      }
    }
    for (const [nodeId, nf] of openMap) {
      const current = this.fastCache.getNode(nodeId);
      if (!current) {
        this.fastCache.upsertNode(nodeId, nf.data, nf.body);
        consistent = false;
      } else if (JSON.stringify(current) !== JSON.stringify(nf.data) || this.fastCache.getBody(nodeId) !== nf.body) {
        this.fastCache.upsertNode(nodeId, nf.data, nf.body);
        consistent = false;
      }
    }

    if (!consistent) {
      this.refreshStore();
    }

    return consistent;
  }

  // ============================================================
  // 树形构建（供后续操作口使用，基于快速缓存）
  // ============================================================

  /**
   * 构建以指定类型为根的树形结构（沿 follows 边）
   *
   * @param rootKind 根节点类型；仅返回该类型节点为根的树
   */
  buildTree(rootKind: NodeKind): TreeNode[] {
    const roots: TreeNode[] = [];
    const rootNodes = this.getByKind(rootKind);
    for (const { nodeId, data } of rootNodes) {
      roots.push(this.buildTreeNode(nodeId, data, 0));
    }
    return roots;
  }

  /**
   * 递归构建树节点
   */
  private buildTreeNode(nodeId: string, data: SeqtkNode, depth: number): TreeNode {
    const children: TreeNode[] = [];
    for (const child of this.getChildren(nodeId)) {
      if (!child.data) continue;
      children.push(this.buildTreeNode(child.nodeId, child.data, depth + 1));
    }
    return { nodeId, data, children, depth, expanded: depth < 2 };
  }
}
