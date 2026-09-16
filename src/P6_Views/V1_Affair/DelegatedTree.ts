/**
 * DelegatedTreeView — 委托的框架树（独立视图落点）
 *
 * 设计视图左栏可用图标按钮把框架树「委托」出去，便于在别的视图工作时仍能展开、选中框架。
 * 两处**共享**展开与选中状态（单一事实源：design/FrameworkTreeShared），
 * 因此在任一处展开/选中，另一处同步反映。
 *
 * 落点由设置项 delegateTarget 决定：
 *   - 'hub'  借用中控台侧栏容器（默认）—— 见 V0_Common/Hub.ts 的框架树一节
 *   - 'view' 本独立视图
 * 两者渲染同一棵树、同一份状态，状态装配都在 DelegateTreeController 里，本类只负责挂载。
 *
 * 本面板是**只读委托**：只提供展开与选中 —— 右键菜单、行内新建、拖拽排序等编辑能力
 * 留在设计视图左栏。两个入口同时改同一棵树会让「谁在编辑」变得难以预期。
 */

import type { ReactNode } from "react";
import type { WorkspaceLeaf } from "obsidian";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { DelegateTreeController } from "./DelegateTreeController";
import { FRAMEWORK_TREE } from "./Design/Slice/FrameworkTreeShared";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { DataPipe } from "../../P5_Data/CoPipe/DataPipe";
import type { PluginSettings } from "../../P3_Settings/Settings";

export const VIEW_TYPE_DELEGATED_TREE = 'seqtk-delegated-tree';

@AutoView()
@AutoRegister()
export class DelegatedTreeView extends ReactViewBase {
    /**
     * 面板目录条目
     *
     * 不设 category：它是「委托」的落点（由设计视图左栏的按钮打开），
     * 不该出现在中控台的面板目录里，否则会出现「打开一个空壳」的入口。
     */
    static metas: PanelEntry[] = [
        {
            viewType: VIEW_TYPE_DELEGATED_TREE,
            title: '框架树委托',
            icon: 'panel-left',
            description: '设计视图左栏的框架树被委托到此，与左栏共享展开与选中状态。',
        },
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): DelegatedTreeView {
        return new DelegatedTreeView(leaf, plugin.allDeps.dataPipe, plugin.allDeps.settings);
    }

    /** 打开命令（同时置位委托开关，设计视图左栏据此显示「取消委托」） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-delegated-tree',
            name: '委托框架树到侧栏（独立视图）',
            callback: () => {
                FRAMEWORK_TREE.delegated = true;
                void plugin.activateView(VIEW_TYPE_DELEGATED_TREE, 'left');
            },
        });
    }

    /** 委托框架树的状态装配（与中控台那个落点共用同一份） */
    private readonly controller = new DelegateTreeController(
        this.app,
        this.pipe,
        this.settings,
        () => void this.cancelDelegate(),
    );

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
        return '框架树';
    }

    getIcon(): string {
        return 'panel-left';
    }

    /** 渲染件在 DelegatedTreePanel.tsx；视图类不写 JSX 字面量 */
    protected renderPanel(): ReactNode {
        return this.controller.render();
    }

    protected onMounted(): void {
        this.controller.start();
    }

    protected onBeforeUnmount(): void {
        this.controller.stop();
        // 面板被直接关闭（而非经「取消委托」）时也要复位委托开关
        FRAMEWORK_TREE.delegated = false;
    }

    /** 取消委托：复位开关并关闭本面板（框架树交还设计视图左栏） */
    private async cancelDelegate(): Promise<void> {
        FRAMEWORK_TREE.delegated = false;
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DELEGATED_TREE)) {
            leaf.detach();
        }
    }
}
