import type SeqtkPlugin from "../main";
import {DEFAULT_ROOT_FOLDER} from "../P2_Tools/Const/DefaultPaths";
import {DEFAULT_STATE_RULES, type StatePropagationRule} from "../P4_Nodes/NodeField/Propagation";
import {
    DEFAULT_DESTRUCTIVE_POLICY,
    type ArchiveChildrenMode,
    type ConfirmLevel,
    type DeleteChildrenMode,
} from "../P4_Nodes/NodeField/DeletionPolicy";

/** 插件配置 */
/** 委托落点：借用中控台容器，或独立视图 */
export type DelegateTarget = 'hub' | 'view';

export const DELEGATE_TARGET_LABELS: Record<DelegateTarget, string> = {
    hub: '中控台侧栏（默认）',
    view: '独立视图',
};

export interface PluginSettings {

    /** 数据根文件夹路径（相对于 vault 根目录） */
    rootFolder: string;

    /** 默认排序方式 */
    defaultSort: 'create' | 'modify' | 'desc' | 'state';

    /** 默认排序方向 */
    defaultSortDirection: 'asc' | 'desc';

    /**
     * 状态传播规则：按状态类型配置的父子传播
     * （见 P4_Nodes/NodeField/Propagation —— 取代了旧的 stateCascade / statusFollow）
     */
    stateRules: StatePropagationRule[];

    /** 归档父节点时，其后代如何处理 */
    archiveChildren: ArchiveChildrenMode;

    /** 删除父节点时，其后代如何处理 */
    deleteChildren: DeleteChildrenMode;

    /** 归档节点时的提示级别 */
    archiveConfirm: ConfirmLevel;

    /** 删除节点时的提示级别 */
    deleteConfirm: ConfirmLevel;

    /** 是否在事务设计左侧栏显示「全部事务」入口（默认隐藏） */
    showAllOverview: boolean;

    /** 左侧栏顶级框架顺序（nodeId 数组；未列入的按创建时间排尾部） */
    topFrameworkOrder: string[];

    /** 事务设计：左栏宽度（px；0 = 使用默认宽度） */
    leftPaneWidth: number;

    /** 事务设计：左栏展开的框架 nodeId（记忆展开状态） */
    expandedFrameworkIds: string[];

    /** 事务设计：右栏展开的 nodeId（与左栏各记各的 —— 两栏本就是独立的展开集合） */
    expandedRightIds: string[];

    /** 中控台管理：各章节的显隐与组内顺序（key=章节名；空 = 默认全部显示/registry 顺序） */
    hub: Record<string, { hidden: string[]; order: string[] }>;

    /** 事务设计：是否处于委托（重开库时据此把框架树面板恢复到侧栏） */
    delegated: boolean;

    /**
     * 事务设计的框架树被委托到哪里
     *   'hub'  借用中控台侧栏容器（默认）—— 框架树作为一节渲染在中控台里
     *   'view' 独立视图 seqtk-delegated-tree
     */
    delegateTarget: DelegateTarget;

    /** 事务设计：上次选中的框架 nodeId（重开库时恢复选中） */
    selectedFrameworkId: string | null;

    /** 事务设计：左 / 右栏树容器的滚动位置（px） */
    treeScrollLeft: number;
    treeScrollRight: number;

}

/** 默认设置 */
export const DEFAULT_SETTINGS: PluginSettings = {
    rootFolder: DEFAULT_ROOT_FOLDER,
    defaultSort: 'create',
    defaultSortDirection: 'desc',
    stateRules: DEFAULT_STATE_RULES.map((r) => ({ ...r, from: [...r.from] })),
    ...DEFAULT_DESTRUCTIVE_POLICY,
    showAllOverview: false,
    topFrameworkOrder: [],
    leftPaneWidth: 0,
    expandedFrameworkIds: [],
    expandedRightIds: [],
    hub: {},
    delegated: false,
    delegateTarget: 'hub',
    selectedFrameworkId: null,
    treeScrollLeft: 0,
    treeScrollRight: 0,
};


export async function Load_Setting(p: SeqtkPlugin) {
    p.settings = Object.assign({}, DEFAULT_SETTINGS, await p.loadData());
}

export async function Save_Setting(p: SeqtkPlugin) {
    await p.saveData(p.settings);
}

export const Get_Settings = () => {

}
