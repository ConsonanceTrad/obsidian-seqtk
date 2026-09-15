/**
 * FlowView — 事务设计 · 流程设计
 *
 * 双栏：左栏流程脚本（NODE_KIND.FLOW）列表；右栏「脚本程序」与「LAD 程序」切换制。
 * - 脚本为事实源（节点正文存放 flow 语法文本）
 * - 脚本态：textarea 编辑 + 解析错误红标
 * - LAD 态：LadRenderer 母线投影渲染 + 逆向转换（步骤拖拽重排 / 时间节点
 *   上移下移 / 增删内容块与步骤），修改经序列化写回脚本文本
 *
 * 逻辑与渲染分离：
 * - 本文件（逻辑）：注册、数据读写、AST 操作，以及 **LAD 编辑器的命令式 DOM 逻辑**；
 * - FlowDesignPanel.tsx（渲染）：左栏脚本列表 + 右栏外壳（模式切换 / 保存 / 容器）。
 *
 * 为什么 LAD 编辑器不 React 化：它是「HTML5 拖拽 + 递归 DOM 构建 + 右键菜单」的
 * 深度命令式代码（928 行中约 600 行），强行声明式化既易引入回归又无收益。
 * 沿用与 CanvasBoardHost 相同的原则：React 只出容器，命令式资源不进渲染树。
 */

import { createElement, type ReactNode } from "react";
import { App, Menu, Modal, Notice, Setting, TextComponent, type WorkspaceLeaf } from "obsidian";
import { AutoView } from "../../P1_Register/View";
import { AutoRegister } from "../../P1_Register/Comd";
import { ReactViewBase } from "../../P0_UI/ViewBase";
import { SimpleStore } from "../../P5_Data/Svelte/SimpleStore";
import { NODE_KIND } from "../../P4_Nodes/NodeKind/NodeKind";
import { NODE_KIND_LABELS } from "../../P4_Nodes/NodeKind/NodeLabel";
import { parseFlowScript } from "../../P2_Tools/Script/parser";
import { serializeFlowScript } from "../../P2_Tools/Script/serialize";
import { GET_FileByPath } from "../../P5_Data/MdFile/PathTools/PathParse";
import { TransactionCreateModal } from "../../P7_Render/Structure/S2_Modal/TransactionModals";
import { FlowDesignPanel, type FlowDesignState, type FlowScriptRow } from "./FlowDesignPanel";
import type SeqtkPlugin from "../../main";
import type { PanelEntry } from "../panelRegistry";
import type { DataPipe } from "../../P5_Data/CoPipe/DataPipe";
import type { PluginSettings } from "../../P3_Settings/Settings";
import type { NodeKindValue } from "../../P4_Nodes/NodeKind/NodeKind";
import type { SeqtkNode } from "../../P4_Nodes/Node";
import type { FlowScript, FlowLine, FlowLineItem, FlowTimeNode, FlowContentBlock } from "../../P2_Tools/Script/parser";

export const VIEW_TYPE_FLOW = 'seqtk-flow';

