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
 * 此时不动落点。
 *
 * 注意：本函数**会把落点亮出来**（用户刚点完按钮，需要看到反馈），所以**启动恢复那条路
 * 不该用它** —— 启动时抢焦点会破坏原布局，那条路走 DelegateSession.RESTORE_Delegate。
 */
export function START_Delegate(app: App, settings: PluginSettings, owner: DelegateOwner): boolean {
    if (!DELEGATE.delegate(owner)) return false;
    OPEN_DelegateTarget(app, settings);
    return true;
}

/**
 * 把落点打开或亮出来
 *
 * 从 START_Delegate 里抽出来，是为了让「登记委托」与「动布局」成为两件可分开的事：
 * 用户点委托按钮时两者都要，而**启动恢复时只要前者**（见 RESTORE_Delegate）。
 * 之所以恢复时不开也行：落点视图自己订阅登记处（见 DelegatedTree / Hub 的 unsubDelegate），
 * 工作区把它恢复出来了它就会渲染，没恢复出来则是「原布局」—— 本就不该由我们替它打开。
 */
function OPEN_DelegateTarget(app: App, settings: PluginSettings): void {
    const viewType = (settings.delegateTarget ?? 'hub') === 'view'
        ? VIEW_TYPE_DELEGATED_TREE
        : VIEW_TYPE_HUB_SIDE;
    // 已开着（含工作区恢复出来的）就只亮出来，不再新开一个
    const opened = app.workspace.getLeavesOfType(viewType);
    if (opened.length > 0) {
        app.workspace.revealLeaf(opened[0]);
        return;
    }
    const leaf = app.workspace.getLeftLeaf(false);
    if (leaf) {
        void leaf.setViewState({ type: viewType, active: true });
        app.workspace.revealLeaf(leaf);
    }
}

/**
 * 把焦点移回某个来源视图；它没开着就打开一个
 *
 * 用于委托面板里点行末的「在右侧打开」：那时用户真正想看的是**来源视图**（那里有完整的两栏，
 * 面板里这棵树只是它的镜像）。与 START_Delegate 的区别：那边管的是**落点**（侧栏面板），
 * 这里管的是**来源**（设计 / 模板 / 线路视图本身），两者是委托关系里相反的两端。
 */
export function REVEAL_SourceView(app: App, viewType: string): void {
    const opened = app.workspace.getLeavesOfType(viewType);
    if (opened.length > 0) {
        app.workspace.revealLeaf(opened[0]);
        return;
    }
    // 没开着就新开一个：来源视图是主区标签页（与落点的侧栏不同）
    const leaf = app.workspace.getLeaf('tab');
    if (!leaf) return;
    void leaf.setViewState({ type: viewType, active: true });
    app.workspace.revealLeaf(leaf);
}
