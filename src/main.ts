/**
 * SeqTK — Obsidian 插件
 *
 * 基于 YAML 标记的 md 节点文件存储数据（节点为独立 MD 文档）
 * 使用内嵌 sql.js（SQLite 的 WASM 版）作为查询加速缓存，
 * MD 文件仍是事实来源，数据库可从 MD 全量重建。
 *
 * 概念体系参见 doc/数据定义与持久化/：
 * - 六类节点：框架 / 事务 / 证据 / 标记 / 运行 / 脚本
 * - 关系：Follows（直属下属）、Parent（直属上级）、Links（无向关联）、Progress（标记插入）
 */

import { Plugin, Notice } from 'obsidian';
import type { PluginSettings } from './types/index';
import { DEFAULT_SETTINGS } from './types/index';
import { NodeFileManager } from './core/NodeFileManager';
import { NodeCache } from './core/NodeCache';
import { OperationQueue } from './core/OperationQueue';
import { parseFlowScript } from './core/flow/parser';
import { generatePushTasks } from './core/flow/push';
import { DesignView, VIEW_TYPE_DESIGN } from './views/DesignView';
import { TemplateView, VIEW_TYPE_TEMPLATE } from './views/TemplateView';
import { TableView, VIEW_TYPE_TABLE } from './views/TableView';
import { AppendView, VIEW_TYPE_APPEND } from './views/AppendView';
import { FocusView, VIEW_TYPE_FOCUS } from './views/FocusView';
import { OverviewView, VIEW_TYPE_OVERVIEW } from './views/OverviewView';
import { RouteView, VIEW_TYPE_ROUTE } from './views/RouteView';
import { FlowView, VIEW_TYPE_FLOW } from './views/FlowView';
import { FlowPushView, VIEW_TYPE_FLOW_PUSH } from './views/FlowPushView';
import { RecycleView, VIEW_TYPE_RECYCLE } from './views/RecycleView';
import { PlaceholderView, VIEW_TYPE_EXEC_DESIGN, VIEW_TYPE_QUERY_DESIGN, VIEW_TYPE_COLLAB, VIEW_TYPE_LOG } from './views/PlaceholderView';
import { SeqtkSettingTab } from './settings/SeqtkSettingTab';
import { HubView, VIEW_TYPE_HUB, VIEW_TYPE_HUB_SIDE } from './views/HubView';
// ────────────────────────────────────────────────────────────
// 操作口（视图 / 设置面板）待按新概念重新设计
// ────────────────────────────────────────────────────────────
// 旧版视图（src/views/PlanningView.ts、ChecklistView.ts、ExecutionView.ts 及
// src/views/components/* 中的部分组件、src/settings/SettingsTab.ts）基于已废弃
// 的节点类型体系（desire/taskchain/cycle 等），当前与核心概念脱节，保留作为参考。
// TODO(操作口重设计):
//   import { PlanningView } from './views/PlanningView';
//   import { ChecklistView } from './views/ChecklistView';
//   import { ExecutionView } from './views/ExecutionView';
//   import { SeqtkSettingTab } from './settings/SettingsTab';

export default class SeqtkPlugin extends Plugin {
  settings!: PluginSettings;
  fileManager!: NodeFileManager;
  nodeCache!: NodeCache;
  operationQueue!: OperationQueue;

