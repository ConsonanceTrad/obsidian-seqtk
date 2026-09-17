/**
 * KindColors — 类型配色的**唯一来源**
 *
 * 颜色的流向只有一条，别再让它分叉：
 *
 *   KindColors 的两张生效表（TS）
 *     ├─ 白板（Cytoscape）节点底色：直接取 GET_KindColor / GET_CategoryColor
 *     └─ 徽章与附加行预览：类名只负责「结构」（.kind-* / .role-*），颜色由 CSS 变量
 *        提供 —— 每项一对：底色 `--seqtk-kind-* / --seqtk-role-*`，文字色 `*-text`。
 *        插件启动与设置落盘时把生效值推进这些变量（见 P3_Settings/Settings.ts 的 PUSH_KindColorVars）
 *
 * 于是 styles.css 里只剩「变量名 + 出厂回退值」。此前 CSS 与 TS 各存一份字面色值、
 * 改色必须两处手动同步的日子到此为止（那个双源正是历史上"徽章全部落灰底"的根源）。
 *
 * 消费点：节点行 / 树的类型徽章、附加行（行内新建）的类型预览、白板节点底色。
 */

import { GET_CategoryOfNode, NODE_KIND, type NodeCategoryValue, type NodeKindValue } from './NodeKind';
// 设置页清单要用的显示名：当前名取自 NODE_KIND_LABELS（会跟随用户改的名字），
// 出厂名取自 DEFAULT_KIND_LABELS
import {
    DEFAULT_KIND_LABELS,
    NODE_CATEGORY_LABELS as CATEGORY_LABELS,
    NODE_KIND_LABELS as KIND_LABELS,
} from './NodeLabel';

/**
 * 大类基色的出厂值
 *
 * FRAMEWORK 蓝 / AFFAIR 绿 / EVIDENCE 橙 / RUNTIME 红 / SCRIPT 灰 / UNKNOWN 中灰
 */
const BUILTIN_CATEGORY_COLORS: Record<NodeCategoryValue, string> = {
    FRAMEWORK: '#7c8cff',
    AFFAIR: '#4caf6d',
    EVIDENCE: '#e0913c',
    RUNTIME: '#e06c6c',
    SCRIPT: '#8a8a8a',
    UNKNOWN: '#9a9a9a',
};

/**
 * 事务链路角色色的出厂值
 *
 * 两条链路各用一个色相，按从属深度逐级加深 —— 行上一眼能看出「处在第几层」：
 *   主线 构想 → 方向 → 目标 → 工序（绿，与大类基色同族，目标居中）
 *   支线 清单 → 事项（青）
 * 未列入的事务类型（项目 / 事件）沿用大类色；白板仍按大类取色（GET_KindColor）。
 */
const BUILTIN_ROLE_COLORS: Partial<Record<NodeKindValue, string>> = {
    [NODE_KIND.CONCEPT]: '#86cfa4',
    [NODE_KIND.DIRECT]: '#65bf8a',
    [NODE_KIND.TARGET]: '#4caf6d',
    [NODE_KIND.PROCESS]: '#2f8f56',
    [NODE_KIND.CHECK]: '#6fb6d0',
    [NODE_KIND.ITEM]: '#4794b3',
};

/** 角色 class 后缀（`.role-*`）：键与角色色表一致，样式表按同名规则配色 */
const AFFAIR_ROLE_CLASSES: Partial<Record<NodeKindValue, string>> = {
    [NODE_KIND.CONCEPT]: 'role-concept',
    [NODE_KIND.DIRECT]: 'role-direct',
    [NODE_KIND.TARGET]: 'role-target',
    [NODE_KIND.PROCESS]: 'role-process',
    [NODE_KIND.CHECK]: 'role-check',
    [NODE_KIND.ITEM]: 'role-item',
};

// ============================================================
// 生效表 / 出厂值
// ============================================================

/** 出厂值快照（只读）：设置页的「恢复默认」与默认色显示据此 */
export const DEFAULT_CATEGORY_COLORS: Readonly<Record<NodeCategoryValue, string>> = {...BUILTIN_CATEGORY_COLORS};
export const DEFAULT_ROLE_COLORS: Readonly<Partial<Record<NodeKindValue, string>>> = {...BUILTIN_ROLE_COLORS};

/**
 * 当前生效的大类基色 —— **活表**
 *
 * 与 NODE_KIND_LABELS 同款设计：插件启动与设置落盘时由 APPLY_KindColors 就地覆盖，
 * 消费点直接读它，不必各自去问设置。默认值见 DEFAULT_CATEGORY_COLORS。
 */
export const CATEGORY_COLORS: Record<NodeCategoryValue, string> = {...BUILTIN_CATEGORY_COLORS};

/** 当前生效的事务角色色（活表；同上） */
export const AFFAIR_ROLE_COLORS: Partial<Record<NodeKindValue, string>> = {...BUILTIN_ROLE_COLORS};

// ============================================================
// 文字色
// ============================================================

