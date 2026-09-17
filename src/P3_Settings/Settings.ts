import type SeqtkPlugin from "../main";
import {DEFAULT_ROOT_FOLDER} from "../P2_Tools/Const/DefaultPaths";
import {DEFAULT_STATE_RULES, type StatePropagationRule} from "../P4_Nodes/NodeField/Propagation";
import {
    DEFAULT_DESTRUCTIVE_POLICY,
    type ArchiveChildrenMode,
    type ConfirmLevel,
    type DeleteChildrenMode,
} from "../P4_Nodes/NodeField/DeletionPolicy";
import {APPLY_KindLabels} from "../P4_Nodes/NodeKind/NodeLabel";
import {APPLY_KindColors, GET_KindColorVars} from "../P4_Nodes/NodeKind/KindColors";

/** 插件配置 */
/** 委托落点：借用中控台容器，或独立视图 */
export type DelegateTarget = 'hub' | 'view';

export const DELEGATE_TARGET_LABELS: Record<DelegateTarget, string> = {
    hub: '借用中控台',
    view: '独立视图',
};

export interface PluginSettings {

    /** 数据根文件夹路径（相对于 vault 根目录） */
    rootFolder: string;

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

    /**
     * 类型显示名覆盖：key = 类型值（NodeKindValue），value = 用户改的名字
     *
     * 只存被改过的项 —— 未列出的键、空串都表示"用默认名"（见 P4_Nodes/NodeKind/NodeLabel）。
     * 这是**显示层**配置：节点文件里存的是 ASCII 类型值、文本树用类型短码，都不受影响。
     */
    kindLabels: Record<string, string>;

    /**
     * 类型配色覆盖：key = `category.<大类>` / `role.<类型值>`，value = 十六进制色值
     *
     * 只存改过的项 —— 未列出的键用出厂色（见 P4_Nodes/NodeKind/KindColors 的 GET_KindColorItems）。
     * 同样是显示层配置：白板与徽章都读它，但节点文件里没有任何颜色信息。
     */
    kindColors: Record<string, string>;

    /**
     * 逐项的「字体反色」开关：key 同 kindColors，value = true 表示该项文字用黑色
     *
     * 缺省（未列出 / false）= 白字 —— 出厂一律白字，哪一项想用黑字由用户逐项决定。
     */
    kindTextInverted: Record<string, boolean>;

    /** 左侧栏顶级框架顺序（nodeId 数组；未列入的按创建时间排尾部） */
    topFrameworkOrder: string[];

    /** 事务设计：左栏宽度（px；0 = 使用默认宽度） */
    leftPaneWidth: number;

    /** 事务设计：左栏展开的框架 nodeId（记忆展开状态） */
    expandedFrameworkIds: string[];

    /** 事务设计：右栏展开的 nodeId（与左栏各记各的 —— 两栏本就是独立的展开集合） */
    expandedRightIds: string[];

    /**
     * 中控台管理：各章节下**要隐藏**的视图（key=章节名，value=viewType 列表；
     * 空 = 该章节全部显示）。
     *
     * 顺序不在这里 —— 中控台的排列由代码里的 HUB_DEFAULT_ORDER 决定
     * （见 P6_Views/panelRegistry.ts），这份配置只管显隐。
     */
    hub: Record<string, { hidden: string[] }>;

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
    stateRules: DEFAULT_STATE_RULES.map((r) => ({ ...r, from: [...r.from] })),
    ...DEFAULT_DESTRUCTIVE_POLICY,
    kindLabels: {},
    kindColors: {},
    kindTextInverted: {},
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

/**
 * 把当前生效的配色推进 CSS 变量
 *
 * 徽章与附加行预览靠这些变量上色（styles.css 里只剩「变量名 + 出厂回退值」）；
 * 挂在 body 上是因为变量可继承 —— 改一次颜色只需重跑这一处，不必逐个元素设内联样式。
 * 白板不走这条路，它直接读 KindColors 的生效表。
 */
function PUSH_KindColorVars(p: SeqtkPlugin): void {
    const vars = GET_KindColorVars(p.settings.kindTextInverted ?? {});
    const style = document.body.style;
    for (const [name, value] of Object.entries(vars)) {
        style.setProperty(name, value);
    }
}

export async function Load_Setting(p: SeqtkPlugin) {
    p.settings = Object.assign({}, DEFAULT_SETTINGS, await p.loadData());
    // 读盘后立刻把用户改过的类型名与配色刷进全局生效表 —— 界面各处读的正是那几张表
    APPLY_KindLabels(p.settings.kindLabels);
    APPLY_KindColors(p.settings.kindColors);
    PUSH_KindColorVars(p);
}

export async function Save_Setting(p: SeqtkPlugin) {
    // 落盘前同样刷一次：保证"存下来的"与"界面上生效的"始终是同一份
    APPLY_KindLabels(p.settings.kindLabels);
    APPLY_KindColors(p.settings.kindColors);
    PUSH_KindColorVars(p);
    await p.saveData(p.settings);
}

export const Get_Settings = () => {

}
