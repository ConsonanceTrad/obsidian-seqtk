/**
 * PlaceholderView — 未实现功能口的通用占位视图
 *
 * 中控台展示操作口目录中尚未实现的功能口，点击打开此占位视图，
 * 展示标题、描述与规划要点（内容摘录自操作口目录）。
 */

import {AutoView} from "../../../P1_Register/View";
import {AutoRegister} from "../../../P1_Register/Comd";
import type SeqtkPlugin from "../../../main";
import type {PanelEntry} from "../../panelRegistry";
import { ItemView, WorkspaceLeaf } from 'obsidian';

export const VIEW_TYPE_EXEC_DESIGN = 'seqtk-exec-design';
export const VIEW_TYPE_EXEC_BIND = 'seqtk-exec-bind';
export const VIEW_TYPE_QUERY_DESIGN = 'seqtk-query-design';
export const VIEW_TYPE_COLLAB = 'seqtk-collab';
export const VIEW_TYPE_LOG = 'seqtk-log';

interface PlaceholderOptions {
    title: string;
    desc: string;
    /** 规划要点列表 */
    points?: string[];
}

@AutoView()
@AutoRegister()
export class PlaceholderView extends ItemView {
    /** 面板目录条目（占位：智能协作尚无独立视图文件） */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_COLLAB, title: '智能协作', icon: 'bot', description: '智能体工作控制。', category: '节点通用', placeholder: true},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用；按 viewType 提供占位内容 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): PlaceholderView {
        const opts: PlaceholderOptions = viewType === VIEW_TYPE_COLLAB
            ? {
                title: '智能协作',
                desc: '智能体身份与其工作流记录。',
                points: [
                    '工作控制：内置智能体微调 / 自定义智能体 / 权限管理',
                    '记忆审查：检查智能体对用户印象，进行审查管理；检查与印象关联的日志记录，进行溯源删改',
                    '术语管理：手动添加术语定义并在使用时注入；检查智能体对术语的学习；检查术语关联的日志记录进行溯源删改',
                ],
            }
            : { title: '待定面板', desc: '占位视图' };
        return new PlaceholderView(leaf, opts);
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-collab',
            name: '打开智能协作',
            callback: () => plugin.activateView(VIEW_TYPE_COLLAB),
        });
    }

    constructor(
        leaf: WorkspaceLeaf,
        private opts: PlaceholderOptions,
    ) {
        super(leaf);
    }

    getViewType(): string {
        // 由 opts 匹配对应的 viewType（执行设计/执行绑定/查询设计/日志已迁出为独立双栏视图，
        // 常量仍在此导出供它们与 panelRegistry 复用）
        switch (this.opts.title) {
            case '智能协作': return VIEW_TYPE_COLLAB;
            default: return 'seqtk-placeholder';
        }
    }

    getDisplayText(): string {
        return this.opts.title;
    }

    getIcon(): string {
        switch (this.opts.title) {
            case '智能协作': return 'bot';
            default: return 'help-circle';
        }
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl as HTMLElement;
        container.empty();
        container.addClass('seqtk-placeholder-view');

        container.createEl('h3', { cls: 'seqtk-placeholder-title', text: this.opts.title });
        container.createEl('div', { cls: 'seqtk-placeholder-badge', text: '规划中 · 尚未实现' });

        // 功能说明区 + 功能区面板骨架（可视化占位，无功能）
        const frame = container.createDiv('seqtk-placeholder-frame');
        frame.createEl('div', { cls: 'seqtk-placeholder-desc', text: this.opts.desc });

        const panels = frame.createDiv('seqtk-placeholder-panels');
        if (this.opts.points && this.opts.points.length > 0) {
            for (const p of this.opts.points) {
                const panel = panels.createDiv('seqtk-placeholder-panel');
                panel.createDiv('seqtk-placeholder-panel-title').setText('功能区');
                panel.createDiv('seqtk-placeholder-panel-desc').setText(p);
            }
        } else {
            const panel = panels.createDiv('seqtk-placeholder-panel');
            panel.createDiv('seqtk-placeholder-panel-title').setText('功能区');
            panel.createDiv('seqtk-placeholder-panel-desc').setText('功能待接入：界面将在此呈现');
        }
    }

    async onClose(): Promise<void> {
        // 无订阅，无需清理
    }
}
// 占位的空白页面，在部分视图未实际搭载时使用此页面进行展示
