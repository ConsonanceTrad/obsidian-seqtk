/**
 * SqliteCache — sql.js 数据库封装
 *
 * 职责：
 * - 初始化 sql.js（SQLite 的 WASM 版）并建表
 * - 节点数据表 nodes + 关系表 relations（follows / parent / links / progress）
 * - 节点 CRUD、关系查询、模糊搜索、环状引用检测
 * - export()/load() 二进制持久化
 *
 * 与 MD 文件的关系（参见 doc/数据定义与持久化/关联缓存.md）：
 * - MD 文件（frontmatter + body）是事实来源
 * - 数据库仅做查询加速，可从 MD 文件全量重建
 *
 * 注：列名避开 SQLite 保留字（如 created_at 而非 create）。
 */

import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';
import type {
  NodeKind,
  SeqtkNode,
  SeqtkState,
  SeqtkEstate,
  SeqtkIndicator,
} from '../types/index';

// ============================================================
// 常量与类型
// ============================================================

/** 关系类型 — 对应文档中的从属关系属性 */
export type RelationType = 'follows' | 'parent' | 'links' | 'progress' | 'route';

/** 一条关系出边 */
export interface RelationRef {
  nodeId: string;
  rel: RelationType;
  /** 关系描述（仅 route 线路关联携带） */
  description?: string;
}

