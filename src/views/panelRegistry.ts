/**
 * 面板注册表 — 中控台与内置指令的统一面板清单
 *
 * 新增操作面板时：
 *   1. 在此处追加一条 PanelEntry（viewType 需与 main.ts registerView 一致）
 *   2. 在 main.ts 中 registerView + 添加对应的打开命令
 *
 * 设计约定：各类型面板不设置 ribbon 按钮，仅通过内置指令与中控台打开。
 * 中控台按 category 分栏展示（对应操作口目录章节），设置面板可显隐/组内排序。
 */

import { VIEW_TYPE_DESIGN } from './DesignView';
import { VIEW_TYPE_TEMPLATE } from './TemplateView';
import { VIEW_TYPE_TABLE } from './TableView';
import { VIEW_TYPE_APPEND } from './AppendView';
import { VIEW_TYPE_FOCUS } from './FocusView';
import { VIEW_TYPE_OVERVIEW } from './OverviewView';
import { VIEW_TYPE_ROUTE } from './RouteView';
import { VIEW_TYPE_FLOW } from './FlowView';
import { VIEW_TYPE_FLOW_PUSH } from './FlowPushView';
import { VIEW_TYPE_RECYCLE } from './RecycleView';
import { VIEW_TYPE_EXEC_DESIGN, VIEW_TYPE_QUERY_DESIGN, VIEW_TYPE_COLLAB, VIEW_TYPE_LOG } from './PlaceholderView';

/** 中控台分栏章节（顺序即展示顺序，对应操作口目录章节） */
export const HUB_CATEGORIES = ['事务设计', '证据管理', '规则设计', '节点通用'] as const;

export type HubCategory = typeof HUB_CATEGORIES[number];

/** 操作面板条目 */
export interface PanelEntry {
  /** 视图类型（与 registerView 的 viewType 一致） */
  viewType: string;
  /** 面板标题 */
  title: string;
  /** 图标名（Obsidian lucide 图标） */
  icon: string;
  /** 一句话描述 */
  description: string;
  /** 中控台分栏章节 */
  category: HubCategory;
  /** true = 未实现的占位视图（中控台显示「规划中」徽标） */
  placeholder?: boolean;
}

/** 全部操作面板注册表（中控台据此渲染） */
export const PANEL_REGISTRY: PanelEntry[] = [
  // ============================================================
  // 事务设计
  // ============================================================
  {
    viewType: VIEW_TYPE_DESIGN,
    title: '事务设计',
    icon: 'layout-grid',
    description: '设计模式：框架-子框架总览，统一编辑框架内的事务与证据；含全部事务总览。',
    category: '事务设计',
  },
  {
    viewType: VIEW_TYPE_TEMPLATE,
    title: '模板模式',
    icon: 'copy',
    description: '从框架提取模板单元（{{占位}} 骨架），管理模板框架并应用到目标框架。',
    category: '事务设计',
  },
  {
    viewType: VIEW_TYPE_TABLE,
    title: '表格模式',
    icon: 'table',
    description: '节点属性表格阅览、行内编辑与批量操作（含归档节点视图）。',
    category: '事务设计',
  },
  {
    viewType: VIEW_TYPE_ROUTE,
    title: '线路模式',
    icon: 'route',
    description: '项目线路图：框架间隐性关联（From/To + 描述）与复合进度信息输出。',
    category: '事务设计',
  },
  // ============================================================
  // 证据管理
  // ============================================================
  {
    viewType: VIEW_TYPE_APPEND,
    title: '证据追加',
    icon: 'git-branch',
    description: '选择事务，编辑其证据（对象/条件/信息/状态）与证据间关联。',
    category: '证据管理',
  },
  {
    viewType: VIEW_TYPE_FOCUS,
    title: '证据聚焦',
    icon: 'network',
    description: '选择事务，白板阅览其中证据的相互关联关系（连线编辑）。',
    category: '证据管理',
  },
  {
    viewType: VIEW_TYPE_OVERVIEW,
    title: '证据总览',
    icon: 'network',
    description: '不聚焦事务，白板阅览全局证据关系，可连接跨事务证据、建立无指向证据。',
    category: '证据管理',
  },
  // ============================================================
  // 规则设计
  // ============================================================
  {
    viewType: VIEW_TYPE_FLOW,
    title: '流程设计',
    icon: 'workflow',
    description: '内置可切换的可视化流程程序与流程脚本程序，为时段/日期/时间点编写推送规则（脚本为事实源）。',
    category: '规则设计',
  },
  {
    viewType: VIEW_TYPE_FLOW_PUSH,
    title: '流程推送',
    icon: 'bell',
    description: '根据指定流程脚本，在右侧边栏展示被推送的任务序列。',
    category: '规则设计',
  },
  {
    viewType: VIEW_TYPE_EXEC_DESIGN,
    title: '执行设计',
    icon: 'play',
    description: '可视化执行程序/执行脚本程序（脚本为事实源），提供触发式或手动式的自动程序；双栏编辑器。',
    category: '规则设计',
    placeholder: true,
  },
  {
    viewType: VIEW_TYPE_QUERY_DESIGN,
    title: '查询设计',
    icon: 'search',
    description: '使用内置脚本配合 db 实现相关信息查询，支持复杂语句，查询结果解析输出模块。',
    category: '规则设计',
    placeholder: true,
  },
  // ============================================================
  // 节点通用
  // ============================================================
  {
    viewType: VIEW_TYPE_COLLAB,
    title: '智能协作',
    icon: 'bot',
    description: '智能体身份与工作流记录：工作控制、记忆审查、术语管理。',
    category: '节点通用',
    placeholder: true,
  },
  {
    viewType: VIEW_TYPE_RECYCLE,
    title: '回收模式',
    icon: 'trash-2',
    description: '阅览归档节点，提供还原与彻底删除。',
    category: '节点通用',
  },
  {
    viewType: VIEW_TYPE_LOG,
    title: '日志阅览',
    icon: 'scroll-text',
    description: '条目化的阅览和搜索日志；定义日志是否缓存及如何被脚本或自动化获取调用。',
    category: '节点通用',
    placeholder: true,
  },
];
