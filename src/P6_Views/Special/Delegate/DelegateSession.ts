/**
 * Special/Delegate/DelegateSession — 委托状态的持久化（读 / 写各一支）
 *
 * 委托状态是**全局单值**：谁被委托记在 settings.delegatedOwner，与「哪个视图开着」无关
 * （全局互斥，见 DelegateRegistry）。所以它的恢复与落盘不该由任何视图负责，也不该散落在
 * 各视图的会话切片里 —— 那正是先前的毛病：设计视图的 session.persistNow 里写过它一次，
 * main.onunload 里又写过一次，两处重复；而新增一个来源时谁都不确定该照哪一处抄。
 *
 * 本模块是这两个动作的**唯一入口**：
 * - RESTORE_Delegate：启动时把上次的来源接回（onReady 阶段调用）
 * - PERSIST_Delegate：把当前持有者写回设置（onunload 阶段调用）
 *
 * 视图侧不需要为持久化做任何事。它们各自把「上次的委托意图」喂给自己的共享状态源
 * （SET_PendingDelegated），那是为了消掉启动瞬间的闪烁 —— 与本模块管的是两件不同的事。
 * 写盘（Save_Setting）仍由调用方负责：本模块只管设置字段的值。
 */

import { DELEGATE } from './DelegateRegistry';
import type { PluginSettings } from '../../../P3_Settings/Settings';

/**
 * 接回上次的委托
 *
 * **只登记，不动布局**：这里刻意不调 START_Delegate —— 那个会把落点亮出来（用户点委托
 * 按钮时正该如此），而启动时抢焦点会把焦点与布局一并挪走（实测表现：重开库后焦点跑到
 * 中控台）。落点视图自己订阅登记处（见 DelegatedTree / Hub 的 unsubDelegate），工作区若
 * 把它恢复出来了，它自然会渲染那一节；没恢复出来就是「原布局」，不该由我们替它打开。
 *
 * 来源接不上（换过库、或它的视图从未打开过）时把这次意图作废：清掉设置并通知落点 ——
 * 否则中控台会一直按「将要委托」让着面板目录（那份预留见 HubView.renderDelegateSection）。
 */
export function RESTORE_Delegate(settings: PluginSettings): void {
    const owner = settings.delegatedOwner;
    if (!owner) return;
    if (!DELEGATE.delegate(owner)) {
        settings.delegatedOwner = null;
        DELEGATE.NOTIFY();
    }
}

/**
 * 把当前委托写回设置
 *
 * 取登记处的**实际持有者**，而不是某个共享状态源的 `delegated`：后者含「上次意图」那一段，
 * 会把一个尚未兑现的意图当成事实写回去（那会让下次启动去接一个本就不该存在的委托）。
 */
export function PERSIST_Delegate(settings: PluginSettings): void {
    settings.delegatedOwner = DELEGATE.active?.owner ?? null;
}
