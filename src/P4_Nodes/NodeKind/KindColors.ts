/**
 * KindColors — 类型配色的**唯一来源**
 *
 * 消费点共用这一组色（用户要求：不同类型要能区分，且在不同地方保持一致）：
 * - 节点行 / 树的类型徽章：CSS class `.seqtk-kind-badge.kind-*` / `.role-*`
 * - 白板（Cytoscape）节点底色：`P7_Render/Structure/S3_Board/CanvasBoard`（只按大类）
 * - 附加行的类型预览：CSS class `.seqtk-inline-kind-preview.kind-*` / `.role-*`
 *
 * ⚠️ `styles.css` 里用的是同一组字面色值（CSS 读不到 TS 常量），**改动必须两处同步**；
 * 两处都以本表为准。此前的 bug 正源于两处各自为政：CSS 的类名（小写、
 * 且用了 `transaction` / `mark` 两个并不存在的类别名）与代码拼出的
 * `kind-${category}`（大写 `NODE_CATEGORY_KIND` 值）完全不匹配，
 * 导致所有类型徽章都没吃到分色规则，一起落了灰底。
 */

import { GET_CategoryOfNode, NODE_KIND, type NodeCategoryValue, type NodeKindValue } from './NodeKind';

/**
 * 大类基色（与 styles.css 的 `.seqtk-kind-badge.kind-*` 一一对应）
 *
 * FRAMEWORK 蓝 / AFFAIR 绿 / EVIDENCE 橙 / RUNTIME 红 / SCRIPT 灰 / UNKNOWN 中灰
 */
export const CATEGORY_COLORS: Record<NodeCategoryValue, string> = {
    FRAMEWORK: '#7c8cff',
    AFFAIR: '#4caf6d',
    EVIDENCE: '#e0913c',
    RUNTIME: '#e06c6c',
    SCRIPT: '#8a8a8a',
    UNKNOWN: '#9a9a9a',
};

/**
 * 事务链路角色的色阶（与 styles.css 的 `.role-*` 一一对应）
 *
 * 两条链路各用一个色相，按从属深度逐级加深 —— 行上一眼能看出「处在第几层」：
 *   主线 构想 → 方向 → 目标 → 工序（绿，与大类基色同族，目标居中）
 *   支线 清单 → 事项（青）
 * 未列入的事务类型（项目 / 事件）沿用大类色；白板仍按大类取色（GET_KindColor）。
 */
export const AFFAIR_ROLE_COLORS: Partial<Record<NodeKindValue, string>> = {
    [NODE_KIND.CONCEPT]: '#86cfa4',
    [NODE_KIND.DIRECT]: '#65bf8a',
    [NODE_KIND.TARGET]: '#4caf6d',
    [NODE_KIND.PROCESS]: '#2f8f56',
    [NODE_KIND.CHECK]: '#6fb6d0',
    [NODE_KIND.ITEM]: '#4794b3',
};

/** 角色 class 后缀（`.role-*`）：键与 AFFAIR_ROLE_COLORS 一致，样式表按同名规则配色 */
const AFFAIR_ROLE_CLASSES: Partial<Record<NodeKindValue, string>> = {
    [NODE_KIND.CONCEPT]: 'role-concept',
    [NODE_KIND.DIRECT]: 'role-direct',
    [NODE_KIND.TARGET]: 'role-target',
    [NODE_KIND.PROCESS]: 'role-process',
    [NODE_KIND.CHECK]: 'role-check',
    [NODE_KIND.ITEM]: 'role-item',
};

/**
 * 徽章用的 CSS class。
 *
 * 大类色 + 链路角色色：事务链路再按角色细分，其它大类只按大类着色。
 * 统一转小写，与 styles.css 的 `.kind-*` / `.role-*` 对齐 —— 不要改成直接内插 category
 * （`NODE_CATEGORY_KIND` 的值是大写，会与样式表失配，这正是修复前的 bug）。
 */
export const GET_KindClass = (kind: NodeKindValue): string => {
    const category = `kind-${GET_CategoryOfNode(kind).toLowerCase()}`;
    const role = AFFAIR_ROLE_CLASSES[kind];
    return role ? `${category} ${role}` : category;
};

/** 按大类取色（已知 category 的场景，如附加行预览） */
export const GET_CategoryColor = (category: NodeCategoryValue): string =>
    CATEGORY_COLORS[category] ?? CATEGORY_COLORS.UNKNOWN;

/** 节点颜色：按所属大类取色（白板节点着色；未知类型落 UNKNOWN） */
export const GET_KindColor = (kind: NodeKindValue): string =>
    CATEGORY_COLORS[GET_CategoryOfNode(kind)] ?? CATEGORY_COLORS.UNKNOWN;