/**
 * 徽章 / 附加行预览上的字色
 *
 * 出厂一律白色 —— 底色都是有彩度的中低亮度色，白字最稳（早先只有 concept / direct / check
 * 三档浅绿、浅青用深字，现在统一为白）。想用黑字时打开该项自己的「字体反色」开关，
 * 开关是**逐项**的：底色是按项配的，字色是否该反也应当按项决定。
 *
 * 开关只做一件事：把该项的文字色变量换成黑色 —— 不自动算对比度，
 * 改了底色之后白字还是黑字更清楚，那是用户的取舍，这里不猜。
 */
export const DEFAULT_KIND_TEXT_COLOR = '#fff';
export const INVERTED_KIND_TEXT_COLOR = '#000';

/** 反色开关 → 文字色（关：白字；开：黑字） */
export const GET_TextColorOf = (inverted: boolean | undefined): string =>
    inverted ? INVERTED_KIND_TEXT_COLOR : DEFAULT_KIND_TEXT_COLOR;

// ============================================================
// 变量名 / 取值
// ============================================================

/** 大类底色的 CSS 变量名（与 styles.css 的 `.kind-*` 规则一一对应） */
export const GET_CategoryColorVar = (category: NodeCategoryValue): string =>
    `--seqtk-kind-${category.toLowerCase()}`;

/** 角色底色的 CSS 变量名（与 styles.css 的 `.role-*` 规则一一对应）；非角色类型返回 null */
export const GET_RoleColorVar = (kind: NodeKindValue): string | null => {
    const cls = AFFAIR_ROLE_CLASSES[kind];
    return cls ? `--seqtk-${cls}` : null;
};

/** 大类文字色的 CSS 变量名（底色变量名 + `-text`） */
export const GET_CategoryTextVar = (category: NodeCategoryValue): string =>
    `${GET_CategoryColorVar(category)}-text`;

/** 角色文字色的 CSS 变量名；非角色类型返回 null */
export const GET_RoleTextVar = (kind: NodeKindValue): string | null => {
    const base = GET_RoleColorVar(kind);
    return base ? `${base}-text` : null;
};

/** 按大类取色（已知 category 的场景，如附加行预览） */
export const GET_CategoryColor = (category: NodeCategoryValue): string =>
    CATEGORY_COLORS[category] ?? CATEGORY_COLORS.UNKNOWN;

/** 节点颜色：按所属大类取色（白板节点着色；未知类型落 UNKNOWN） */
export const GET_KindColor = (kind: NodeKindValue): string =>
    CATEGORY_COLORS[GET_CategoryOfNode(kind)] ?? CATEGORY_COLORS.UNKNOWN;

/**
 * 徽章用的 CSS class。
 *
 * 大类色 + 链路角色色：事务链路再按角色细分，其它大类只按大类着色。
 * 统一转小写，与 styles.css 的 `.kind-*` / `.role-*` 对齐 —— 不要改成直接内插 category
 * （`NODE_CATEGORY_KIND` 的值是大写，会与样式表失配，这正是修复前的 bug）。
 * 颜色本身不在这里，见文件头：class 只管结构，颜色走 CSS 变量。
 */
export const GET_KindClass = (kind: NodeKindValue): string => {
    const category = `kind-${GET_CategoryOfNode(kind).toLowerCase()}`;
    const role = AFFAIR_ROLE_CLASSES[kind];
    return role ? `${category} ${role}` : category;
};

// ============================================================
// 覆盖 / 注入 / 设置页清单
// ============================================================

/** 设置项的两个键前缀（见 GET_KindAppearanceGroups） */
const KEY_CATEGORY = 'category.';
const KEY_ROLE = 'role.';

/** 合法色值：#rgb / #rrggbb / 带 alpha 的 4/8 位十六进制（颜色选择器给的都是这一族） */
const IS_ColorValue = (value: string): boolean => /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);

/**
 * 用用户配置刷新两张底色表
 *
 * 与 APPLY_KindLabels 同款做法：先整体还原出厂值、再套覆盖 ——
 * 否则"把某个颜色改回默认"会残留上一轮的旧色。
 * 键形如 `category.AFFAIR` / `role.AFFAIR_CONCEPT`（见 GET_KindAppearanceGroups）；
 * 认不出的键、空值、不像色值的字符串一律忽略。
 *
 * 文字色不在这张表里：它是由「字体反色」开关逐项决定的（见 GET_KindColorVars）。
 */
export function APPLY_KindColors(overrides?: Record<string, string> | null): void {
    Object.assign(CATEGORY_COLORS, BUILTIN_CATEGORY_COLORS);
    Object.assign(AFFAIR_ROLE_COLORS, BUILTIN_ROLE_COLORS);
    if (!overrides) return;

    for (const [key, value] of Object.entries(overrides)) {
        const color = typeof value === 'string' ? value.trim() : '';
        if (!IS_ColorValue(color)) continue;

        if (key.startsWith(KEY_CATEGORY)) {
            const category = key.slice(KEY_CATEGORY.length) as NodeCategoryValue;
            if (category in BUILTIN_CATEGORY_COLORS) CATEGORY_COLORS[category] = color;
        } else if (key.startsWith(KEY_ROLE)) {
            const kind = key.slice(KEY_ROLE.length) as NodeKindValue;
            if (kind in BUILTIN_ROLE_COLORS) AFFAIR_ROLE_COLORS[kind] = color;
        }
    }
}

