/**
 * flowDesign/host — 流程设计各切片对「视图」的最小依赖
 *
 * 与事务设计的 NodeEditHost 同一思路：切片只认识这个接口，不认识 FlowView 类，
 * 于是「视图壳 ⇄ 切片」不会成环，切片也能被别的宿主复用。
 *
 * 刻意保持**小**：只列切片真正用到的成员。接口每多一个成员，能实现它的地方就少一圈。
 */

import type { App } from 'obsidian';
import type { DataPipe } from '../../../../P5_Data/CoPipe/DataPipe';
import type { PluginSettings } from '../../../../P3_Settings/Settings';

export interface FlowDesignHost {
    readonly app: App;
    /** 数据面唯一入口（脚本本身就是 NODE_KIND.FLOW 节点） */
    readonly pipe: DataPipe;
    readonly settings: PluginSettings;

    /** 当前选中的脚本 nodeId（null = 未选）；切片协作可见 */
    currentScriptId: string | null;
    /** 当前脚本的正文文本（脚本态编辑 / LAD 序列化都落在它上面）；切片协作可见 */
    currentText: string;
    /** 右栏模式；切片协作可见 */
    mode: 'script' | 'lad';

    /** 重算左栏与右栏外壳状态（数据 → 视图状态） */
    recompute(): void;
    /** 重绘右栏内容 */
    renderContent(): void;
    /** LAD 改动落回脚本文本并重绘（AST → serialize） */
    commitAst(): void;
    /** 安排一次防抖自动保存（脚本态敲字 / LAD 改动都汇到这里） */
    scheduleSaveScript(): void;
}
