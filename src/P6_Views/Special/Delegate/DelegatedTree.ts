/**
 * DelegatedTreeView — 委托树（独立视图落点）
 *
 * 「委托」= 把某个来源左栏的树交给侧栏显示。谁在委托由 DelegateRegistry 登记
 * （全局互斥，同时只有一份）：设计视图左栏的框架树、模板模式的模板框架树都可能落在这里。
 * 本视图只是**落点** —— 树、标题与行菜单都由 DELEGATE.active 那份来源给出，
 * 展开与选中也记在来源那一侧，于是与来源视图天然一致。
 *
 * 落点由设置项 delegateTarget 决定：
 *   - 'hub'  借用中控台侧栏容器（默认）—— 见 Special/Hub/Hub.ts 的那一节
 *   - 'view' 本独立视图
 *
 * 被抢占（另有来源发起委托）或委托被取消（登记处为空）时，本视图自己关掉自己 ——
 * 空壳面板留着只会让人以为委托还在。
 */

import type { ReactNode } from "react";
import type { WorkspaceLeaf } from "obsidian";
import { AutoView } from "../../../P1_Register/View";
import { AutoRegister } from "../../../P1_Register/Comd";
import { ReactViewBase } from "../../../P0_UI/ViewBase";
import { DelegateTreeController } from "./DelegateTreeController";
import { DELEGATE } from "./DelegateRegistry";
import { DESIGN_DELEGATE } from "../../V1_Affair/Design/Slice/FrameworkTreeShared";
import type SeqtkPlugin from "../../../main";
import type { PanelEntry } from "../../panelRegistry";
import type { DataPipe } from "../../../P5_Data/CoPipe/DataPipe";
import type { PluginSettings } from "../../../P3_Settings/Settings";

export const VIEW_TYPE_DELEGATED_TREE = 'seqtk-delegated-tree';

@AutoView()
@AutoRegister()
export class DelegatedTreeView extends ReactViewBase {
    /**
     * 面板目录条目
     *
     * 不设 category：它是「委托」的落点（由来源视图左栏的按钮打开），
     * 不该出现在中控台的面板目录里，否则会出现「打开一个空壳」的入口。
     */
    static metas: PanelEntry[] = [
        {
            viewType: VIEW_TYPE_DELEGATED_TREE,
            title: '树委托',
            icon: 'panel-left',
            description: '被委托的树落在此处（设计左栏的框架树 / 模板模式的模板框架树），与来源视图共享展开与选中。',
        },
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): DelegatedTreeView {
        return new DelegatedTreeView(leaf, plugin.allDeps.dataPipe, plugin.allDeps.settings);
    }

    /** 打开命令：把设计来源委托到独立视图落点（落点仍按设置里的 delegateTarget） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-delegated-tree',
            name: '委托框架树到侧栏（独立视图）',
            callback: () => {
                DELEGATE.delegate('design');
                void plugin.activateView(VIEW_TYPE_DELEGATED_TREE, 'left');
            },
        });
    }

    /**
     * 委托树的状态装配（与中控台那个落点共用同一份）
     *
     * 来源取登记处当前的 active；工作区恢复出的面板可能在登记处还没有记录
     * （重开库时内存是空的），此时按设计来源兜底 —— start() 会把这份来源补登记。
     */
    private readonly controller = new DelegateTreeController(
        this.app,
        this.pipe,
        this.settings,
        DELEGATE.active ?? DESIGN_DELEGATE,
        () => void this.cancelDelegate(),
    );

    /** 登记处的订阅（落点自己跟随委托的存亡） */
    private unsubDelegate: (() => void) | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        private pipe: DataPipe,
        private settings: PluginSettings,
    ) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_DELEGATED_TREE;
    }

    getDisplayText(): string {
        return '树';
    }

    getIcon(): string {
        return 'panel-left';
    }

    /** 渲染件在 DelegatedTreePanel.tsx；视图类不写 JSX 字面量 */
    protected renderPanel(): ReactNode {
        return this.controller.render();
    }

    protected onMounted(): void {
        this.controller.source = DELEGATE.active ?? this.controller.source;
        this.controller.start();
        this.unsubDelegate = DELEGATE.store.subscribe(() => this.syncWithDelegate());
    }

    /**
     * 落点跟随登记处：换来源就换树；没有委托了就关掉自己
     *
     * 「被抢占」也走这里 —— 新的委托一登记，旧落点（若就是本视图）自动退场，
     * 不会和新的那份并排站着。
     */
    private syncWithDelegate(): void {
        const active = DELEGATE.active;
        if (!active) {
            this.detachSelf();
            return;
        }
        if (active !== this.controller.source) {
            this.controller.source = active;
            this.controller.recompute();
        }
    }

    protected onBeforeUnmount(): void {
        this.unsubDelegate?.();
        this.unsubDelegate = null;
        this.controller.stop();
        // 面板被直接关闭（而非经「取消委托」）时也要收掉这份委托；
        // 但只收「本面板承载的那一份」—— 被抢占后这里就不再匹配，不会误放别人的委托
        DELEGATE.release(this.controller.source.owner);
    }

    /** 取消委托：释放登记处并关闭本面板（树交还来源视图） */
    private async cancelDelegate(): Promise<void> {
        DELEGATE.release(this.controller.source.owner);
        this.detachSelf();
    }

    private detachSelf(): void {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DELEGATED_TREE)) {
            leaf.detach();
        }
    }
}
