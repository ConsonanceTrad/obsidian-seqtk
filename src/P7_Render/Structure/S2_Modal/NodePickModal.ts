/**
 * NodePickModal — 选择一个节点（输入即搜 + 点选）
 *
 * 供「变更归属」等需要指定目标节点的场景复用：输入关键词检索（SEARCH_Nodes），
 * 列表展示类型徽章 + 名称 + nodeId，点选即回调。
 *
 * 只读：不创建、不修改任何节点，是否落盘由调用方在 onPick 里决定。
 * 保持 Obsidian 原生 Modal（与 S2_Modal 下其它弹窗一致，见 dec-db13741643639699）。
 */

import { App, Modal, Notice } from 'obsidian';
import { GET_KindClass } from '../../../P4_Nodes/NodeKind/KindColors';
import { NODE_KIND_LABELS } from '../../../P4_Nodes/NodeKind/NodeLabel';
import type { NodeKindValue } from '../../../P4_Nodes/NodeKind/NodeKind';
import type { DataPipe } from '../../../P5_Data/CoPipe/DataPipe';

export interface NodePickOptions {
    title: string;
    /** 不参与选择的 nodeId（如节点自身与其后代 —— 选了会成环） */
    excludeIds?: string[];
    /**
     * 候选过滤：返回 false 的节点不列出（如「变更归属」只留能容纳该节点类型的父）。
     * 父子类型规则交给调用方 —— 弹窗自己不认识这类规则。
     */
    allow?: (nodeId: string, kind: NodeKindValue) => boolean;
    /** 列表为空时的提示 */
    emptyText?: string;
    /** 是否提供「顶层」选项（onPick 会收到空串） */
    allowTop?: boolean;
    onPick: (nodeId: string) => void;
}

export class NodePickModal extends Modal {
    private searchInput!: HTMLInputElement;
    private listEl!: HTMLElement;
    private searchTimer: number | null = null;

    constructor(app: App, private pipe: DataPipe, private opts: NodePickOptions) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('seqtk-modal');
        this.setTitle(this.opts.title);

        this.searchInput = contentEl.createEl('input', {
            cls: 'seqtk-draft-node-search',
            attr: { type: 'text', placeholder: '输入名称 / nodeId 搜索…' },
        });
        this.listEl = contentEl.createDiv('seqtk-draft-node-list');

        this.searchInput.addEventListener('input', () => {
            if (this.searchTimer) window.clearTimeout(this.searchTimer);
            this.searchTimer = window.setTimeout(() => this.renderList(this.searchInput.value), 120);
        });
        this.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.close();
        });
        window.setTimeout(() => {
            this.searchInput.focus();
            this.renderList('');
        }, 30);
    }

    private renderList(query: string): void {
        this.listEl.empty();

        // 「顶层」不是一个节点，但常是你要选的答案；只在未输入关键词时提供，免得干扰检索
        if (this.opts.allowTop && !query.trim() && !this.opts.excludeIds?.includes("")) {
            const topRow = this.listEl.createDiv("seqtk-draft-node-item");
            topRow.createEl("span", { cls: "seqtk-kind-badge kind-unknown", text: "顶层" });
            topRow.createEl("span", { cls: "seqtk-draft-node-item-name", text: "（不挂在任何节点下）" });
            topRow.addEventListener("click", () => {
                this.opts.onPick("");
                this.close();
            });
        }

        const excluded = new Set(this.opts.excludeIds ?? []);
        const results = this.pipe
            .SEARCH_Nodes(query.trim(), 50)
            .filter(
                (r) =>
                    !excluded.has(r.nodeId) &&
                    // 类型不合适的候选直接不列出（判定由调用方给出）
                    (this.opts.allow?.(r.nodeId, r.data.kind) ?? true),
            );

        if (results.length === 0) {
            this.listEl.createEl('div', {
                cls: 'seqtk-draft-node-empty',
                text: this.opts.emptyText ?? '无匹配节点',
            });
            return;
        }

        for (const { nodeId, data } of results) {
            const row = this.listEl.createDiv('seqtk-draft-node-item');
            row.createEl('span', {
                cls: `seqtk-kind-badge ${GET_KindClass(data.kind)}`,
                text: NODE_KIND_LABELS[data.kind],
            });
            const nameEl = row.createEl('span', { cls: 'seqtk-draft-node-item-name', text: data.desc });
            row.createEl('span', { cls: 'seqtk-draft-node-item-id', text: nodeId });
            row.addEventListener('click', () => {
                this.opts.onPick(nodeId);
                this.close();
            });
            row.addEventListener('mouseenter', () => {
                nameEl.textContent = `${data.desc}  (${nodeId})`;
            });
            row.addEventListener('mouseleave', () => {
                nameEl.textContent = data.desc;
            });
        }
    }

    onClose(): void {
        this.contentEl.empty();
        if (this.searchTimer) window.clearTimeout(this.searchTimer);
    }
}
