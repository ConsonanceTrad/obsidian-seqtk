/**
 * Special/Delegate/rowMenuRegistry — 委托面板里「行右键菜单」的装配器登记处（按来源分槽）
 *
 * 背景：委托出去的那棵树渲染在中控台侧栏里，那里**没有**来源视图的实例。可菜单里不少项
 * 要读视图状态（选中了谁、哪一栏发起的、右栏来路栈…），所以这些装配只能由视图提供。
 * 视图在挂载时把装配好的那一套登记到这里、卸载时撤掉，来源按 owner 取出转发给面板 ——
 * 于是「委托前后菜单是同一套」，而不是各写一份（那正是菜单慢慢漂移的成因）。
 *
 * **按 owner 分槽**是这个模块的全部意义：早先它是单个模块级变量，只能容下一个来源，
 * 于是第二个来源一旦登记就会把前一个顶掉（谁后挂载谁生效）。分槽后各保持各的，
 * 互不干扰。
 *
 * 另一条路（见 Template/Slice/templateDelegate）：若来源的菜单**不需要**视图状态、
 * 只用面板给的 host 就能拼出来，那就直接在 DelegateSource 里写 rowMenu，不必来登记 ——
 * 那种来源在视图关掉之后菜单依然可用，反而更强。本登记处服务的是前者。
 */

import type { NodeLineCtx } from '../../../P7_Render/Composition/C1_NodeLine/NodeLine';
import type { DelegateOwner, DelegateTreeHost } from './DelegateRegistry';

/** 视图提供的行菜单装配器 */
export type RowMenuHandler = (ctx: NodeLineCtx, e: MouseEvent) => void;

const handlers = new Map<DelegateOwner, RowMenuHandler>();

/**
 * 登记（传函数）或撤销（传 null）某个来源的行菜单装配器
 *
 * 由来源视图在挂载 / 卸载时调用。撤销只影响自己那一个槽 —— 这是分槽与单个变量的差别。
 */
export function SET_RowMenu(owner: DelegateOwner, fn: RowMenuHandler | null): void {
    if (fn) handlers.set(owner, fn);
    else handlers.delete(owner);
}

/**
 * 取某个来源的行菜单（`DelegateSource.rowMenu` 用）
 *
 * 用 getter 调用而不是把结果存下来：装配器是视图挂载时才登记的，视图从未打开过就取不到 ——
 * 那时返回 undefined，面板据此退回默认三项（见 DelegateTreeController.showRowMenu）。
 */
export function GET_RowMenu(
    owner: DelegateOwner,
): ((host: DelegateTreeHost, ctx: NodeLineCtx, e: MouseEvent) => void) | undefined {
    const handler = handlers.get(owner);
    if (!handler) return undefined;
    // host 用不上：菜单完全由视图那边的装配器决定（面板的 host 只在默认三项里用）
    return (_host: DelegateTreeHost, ctx: NodeLineCtx, e: MouseEvent) => handler(ctx, e);
}