/** 通用多字段输入弹窗（替代 window.prompt，Obsidian Electron 不支持 prompt()） */
class FlowPromptModal extends Modal {
    constructor(
        app: App,
        private fields: { label: string; defaultValue?: string }[],
        private onConfirm: (values: string[]) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('seqtk-modal');
        this.setTitle('输入');
        const inputs: TextComponent[] = [];
        for (const f of this.fields) {
            new Setting(contentEl).setName(f.label).addText((tc) => {
                if (f.defaultValue) tc.setValue(f.defaultValue);
                inputs.push(tc);
                return tc;
            });
        }
        new Setting(contentEl).addButton((b) => {
            b.setButtonText('确认').setCta().onClick(() => {
                this.onConfirm(inputs.map((i) => i.getValue()));
                this.close();
            });
        }).addButton((b) => {
            b.setButtonText('取消').onClick(() => this.close());
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

@AutoView()
@AutoRegister()
export class FlowView extends ReactViewBase {
    /** 面板目录条目 */
    static metas: PanelEntry[] = [
        {viewType: VIEW_TYPE_FLOW, title: '流程设计', icon: 'workflow', description: '内置可切换的可视化流程程序与流程脚本程序，为时段/日期/时间点编写推送规则（脚本为事实源）。', category: '规则设计'},
    ];

    /** 视图工厂：由 Register_View 以 (leaf) 调用 */
    static create(leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string): FlowView {
        return new FlowView(leaf, plugin, plugin.allDeps.dataPipe, plugin.allDeps.settings);
    }

    /** 打开命令（手写；统一经 plugin.activateView 打开/聚焦） */
    static registerCommands(plugin: SeqtkPlugin) {
        plugin.addCommand({
            id: 'open-flow',
            name: '打开流程设计',
            callback: () => plugin.activateView(VIEW_TYPE_FLOW),
        });
    }

    /** FlowDesignPanel 提供的右栏内容容器 */
    private flowContent: HTMLDivElement | null = null;
    private mode: 'script' | 'lad' = 'script';
    private currentScriptId: string | null = null;
    private currentText = '';
    private currentAst: FlowScript | null = null;
    private unsub: (() => void) | null = null;
    /** 渲染件订阅的唯一状态源 */
    private readonly state = new SimpleStore<FlowDesignState>({
        initializing: true,
        scripts: [],
        currentScriptId: null,
        mode: 'script',
    });

    constructor(
        leaf: WorkspaceLeaf,
        private plugin: SeqtkPlugin,
        /** 数据面唯一入口（读写一律经它） */
        private pipe: DataPipe,
        private settings: PluginSettings,
    ) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_FLOW;
    }

    getDisplayText(): string {
        return '流程设计';
    }

    getIcon(): string {
        return 'workflow';
    }

    /** 渲染件在 FlowDesignPanel.tsx；视图类不写 JSX 字面量（见 P6_Views/Views.md 契约） */
    protected renderPanel(): ReactNode {
        return createElement(FlowDesignPanel, {
            state: this.state,
            onSelectScript: (nodeId: string) => this.selectScript(nodeId),
            onScriptContextMenu: (nodeId: string | null, e: globalThis.MouseEvent) => {
                const data = nodeId ? this.pipe.GET_Node(nodeId) : null;
                this.showScriptMenu(nodeId, data ?? null, e);
            },
            onToggleMode: () => this.switchMode(this.mode === 'script' ? 'lad' : 'script'),
            onSave: () => this.save(),
            onContentReady: (container: HTMLDivElement) => {
                this.flowContent = container;
                this.renderContent();
            },
            onContentDispose: () => { this.flowContent = null; },
        });
    }

    protected onMounted(): void {
        this.unsub = this.pipe.SUB_ActiveView(() => this.recompute());
        this.recompute();
    }

    protected onBeforeUnmount(): void {
        this.unsub?.();
        this.unsub = null;
    }

    // ============================================================
    // 左栏：流程脚本列表（数据 → 状态）
    // ============================================================

    private recompute(): void {
        const scripts: FlowScriptRow[] = this.pipe
            .GET_ByKind(NODE_KIND.FLOW)
            .map(({ nodeId, data }) => ({ nodeId, desc: data.desc, kindLabel: NODE_KIND_LABELS[data.kind] }));

        this.state.set({
            initializing: !this.pipe.isInitialized,
            scripts,
            currentScriptId: this.currentScriptId,
            mode: this.mode,
            contentEmpty: this.currentScriptId ? undefined : '请在左侧选择流程脚本',
        });
    }

    private selectScript(nodeId: string): void {
        this.currentScriptId = nodeId;
        this.currentText = this.pipe.GET_NodeBody(nodeId);
        this.recompute();
        this.renderContent();
    }

    private showScriptMenu(nodeId: string | null, data: SeqtkNode | null, e: MouseEvent): void {
        const menu = new Menu();
        if (nodeId && data) {
            menu.addItem((item) =>
                item.setTitle('编辑').setIcon('pencil')
                    .onClick(() => this.selectScript(nodeId)));
            menu.addItem((item) =>
                item.setTitle('打开文件').setIcon('file-text')
                    .onClick(() => this.openNodeFile(data.kind, nodeId)));
            menu.addItem((item) =>
                item.setTitle('归档').setIcon('archive')
                    .onClick(() => {
                        this.pipe.EXEC_Mutation({
                            op: 'update',
                            kind: data.kind,
                            nodeId,
                            updates: { open: false, modify: new Date().toISOString() },
                        });
                    }));
            menu.addSeparator();
            menu.addItem((item) =>
                item.setTitle('删除').setIcon('trash')
                    .onClick(() => {
                        this.pipe.EXEC_Mutation({ op: 'remove', kind: data.kind, nodeId });
                    }));
        } else {
            menu.addItem((item) =>
                item.setTitle('新建流程脚本').setIcon('plus')
                    .onClick(() => this.createScript()));
        }
        menu.showAtMouseEvent(e);
    }

    private createScript(): void {
        new TransactionCreateModal(this.app, {
            kinds: [NODE_KIND.FLOW],
            onSubmit: (input) => {
                const now = new Date().toISOString();
                const data = {
                    kind: input.kind,
                    desc: input.desc,
                    open: true,
                    create: now,
                    modify: now,
                } as SeqtkNode;
                // 文件先行 + 缓存写入，统一由 EXEC_Create 承担（无父）
                void this.pipe.EXEC_Create({ kind: input.kind, data }).then((nodeId) => {
                    this.selectScript(nodeId);
                }).catch((e) => {
                    console.error('[SeqTK] 新建流程脚本失败:', e);
                    new Notice('新建流程脚本失败，请查看控制台');
                });
            },
        }).open();
    }

    private openNodeFile(kind: NodeKindValue, nodeId: string): void {
        const filePath = GET_FileByPath(kind, nodeId, this.plugin.settings);
        const file = this.app.vault.getFileByPath(filePath);
        if (file) void this.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
    }

    // ============================================================
    // 右栏：模式切换与内容
    // ============================================================

    private switchMode(mode: 'script' | 'lad'): void {
        this.mode = mode;
        this.state.set({ ...this.state.get(), mode });
        this.renderContent();
    }

    private renderContent(): void {
        const el = this.flowContent;
        if (!el) return;
        el.empty();
        if (!this.currentScriptId) return;   // 空态由 Panel 渲染
        if (this.mode === 'script') this.renderScriptMode(el);
        else this.renderLadMode(el);
    }

    // ---- 脚本态 ----

    private renderScriptMode(el: HTMLElement): void {
        const wrap = el.createDiv('seqtk-flow-script');
        const textArea = wrap.createEl('textarea', {
            cls: 'seqtk-flow-textarea',
            attr: { spellcheck: 'false' },
        });
        textArea.value = this.currentText;
        const errorEl = wrap.createDiv('seqtk-flow-errors');

        const showParseErrors = () => {
            errorEl.empty();
            const ast = parseFlowScript(this.currentText);
            if (ast.errors.length === 0) {
                errorEl.createEl('div', { cls: 'seqtk-flow-ok', text: '语法正确' });
            } else {
                for (const err of ast.errors) {
                    errorEl.createEl('div', {
                        cls: 'seqtk-flow-err',
                        text: `第 ${err.line} 行：${err.message}`,
                    });
                }
            }
        };
        textArea.addEventListener('input', () => {
            this.currentText = textArea.value;
            showParseErrors();
        });
        showParseErrors();
    }

    // ---- LAD 态（投影 + 逆向转换） ----

    private renderLadMode(el: HTMLElement): void {
        this.currentAst = parseFlowScript(this.currentText);
        const ast = this.currentAst;
        const wrap = el.createDiv('seqtk-flow-lad');
        if (ast.errors.length > 0) {
            for (const err of ast.errors) {
                wrap.createEl('div', { cls: 'seqtk-flow-err', text: `第 ${err.line} 行：${err.message}` });
            }
            wrap.createEl('div', { cls: 'seqtk-empty', text: '存在语法错误，无法渲染 LAD（请在脚本态修正）' });
            return;
        }
        this.renderLadWithOps(wrap, ast);
    }

    /** 渲染 LAD 并挂逆向转换操作（右侧组件面板 + 拖拽添加） */
    private renderLadWithOps(wrap: HTMLElement, ast: FlowScript): void {
        wrap.createEl('div', {
            cls: 'seqtk-lad-hint',
            text: '提示：从右侧面板拖入组件添加；拖动步骤块重排顺序；时间节点可用 ↑↓ 移动；块内可增删内容块与步骤。修改即时写回脚本。',
        });
        const layout = wrap.createDiv('seqtk-lad-layout');
        const editArea = layout.createDiv('seqtk-lad-edit');
        this.renderPalette(layout);
        // 编辑区任意空白按类型智能归位：时间节点→时间轴、步骤类→第一条线路行、内容块→第一个时间节点
        const handleEditDrop = (type: string): void => {
            if (this.isTimeNodeType(type)) {
                this.addTimeNodeByDrop(type, ast.timeNodes);
            } else if (type === 'line') {
                this.addLineByDrop(() => ast.lines);
            } else if (type === 'step' || type === 'if' || type === 'not' || type === 'do') {
                if (ast.lines.length > 0) this.addLineItemByDrop(type, ast.lines[0]);
            } else if (ast.timeNodes.length > 0) {
                this.addContentByDrop(type, ast.timeNodes[0]);
            }
        };
        // 整个内容区（含 hint 下方、编辑区）空白处均可投放，悬停高亮
        this.attachDrop(editArea, handleEditDrop, 'seqtk-lad-zone-active');
        this.attachDrop(wrap, handleEditDrop, 'seqtk-lad-zone-active');
        this.renderLadStructure(editArea, ast);
    }

    /** 右侧预设组件面板（拖拽添加到编辑区） */
    private renderPalette(layout: HTMLElement): void {
        const palette = layout.createDiv('seqtk-lad-palette');
        palette.createEl('div', { cls: 'seqtk-lad-palette-title', text: '组件' });
        const items: { type: string; label: string; cls: string }[] = [
            { type: 'line', label: '例程', cls: 'seqtk-lad-line' },
            { type: 'step', label: '步骤', cls: 'seqtk-lad-step' },
            { type: 'if', label: 'IF 条件', cls: 'seqtk-lad-if' },
            { type: 'not', label: 'NOT 条件', cls: 'seqtk-lad-not' },
            { type: 'do', label: 'DO 动作', cls: 'seqtk-lad-do' },
            { type: 'lst', label: '清单内容', cls: 'seqtk-lad-content-kind' },
            { type: 'task', label: '事项内容', cls: 'seqtk-lad-content-kind' },
            { type: 'at', label: '时间点 at', cls: 'seqtk-lad-tn-time' },
            { type: 'span', label: '时间段 span', cls: 'seqtk-lad-tn-time' },
            { type: 'repeat', label: '周期 repeat', cls: 'seqtk-lad-tn-time' },
            { type: 'when', label: '条件使能 when', cls: 'seqtk-lad-tn-time' },
        ];
        for (const it of items) {
            const el = document.createElement('div');
            el.className = `seqtk-lad-palette-item ${it.cls}`;
            el.textContent = it.label;
            el.draggable = true;
            el.addEventListener('dragstart', (e) => {
                e.dataTransfer?.setData('seqtk/elem', it.type);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
            });
            palette.appendChild(el);
        }
        palette.createEl('div', {
            cls: 'seqtk-lad-palette-hint',
            text: '拖到线路行/时间节点/时间轴区域',
        });
    }

    /** 挂载拖放目标：dragover + drop 分发（dragover 用 types 判断组件拖拽，避免 getData 在 dragover 不可靠） */
    private attachDrop(el: HTMLElement, onDrop: (type: string) => void, hoverClass?: string): void {
        el.addEventListener('dragover', (e) => {
            const types = e.dataTransfer?.types ?? [];
            if (!types.includes('seqtk/elem')) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            if (hoverClass) el.classList.add(hoverClass);
        });
        el.addEventListener('dragleave', () => {
            if (hoverClass) el.classList.remove(hoverClass);
        });
        el.addEventListener('drop', (e) => {
            const type = e.dataTransfer?.getData('seqtk/elem') ?? '';
            e.preventDefault();
            e.stopPropagation();
            if (hoverClass) el.classList.remove(hoverClass);
            if (type) onDrop(type);
        });
    }

    /** 时间节点类型判断 */
    private isTimeNodeType(type: string): boolean {
        return type === 'at' || type === 'span' || type === 'repeat' || type === 'when';
    }

    /** 投放插槽：时间节点块之间的空白条，拖时间节点类型可插入该位置 */
    private renderInsertSlot(parent: HTMLElement, onInsert: (type: string) => void): void {
        const slot = document.createElement('div');
        slot.className = 'seqtk-lad-slot';
        slot.addEventListener('dragover', (e) => {
            const types = e.dataTransfer?.types ?? [];
            if (!types.includes('seqtk/elem')) return;
            e.preventDefault();
            e.stopPropagation();
            slot.classList.add('seqtk-lad-slot-active');
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        });
        slot.addEventListener('dragleave', () => slot.classList.remove('seqtk-lad-slot-active'));
        slot.addEventListener('drop', (e) => {
            const type = e.dataTransfer?.getData('seqtk/elem') ?? '';
            if (this.isTimeNodeType(type)) {
                e.preventDefault();
                e.stopPropagation();
                slot.classList.remove('seqtk-lad-slot-active');
                onInsert(type);
            }
        });
        parent.appendChild(slot);
    }

    /** 根据拖入类型在时间节点列表插入节点（insertIndex 指定位置；缺省追加末尾） */
    private addTimeNodeByDrop(type: string, siblings: FlowTimeNode[], insertIndex?: number): void {
        const commit = (node: FlowTimeNode): void => {
            if (insertIndex !== undefined) siblings.splice(insertIndex, 0, node);
            else siblings.push(node);
            this.commitAst();
        };
        switch (type) {
            case 'at':
                new FlowPromptModal(this.app, [{ label: '时间点（如 08:00）', defaultValue: '08:00' }], ([time]) => {
                    if (!time) return;
                    commit({ type: 'at', time, lines: [], contents: [], children: [] });
                }).open();
                break;
            case 'span':
                new FlowPromptModal(this.app, [
                    { label: '时间段名称', defaultValue: '' },
                    { label: '开始（如 09:00）', defaultValue: '09:00' },
                    { label: '结束（如 12:00）', defaultValue: '12:00' },
                ], ([name, from, to]) => {
                    if (!from || !to) return;
                    commit({ type: 'span', name: name || undefined, from, to, lines: [], contents: [], children: [] });
                }).open();
                break;
            case 'repeat':
                new FlowPromptModal(this.app, [
                    { label: '周期规则名称', defaultValue: '' },
                    { label: '周期（如 day/week）', defaultValue: 'day' },
                    { label: '时刻（如 18:00）', defaultValue: '18:00' },
                ], ([name, every, time]) => {
                    if (!every || !time) return;
                    commit({ type: 'repeat', name: name || undefined, every, time, lines: [], contents: [], children: [] });
                }).open();
                break;
            case 'when':
                new FlowPromptModal(this.app, [{ label: '条件（如 工作日）', defaultValue: '' }], ([cond]) => {
                    if (!cond) return;
                    commit({ type: 'when', when: cond, lines: [], contents: [], children: [] });
                }).open();
                break;
            default:
                return;
        }
    }

    /** 拖入线路行元素：step / if / not / do */
    private addLineItemByDrop(type: string, line: FlowLine): void {
        const commit = (item: FlowLineItem): void => {
            line.items.push(item);
            this.commitAst();
        };
        switch (type) {
            case 'step':
                new FlowPromptModal(this.app, [{ label: '步骤名称', defaultValue: '' }], ([name]) => {
                    if (!name) return;
                    commit({ type: 'step', name, next: '', nextKind: 'seq' });
                }).open();
                break;
            case 'if':
            case 'not':
                new FlowPromptModal(this.app, [{ label: type === 'not' ? 'NOT 条件' : 'IF 条件', defaultValue: '' }], ([cond]) => {
                    if (!cond) return;
                    commit({ type: 'if', not: type === 'not', cond, do: undefined });
                }).open();
                break;
            case 'do':
                new FlowPromptModal(this.app, [{ label: 'DO 动作', defaultValue: '' }], ([act]) => {
                    if (!act) return;
                    commit({ type: 'if', not: false, cond: 'true', do: act });
                }).open();
                break;
            default:
                return;
        }
    }

    /** 拖入例程：新建线路行到指定数组（弹窗询问名称） */
    private addLineByDrop(getTarget: () => FlowLine[]): void {
        new FlowPromptModal(this.app, [{ label: '例程名称', defaultValue: '' }], ([name]) => {
            getTarget().push({ type: 'line', name: name || undefined, items: [] });
            this.commitAst();
        }).open();
    }

    /** 拖入内容块：lst / task → 归位到 do 输出 */
    private addContentByDrop(type: string, node: FlowTimeNode): void {
        if (type !== 'lst' && type !== 'task') return;
        new FlowPromptModal(this.app, [{ label: `${type.toUpperCase()} 内容文本`, defaultValue: '' }], ([text]) => {
            if (!text) return;
            this.addContentToNode(node, { kind: type, text: text.trim() } as FlowContentBlock);
            this.commitAst();
        }).open();
    }

    /** 将内容块归位到时间节点的 do 输出（无线路行/do 则自动创建） */
    private addContentToNode(node: FlowTimeNode, block: FlowContentBlock): void {
        if (node.lines.length === 0) {
            node.lines.push({ type: 'line', items: [] });
        }
        const line = node.lines[0];
        let doItem: FlowLineItem | null = null;
        for (let k = line.items.length - 1; k >= 0; k--) {
            const it = line.items[k];
            if (it.type === 'if' && it.do !== undefined) {
                doItem = it;
                break;
            }
        }
        if (!doItem) {
            const item: FlowLineItem = { type: 'if', not: false, cond: 'true', do: '', contents: [] };
            line.items.push(item);
            doItem = item;
        }
        if (doItem.type === 'if') {
            doItem.contents = [...(doItem.contents ?? []), block];
        }
    }

    /** 右键菜单删除（LAD 不显示删除按钮，保持视觉干净） */
    private attachDeleteMenu(el: HTMLElement, onDelete: () => void): void {
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const menu = new Menu();
            menu.addItem((item) =>
                item.setTitle('删除').setIcon('trash')
                    .onClick(() => {
                        onDelete();
                        this.commitAst();
                    }));
            menu.showAtMouseEvent(e);
        });
    }

    private renderLadStructure(parent: HTMLElement, ast: FlowScript): void {
        // 手动构建（复用 LadRenderer 的视觉，但挂载编辑控件）
        // 例程区（最上方常通线路区）始终渲染，无论是否设置例程
        const top = document.createElement('div');
        top.className = 'seqtk-lad-top';
        const axis = document.createElement('div');
        axis.className = 'seqtk-lad-axis';
        const title = document.createElement('div');
        title.className = 'seqtk-lad-section-title';
        title.textContent = '例程（始终激活）';
        top.appendChild(title);
        if (ast.lines.length > 0) {
            ast.lines.forEach((line, i) => this.renderLineEditable(top, line, i, () => { ast.lines.splice(i, 1); }));
        } else {
            // 空例程区：占位引导（点击新建线路行）
            const ph = document.createElement('div');
            ph.className = 'seqtk-lad-placeholder';
            ph.textContent = '点击添加例程，或从右侧拖入组件';
            ph.addEventListener('click', () => {
                new FlowPromptModal(this.app, [{ label: '例程名称', defaultValue: '' }], ([name]) => {
                    ast.lines.push({ type: 'line', name: name || undefined, items: [] });
                    this.commitAst();
                }).open();
            });
            top.appendChild(ph);
        }
        parent.appendChild(top);

        if (ast.timeNodes.length > 0) {
            const tTitle = document.createElement('div');
            tTitle.className = 'seqtk-lad-section-title';
            tTitle.textContent = '时间轴';
            axis.appendChild(tTitle);
            ast.timeNodes.forEach((node, i) => {
                this.renderInsertSlot(axis, (type) => this.addTimeNodeByDrop(type, ast.timeNodes, i));
                this.renderTimeNodeEditable(axis, node, i, ast.timeNodes);
            });
            // 末尾插槽（追加）
            this.renderInsertSlot(axis, (type) => this.addTimeNodeByDrop(type, ast.timeNodes, ast.timeNodes.length));
            parent.appendChild(axis);
        }
    }

    /** 线路行（可编辑）：步骤拖拽重排 + 增删步骤（删除走右键菜单） */
    private renderLineEditable(
        parent: HTMLElement,
        line: FlowLine,
        lineIdx: number,
        deleteFn: () => void,
    ): void {
        void lineIdx;
        const row = document.createElement('div');
        row.className = 'seqtk-lad-line';
        const head = document.createElement('div');
        head.className = 'seqtk-lad-line-head';
        head.textContent = `例程：${line.name ?? '(未命名)'}`;
        if (line.on) {
            const span = document.createElement('span');
            span.className = 'seqtk-lad-on';
            span.textContent = ` on <${line.on}>`;
            head.appendChild(span);
        }
        row.appendChild(head);
        // 右键线路行删除
        this.attachDeleteMenu(row, deleteFn);

        const items = document.createElement('div');
        items.className = 'seqtk-lad-items';
        line.items.forEach((it, idx) => {
            const itemEl = this.renderLineItemEditable(it, idx, line, items);
            items.appendChild(itemEl);
        });
        row.appendChild(items);

        // 空线路行显示占位文字（点击添加；内部有块后不再显示引导）
        if (line.items.length === 0) {
            const ph = document.createElement('div');
            ph.className = 'seqtk-lad-placeholder';
            ph.textContent = '点击添加步骤/条件，或从右侧拖入组件';
            ph.addEventListener('click', (e) => this.showAddLineMenu(e, line));
            row.appendChild(ph);
        }
        // 整行作为拖放目标：step / if / not / do → 追加到该线路行
        this.attachDrop(row, (type) => this.addLineItemByDrop(type, line));
        parent.appendChild(row);
    }

    /** 线路行占位文字点击：添加菜单（步骤 / IF / NOT / DO） */
    private showAddLineMenu(e: MouseEvent, line: FlowLine): void {
        const menu = new Menu();
        const promptOne = (label: string, onVal: (v: string) => void): void => {
            new FlowPromptModal(this.app, [{ label, defaultValue: '' }], ([v]) => {
                if (!v) return;
                onVal(v);
                this.commitAst();
            }).open();
        };
        menu.addItem((item) => item.setTitle('步骤').setIcon('plus')
            .onClick(() => promptOne('步骤名称', (name) => {
                line.items.push({ type: 'step', name, next: '', nextKind: 'seq' });
            })));
        menu.addItem((item) => item.setTitle('IF 条件').setIcon('plus')
            .onClick(() => promptOne('IF 条件', (cond) => {
                line.items.push({ type: 'if', not: false, cond, do: undefined });
            })));
        menu.addItem((item) => item.setTitle('NOT 条件').setIcon('plus')
            .onClick(() => promptOne('NOT 条件', (cond) => {
                line.items.push({ type: 'if', not: true, cond, do: undefined });
            })));
        menu.addItem((item) => item.setTitle('DO 动作').setIcon('plus')
            .onClick(() => promptOne('DO 动作', (act) => {
                line.items.push({ type: 'if', not: false, cond: 'true', do: act });
            })));
        menu.showAtMouseEvent(e);
    }

    /** 线路行内元素（步骤可拖拽重排；IF/NOT/DO 只读展示） */
    private renderLineItemEditable(
        it: FlowLineItem,
        idx: number,
        line: FlowLine,
        items: HTMLElement,
    ): HTMLElement {
        void items;
        const wrap = document.createElement('div');
        wrap.className = 'seqtk-lad-item';
        if (it.type === 'step') {
            const step = document.createElement('div');
            step.className = 'seqtk-lad-step';
            step.textContent = it.name;
            step.draggable = true;
            step.title = '拖动重排';
            step.addEventListener('dragstart', (e) => {
                e.dataTransfer?.setData('text/plain', String(idx));
            });
            step.addEventListener('dragover', (e) => e.preventDefault());
            step.addEventListener('drop', (e) => {
                e.preventDefault();
                const from = parseInt(e.dataTransfer?.getData('text/plain') ?? '', 10);
                if (Number.isNaN(from) || from === idx) return;
                const moved = line.items.splice(from, 1)[0];
                line.items.splice(idx, 0, moved);
                this.commitAst();
            });
            // 右键步骤删除
            this.attachDeleteMenu(step, () => { line.items.splice(idx, 1); });
            wrap.appendChild(step);
        } else {
            const elem = document.createElement('div');
            const cls = it.not ? 'seqtk-lad-not' : (it.cond === 'true' && it.do ? 'seqtk-lad-do' : 'seqtk-lad-if');
            elem.className = `seqtk-lad-elem ${cls}`;
            elem.textContent = it.not
                ? `NOT ${it.cond}`
                : (it.cond === 'true' && it.do ? `DO ${it.do}` : `IF ${it.cond}`);
            wrap.appendChild(elem);
            if (it.do && it.cond !== 'true') {
                const doEl = document.createElement('div');
                doEl.className = 'seqtk-lad-elem seqtk-lad-do';
                doEl.textContent = `DO ${it.do}`;
                wrap.appendChild(doEl);
            }
            // 右键元件删除（含 do 输出内容）
            this.attachDeleteMenu(wrap, () => { line.items.splice(idx, 1); });
            // do 的输出内容块紧跟其后（右键删除）
            if (it.do !== undefined && it.contents) {
                it.contents.forEach((c, ci) => {
                    const cRow = document.createElement('div');
                    cRow.className = 'seqtk-lad-content';
                    const kind = document.createElement('span');
                    kind.className = 'seqtk-lad-content-kind';
                    kind.textContent = c.kind;
                    cRow.appendChild(kind);
                    cRow.appendChild(document.createTextNode(` ${c.text}`));
                    this.attachDeleteMenu(cRow, () => { it.contents?.splice(ci, 1); });
                    wrap.appendChild(cRow);
                });
            }
        }
        return wrap;
    }

    /** 时间节点（可编辑）：↑↓ 移动 + 增删内容块/嵌套 */
    private renderTimeNodeEditable(
        parent: HTMLElement,
        node: FlowTimeNode,
        idx: number,
        siblings: FlowTimeNode[],
    ): void {
        const block = document.createElement('div');
        block.className = `seqtk-lad-timenode seqtk-lad-tn-${node.type}`;
        const head = document.createElement('div');
        head.className = 'seqtk-lad-tn-head';
        const label = this.timeLabel(node);
        const icon = document.createElement('span');
        icon.className = 'seqtk-lad-tn-icon';
        icon.textContent = label.icon;
        head.appendChild(icon);
        const time = document.createElement('span');
        time.className = 'seqtk-lad-tn-time';
        time.textContent = label.text;
        head.appendChild(time);
        if (label.name) {
            const name = document.createElement('span');
            name.className = 'seqtk-lad-tn-name';
            name.textContent = label.name;
            head.appendChild(name);
        }
        // ↑↓ 移动
        const up = document.createElement('button');
        up.className = 'seqtk-btn seqtk-btn-small seqtk-flow-x';
        up.textContent = '↑';
        up.title = '上移';
        up.disabled = idx === 0;
        up.addEventListener('click', () => {
            const [m] = siblings.splice(idx, 1);
            siblings.splice(idx - 1, 0, m);
            this.commitAst();
        });
        head.appendChild(up);
        const down = document.createElement('button');
        down.className = 'seqtk-btn seqtk-btn-small seqtk-flow-x';
        down.textContent = '↓';
        down.title = '下移';
        down.disabled = idx === siblings.length - 1;
        down.addEventListener('click', () => {
            const [m] = siblings.splice(idx, 1);
            siblings.splice(idx + 1, 0, m);
            this.commitAst();
        });
        head.appendChild(down);
        block.appendChild(head);
        // 右键时间节点删除
        this.attachDeleteMenu(block, () => { siblings.splice(idx, 1); });

        const body = document.createElement('div');
        body.className = 'seqtk-lad-tn-body';
        node.lines.forEach((line, li) => this.renderLineEditable(body, line, li, () => { node.lines.splice(li, 1); }));
        // 内容块不再直接挂时间节点，随线路行 DO 显示（旧数据 node.contents 兼容渲染，右键删除）
        node.contents.forEach((c, ci) => {
            const cRow = document.createElement('div');
            cRow.className = 'seqtk-lad-content';
            const kind = document.createElement('span');
            kind.className = 'seqtk-lad-content-kind';
            kind.textContent = c.kind;
            cRow.appendChild(kind);
            cRow.appendChild(document.createTextNode(` ${c.text}`));
            this.attachDeleteMenu(cRow, () => { node.contents.splice(ci, 1); });
            body.appendChild(cRow);
        });
        node.children.forEach((child, ci) => {
            this.renderInsertSlot(body, (type) => this.addTimeNodeByDrop(type, node.children, ci));
            this.renderTimeNodeEditable(body, child, ci, node.children);
        });
        // 末尾插槽（追加）
        this.renderInsertSlot(body, (type) => this.addTimeNodeByDrop(type, node.children, node.children.length));

        const addContent = document.createElement('div');
        addContent.className = 'seqtk-lad-placeholder';
        addContent.textContent = '点击添加输出内容，或从右侧拖入组件';
        addContent.addEventListener('click', () => {
            new FlowPromptModal(this.app, [
                { label: '内容块类型（lst/task/...）', defaultValue: 'lst' },
                { label: '内容文本', defaultValue: '' },
            ], ([kind, text]) => {
                if (!kind || !text) return;
                this.addContentToNode(node, { kind: kind.trim().toLowerCase(), text: text.trim() } as FlowContentBlock);
                this.commitAst();
            }).open();
        });
        // 内部有块（线路行/内容/子节点）后不显示占位引导
        const hasBlocks = node.lines.length > 0 || node.contents.length > 0 || node.children.length > 0;
        if (!hasBlocks) body.appendChild(addContent);
        // 整块为拖放目标：line → 新建嵌套线路行；lst/task → 内容块（归位到 do 输出）；
        // step/if/not/do → 归位到内部线路行（无则自动创建）
        this.attachDrop(block, (type) => {
            if (type === 'line') {
                this.addLineByDrop(() => node.lines);
            } else if (type === 'lst' || type === 'task') {
                this.addContentByDrop(type, node);
            } else if (type === 'step' || type === 'if' || type === 'not' || type === 'do') {
                if (node.lines.length === 0) {
                    node.lines.push({ type: 'line', items: [] });
                }
                this.addLineItemByDrop(type, node.lines[0]);
            }
        });
        block.appendChild(body);
        parent.appendChild(block);
    }

    private timeLabel(node: FlowTimeNode): { icon: string; text: string; name?: string } {
        switch (node.type) {
            case 'at':
                return { icon: '●', text: node.time ?? '' };
            case 'span':
                return { icon: '●', text: `${node.from ?? ''} → ${node.to ?? ''}`, name: node.name };
            case 'repeat':
                return { icon: '◇', text: `每${node.every ?? ''} ${node.time ?? ''}`, name: node.name };
            case 'when':
                return { icon: '◈', text: `当 [${node.when ?? ''}]` };
        }
    }

    /** LAD 修改 → 序列化写回脚本文本并重渲染 */
    private commitAst(): void {
        if (!this.currentAst) return;
        this.currentText = serializeFlowScript(this.currentAst);
        const el = this.flowContent;
        if (el) this.renderLadMode(el);
    }

    // ============================================================
    // 保存
    // ============================================================

    private save(): void {
        if (!this.currentScriptId) return;
        const node = this.pipe.GET_Node(this.currentScriptId);
        if (!node) return;
        // 脚本态下取 textarea 值；LAD 态下取 currentText（commitAst 已同步）
        const ta = this.flowContent?.querySelector('textarea.seqtk-flow-textarea') as HTMLTextAreaElement | null;
        if (this.mode === 'script' && ta) {
            this.currentText = ta.value;
        }
        const scriptId = this.currentScriptId;
        this.pipe.EXEC_Mutation({
            op: 'setBody',
            kind: node.kind,
            nodeId: scriptId,
            body: this.currentText,
        });
        new Notice('流程脚本已保存');
    }
}
