/**
 * TextTreeImportModal — 文本树导入（输入 → 实时预览 → 投递）
 *
 * 上方文本框贴入或编辑文本树；下方实时预览解析结果：缩进层级 + 类型名 + 状态，
 * 解析问题（带行号）单独列出。**有问题时禁用「导入」** —— 与其把半截结构建进库再让用户清理，
 * 不如在门口拦住。
 *
 * 只做输入与预览：解析用纯函数（P2_Tools/Parse/TextTree），投递由调用方在 onConfirm 里执行，
 * 本弹窗不接触数据层、不 import "obsidian" 之外的依赖。
 * 保持 Obsidian 原生 Modal（与 S2_Modal 下其它弹窗一致，见 dec-db13741643639699）。
 */

import { App, Modal, Setting } from 'obsidian';
import {
    CONTINUE_TextLine,
    INDENT_TextLine,
    PARSE_TextTree,
    PREVIEW_TextTree,
    type TextTreeNode,
} from '../../../P2_Tools/Parse/TextTree';
import { GET_KindClass } from '../../../P4_Nodes/NodeKind/KindColors';
import { NODE_STATE_LABELS } from '../../../P4_Nodes/NodeField/StateKeys';

export interface TextTreeImportOptions {
    title: string;
    /** 初始文本（如编辑器里选中的内容） */
    initialText?: string;
    desc?: string;
    /**
     * 额外的提示行（由调用方按解析结果计算，如「将删除 N 个节点」）
     *
     * 放在弹窗里而不是调用方外部，是为了让它随文本实时刷新 —— 用户改一行就该看到
     * 影响范围跟着变，而不是等按下按钮才被告知要删什么。
     */
    notice?: (roots: TextTreeNode[]) => string[];
    /**
     * 点到弹窗外部是否关闭（默认 true）
     *
     * 批量编辑传 false：那段文本可能改了很久，误点一下外部就丢掉代价太大。
     * 关掉之后仍可用 Esc 或「取消」结束。
     */
    closeOnClickOutside?: boolean;
    onConfirm: (roots: TextTreeNode[]) => void;
}

export class TextTreeImportModal extends Modal {
    private textarea!: HTMLTextAreaElement;
    private previewEl!: HTMLElement;
    private issuesEl!: HTMLElement;
    private importBtn: { setDisabled(v: boolean): unknown } | null = null;

    constructor(app: App, private opts: TextTreeImportOptions) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('seqtk-modal');
        // 宽一档：这里编辑的是长文本，宽度不够会频繁横向滚动（宽度写在样式表里）
        this.modalEl.addClass('seqtk-texttree-modal');
        this.setTitle(this.opts.title);
        if (this.opts.desc) contentEl.createEl('p', { text: this.opts.desc });

        // 批量编辑：点到弹窗外部不关闭 —— 遮罩上的 mousedown 被拦下，
        // Obsidian 那套「点外部关闭」便不会触发；Esc 与「取消」照旧有效。
        if (this.opts.closeOnClickOutside === false) {
            const container = this.containerEl;
            container.addEventListener(
                'mousedown',
                (ev) => {
                    if (ev.target === container) {
                        ev.stopPropagation();
                        ev.preventDefault();
                    }
                },
                true,
            );
        }

        this.textarea = contentEl.createEl('textarea', {
            cls: 'seqtk-texttree-input',
            attr: {
                rows: '10',
                placeholder: '- [ ] 构想名\n  - [ ] 方向名\n    - [ ] 目标名',
            },
        });
        this.textarea.value = this.opts.initialText ?? '';

        this.issuesEl = contentEl.createDiv({ cls: 'seqtk-texttree-issues' });
        this.previewEl = contentEl.createDiv({ cls: 'seqtk-texttree-preview' });

        this.textarea.addEventListener('input', () => this.refresh());
        this.textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.close();
                return;
            }
            // 缩进与语法头辅助：接管成功就不再往下走（否则 Tab 会切走焦点）
            if (this.handleIndentKey(e)) return;
            if (this.handleEnterKey(e)) return;
        });

        new Setting(contentEl)
            .addButton((b) => {
                this.importBtn = b;
                b.setButtonText('导入').setCta().onClick(() => {
                    const { roots, issues } = PARSE_TextTree(this.textarea.value);
                    if (issues.length > 0 || roots.length === 0) return;
                    this.close();
                    this.opts.onConfirm(roots);
                });
            })
            .addButton((b) => b.setButtonText('取消').onClick(() => this.close()));

        this.refresh();
        window.setTimeout(() => this.textarea.focus(), 30);
    }

    /** Tab / Ctrl+Tab / Shift+Tab：整行加 / 减一级缩进（逻辑在纯函数里，便于单测） */
    private handleIndentKey(e: KeyboardEvent): boolean {
        if (e.key !== 'Tab') return false;
        // 必须吃掉默认行为：否则 Tab 会把焦点移到弹窗的按钮上，缩进完就没法接着打字了
        e.preventDefault();
        const ta = this.textarea;
        const r = INDENT_TextLine(ta.value, ta.selectionStart, ta.selectionEnd, e.ctrlKey || e.shiftKey);
        ta.value = r.value;
        ta.selectionStart = ta.selectionEnd = r.caret;
        this.refresh();
        return true;
    }

    /** Enter：续写同级语法头（逻辑在纯函数里，便于单测） */
    private handleEnterKey(e: KeyboardEvent): boolean {
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return false;
        const ta = this.textarea;
        const r = CONTINUE_TextLine(ta.value, ta.selectionStart, ta.selectionEnd);
        if (!r) return false;
        e.preventDefault();
        ta.value = r.value;
        ta.selectionStart = ta.selectionEnd = r.caret;
        this.refresh();
        return true;
    }
    /** 重新解析并刷新预览与「导入」可用性 */
    private refresh(): void {
        const { roots, issues } = PARSE_TextTree(this.textarea.value);

        this.issuesEl.empty();
        for (const issue of issues) {
            this.issuesEl.createDiv({ cls: 'seqtk-texttree-issue', text: `第 ${issue.line} 行：${issue.message}` });
        }

        this.previewEl.empty();
        const rows = PREVIEW_TextTree(roots);
        if (rows.length === 0 && issues.length === 0) {
            this.previewEl.createDiv({ cls: 'seqtk-texttree-empty', text: '（暂无内容）' });
        }
        for (const row of rows) {
            const line = this.previewEl.createDiv({ cls: 'seqtk-texttree-row' });
            line.style.paddingLeft = `${row.depth * 14}px`;
            line.createEl('span', { cls: `seqtk-kind-badge ${GET_KindClass(row.kind)}`, text: row.kindLabel });
            line.createEl('span', { cls: 'seqtk-texttree-desc', text: row.desc });
            // 状态放行末，用与正常节点行同一个圆点样式（含悬停状态名），让预览一眼就像那棵树；
            // 文本语法里的 [ ] 只留在上面的编辑框里（那是回写要用的语法）
            line.createEl('span', {
                cls: `seqtk-state-dot state-${row.state}`,
                attr: { title: NODE_STATE_LABELS[row.state] },
            });
        }

        // 调用方提供的额外提示（如编辑模式下的删除预告）
        if (this.opts.notice) {
            for (const line of this.opts.notice(roots)) {
                this.issuesEl.createDiv({ cls: 'seqtk-texttree-issue seqtk-texttree-notice', text: line });
            }
        }

        // 有问题或空内容时不允许导入
        const disabled = issues.length > 0 || roots.length === 0;
        this.importBtn?.setDisabled(disabled);
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
