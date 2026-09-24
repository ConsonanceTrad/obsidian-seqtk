import {Load_Setting, Save_Setting, type PluginSettings} from "./P3_Settings/Settings";
import {Plugin, type WorkspaceLeaf} from "obsidian";
import {Load_Cache_Data, Check_Cache_Data, SAVE_Cache_Data} from "./P1_Register/Data";
import {EVENTS} from "./P1_Register/Event";
import {CacheDbStore} from "./P5_Data/SQLite/Cache/CacheDbStore";
import type {NodeCache} from "./P5_Data/SQLite/Cache/NodeCache";
import type {NodeFileManager} from "./P5_Data/MdFile/NodeFileManager";
import type {OperationQueue} from "./P5_Data/Queue/OperationQueue";
import type {DataPipe} from "./P5_Data/CoPipe/DataPipe";
import {Module_Register} from "./P1_Register/Zxport";
import type {PanelEntry} from "./P6_Views/panelRegistry";
import {DELEGATE} from "./P6_Views/Special/Delegate/DelegateRegistry";
import {PERSIST_Delegate, RESTORE_Delegate} from "./P6_Views/Special/Delegate/DelegateSession";
import {DesignView, VIEW_TYPE_DESIGN} from "./P6_Views/V1_Affair/Design/Core/Design";
import {RouteView, VIEW_TYPE_ROUTE} from "./P6_Views/V1_Affair/Route/Core/Route";
import {TemplateView, VIEW_TYPE_TEMPLATE} from "./P6_Views/V1_Affair/Template/Core/Template";
import {FlowView, VIEW_TYPE_FLOW} from "./P6_Views/V3_Script/FlowDesign/Core/FlowDesign";
import {MIGRATE_Drafts} from "./P2_Tools/Script/DraftStore";

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
    EVENTS.Register_Event(this);
    // 写入闸门：缓存与磁盘对账完成前拒绝一切写入（对账在 onReady 进行）
    this.operationQueue.setGuard(() => this.nodeCache.isVerified);
    // 文件队列落盘完成后（防抖）把缓存写回磁盘
    this.operationQueue.setOnFileOpsComplete(() => this.scheduleSaveCache());
    // 布局结束后的行为，不阻塞插件注册与库的整体启动速度
    this.app.workspace.onLayoutReady(() => void this.onReady());
    // 委托状态在**用户动作**上落盘：登记处的 delegate / release 会回调到这里。
    //
    // 刻意**不**订阅 DELEGATE.store：那条通道包含启动期的内部触发与 NOTIFY，它们不是用户
    // 意图，却会带着「active 还是 null」把刚从磁盘读进来的值当场冲掉 —— 实测踩过：
    // onload 读到 design，紧接着被写成 null 并落盘，等 onReady 去恢复时已经晚了。
    DELEGATE.SET_OnIntentChanged(() => {
      PERSIST_Delegate(this.settings);
      void Save_Setting(this);
    });
  }

  async onReady() {
    // 指纹对账（差异文件才扫描解析）→ 打开写入闸门 → 落盘一次
    await Check_Cache_Data(this);

    // 恢复委托状态：交给 DelegateSession（细节与理由见那边的 RESTORE_Delegate）。
    // 它**只登记、不动布局** —— 启动时不抢焦点，布局交给工作区恢复
    RESTORE_Delegate(this.settings);

    // 旧版草稿（flow-drafts.json，多轴泳道结构）一次性迁移为 DRAFT 节点。
    // 幂等：旧文件为空就直接返回；搬完把旧文件内容留档，不会再重复建节点
    await MIGRATE_Drafts(this.dataPipe);
  }

  async onunload() {
    // 会话状态先落盘：四个视图（设计 / 模板 / 线路 / 流程设计）的展开 / 选中 / 宽度 /
    // 打开位置都记在 settings 上，而它们的写回有防抖，插件被卸载时未必来得及。
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DESIGN)) {
      (leaf.view as DesignView).FLUSH_Session?.();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TEMPLATE)) {
      (leaf.view as TemplateView).FLUSH_Session?.();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ROUTE)) {
      (leaf.view as RouteView).FLUSH_Session?.();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FLOW)) {
      (leaf.view as FlowView).FLUSH_Session?.();
    }
    // 兜底：用户动作那条路（SET_OnIntentChanged）已经写过，这里只在**确实还持有委托**时补写。
    // 刻意不无条件写 —— 若此刻 active 已空（例如落点视图先于插件卸载被关闭而 release），
    // 写出去就是 null，会把上次真正的意图擦掉：这正是最早那版「重开没恢复」的成因。
    if (DELEGATE.active) {
      PERSIST_Delegate(this.settings);
      await Save_Setting(this);
    }
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
