/**
 * SqliteCache — sql.js 数据库封装
 *
 * 职责：
 * - 初始化 sql.js（SQLite 的 WASM 版）并建表
 * - 节点数据表 nodes + 关系表 relations（follows / parent / links / progress / route）
 * - 节点 CRUD、关系查询、模糊搜索、环状引用检测
 * - export()/load() 二进制持久化 + 文件指纹（增量校验依据）
 *
 * 与 MD 文件的关系（参见 doc/数据定义与持久化/关联缓存.md）：
 * - MD 文件（frontmatter + body）是事实来源
 * - 数据库仅做查询加速，可从 MD 文件全量重建
 *
 * 注：列名避开 SQLite 保留字（如 created_at 而非 create）。
 *
 * 命名：方法统一「全大写操作_行为」（数据字段保持小写）。
 */

import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';
import type { SeqtkNode } from '../../../P4_Nodes/Node';
import type { RouteRef } from '../../../P4_Nodes/NodeField/AttriGroup/Route';
import type { NodeKindValue } from '../../../P4_Nodes/NodeKind/NodeKind';
import type {
  SeqtkState,
  SeqtkEstate,
  SeqtkIndicator,
} from '../../../P4_Nodes/NodeField/StateKeys';
import type { FileFingerprint } from '../../FileFingerprint';

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

/** 只读 SQL 的结果：列名 + 原始行 */
export interface RawQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** 是否因达到行数上限而截断（即结果集还有更多行没取） */
  truncated: boolean;
}

/**
 * 只读 SQL 的通行判定：必须以 `SELECT` 或 `WITH` 开头
 *
 * 允许语句前面有空白与注释（`--` 行注释、块注释）—— 把注释写在最上面
 * 是很自然的写法，没理由因此判它不合格。
 */
const READONLY_SQL = /^\s*(?:(?:--[^\n]*\n)|(?:\/\*[\s\S]*?\*\/)|[ \t\r\n])*(?:SELECT|WITH)\b/i;

/**
 * 当前 schema 版本（建库时写入 PRAGMA user_version）
 *
 * 加载持久化缓存时版本不符即丢弃并冷启动重建（MD 文件是事实来源，重建总是安全）。
 * 仅**向后兼容**的变更（如新增可空列）无需递增：MIGRATE_Schema 会幂等补列，
 * 补出的新列为 NULL，指纹比对时视为「未知」而重读该文件。
 */
const SCHEMA_VERSION = 1;

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
  sources     TEXT,
  fs_mtime    INTEGER,
  fs_size     INTEGER,
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

/** 节点表行结构（仅业务字段；fs_mtime/fs_size 为文件系统元数据，不进入节点对象） */
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
  sources: string | null;
  body: string;
}

// ============================================================
// 序列化辅助（模块级私有纯函数，camelCase）
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

/** 读取库的 PRAGMA user_version（未设置时 SQLite 返回 0） */
function READ_UserVersion(db: Database): number {
  const result = db.exec('PRAGMA user_version');
  if (result.length === 0 || result[0].values.length === 0) return 0;
  return Number(result[0].values[0][0]);
}

