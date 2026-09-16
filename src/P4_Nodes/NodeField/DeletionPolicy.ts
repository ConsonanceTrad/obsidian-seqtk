/**
 * DeletionPolicy — 归档 / 删除时对后代的处理策略与提示级别
 *
 * 与状态传播（Propagation.ts）**分开配置**：那一条管「状态怎么跟着变」，
 * 这一条管「子树怎么被带走、要不要拦一道」。原先只有一个布尔
 * `archiveConfirmPrompt`，既表达不了后代的处理方式，也表达不了提示的强度。
 */

/** 归档父节点时，其后代如何处理 */
export type ArchiveChildrenMode =
    /** 只归档自身，后代留在原处 */
    | 'keep'
    /** 后代一并归档 */
    | 'archive';

/** 删除父节点时，其后代如何处理 */
export type DeleteChildrenMode =
    /** 只删自身（后代成为无父节点） */
    | 'keep'
    /** 后代一并归档（保留内容，可回收） */
    | 'archive'
    /** 后代一并删除（级联，进系统回收站） */
    | 'delete';

/**
 * 破坏性操作的提示级别
 *
 * - `none`：直接执行，不打断
 * - `children`：仅当该节点**含子节点**时才提示 —— 平衡安全与迅捷：动一棵子树前问一句，
 *   日常对叶子节点的操作则不打断
 * - `simple`：确认 / 取消（显示影响范围）
 * - `strict`：另需手动输入确认词，防误触
 */
export type ConfirmLevel = 'none' | 'children' | 'simple' | 'strict';

/** 归档 / 删除相关策略（存放于 PluginSettings） */
export interface DestructivePolicy {
    /** 归档父节点时，后代如何处理 */
    archiveChildren: ArchiveChildrenMode;
    /** 删除父节点时，后代如何处理 */
    deleteChildren: DeleteChildrenMode;
    /** 归档时的提示级别 */
    archiveConfirm: ConfirmLevel;
    /** 删除时的提示级别 */
    deleteConfirm: ConfirmLevel;
}

/**
 * 默认策略
 *
 * 归档：只动自身（归档语义是「从快速缓存移除」，子孙不该被牵连）
 * 删除：级联删子树（原先就是级联；改成可配后默认仍是它，行为不变）
 * 提示：归档可逆且是日常动作 → 只在动到子树时问一句（`children`）；
 *       删除级联且进系统回收站、风险更高 → 默认总是问一次（`simple`）
 */
export const DEFAULT_DESTRUCTIVE_POLICY: DestructivePolicy = {
    archiveChildren: 'keep',
    deleteChildren: 'delete',
    archiveConfirm: 'children',
    deleteConfirm: 'simple',
};

/**
 * 该提示级别在「本次操作对象有无子节点」下是否需要弹窗
 *
 * `children` 档把「有无子节点」当判据；这个事实由调用方从数据层取好传进来 ——
 * 本模块只做策略判断，不查数据。
 */
export const NEEDS_Confirm = (level: ConfirmLevel, hasChildren: boolean): boolean => {
    if (level === 'none') return false;
    if (level === 'children') return hasChildren;
    return true;
};

/** strict 级别需要手动输入的确认词 */
export const STRICT_CONFIRM_WORD = '删除';

/** 策略可选值的显示名 */
export const ARCHIVE_CHILDREN_LABELS: Record<ArchiveChildrenMode, string> = {
    keep: '只归档自身',
    archive: '后代一并归档',
};

export const DELETE_CHILDREN_LABELS: Record<DeleteChildrenMode, string> = {
    keep: '只删除自身（后代脱离父级）',
    archive: '后代一并归档',
    delete: '后代一并删除（级联）',
};

export const CONFIRM_LEVEL_LABELS: Record<ConfirmLevel, string> = {
    none: '不提示，直接执行',
    children: '仅当含子节点时提示',
    simple: '提示一次（确认 / 取消）',
    strict: `提示并要求输入「${STRICT_CONFIRM_WORD}」`,
};