  async onload() {
    // 加载设置
    await this.loadSettings();

    // 初始化核心模块（轻量：仅创建对象，不触碰 wasm/数据库）
    this.fileManager = new NodeFileManager(this.app, this.settings);
    this.nodeCache = new NodeCache();
    this.operationQueue = new OperationQueue(this.settings.fileQueueDebounce);

    // 设置文件操作完成后的缓存校验回调
    this.operationQueue.setOnFileOpsComplete(async () => {
      await this.nodeCache.verifyWithDisk(this.fileManager);
      await this.persistCacheDb();
    });

    // 注册中控台面板（主编辑区 + 侧边栏，两者可共存）
    this.registerView(
      VIEW_TYPE_HUB,
      (leaf) => new HubView(leaf, VIEW_TYPE_HUB, this.settings.hub),
    );
    this.registerView(
      VIEW_TYPE_HUB_SIDE,
      (leaf) => new HubView(leaf, VIEW_TYPE_HUB_SIDE, this.settings.hub),
    );

    // 注册事务设计视图（设计模式 + 模板模式，取代旧事务面板）
    this.registerView(
      VIEW_TYPE_DESIGN,
      (leaf) => new DesignView(leaf, this.nodeCache, this.fileManager, this.operationQueue, this.settings),
    );
    this.registerView(
      VIEW_TYPE_TEMPLATE,
      (leaf) => new TemplateView(leaf, this.nodeCache, this.fileManager, this.operationQueue),
    );
    this.registerView(
      VIEW_TYPE_TABLE,
      (leaf) => new TableView(leaf, this.nodeCache, this.fileManager, this.operationQueue),
    );
    this.registerView(
      VIEW_TYPE_APPEND,
      (leaf) => new AppendView(leaf, this.nodeCache, this.fileManager, this.operationQueue),
    );
    this.registerView(
      VIEW_TYPE_FOCUS,
      (leaf) => new FocusView(leaf, this.nodeCache, this.fileManager, this.operationQueue),
    );
    this.registerView(
      VIEW_TYPE_OVERVIEW,
      (leaf) => new OverviewView(leaf, this.nodeCache, this.fileManager, this.operationQueue),
    );
    this.registerView(
      VIEW_TYPE_ROUTE,
      (leaf) => new RouteView(leaf, this.nodeCache, this.fileManager, this.operationQueue),
    );
    this.registerView(
      VIEW_TYPE_FLOW,
      (leaf) => new FlowView(leaf, this.nodeCache, this.fileManager, this.operationQueue),
    );
    this.registerView(
      VIEW_TYPE_FLOW_PUSH,
      (leaf) => new FlowPushView(leaf, this.nodeCache),
    );
    // 未实现功能口：占位视图
    this.registerView(VIEW_TYPE_EXEC_DESIGN, (leaf) => new PlaceholderView(leaf, {
      title: '执行设计',
      desc: '使用内置可切换的可视化执行程序或执行脚本程序（可视化以脚本为基础的渲染，脚本为事实源），提供触发式或手动式的自动程序。提供双栏编辑器，连接 Obsidian 右侧附属信息叶子窗口。',
    }));
    this.registerView(VIEW_TYPE_QUERY_DESIGN, (leaf) => new PlaceholderView(leaf, {
      title: '查询设计',
      desc: '使用内置脚本配合 db 实现相关信息查询，支持复杂语句，支持查询结果解析输出模块以供使用。',
    }));
    this.registerView(VIEW_TYPE_COLLAB, (leaf) => new PlaceholderView(leaf, {
      title: '智能协作',
      desc: '智能体身份与其工作流记录。',
      points: [
        '工作控制：内置智能体微调 / 自定义智能体 / 权限管理',
        '记忆审查：检查智能体对用户印象，进行审查管理；检查与印象关联的日志记录，进行溯源删改',
        '术语管理：手动添加术语定义并在使用时注入；检查智能体对术语的学习；检查术语关联的日志记录进行溯源删改',
      ],
    }));
    this.registerView(VIEW_TYPE_LOG, (leaf) => new PlaceholderView(leaf, {
      title: '日志阅览',
      desc: '条目化的阅览和搜索日志；定义部分日志是否需要缓存，以及如何被脚本或自动化获取调用（例如任务的完成信息等）。',
    }));
    this.registerView(
      VIEW_TYPE_RECYCLE,
      (leaf) => new RecycleView(leaf, this.nodeCache, this.fileManager, this.operationQueue),
    );

    // 中控台 ribbon（唯一可视化入口；其他面板不设 ribbon，仅指令 + 中控台打开）
    this.addRibbonIcon('layout-dashboard', '打开中控台', () => {
      this.activateView(VIEW_TYPE_HUB);
    });

    // 设置面板（中控台管理：显隐/组内顺序）
    this.addSettingTab(new SeqtkSettingTab(this.app, this));

    // 复合信息输出通道：供外部功能/脚本调用（线路模式）
    (window as any).SeqTK = (window as any).SeqTK ?? {};
    (window as any).SeqTK.getRouteOverviewJson = () => this.buildRouteOverviewJson();

    // 流程推送：由指定流程脚本生成任务序列（选择性调用，无自动调度）
    (window as any).SeqTK.pushFlow = (scriptId: string) => {
      const node = this.nodeCache.getNode(scriptId);
      if (!node) return { error: '脚本不存在', tasks: [] };
      const ast = parseFlowScript(this.nodeCache.getNodeBody(scriptId));
      return { scriptId, errors: ast.errors, tasks: generatePushTasks(ast) };
    };

    // 注册命令（各面板不设 ribbon，仅通过内置指令与中控台打开）
    this.addCommand({
      id: 'open-hub',
      name: '打开中控台',
      callback: () => this.activateView(VIEW_TYPE_HUB, 'tab'),
    });
    this.addCommand({
      id: 'open-hub-side',
      name: '打开中控台（侧边栏）',
      callback: () => this.activateView(VIEW_TYPE_HUB_SIDE, 'right'),
    });
    this.addCommand({
      id: 'open-design',
      name: '打开事务设计（设计模式）',
      callback: () => this.activateView(VIEW_TYPE_DESIGN),
    });
    this.addCommand({
      id: 'open-template',
      name: '打开模板模式',
      callback: () => this.activateView(VIEW_TYPE_TEMPLATE),
    });
    this.addCommand({
      id: 'open-table',
      name: '打开表格模式',
      callback: () => this.activateView(VIEW_TYPE_TABLE),
    });
    this.addCommand({
      id: 'open-append',
      name: '打开证据追加',
      callback: () => this.activateView(VIEW_TYPE_APPEND),
    });
    this.addCommand({
      id: 'open-focus',
      name: '打开证据聚焦',
      callback: () => this.activateView(VIEW_TYPE_FOCUS),
    });
    this.addCommand({
      id: 'open-overview',
      name: '打开证据总览',
      callback: () => this.activateView(VIEW_TYPE_OVERVIEW),
    });
    this.addCommand({
      id: 'open-route',
      name: '打开线路模式',
      callback: () => this.activateView(VIEW_TYPE_ROUTE),
    });
    this.addCommand({
      id: 'open-flow',
      name: '打开流程设计',
      callback: () => this.activateView(VIEW_TYPE_FLOW),
    });
    this.addCommand({
      id: 'open-flow-push',
      name: '打开流程推送（侧边栏）',
      callback: () => this.activateView(VIEW_TYPE_FLOW_PUSH, 'right'),
    });
    // 未实现功能口命令
    this.addCommand({
      id: 'open-exec-design',
      name: '打开执行设计（规划中）',
      callback: () => this.activateView(VIEW_TYPE_EXEC_DESIGN),
    });
    this.addCommand({
      id: 'open-query-design',
      name: '打开查询设计（规划中）',
      callback: () => this.activateView(VIEW_TYPE_QUERY_DESIGN),
    });
    this.addCommand({
      id: 'open-collab',
      name: '打开智能协作（规划中）',
      callback: () => this.activateView(VIEW_TYPE_COLLAB),
    });
    this.addCommand({
      id: 'open-log',
      name: '打开日志阅览（规划中）',
      callback: () => this.activateView(VIEW_TYPE_LOG),
    });
    this.addCommand({
      id: 'open-recycle',
      name: '打开回收模式',
      callback: () => this.activateView(VIEW_TYPE_RECYCLE),
    });
    this.addCommand({
      id: 'seqtk-rebuild-cache',
      name: '重建查询缓存',
      callback: async () => {
        try {
          await this.initCache();
          new Notice(`[SeqTK] 查询缓存已重建（${this.nodeCache.size} 个节点）`);
        } catch (err) {
          console.error('[SeqTK] 重建缓存失败:', err);
          new Notice(`[SeqTK] 重建缓存失败: ${err}`);
        }
      },
    });

    // 懒加载缓存：布局就绪后异步初始化，不阻塞插件注册与库的整体启动速度
    this.app.workspace.onLayoutReady(() => {
      void this.initCache();
    });
  }

