import {Load_Setting, Save_Setting, type PluginSettings} from "./P3_Settings/Settings";
import {Plugin, type WorkspaceLeaf} from "obsidian";
import {Load_Cache_Data, Check_Cache_Data, SAVE_Cache_Data} from "./P1_Register/Data";
import {EventP} from "./P1_Register/Event";
import {CacheDbStore} from "./P5_Data/SQLite/Cache/CacheDbStore";
import type {NodeCache} from "./P5_Data/SQLite/Cache/NodeCache";
import type {NodeFileManager} from "./P5_Data/MdFile/NodeFileManager";
import type {OperationQueue} from "./P5_Data/Queue/OperationQueue";
import type {DataPipe} from "./P5_Data/CoPipe/DataPipe";
import {Module_Register} from "./P1_Register/Zxport";
import type {PanelEntry} from "./P6_Views/panelRegistry";
import {FRAMEWORK_TREE} from "./P6_Views/V1_Affair/design/FrameworkTreeShared";
import {VIEW_TYPE_DELEGATED_TREE} from "./P6_Views/V1_Affair/DelegatedTree";
import {DesignView, VIEW_TYPE_DESIGN} from "./P6_Views/V1_Affair/Design";
import {VIEW_TYPE_HUB_SIDE} from "./P6_Views/V0_Common/Hub";

/** 缓存落盘防抖（毫秒）：文件队列跑完后延迟落盘，密集变更只写一次 */
const CACHE_SAVE_DEBOUNCE_MS = 10_000;

export default class SeqtkPlugin extends Plugin {
  settings!: PluginSettings;
  nodeCache!: NodeCache;
  fileManager!: NodeFileManager;
  operationQueue!: OperationQueue;
  dataPipe!: DataPipe;
  /** 缓存数据库的持久化载体（落在设置的数据根文件夹下，见 CacheDbStore） */
  cacheDbStore!: CacheDbStore;
  /** 面板目录：由 Register_View 填充（仅带 category 的 @AutoView 条目），中控台据此渲染 */
  panelRegistry: PanelEntry[] = [];
  /** 缓存落盘防抖计时器 */
  private saveTimer: number | null = null;
  /** 导出全部依赖 */
  get allDeps() {
    return {
      settings: this.settings,
      nodeCache: this.nodeCache,
      fileManager: this.fileManager,
      operationQueue: this.operationQueue,
      dataPipe: this.dataPipe,
      panelRegistry: this.panelRegistry,
    };
  }

  async onload() {
    // 加载设置
    await Load_Setting(this);
    // 模块注册（Load_Core 组装 Data 层）
    Module_Register(this);
    // 缓存持久化载体：位于设置的数据根文件夹下，与节点数据同处一棵目录树
    this.cacheDbStore = new CacheDbStore(this.app, this.settings);
    // 缓存加载：sql.js 运行时 + 读回持久化缓存。此步骤不扫描磁盘，
    // 命中的缓存立即可渲染；未命中则库为空，等 onReady 全量填充
    await Load_Cache_Data(this);
    // vault 事件（文件基准 kind，自触发抑制）
    new EventP().Register_Event(this);
    // 写入闸门：缓存与磁盘对账完成前拒绝一切写入（对账在 onReady 进行）
    this.operationQueue.setGuard(() => this.nodeCache.isVerified);
    // 文件队列落盘完成后（防抖）把缓存写回磁盘
    this.operationQueue.setOnFileOpsComplete(() => this.scheduleSaveCache());
    // 布局结束后的行为，不阻塞插件注册与库的整体启动速度
    this.app.workspace.onLayoutReady(() => void this.onReady());
  }

  async onReady() {
    // 指纹对账（差异文件才扫描解析）→ 打开写入闸门 → 落盘一次
    await Check_Cache_Data(this);

    // 恢复委托状态：上次关库时框架树被委托到侧栏，这里把它重新放回去。
    // 放在 onReady 而不是 onload —— 布局就绪后再开侧栏，不会被工作区恢复流程覆盖。
    if (this.settings.delegated) {
      FRAMEWORK_TREE.delegated = true;
      // 恢复到配置的落点：默认借用中控台容器，配成独立视图时开那个视图
      const viewType = this.settings.delegateTarget === 'view'
        ? VIEW_TYPE_DELEGATED_TREE
        : VIEW_TYPE_HUB_SIDE;
      void this.activateView(viewType, 'left');
    }
  }

  async onunload() {
    // 会话状态先落盘：设计视图的展开 / 滚动 / 选中都记在 settings 上，
    // 而它们的写回有 600ms 防抖，插件被卸载时未必来得及。
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DESIGN)) {
      (leaf.view as DesignView).FLUSH_Session?.();
    }
    // 委托开关记在共享状态里，与视图是否打开无关，单独取一次
    this.settings.delegated = FRAMEWORK_TREE.delegated;
    await Save_Setting(this);
    // 冲刷慢序列，确保未落盘的文件操作全部写入
    await this.dataPipe?.FLUSH();
    // 落盘查询缓存，供下次启动直接加载
    this.cancelSaveCache();
    await SAVE_Cache_Data(this);
  }

  /** 变更后延迟落盘缓存（防抖；未对账时 SAVE_Cache_Data 内部会跳过） */
  private scheduleSaveCache(): void {
    this.cancelSaveCache();
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void SAVE_Cache_Data(this);
    }, CACHE_SAVE_DEBOUNCE_MS);
  }

  /** 取消待执行的落盘 */
  private cancelSaveCache(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /**
   * 打开/聚焦面板视图
   * @param viewType 视图类型（@AutoView 声明 / registerView 的 viewType）
   * @param location 打开位置：tab=主编辑区，left/right=侧边栏（用于中控台双开共存）
   */
  async activateView(viewType: string, location: 'tab' | 'left' | 'right' = 'tab'): Promise<void> {
    const {workspace} = this.app;

    // 已打开 → 直接 reveal
    const existing = workspace.getLeavesOfType(viewType)[0] ?? null;
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }

    // 主区标签页：同一大类已打开的面板在其原位转变，避免标签页过多
    if (location === 'tab') {
      const entry = this.panelRegistry.find((e) => e.viewType === viewType);
      if (entry) {
        const sameCatTypes = this.panelRegistry
            .filter((p) => p.category === entry.category)
            .map((p) => p.viewType);
        let sameCatLeaf: WorkspaceLeaf | null = null;
        for (const vt of sameCatTypes) {
          // 排除侧边栏 leaf，仅取主区标签页
          const mainLeaf = workspace.getLeavesOfType(vt)
              .find((l) => !((l.getRoot() as { inSidebar?: boolean })?.inSidebar ?? false));
          if (mainLeaf) {
            sameCatLeaf = mainLeaf;
            break;
          }
        }
        if (sameCatLeaf) {
          await sameCatLeaf.setViewState({ type: viewType, active: true });
          workspace.revealLeaf(sameCatLeaf);
          return;
        }
      }
    }

    // 未打开 → 在指定位置新建叶子
    const leaf = location === 'right'
        ? workspace.getRightLeaf(false)
        : location === 'left'
            ? workspace.getLeftLeaf(false)
            : workspace.getLeaf('tab');
    if (leaf) {
      await leaf.setViewState({ type: viewType, active: true });
      workspace.revealLeaf(leaf);
    }
  }

}
