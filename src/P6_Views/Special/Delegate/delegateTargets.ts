/**
 * Special/Delegate/delegateTargets — 发起委托时的落点编排
 *
 * 「委托」的落点由设置项 delegateTarget 决定：
 *   - 'hub'  借用中控台侧栏容器（默认）：把中控台视图开出来 / 亮出来，那一节由 HubView 渲染
 *   - 'view' 独立视图 seqtk-delegated-tree
 *
 * 发起委托只有这一条路：先让登记处接受来源（互斥，见 DelegateRegistry），
 * 再把对应落点打开或亮出来。取消委托不在这里 —— 那是 DELEGATE.release(owner)，
 * 落点自己订阅登记处、随之收起。
 */

import type { App } from 'obsidian';
import { DELEGATE, type DelegateOwner } from './DelegateRegistry';
import { VIEW_TYPE_DELEGATED_TREE } from './DelegatedTree';
import { VIEW_TYPE_HUB_SIDE } from '../Hub/Hub';
import type { PluginSettings } from '../../../P3_Settings/Settings';

/**
 * 发起委托（来源视图左栏的委托按钮都走这里）
 *
 * 返回 false = 该来源尚未注册（它所属的视图从未打开过）：没有来源就没有可委托的树，
 * 此时不动落点。落点已经开着（含工作区恢复出来的）就只亮出来，不再新开一个。
 */
export function START_Delegate(app: App, settings: PluginSettings, owner: DelegateOwner): boolean {
    if (!DELEGATE.delegate(owner)) return false;
    const viewType = (settings.delegateTarget ?? 'hub') === 'view'
        ? VIEW_TYPE_DELEGATED_TREE
        : VIEW_TYPE_HUB_SIDE;
    const opened = app.workspace.getLeavesOfType(viewType);
    if (opened.length > 0) {
        app.workspace.revealLeaf(opened[0]);
        return true;
    }
    const leaf = app.workspace.getLeftLeaf(false);
    if (leaf) {
        void leaf.setViewState({ type: viewType, active: true });
        app.workspace.revealLeaf(leaf);
    }
    return true;
}
