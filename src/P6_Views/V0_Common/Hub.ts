/**
 * HubView — 中控台面板
 *
 * 所有操作面板的统一入口：列出注册表中的全部面板（图标 + 标题 + 描述），
 * 点击打开对应面板（已打开则聚焦）。
 *
 * 设计约定：各类型面板不设置 ribbon 按钮，仅通过内置指令与中控台打开；
 *
 * 另外它还承载「委托」的默认落点：设计视图左栏把框架树委托出来时，框架树作为一节
 * 直接渲染在本容器里（借用容器），而不是另开一个视图。两种落点由设置项 delegateTarget
 * 决定，渲染的树与状态完全相同（共用 DelegateTreeController）。
 *
 * 委托期间面板目录**让位**：它本来就是「选一个面板打开」的入口，而此刻用户在用框架树，
 * 目录只会挤占空间、分散注意。用容器上的 seqtk-hub-delegated 类切换，不重建目录。
 * 中控台自身通过内置指令「打开中控台」进入。
 *
 * 注册方式（散布式）：
 *   @AutoView()    声明视图注册（metas + create），由 P1_Register/View.ts 执行
 *   @AutoRegister() 声明打开命令（registerCommands），由 P1_Register/Comd.ts 执行
 */

import {ItemView, setIcon, type WorkspaceLeaf} from 'obsidian';
import {AutoRegister} from "../../P1_Register/Comd";
import {AutoView} from "../../P1_Register/View";
import type SeqtkPlugin from "../../main";
import type {PluginSettings} from "../../P3_Settings/Settings";
import {HUB_CATEGORIES, type PanelEntry} from "../panelRegistry";
import {DelegateTreeController} from '../V1_Affair/DelegateTreeController';
import {FRAMEWORK_TREE} from '../V1_Affair/Design/Slice/FrameworkTreeShared';
import {mountReact} from '../../P0_UI/ReactHost';
import type {Root} from 'react-dom/client';
import type {DataPipe} from '../../P5_Data/CoPipe/DataPipe';

/** 侧边栏中控台 */
export const VIEW_TYPE_HUB_SIDE = 'seqtk-hub-side';

