/**
 * 面板目录 — 视图散布式注册的公共契约（类型 + 分类常量）
 *
 * 数据流向：
 *   - 各视图类通过 @AutoView() 在类上声明 static metas（PanelEntry[]）与
 *     static create(leaf, plugin, viewType) 工厂（见 P1_Register/Comd.ts）；
 *   - P1_Register 的 Register_View 在注册阶段执行 registerView，并把「带 category 的条目」
 *     写入插件实例级 panelRegistry（中控台目录）；
 *   - HubView 据 plugin.panelRegistry 与 settings.hub 渲染中控台。
 *
 * 本文件只承担类型与分类常量，不含具体视图的 viewType 常量 ——
 * viewType 常量由各视图文件自行导出（如 V0_Common/Hub.ts 的 VIEW_TYPE_HUB）。
 */

/** 中控台分栏章节（顺序即展示顺序，对应操作口目录章节） */
export const HUB_CATEGORIES = ['事务设计', '规则设计', '节点通用'] as const;

export type HubCategory = typeof HUB_CATEGORIES[number];

/**
 * 中控台各分栏的默认先后 —— 中控台顺序的**唯一事实源**
 *
 * 为什么不沿用「视图模块的 import 顺序」（P1_Register/Zxport 那批副作用导入）：
 * 那份顺序只说明「谁先被加载」，拿它当排序等于让一件无关的事顺手决定界面，
 * 想调顺序时也看不出该改哪儿。表里没列到的条目接在该栏末尾，不会丢。
 *
 * 与 settings.hub[分类].hidden 的分工：这张表管**顺序**，hidden 只管**显隐**。
 * 新增视图时记得往这里补一行，否则它会排到该栏最后。
 */
export const HUB_DEFAULT_ORDER: Record<HubCategory, string[]> = {
    '事务设计': [
        'seqtk-design',
        'seqtk-template',
        'seqtk-route',
        'seqtk-overview'
    ],
    '规则设计': [
        'seqtk-exec-bind',
        'seqtk-flow-draft',
        'seqtk-flow-push',
        'seqtk-exec-design',
        'seqtk-flow',
        'seqtk-query-design',
    ],
    '节点通用': ['seqtk-collab', 'seqtk-log', 'seqtk-recycle'],
};

/** 操作面板条目 */
export interface PanelEntry {
  /** 视图类型（与 registerView 的 viewType 一致） */
  viewType: string;
  /** 面板标题 */
  title: string;
  /** 图标名（Obsidian lucide 图标） */
  icon: string;
  /** 一句话描述 */
  description?: string;
  /**
   * 中控台分栏章节。
   * 缺省 = 仅注册为 Obsidian 视图、不进入中控台目录（如中控台自身 hub / hub-side）。
   */
  category?: HubCategory;
  /** true = 未实现的占位视图（中控台显示「规划中」徽标） */
  placeholder?: boolean;
}