/** 数据库行 → SeqtkNode 对象（含 id，与 frontmatter 键对齐） */
function rowToNode(row: NodeRow): SeqtkNode {
  const node: Record<string, any> = {
    id: row.id,
    kind: row.kind as NodeKindValue,
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
  // 外部信息源：与 tags / indicators 一样按 JSON 列存回（列为 NULL 即「没有信息源」）
  const sources = jsonDecode<SeqtkNode['sources']>(row.sources);
  if (sources) node.sources = sources;
  return node as SeqtkNode;
}

/**
 * 在基础行解析之上补充出边关系（follows / parent / links / progress / route）
 *
 * 关系存储于 relations 表而非 nodes 列，读取时必须一并还原，
 * 否则部分更新（如向 follows 追加子节点）会因缺失旧关系而被覆盖。
 *
 * route 也在这里还原：它以 `routes` 字段（源侧 frontmatter）为权威来源，
 * SQLite 那侧只是它的投影，所以读回时同样按 nodeId + desc 组装成 routes。
 *
 * @param row  节点行
 * @param rels 该节点的出边关系列表（调用方提供；不传时返回无关系字段的基础对象）
 */
function rowToNodeFull(row: NodeRow, rels?: RelationRef[]): SeqtkNode {
  const node = rowToNode(row) as Record<string, any>;
  const list = rels ?? [];
  const follows = list.filter((r) => r.rel === 'follows').map((r) => r.nodeId);
  const links = list.filter((r) => r.rel === 'links').map((r) => r.nodeId);
  const progress = list.filter((r) => r.rel === 'progress').map((r) => r.nodeId);
  const routes = list
    .filter((r) => r.rel === 'route')
    .map((r) => (r.description ? { toId: r.nodeId, desc: r.description } : { toId: r.nodeId }));
  if (follows.length > 0) node.follows = follows;
  if (links.length > 0) node.links = links;
  if (progress.length > 0) node.progress = progress;
  if (routes.length > 0) node.routes = routes;
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
  async INIT_Sql(wasmBinary?: ArrayBuffer): Promise<void> {
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
    this.MIGRATE_Schema();
    this.SET_SchemaVersion();
  }

  /**
   * 从持久化字节加载数据库（运行时须已初始化）
   *
   * 校验顺序：字节可解析 → schema 版本匹配。任一步失败都抛出，由调用方
   * 降级为冷启动重建；失败时不会改动当前已打开的库（先构造临时库再替换）。
   *
   * @param bytes sql.js export() 产生的 Uint8Array
   */
  LOAD_Db(bytes: Uint8Array): void {
    if (!this.sql || !this.db) {
      throw new Error('[SeqTK] SqliteCache.LOAD_Db: database not initialized');
    }
    const loaded = new this.sql.Database(bytes);
    const version = READ_UserVersion(loaded);
    if (version !== SCHEMA_VERSION) {
      loaded.close();
      throw new Error(
        `[SeqTK] SqliteCache.LOAD_Db: schema version mismatch (file=${version}, expected=${SCHEMA_VERSION})`,
      );
    }
    this.db.close();
    this.db = loaded;
    this.MIGRATE_Schema();
  }

  /** 当前库的 schema 版本（PRAGMA user_version） */
  GET_SchemaVersion(): number {
    return READ_UserVersion(this.REQUIRE_Db());
  }

  /** 写入当前 schema 版本（建库后调用） */
  private SET_SchemaVersion(): void {
    this.REQUIRE_Db().run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * 旧库结构迁移：确保表结构与新增列完整
   *
   * 早期版本创建的缓存库可能缺少后续迭代新增的表（如 relations）或列
   * （如 nature、at、fs_mtime）。先幂等补建表与索引（CREATE IF NOT EXISTS），
   * 再按需 ALTER TABLE 补列（补出的列为 NULL）。
   */
  private MIGRATE_Schema(): void {
    const db = this.REQUIRE_Db();
    // 补建缺失的表与索引（幂等；对已存在的表/索引不产生任何操作）
    db.run(SCHEMA);
    // 补列：nodes 表按需追加 [列名, 类型]
    const ALTER_COLUMNS: [string, string][] = [
      ['nature', 'TEXT'],
      ['at', 'TEXT'],
      ['expected_time', 'TEXT'],
      ['expected_repeat', 'TEXT'],
      ['expected_span', 'TEXT'],
      ['sources', 'TEXT'],
      ['fs_mtime', 'INTEGER'],
      ['fs_size', 'INTEGER'],
    ];
    const nodeResult = db.exec('PRAGMA table_info(nodes)');
    const nodeCols: string[] =
      nodeResult.length > 0 ? nodeResult[0].values.map((r) => String(r[1])) : [];
    const needsSources = !nodeCols.includes('sources');
    for (const [col, type] of ALTER_COLUMNS) {
      if (!nodeCols.includes(col)) {
        db.run(`ALTER TABLE nodes ADD COLUMN ${col} ${type}`);
      }
    }
    // 补出的业务列为 NULL，而文件指纹只含 fs_mtime / fs_size：存量行不会因此被重读，
    // 那一列会一直空着（sources 正是这种情况）。故把指纹一并作废，
    // 让下一次对账全量重读一次文件（只发生这一次）。
    if (needsSources) {
      db.run('UPDATE nodes SET fs_mtime = NULL, fs_size = NULL');
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
  EXPORT_Db(): Uint8Array {
    return this.REQUIRE_Db().export();
  }

  /**
   * 关闭数据库（释放 WASM 内存）
   */
  CLOSE_Db(): void {
    this.db?.close();
    this.db = null;
    this.sql = null;
  }

  private REQUIRE_Db(): Database {
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
   * @param fp     该节点文件当时（或按需）的指纹；不传则写 NULL，
   *               表示「未知」，下次启动校验会重读该文件（保守，不影响正确性）
   */
  UPSERT_Node(nodeId: string, node: SeqtkNode, body: string, fp?: FileFingerprint): void {
    const db = this.REQUIRE_Db();
    const raw = node as Record<string, any>;

    db.run(
      `INSERT OR REPLACE INTO nodes
         (id, kind, desc, open, source, created_at, modified_at,
          state, estate, clear, tags, indicators, pmarks, nature, at,
          expected_time, expected_repeat, expected_span, sources,
          fs_mtime, fs_size, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        jsonEncode(raw.sources),
        fp?.mtime ?? null,
        fp?.size ?? null,
        body ?? '',
      ]
    );

    // 出边关系一律从 frontmatter 重建 —— 含 route：routes 字段是权威来源，
    // relations 表只是它的投影（早先「保留 route」的例外已随 routes 落盘取消）
    db.run('DELETE FROM relations WHERE from_id = ?', [nodeId]);
    const addRel = (toId: string, rel: RelationType, description?: string) => {
      if (!toId) return;
      db.run(
        'INSERT OR REPLACE INTO relations (from_id, rel, to_id, description) VALUES (?, ?, ?, ?)',
        [nodeId, rel, toId, description ?? null],
      );
    };
    (raw.follows as string[] | undefined)?.forEach((t) => addRel(t, 'follows'));
    (raw.links as string[] | undefined)?.forEach((t) => addRel(t, 'links'));
    (raw.progress as string[] | undefined)?.forEach((t) => addRel(t, 'progress'));
    (raw.routes as RouteRef[] | undefined)?.forEach((r) => addRel(r.toId, 'route', r.desc));
  }

  /**
   * 库中全部节点的文件指纹（nodeId → 指纹；未知时为 undefined）
   *
   * 返回全部 id 而非仅「有指纹的」：调用方需据此判断哪些 id 已从磁盘消失。
   * 旧库补列后该两列为 NULL，其值落在 undefined 上，指纹比对一律视为不一致
   * （保守：重读该文件），属预期的降级路径。
   */
  GET_Fingerprints(): Map<string, FileFingerprint | undefined> {
    const db = this.REQUIRE_Db();
    const map = new Map<string, FileFingerprint | undefined>();
    const stmt = db.prepare('SELECT id, fs_mtime, fs_size FROM nodes');
    while (stmt.step()) {
      const row = stmt.getAsObject() as { id: string; fs_mtime: number | null; fs_size: number | null };
      map.set(
        row.id,
        row.fs_mtime === null || row.fs_size === null
          ? undefined
          : { mtime: Number(row.fs_mtime), size: Number(row.fs_size) },
      );
    }
    stmt.free();
    return map;
  }

  // ============================================================
  // 线路关联（route）—— relations 表里的投影
  // 权威来源是源节点 frontmatter 的 routes 字段（见 AttriGroup/Route），
  // 写入一律经 UPSERT_Node 重建，故这里只有查询、没有增删。
  // ============================================================

  /** 节点的 route 出边（From = 该节点） */
  GET_RouteOutgoing(nodeId: string): RelationRef[] {
    return this.QUERY_RouteRelations('SELECT rel, to_id, description FROM relations WHERE from_id = ? AND rel = ?', nodeId);
  }

  /** 节点的 route 入边（To = 该节点） */
  GET_RouteIncoming(nodeId: string): RelationRef[] {
    return this.QUERY_RouteRelations('SELECT rel, from_id AS to_id, description FROM relations WHERE to_id = ? AND rel = ?', nodeId);
  }

  private QUERY_RouteRelations(sql: string, nodeId: string): RelationRef[] {
    const db = this.REQUIRE_Db();
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
  REMOVE_Node(nodeId: string): void {
    const db = this.REQUIRE_Db();
    db.run('DELETE FROM nodes WHERE id = ?', [nodeId]);
    db.run('DELETE FROM relations WHERE from_id = ? OR to_id = ?', [nodeId, nodeId]);
  }

  /** 按 nodeId 查询节点数据；不存在返回 null */
  GET_Node(nodeId: string): SeqtkNode | null {
    const db = this.REQUIRE_Db();
    const stmt = db.prepare('SELECT * FROM nodes WHERE id = ?');
    stmt.bind([nodeId]);
    let result: SeqtkNode | null = null;
    if (stmt.step()) {
      const row = stmt.getAsObject() as unknown as NodeRow;
      result = rowToNodeFull(row, this.GET_OutgoingRelations(nodeId));
    }
    stmt.free();
    return result;
  }

  /** 获取节点正文缓存 */
  GET_Body(nodeId: string): string {
    const db = this.REQUIRE_Db();
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
  SET_Body(nodeId: string, body: string): void {
    const db = this.REQUIRE_Db();
    db.run('UPDATE nodes SET body = ? WHERE id = ?', [body, nodeId]);
  }

  /** 全量节点（用于响应式快照） */
  GET_AllNodes(): NodeQueryItem[] {
    const db = this.REQUIRE_Db();
    const relMap = this.BUILD_RelationMap();
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
  GET_ByKind(kind: NodeKindValue): NodeQueryItem[] {
    return this.QUERY_Nodes('SELECT * FROM nodes WHERE kind = ? ORDER BY created_at', [kind]);
  }

  /** 按过程状态查询节点 */
  GET_ByState(state: SeqtkState): NodeQueryItem[] {
    return this.QUERY_Nodes('SELECT * FROM nodes WHERE state = ? ORDER BY created_at', [state]);
  }

  /** 按启用状态查询节点 */
  GET_ByOpen(open: boolean): NodeQueryItem[] {
    return this.QUERY_Nodes('SELECT * FROM nodes WHERE open = ? ORDER BY created_at', [open ? 1 : 0]);
  }

  /** 节点总数 */
  GET_Count(): number {
    const db = this.REQUIRE_Db();
    const result = db.exec('SELECT COUNT(*) AS n FROM nodes');
    return result.length > 0 ? Number(result[0].values[0][0]) : 0;
  }

  /**
   * 模糊搜索 — 匹配 desc / tags / body
   *
   * @param query 关键字
   * @param limit 最大结果数（默认 100）
   */
  SEARCH_Nodes(query: string, limit = 100): NodeQueryItem[] {
    const db = this.REQUIRE_Db();
    const relMap = this.BUILD_RelationMap();
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

  private QUERY_Nodes(sql: string, params: any[]): NodeQueryItem[] {
    const db = this.REQUIRE_Db();
    const relMap = this.BUILD_RelationMap();
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
   * 跑一条**只读** SQL，返回原始行列
   *
   * 只认 `SELECT` / `WITH` 打头（前面允许注释），其余一律拒绝。卡这么死的理由：
   * MD 文件才是事实来源，db 随时会被全量重建抹掉 —— 一旦放行写操作，用户会看到
   * 「db 改了、文件没改」，而下一次重建又把改动抹回去，那种不一致最难排查。
   *
   * 值按 sql.js 的原样返回（整数是 number、NULL 是 null），**不做节点对象转换** ——
   * 这个出口是给「直接看表」用的，不是又一个业务查询。
   */
  QUERY_Raw(sql: string, params: unknown[] = [], limit = 500): RawQueryResult {
    if (!READONLY_SQL.test(sql)) {
      throw new Error('只允许只读查询：语句需以 SELECT 或 WITH 开头');
    }
    const db = this.REQUIRE_Db();
    const stmt = db.prepare(sql);
    stmt.bind(params as any);
    const columns = stmt.getColumnNames();
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    while (stmt.step()) {
      if (rows.length >= limit) {
        // 已经取满上限、而结果集还没走完 —— 说明确实还有更多行
        truncated = true;
        break;
      }
      rows.push(stmt.getAsObject() as Record<string, unknown>);
    }
    stmt.free();
    return { columns, rows, truncated };
  }

  /**
   * 语法检查（试编译，不执行）
   *
   * 与 QUERY_Raw 同一道只读闸门；`prepare` 就会抛语法错误，编译通过立即释放语句。
   * 返回 null 表示通过，否则是错误原文（原文就是最准的诊断，与查询错误同口径）。
   */
  CHECK_Sql(sql: string): string | null {
    if (!READONLY_SQL.test(sql)) {
      return '只允许只读查询：语句需以 SELECT 或 WITH 开头';
    }
    try {
      const db = this.REQUIRE_Db();
      const stmt = db.prepare(sql);
      stmt.free();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * 一次性查询全部出边关系，构建 from_id → 关系列表映射
   *
   * 供批量读取（GET_AllNodes / QUERY_Nodes / SEARCH_Nodes）复用，
   * 避免逐节点 N+1 查询。
   */
  private BUILD_RelationMap(): Map<string, RelationRef[]> {
    const db = this.REQUIRE_Db();
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
  GET_OutgoingRelations(nodeId: string, rel?: RelationType): RelationRef[] {
    const db = this.REQUIRE_Db();
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
  GET_IncomingRelations(nodeId: string, rel?: RelationType): RelationRef[] {
    const db = this.REQUIRE_Db();
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
  GET_Children(nodeId: string): string[] {
    return this.GET_OutgoingRelations(nodeId, 'follows').map((r) => r.nodeId);
  }

  /**
   * 获取节点的直属上级（取第一个）
   *
   * 归属只由**上级的 follows** 记录（父 → 子单向），下级不再写 parent 字段，
   * 所以这里反查 follows 入边。多归属时上级会有多个，取第一个是给「只需要一个」
   * 的老调用点（如沿链上溯）用的；要全部请用 GET_Parents。
   */
  GET_Parent(nodeId: string): string | null {
    const parents = this.GET_Parents(nodeId);
    return parents.length > 0 ? parents[0] : null;
  }

  /** 获取节点的无向关联（links 出边） */
  GET_Links(nodeId: string): string[] {
    return this.GET_OutgoingRelations(nodeId, 'links').map((r) => r.nodeId);
  }

  /** 获取节点的标记插入（progress 出边） */
  GET_ProgressOf(nodeId: string): string[] {
    return this.GET_OutgoingRelations(nodeId, 'progress').map((r) => r.nodeId);
  }

  /** 获取节点的全部直属上级（follows 入边，即哪些节点把 nodeId 当作直属下属）—— 多归属时不止一个 */
  GET_Parents(nodeId: string): string[] {
    return this.GET_IncomingRelations(nodeId, 'follows').map((r) => r.nodeId);
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
  DETECT_Cycle(startNodeId: string): string[] | null {
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

      for (const childId of this.GET_Children(nodeId)) {
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
  WITH_Transaction<T>(fn: () => T): T {
    const db = this.REQUIRE_Db();
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