/** 节点查询结果条目 */
export interface NodeQueryItem {
  nodeId: string;
  data: SeqtkNode;
  body: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  desc        TEXT NOT NULL DEFAULT '',
  open        INTEGER NOT NULL DEFAULT 1,
  source      TEXT,
  created_at  TEXT NOT NULL DEFAULT '',
  modified_at TEXT NOT NULL DEFAULT '',
  state       TEXT,
  estate      TEXT,
  clear       INTEGER,
  tags        TEXT,
  indicators  TEXT,
  pmarks      TEXT,
  nature      TEXT,
  at          TEXT,
  expected_time   TEXT,
  expected_repeat TEXT,
  expected_span   TEXT,
  body        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_state ON nodes(state);
CREATE INDEX IF NOT EXISTS idx_nodes_created ON nodes(created_at);

CREATE TABLE IF NOT EXISTS relations (
  from_id TEXT NOT NULL,
  rel     TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (from_id, rel, to_id)
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id, rel);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_id, rel);
`;

/** 节点表行结构 */
interface NodeRow {
  id: string;
  kind: string;
  desc: string;
  open: number;
  source: string | null;
  created_at: string;
  modified_at: string;
  state: string | null;
  estate: string | null;
  clear: number | null;
  tags: string | null;
  indicators: string | null;
  pmarks: string | null;
  nature: string | null;
  at: string | null;
  expected_time: string | null;
  expected_repeat: string | null;
  expected_span: string | null;
  body: string;
}

// ============================================================
// 序列化辅助
// ============================================================

function jsonEncode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function jsonDecode<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** 数据库行 → SeqtkNode 对象（含 id，与 frontmatter 键对齐） */
function rowToNode(row: NodeRow): SeqtkNode {
  const node: Record<string, any> = {
    id: row.id,
    kind: row.kind as NodeKind,
    desc: row.desc,
    open: row.open !== 0,
    create: row.created_at,
    modify: row.modified_at,
  };
  if (row.source) node.from = row.source;
  if (row.state) node.state = row.state as SeqtkState;
  if (row.estate) node.estate = row.estate as SeqtkEstate;
  if (row.clear !== null) node.clear = row.clear !== 0;
  const tags = jsonDecode<string[]>(row.tags);
  if (tags) node.tags = tags;
  const indicators = jsonDecode<SeqtkIndicator[]>(row.indicators);
  if (indicators) node.indicators = indicators;
  const pmarks = jsonDecode<Record<string, string>>(row.pmarks);
  if (pmarks) node.pmarks = pmarks;
  if (row.nature) node.nature = row.nature;
  if (row.at) node.at = row.at;
  if (row.expected_time) node.expectedTime = row.expected_time;
  if (row.expected_repeat) node.expectedRepeat = row.expected_repeat;
  const expectedSpan = jsonDecode<{ from?: string; to?: string }>(row.expected_span);
  if (expectedSpan) node.expectedSpan = expectedSpan;
  return node as SeqtkNode;
}

/**
 * 在基础行解析之上补充出边关系（follows / parent / links / progress）
 *
 * 关系存储于 relations 表而非 nodes 列，读取时必须一并还原，
 * 否则部分更新（如向 follows 追加子节点）会因缺失旧关系而被覆盖。
 *
 * @param row  节点行
 * @param rels 该节点的出边关系列表（调用方提供；不传时返回无关系字段的基础对象）
 */
function rowToNodeFull(row: NodeRow, rels?: RelationRef[]): SeqtkNode {
  const node = rowToNode(row) as Record<string, any>;
  const list = rels ?? [];
  const follows = list.filter((r) => r.rel === 'follows').map((r) => r.nodeId);
  const parent = list.find((r) => r.rel === 'parent')?.nodeId;
  const links = list.filter((r) => r.rel === 'links').map((r) => r.nodeId);
  const progress = list.filter((r) => r.rel === 'progress').map((r) => r.nodeId);
  if (follows.length > 0) node.follows = follows;
  if (parent) node.parent = parent;
  if (links.length > 0) node.links = links;
  if (progress.length > 0) node.progress = progress;
  return node as SeqtkNode;
}

// ============================================================
// SqliteCache
// ============================================================

/** SqliteCache 初始化配置 */
export interface SqliteCacheOptions {
  /**
   * sql-wasm.wasm 的绝对路径（Node/Electron 环境用 fs 定位时）
   * 与 wasmBinary 二选一；均提供时优先 wasmBinary。
   */
  wasmPath?: string;
  /**
   * sql-wasm.wasm 的字节内容（Obsidian 环境经 vault adapter 读取后传入，
   * 由 sql.js 直接从二进制实例化，绕开 fetch(file://) 与 fs 加载限制）。
   */
  wasmBinary?: ArrayBuffer;
}

export class SqliteCache {
  private sql: SqlJsStatic | null = null;
  private db: Database | null = null;
  private wasmPath: string;
  private wasmBinary: ArrayBuffer | null;

  constructor(options: SqliteCacheOptions = {}) {
    this.wasmPath = options.wasmPath ?? '';
    this.wasmBinary = options.wasmBinary ?? null;
  }

  get isReady(): boolean {
    return this.db !== null;
  }

  /**
   * 初始化 sql.js 运行时并创建/打开数据库（空库 + 建表）
   *
   * @param wasmBinary 可选的 wasm 字节（懒加载场景下由调用方在初始化时才提供）
   */
  async init(wasmBinary?: ArrayBuffer): Promise<void> {
    if (wasmBinary) this.wasmBinary = wasmBinary;
    if (this.wasmBinary) {
      this.sql = await initSqlJs({ wasmBinary: this.wasmBinary });
    } else if (this.wasmPath) {
      this.sql = await initSqlJs({ locateFile: () => this.wasmPath });
    } else {
      this.sql = await initSqlJs();
    }
    this.db = new this.sql.Database();
    this.db.run(SCHEMA);
    this.migrate();
  }

  /**
   * 从持久化字节加载数据库（若库未初始化会先 init 运行时）
   *
   * @param bytes sql.js export() 产生的 Uint8Array
   */
  load(bytes: Uint8Array): void {
    if (!this.sql || !this.db) {
      throw new Error('[SeqTK] SqliteCache.load: database not initialized');
    }
    this.db.close();
    this.db = new this.sql.Database(bytes);
    this.migrate();
  }

  /**
   * 旧库结构迁移：确保表结构与新增列完整
   *
   * 早期版本创建的缓存库可能缺少后续迭代新增的表（如 relations）或列
   * （如 nature、at）。先幂等补建表与索引（CREATE IF NOT EXISTS），
   * 再按需 ALTER TABLE 补列。
   */
  private migrate(): void {
    const db = this.requireDb();
    // 补建缺失的表与索引（幂等；对已存在的表/索引不产生任何操作）
    db.run(SCHEMA);
    // 补列：nodes 表按需追加 TEXT 列
    const ALTER_COLUMNS = ['nature', 'at', 'expected_time', 'expected_repeat', 'expected_span'];
    const nodeResult = db.exec('PRAGMA table_info(nodes)');
    const nodeCols: string[] =
      nodeResult.length > 0 ? nodeResult[0].values.map((r) => String(r[1])) : [];
    for (const col of ALTER_COLUMNS) {
      if (!nodeCols.includes(col)) {
        db.run(`ALTER TABLE nodes ADD COLUMN ${col} TEXT`);
      }
    }
    // relations 表补 description 列（route 线路关联的描述）
    const relResult = db.exec('PRAGMA table_info(relations)');
    const relCols: string[] =
      relResult.length > 0 ? relResult[0].values.map((r) => String(r[1])) : [];
    if (!relCols.includes('description')) {
      db.run('ALTER TABLE relations ADD COLUMN description TEXT');
    }
  }

  /**
   * 导出数据库为字节（用于持久化）
   */
  export(): Uint8Array {
    return this.requireDb().export();
  }

  /**
   * 关闭数据库（释放 WASM 内存）
   */
  close(): void {
    this.db?.close();
    this.db = null;
    this.sql = null;
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error('[SeqTK] SqliteCache: database not initialized');
    }
    return this.db;
  }

  // ============================================================
  // 节点 CRUD
  // ============================================================

  /**
   * 插入或替换节点（含正文缓存）
   *
   * 同时根据节点的 follows/parent/links/progress 字段重建出边关系。
   *
   * @param nodeId 节点 ID
   * @param node   节点数据（frontmatter）
   * @param body   正文内容
   */
  upsertNode(nodeId: string, node: SeqtkNode, body: string): void {
    const db = this.requireDb();
    const raw = node as Record<string, any>;

    db.run(
      `INSERT OR REPLACE INTO nodes
         (id, kind, desc, open, source, created_at, modified_at,
          state, estate, clear, tags, indicators, pmarks, nature, at,
          expected_time, expected_repeat, expected_span, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nodeId,
        node.kind,
        node.desc ?? '',
        node.open ? 1 : 0,
        raw.from ?? null,
        node.create ?? '',
        node.modify ?? '',
        raw.state ?? null,
        raw.estate ?? null,
        raw.clear === undefined ? null : raw.clear ? 1 : 0,
        jsonEncode(raw.tags),
        jsonEncode(raw.indicators),
        jsonEncode(raw.pmarks),
        raw.nature ?? null,
        raw.at ?? null,
        raw.expectedTime ?? null,
        raw.expectedRepeat ?? null,
        jsonEncode(raw.expectedSpan),
        body ?? '',
      ]
    );

    // 重建出边关系（保留 route 线路关联，不随 frontmatter 重建）
    db.run("DELETE FROM relations WHERE from_id = ? AND rel != 'route'", [nodeId]);
    const addRel = (toId: string, rel: RelationType) => {
      if (!toId) return;
      db.run('INSERT OR IGNORE INTO relations (from_id, rel, to_id) VALUES (?, ?, ?)', [nodeId, rel, toId]);
    };
    (raw.follows as string[] | undefined)?.forEach((t) => addRel(t, 'follows'));
    if (raw.parent) addRel(raw.parent, 'parent');
    (raw.links as string[] | undefined)?.forEach((t) => addRel(t, 'links'));
    (raw.progress as string[] | undefined)?.forEach((t) => addRel(t, 'progress'));
  }

  // ============================================================
  // 线路关联（route，From/To + 描述，独立于节点 frontmatter）
  // ============================================================

  /** 建立/更新一条 route 线路关联（From → To，含描述） */
  addRoute(fromId: string, toId: string, description: string): void {
    const db = this.requireDb();
    db.run(
      `INSERT OR REPLACE INTO relations (from_id, rel, to_id, description)
       VALUES (?, 'route', ?, ?)`,
      [fromId, toId, description],
    );
  }

  /** 移除一条 route 线路关联 */
  removeRoute(fromId: string, toId: string): void {
    const db = this.requireDb();
    db.run("DELETE FROM relations WHERE from_id = ? AND rel = 'route' AND to_id = ?", [fromId, toId]);
  }

  /** 节点的 route 出边（From = 该节点） */
  getRouteOutgoing(nodeId: string): RelationRef[] {
    return this.queryRouteRelations('SELECT rel, to_id, description FROM relations WHERE from_id = ? AND rel = ?', nodeId);
  }

  /** 节点的 route 入边（To = 该节点） */
  getRouteIncoming(nodeId: string): RelationRef[] {
    return this.queryRouteRelations('SELECT rel, from_id AS to_id, description FROM relations WHERE to_id = ? AND rel = ?', nodeId);
  }

  private queryRouteRelations(sql: string, nodeId: string): RelationRef[] {
    const db = this.requireDb();
    const stmt = db.prepare(sql);
    stmt.bind([nodeId, 'route']);
    const result: RelationRef[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      result.push({ nodeId: row.to_id, rel: 'route', description: row.description ?? undefined });
    }
    stmt.free();
    return result;
  }

  /**
   * 从缓存移除节点及其全部关系（出边 + 入边）
   */
  removeNode(nodeId: string): void {
    const db = this.requireDb();
    db.run('DELETE FROM nodes WHERE id = ?', [nodeId]);
    db.run('DELETE FROM relations WHERE from_id = ? OR to_id = ?', [nodeId, nodeId]);
  }

  /** 按 nodeId 查询节点数据；不存在返回 null */
  getNode(nodeId: string): SeqtkNode | null {
    const db = this.requireDb();
    const stmt = db.prepare('SELECT * FROM nodes WHERE id = ?');
    stmt.bind([nodeId]);
    let result: SeqtkNode | null = null;
    if (stmt.step()) {
      const row = stmt.getAsObject() as unknown as NodeRow;
      result = rowToNodeFull(row, this.getOutgoingRelations(nodeId));
    }
    stmt.free();
    return result;
  }

  /** 获取节点正文缓存 */
  getBody(nodeId: string): string {
    const db = this.requireDb();
    const stmt = db.prepare('SELECT body FROM nodes WHERE id = ?');
    stmt.bind([nodeId]);
    let body = '';
    if (stmt.step()) {
      body = (stmt.getAsObject() as any).body ?? '';
    }
    stmt.free();
    return body;
  }

  /** 更新节点正文缓存 */
  setBody(nodeId: string, body: string): void {
    const db = this.requireDb();
    db.run('UPDATE nodes SET body = ? WHERE id = ?', [body, nodeId]);
  }

  /** 全量节点（用于响应式快照） */
  getAllNodes(): NodeQueryItem[] {
    const db = this.requireDb();
    const relMap = this.buildRelationMap();
    const stmt = db.prepare('SELECT * FROM nodes');
    const items: NodeQueryItem[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as NodeRow;
      items.push({ nodeId: row.id, data: rowToNodeFull(row, relMap.get(row.id)), body: row.body });
    }
    stmt.free();
    return items;
  }

  /** 按类型查询节点 */
  getByKind(kind: NodeKind): NodeQueryItem[] {
    return this.queryNodes('SELECT * FROM nodes WHERE kind = ? ORDER BY created_at', [kind]);
  }

  /** 按过程状态查询节点 */
  getByState(state: SeqtkState): NodeQueryItem[] {
    return this.queryNodes('SELECT * FROM nodes WHERE state = ? ORDER BY created_at', [state]);
  }

  /** 按启用状态查询节点 */
  getByOpen(open: boolean): NodeQueryItem[] {
    return this.queryNodes('SELECT * FROM nodes WHERE open = ? ORDER BY created_at', [open ? 1 : 0]);
  }

  /** 节点总数 */
  count(): number {
    const db = this.requireDb();
    const result = db.exec('SELECT COUNT(*) AS n FROM nodes');
    return result.length > 0 ? Number(result[0].values[0][0]) : 0;
  }

  /**
   * 模糊搜索 — 匹配 desc / tags / body
   *
   * @param query 关键字
   * @param limit 最大结果数（默认 100）
   */
  search(query: string, limit = 100): NodeQueryItem[] {
    const db = this.requireDb();
    const relMap = this.buildRelationMap();
    const like = `%${query}%`;
    const stmt = db.prepare(
      `SELECT * FROM nodes
       WHERE desc LIKE ? OR tags LIKE ? OR body LIKE ?
       ORDER BY created_at DESC LIMIT ?`
    );
    stmt.bind([like, like, like, limit]);
    const items: NodeQueryItem[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as NodeRow;
      items.push({ nodeId: row.id, data: rowToNodeFull(row, relMap.get(row.id)), body: row.body });
    }
    stmt.free();
    return items;
  }

  private queryNodes(sql: string, params: any[]): NodeQueryItem[] {
    const db = this.requireDb();
    const relMap = this.buildRelationMap();
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const items: NodeQueryItem[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as NodeRow;
      items.push({ nodeId: row.id, data: rowToNodeFull(row, relMap.get(row.id)), body: row.body });
    }
    stmt.free();
    return items;
  }

  /**
   * 一次性查询全部出边关系，构建 from_id → 关系列表映射
   *
   * 供批量读取（getAllNodes / queryNodes / search）复用，
   * 避免逐节点 N+1 查询。
   */
  private buildRelationMap(): Map<string, RelationRef[]> {
    const db = this.requireDb();
    const map = new Map<string, RelationRef[]>();
    const stmt = db.prepare('SELECT from_id, rel, to_id FROM relations ORDER BY rowid');
    while (stmt.step()) {
      const r = stmt.getAsObject() as any;
      const list = map.get(r.from_id) ?? [];
      list.push({ nodeId: r.to_id, rel: r.rel as RelationType });
      map.set(r.from_id, list);
    }
    stmt.free();
    return map;
  }

  // ============================================================
  // 关系查询
  // ============================================================

  /** 获取节点的全部出边关系 */
  getOutgoingRelations(nodeId: string, rel?: RelationType): RelationRef[] {
    const db = this.requireDb();
    const sql = rel
      ? 'SELECT rel, to_id FROM relations WHERE from_id = ? AND rel = ? ORDER BY rowid'
      : 'SELECT rel, to_id FROM relations WHERE from_id = ? ORDER BY rowid';
    const params = rel ? [nodeId, rel] : [nodeId];
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const result: RelationRef[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      result.push({ nodeId: row.to_id, rel: row.rel as RelationType });
    }
    stmt.free();
    return result;
  }

  /** 获取节点的全部入边关系（引用该节点的关系） */
  getIncomingRelations(nodeId: string, rel?: RelationType): RelationRef[] {
    const db = this.requireDb();
    const sql = rel
      ? 'SELECT from_id, rel FROM relations WHERE to_id = ? AND rel = ? ORDER BY rowid'
      : 'SELECT from_id, rel FROM relations WHERE to_id = ? ORDER BY rowid';
    const params = rel ? [nodeId, rel] : [nodeId];
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const result: RelationRef[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      result.push({ nodeId: row.from_id, rel: row.rel as RelationType });
    }
    stmt.free();
    return result;
  }

  /** 获取节点的有向直属下属（follows 出边） */
  getChildren(nodeId: string): string[] {
    return this.getOutgoingRelations(nodeId, 'follows').map((r) => r.nodeId);
  }

  /** 获取节点的有向直属上级（parent 出边，取第一条） */
  getParent(nodeId: string): string | null {
    const refs = this.getOutgoingRelations(nodeId, 'parent');
    return refs.length > 0 ? refs[0].nodeId : null;
  }

  /** 获取节点的无向关联（links 出边） */
  getLinks(nodeId: string): string[] {
    return this.getOutgoingRelations(nodeId, 'links').map((r) => r.nodeId);
  }

  /** 获取节点的标记插入（progress 出边） */
  getProgressOf(nodeId: string): string[] {
    return this.getOutgoingRelations(nodeId, 'progress').map((r) => r.nodeId);
  }

  /** 获取引用该节点的上级集合（入边 follows，即哪些节点把 nodeId 当作直属下属） */
  getParentCandidates(nodeId: string): string[] {
    return this.getIncomingRelations(nodeId, 'follows').map((r) => r.nodeId);
  }

  // ============================================================
  // 环状引用检测
  // ============================================================

  /**
   * 沿 follows 边做 DFS 环检测
   *
   * @param startNodeId 起点节点
   * @returns 环路径（首尾相同的节点链）；无环返回 null
   */
  detectCycle(startNodeId: string): string[] | null {
    const visited = new Set<string>();
    const path: string[] = [];
    const pathSet = new Set<string>();

    const dfs = (nodeId: string): string[] | null => {
      if (pathSet.has(nodeId)) {
        // 找到环：从路径中截取环段
        const idx = path.indexOf(nodeId);
        return [...path.slice(idx), nodeId];
      }
      if (visited.has(nodeId)) return null;
      visited.add(nodeId);
      path.push(nodeId);
      pathSet.add(nodeId);

      for (const childId of this.getChildren(nodeId)) {
        const cycle = dfs(childId);
        if (cycle) return cycle;
      }

      path.pop();
      pathSet.delete(nodeId);
      return null;
    };

    return dfs(startNodeId);
  }

  // ============================================================
  // 事务
  // ============================================================

  /**
   * 在单个 SQLite 事务中执行一组写操作
   */
  withTransaction<T>(fn: () => T): T {
    const db = this.requireDb();
    db.run('BEGIN');
    try {
      const result = fn();
      db.run('COMMIT');
      return result;
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }
  }
}