  async onunload() {
    await this.operationQueue.flush();
    await this.persistCacheDb();
    this.nodeCache.db.close();
    this.nodeCache.fullDb.close();
  }

  /**
   * 初始化查询缓存（懒加载入口）
   *
   * 执行顺序：
   *   1. 读取插件目录 sql-wasm.wasm 字节，初始化 sql.js（WASM 编译，耗时操作）
   *   2. 加载持久化缓存数据库（快速恢复旧数据，供视图立即可用）
   *   3. 全量扫描 MD 节点文件重建数据库（MD 是事实来源，保证权威一致）
   *   4. 持久化数据库 + 注册 vault 事件监听
   *
   * 整个流程在 onLayoutReady 后异步执行，避免阻塞 Obsidian 启动。
   */
  private async initCache(): Promise<void> {
    // 读取插件目录下的 sql-wasm.wasm 字节，供 sql.js 直接从二进制实例化
    // （绕开 fetch(file://) 与 fs 加载在 Obsidian renderer 中的限制）
    const wasmBinary = await this.readWasmBinary();

    // 初始化 sql.js 运行时，尝试加载持久化缓存数据库
    await this.nodeCache.initSql(wasmBinary);
    const cached = await this.loadCacheDb();
    if (cached.fast && cached.full) {
      try {
        this.nodeCache.loadDb(cached.fast, cached.full);
      } catch (err) {
        console.warn('[SeqTK] 缓存数据库损坏，将全量重建:', err);
      }
    }

    // 全量扫描 MD 重建（事实源），并持久化 + 注册事件监听
    await this.nodeCache.initialize(this.fileManager);
    await this.persistCacheDb();
    this.registerVaultEvents();
  }