@AutoView()
@AutoRegister()
export class HubView extends ItemView {
    /** 面板目录条目：hub / hub-side 仅注册视图，不进中控台目录（无 category） */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_HUB_SIDE, title: '中控台', icon: 'layout-dashboard'},
    ];
    /** 视图工厂：由 Register_View 以 (leaf) 调用；viewType 指明当前注册的条目 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): HubView {
        return new HubView(
            leaf,
            viewType,
            plugin.settings.hub,
            (vt) => plugin.activateView(vt),
            plugin.panelRegistry,
            plugin.allDeps.dataPipe,
            plugin.allDeps.settings,
        );
    }
    /** 打开命令（手写，不自动派生；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-hub-side',
            name: '打开中控台',
            callback: () => plugin.activateView(VIEW_TYPE_HUB_SIDE, 'left'),
        });
    }
    constructor(
        leaf: WorkspaceLeaf,
        /** 视图类型（侧栏 seqtk-hub-side） */
        private viewType: string = VIEW_TYPE_HUB_SIDE,
        /** 中控台管理设置（显隐与组内顺序） */
        private hubSettings?: PluginSettings['hub'],
        /** 打开面板回调（由插件提供：同大类标签页原位转变 + 打开/聚焦） */
        private onOpenPanel?: (viewType: string) => void,
        /** 面板目录（仅带 category 的 @AutoView 条目；由插件在注册时注入） */
        private entries: PanelEntry[] = [],
        /** 数据面（委托的框架树要用） */
        private pipe?: DataPipe,
        /** 插件设置（委托的框架树要用；同时提供 delegateTarget） */
        private pluginSettings?: PluginSettings,
    ) {
        super(leaf);
    }

    /** 委托框架树的状态装配（与独立视图落点共用同一份） */
    private controller: DelegateTreeController | null = null;
    /** 框架树一节的 React root（本视图是命令式的，需要手动挂载/卸载） */
    private treeRoot: Root | null = null;
    /** 共享状态订阅：委托开关变化时决定这一节显示与否 */
    private unsubShared: (() => void) | null = null;

    getViewType(): string {
        return this.viewType;
    }

    getDisplayText(): string {
        return '中控台';
    }

    getIcon(): string {
        return 'layout-dashboard';
    }

    /** 组内排序：先按 order 中出现的顺序，其余按 registry 声明顺序 */
    private orderedEntries(entries: PanelEntry[], order: string[]): PanelEntry[] {
        const byOrder = order
            .map((vt) => entries.find((e) => e.viewType === vt))
            .filter((e): e is PanelEntry => !!e);
        const rest = entries.filter((e) => !order.includes(e.viewType));
        return [...byOrder, ...rest];
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('seqtk-hub-view');

        // 委托的框架树渲染在目录之上：它是当前正在用的东西，目录是选择入口
        this.renderDelegateSection(container);

        const list = container.createDiv('seqtk-hub-list');
        for (const cat of HUB_CATEGORIES) {
            const entries = this.entries.filter((e) => e.category === cat);
            if (entries.length === 0) continue;
            const cfg = this.hubSettings?.[cat] ?? {hidden: [], order: []};
            const hiddenSet = new Set(cfg.hidden);
            const ordered = this.orderedEntries(entries, cfg.order).filter((e) => !hiddenSet.has(e.viewType));
            if (ordered.length === 0) continue; // 该分栏全部隐藏 → 不显示分栏
            const catTitle = list.createDiv('seqtk-hub-category-title');
            catTitle.setText(cat);
            for (const entry of ordered) {
                this.renderEntry(list, entry);
            }
        }
    }

    private renderEntry(list: HTMLElement, entry: PanelEntry): void {
        const item = list.createDiv('seqtk-hub-item');
        if (entry.placeholder) item.addClass('seqtk-hub-item-placeholder');
        const iconEl = item.createSpan('seqtk-hub-item-icon');
        setIcon(iconEl, entry.icon);
        item.createEl('span', { cls: 'seqtk-hub-item-title', text: entry.title });
        item.createEl('span', { cls: 'seqtk-hub-item-desc', text: entry.description ?? '' });
        if (entry.placeholder) {
            const badge = item.createSpan('seqtk-hub-item-badge');
            badge.setText('规划中');
        }
        item.addEventListener('click', () => this.openPanel(entry.viewType));
    }

    /**
     * 渲染「委托」的框架树一节（借用本容器）
     *
     * 只在已委托且落点为 hub 时渲染。两个条件都会变（开关由设计视图或本节的取消按钮改，
     * 落点由设置改），所以订阅共享状态并在变化时整节重挂 —— 这一节本身不承载输入焦点，
     * 重挂比做差量更简单也更不容易错。
     */
    private renderDelegateSection(container: HTMLElement): void {
        const wantTree = () =>
            !!this.pipe &&
            !!this.pluginSettings &&
            this.pluginSettings.delegateTarget === 'hub' &&
            FRAMEWORK_TREE.delegated;

        /** 目录显隐随委托状态切换：委托期间把它让出来，取消后还原 */
        const syncListVisibility = (): void => {
            container.classList.toggle('seqtk-hub-delegated', wantTree());
        };

        const mount = (): void => {
            if (!wantTree()) return;
            const host = container.createDiv('seqtk-hub-delegate');
            this.controller = new DelegateTreeController(
                this.app,
                this.pipe!,
                this.pluginSettings!,
                () => { FRAMEWORK_TREE.delegated = false; },
            );
            this.controller.start();
            this.treeRoot = mountReact(host, this.controller.render());
        };

        mount();
        syncListVisibility();
        this.unsubShared = FRAMEWORK_TREE.store.subscribe(() => {
            const shouldShow = wantTree();
            const isShown = !!this.treeRoot;
            // 显隐先同步：即使这一节的挂载状态没变，目录也该跟上（两处都以同一个条件为准）
            syncListVisibility();
            if (shouldShow === isShown) return;
            if (shouldShow) {
                mount();
            } else {
                this.treeRoot?.unmount();
                this.treeRoot = null;
                this.controller?.stop();
                this.controller = null;
                container.querySelector('.seqtk-hub-delegate')?.remove();
            }
        });
    }

    async onClose(): Promise<void> {
        this.unsubShared?.();
        this.unsubShared = null;
        this.treeRoot?.unmount();
        this.treeRoot = null;
        this.controller?.stop();
        this.controller = null;
    }

    /** 打开指定视图类型的面板（有回调时委托插件统一逻辑：同大类原位转变/聚焦/新建） */
    private openPanel(viewType: string): void {
        if (this.onOpenPanel) {
            this.onOpenPanel(viewType);
            return;
        }
        // 兜底（无回调）：已打开则聚焦，否则新标签页
        const {workspace} = this.app;
        const existing = workspace.getLeavesOfType(viewType)[0] ?? null;
        if (existing) {
            workspace.revealLeaf(existing);
            return;
        }
        const leaf = workspace.getLeaf('tab');
        if (leaf) {
            void leaf.setViewState({type: viewType, active: true});
            workspace.revealLeaf(leaf);
        }
    }
}