/**
 * 全部颜色变量（变量名 → 当前值）：每项一个底色 + 一个文字色
 *
 * 调用方把结果写进 CSS 变量（一般挂在 body / documentElement 上），徽章与附加行预览
 * 就跟着变色了。白板不走这条路，它直接读上面的生效表。
 *
 * @param inverted 逐项的「字体反色」开关状态，键与 GET_KindAppearanceGroups 一致
 *                 （`category.AFFAIR` / `role.AFFAIR_CONCEPT`）；缺省即全白字
 */
export function GET_KindColorVars(inverted: Record<string, boolean> = {}): Record<string, string> {
    const vars: Record<string, string> = {};

    for (const [category, color] of Object.entries(CATEGORY_COLORS)) {
        const cat = category as NodeCategoryValue;
        vars[GET_CategoryColorVar(cat)] = color;
        vars[GET_CategoryTextVar(cat)] = GET_TextColorOf(inverted[`${KEY_CATEGORY}${cat}`]);
    }

    for (const [kind, color] of Object.entries(AFFAIR_ROLE_COLORS)) {
        const k = kind as NodeKindValue;
        const colorVar = GET_RoleColorVar(k);
        const textVar = GET_RoleTextVar(k);
        if (colorVar && color) vars[colorVar] = color;
        if (textVar) vars[textVar] = GET_TextColorOf(inverted[`${KEY_ROLE}${k}`]);
    }

    return vars;
}

// ============================================================
// 设置页清单：按大类聚合
// ============================================================

/** 设置页的一项配色：覆盖键、这一行的名字、当前底色、出厂底色、是否已开字体反色 */
export interface KindColorItem {
    key: string;
    label: string;
    value: string;
    defaultColor: string;
    inverted: boolean;
}

/** 设置页里的一个类型：当前名 / 出厂名 / 它自己的角色色（没有则为 null） */
export interface KindAppearanceType {
    kind: NodeKindValue;
    /** 当前生效名（用户改过就是改后的） */
    label: string;
    /** 出厂名：输入框的初值与 placeholder 用 */
    defaultLabel: string;
    roleItem: KindColorItem | null;
}

/** 设置页的一组：一个大类 + 它的大类基色 + 该类下的类型（各自带可选的角色色） */
export interface KindAppearanceGroup {
    title: string;
    categoryItem: KindColorItem;
    kinds: KindAppearanceType[];
}

/** 设置页的分组顺序（UNKNOWN 排最后：它没有类型，只提供大类色） */
const APPEARANCE_CATEGORY_ORDER: NodeCategoryValue[] = [
    'FRAMEWORK',
    'AFFAIR',
    'EVIDENCE',
    'RUNTIME',
    'SCRIPT',
    'UNKNOWN',
];

/**
 * 设置页用：把「类型名」与「配色」按大类聚合到一处
 *
 * 设置页照着它就能一行行渲染：每组先一行大类基色，随后每个类型一行更名，
 * 类型若还有自己的角色色，则紧跟一行角色色 —— 名字与颜色因此总是挨在一起，
 * 不必在"一长串名字"和"一长串颜色"之间来回对照。
 *
 * 组的粒度沿用既有分色体系，不做更细的"每个类型一个色"：
 * - 大类基色 6 项（框架 / 事务 / 证据 / 运行 / 脚本 / 外部）
 * - 事务链路角色色 6 项（构想 → 方向 → 目标 → 工序，清单 / 事项）
 *
 * @param inverted 逐项的「字体反色」开关状态（键同上面的覆盖键）
 */
export function GET_KindAppearanceGroups(
    inverted: Record<string, boolean> = {},
): KindAppearanceGroup[] {
    const allKinds = Object.keys(DEFAULT_KIND_LABELS) as NodeKindValue[];

    return APPEARANCE_CATEGORY_ORDER.map((category) => {
        const categoryKey = `${KEY_CATEGORY}${category}`;
        return {
            title: CATEGORY_LABELS[category],
            categoryItem: {
                key: categoryKey,
                label: '大类基色',
                value: CATEGORY_COLORS[category],
                defaultColor: BUILTIN_CATEGORY_COLORS[category],
                inverted: !!inverted[categoryKey],
            },
            kinds: allKinds
                .filter((kind) => GET_CategoryOfNode(kind) === category)
                .map((kind) => {
                    const roleKey = `${KEY_ROLE}${kind}`;
                    const hasRole = kind in BUILTIN_ROLE_COLORS;
                    return {
                        kind,
                        label: KIND_LABELS[kind] ?? kind,
                        defaultLabel: DEFAULT_KIND_LABELS[kind] ?? kind,
                        roleItem: hasRole
                            ? {
                                  key: roleKey,
                                  label: '角色色',
                                  value: AFFAIR_ROLE_COLORS[kind] ?? '',
                                  defaultColor: BUILTIN_ROLE_COLORS[kind] ?? '',
                                  inverted: !!inverted[roleKey],
                              }
                            : null,
                    };
                }),
        };
    });
}