  // ============================================================
  // 设置管理
  // ============================================================

  /**
   * 复合信息输出（线路模式）：结构化 JSON——框架、子树节点与状态、
   * 状态聚合、route 线路关联列表。供外部功能/脚本通过 window.SeqTK 调用。
   */
  private buildRouteOverviewJson(): any {
    const TXN: string[] = ['concept', 'checklist', 'item', 'event'];
    const frameworks = [
      ...this.nodeCache.getByKind('framework-transaction'),
      ...this.nodeCache.getByKind('framework-info'),
    ];
    const result: any[] = [];
    for (const { nodeId, data } of frameworks) {
      const subtree: any[] = [];
      const counts: Record<string, number> = {};
      const walk = (id: string) => {
        const n = this.nodeCache.getNode(id);
        if (!n) return;
        const st = n.state ?? 'plan';
        subtree.push({ id, kind: n.kind, desc: n.desc, state: st });
        counts[st] = (counts[st] ?? 0) + 1;
        for (const c of this.nodeCache.getChildren(id)) {
          if (c.data && (c.data.kind === 'framework-transaction'
            || c.data.kind === 'framework-info' || TXN.includes(c.data.kind))) {
            walk(c.nodeId);
          }
        }
      };
      walk(nodeId);
      const done = counts['done'] ?? 0;
      const total = subtree.length;
      const routes: any[] = [];
      for (const r of this.nodeCache.getRouteOutgoing(nodeId)) {
        routes.push({ from: nodeId, to: r.nodeId, desc: r.desc });
      }
      result.push({
        framework: { id: nodeId, kind: data.kind, desc: data.desc },
        subtree,
        aggregate: {
          plan: counts['plan'] ?? 0,
          open: counts['open'] ?? 0,
          done: counts['done'] ?? 0,
          drop: counts['drop'] ?? 0,
          total,
          donePct: total > 0 ? Math.round((done / total) * 100) : 0,
        },
        routes,
      });
    }
    return { generatedAt: new Date().toISOString(), frameworks: result };
  }

  /** 加载设置数据，此行为需阻塞，调用等待 await */
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    const oldRoot = this.fileManager?.['settings']?.rootFolder;
    const rootChanged = oldRoot && oldRoot !== this.settings.rootFolder;

    await this.saveData(this.settings);
    this.fileManager?.updateSettings(this.settings);
    this.operationQueue?.setDebounceTime(this.settings.fileQueueDebounce);

    // 根路径变更后重新扫描缓存
    if (rootChanged) {
      await this.nodeCache.initialize(this.fileManager);
      await this.persistCacheDb();
      new Notice(`[SeqTK] 根路径已切换，已重新扫描 ${this.nodeCache.size} 个节点`);
    }
  }

  // ============================================================
  // 缓存数据库持久化
  // ============================================================

  /** 缓存数据库文件路径（插件目录，与 data.json 同级；快速/全量各一份） */
  private cacheDbPath(name: 'fast' | 'full'): string {
    const dir = this.manifest.dir ?? '';
    return dir ? `${dir}/seqtk-${name}.db` : '';
  }

  /**
   * 读取插件目录下的 sql-wasm.wasm 字节
   *
   * 插件目录位于 vault 内（.obsidian/plugins/seqtk），通过 vault adapter
   * 读取二进制内容，避免 sql.js 默认的 fetch(file://) 与 fs 绝对路径在
   * Obsidian renderer 环境中受限。
   */
  private async readWasmBinary(): Promise<ArrayBuffer | undefined> {
    const dir = this.manifest.dir ?? '';
    const wasmPath = dir ? `${dir}/sql-wasm.wasm` : '';
    if (!wasmPath) {
      console.error('[SeqTK] 无法确定插件目录，sql-wasm.wasm 加载失败');
      return undefined;
    }
    try {
      if (!(await this.app.vault.adapter.exists(wasmPath))) {
        console.error(`[SeqTK] 未找到 ${wasmPath}，请将 sql-wasm.wasm 与 main.js 放在同一插件目录`);
        return undefined;
      }
      const buf = await this.app.vault.adapter.readBinary(wasmPath);
      if (buf instanceof Uint8Array) {
        // 复制出独立的 ArrayBuffer（Uint8Array 的 buffer 可能带偏移或共享）
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      }
      return buf;
    } catch (err) {
      console.error('[SeqTK] 读取 sql-wasm.wasm 失败:', err);
      return undefined;
    }
  }

  /** 从插件目录读取持久化缓存数据库（快速/全量各一份，缺失的返回 null） */
  private async loadCacheDb(): Promise<{ fast: Uint8Array | null; full: Uint8Array | null }> {
    const readOne = async (name: 'fast' | 'full'): Promise<Uint8Array | null> => {
      try {
        const path = this.cacheDbPath(name);
        if (!path) return null;
        if (!(await this.app.vault.adapter.exists(path))) return null;
        const buf = await this.app.vault.adapter.readBinary(path);
        return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      } catch (err) {
        console.warn(`[SeqTK] 读取 ${name} 缓存数据库失败:`, err);
        return null;
      }
    };
    const [fast, full] = await Promise.all([readOne('fast'), readOne('full')]);
    return { fast, full };
  }

  /** 将两个内存数据库导出并写入插件目录 */
  private async persistCacheDb(): Promise<void> {
    if (!this.nodeCache.isInitialized) return;
    const writeOne = async (name: 'fast' | 'full', bytes: Uint8Array) => {
      try {
        const path = this.cacheDbPath(name);
        if (!path) return;
        await this.app.vault.adapter.writeBinary(path, bytes);
      } catch (err) {
        console.warn(`[SeqTK] 写入 ${name} 缓存数据库失败:`, err);
      }
    };
    await Promise.all([
      writeOne('fast', this.nodeCache.exportFastDb()),
      writeOne('full', this.nodeCache.exportFullDb()),
    ]);
  }

  // ============================================================
  // 视图管理
  // ============================================================

  /**
   * 激活指定类型的视图
   *
   * @param viewType 视图类型
   * @param location 打开位置：tab=主编辑区，right=右侧边栏（用于中控台双开共存）
   */
  private async activateView(viewType: string, location: 'tab' | 'right' = 'tab'): Promise<void> {
    const { workspace } = this.app;

    // 已打开 → 直接 reveal
    const existing = workspace.getLeavesOfType(viewType)[0] ?? null;
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }

    // 未打开 → 在指定位置新建叶子
    const leaf = location === 'right'
      ? workspace.getRightLeaf(false)
      : workspace.getLeaf('tab');
    if (leaf) {
      await leaf.setViewState({ type: viewType, active: true });
      workspace.revealLeaf(leaf);
    }
  }

  // ============================================================
  // Vault 事件监听
  // ============================================================

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (!this.fileManager.isManagedPath(file.path)) return;
        this.handleFileChange(file.path, 'create');
      })
    );

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!this.fileManager.isManagedPath(file.path)) return;
        this.handleFileChange(file.path, 'modify');
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!this.fileManager.isManagedPath(file.path)) return;
        this.handleFileChange(file.path, 'delete');
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!this.fileManager.isManagedPath(file.path) && !this.fileManager.isManagedPath(oldPath)) return;
        this.handleFileRename(file.path, oldPath);
      })
    );
  }

  private async handleFileChange(filePath: string, action: 'create' | 'modify' | 'delete'): Promise<void> {
    const nodeId = this.fileManager.getNodeIdFromPath(filePath);
    if (!nodeId) return;

    if (action === 'delete') {
      this.operationQueue.enqueueCacheOp(() => {
        this.nodeCache.removeNode(nodeId);
      });
    } else {
      const kind = this.fileManager.getKindFromPath(filePath);
      if (!kind) return;
      const nodeFile = await this.fileManager.readNode(kind, nodeId);
      if (nodeFile) {
        this.operationQueue.enqueueCacheOp(() => {
          this.nodeCache.addNode(nodeId, nodeFile.data, nodeFile.body);
        });
      }
    }
  }

  private handleFileRename(newPath: string, oldPath: string): void {
    const oldNodeId = this.fileManager.getNodeIdFromPath(oldPath);
    const newNodeId = this.fileManager.getNodeIdFromPath(newPath);

    if (oldNodeId && newNodeId && oldNodeId !== newNodeId) {
      this.operationQueue.enqueueCacheOp(() => {
        const data = this.nodeCache.getNode(oldNodeId);
        if (data) {
          const body = this.nodeCache.getNodeBody(oldNodeId);
          this.nodeCache.removeNode(oldNodeId);
          this.nodeCache.addNode(newNodeId, data, body);
        }
      });
    }
  }
}
