/**
 * TextPromptModal — 通用文本输入弹窗
 *
 * 替代 window.prompt（Obsidian 的 Electron 环境不支持 prompt()）。
 * 支持多字段（如「名称 + 链接」），确认时回调一份键值表。
 * 保持 Obsidian 原生 Modal（与 S2_Modal 下其它弹窗一致，见 dec-db13741643639699）。
 */

import { App, Modal, Setting, TextComponent } from 'obsidian';
import { FileInputSuggest } from './FileInputSuggest';

export interface TextPromptField {
    /** 回调里的键名 */
    key: string;
    label: string;
    placeholder?: string;
    value?: string;
    /**
     * 字段形态：text（普通输入）| file（库内文件，额外给一个可搜索的选择按钮）
     * | textarea（多行文本，如节点描述正文 —— 回车换行，不提交）
     *
     * 用 file 时输入框仍可编辑 —— 从别处粘一条相对路径常比搜索快。
     */
    type?: 'text' | 'file' | 'textarea';
}

export interface TextPromptOptions {
    /** 省略则不显示标题（如「修改描述」那种整片文本框，标题只占地方） */
    title?: string;
    desc?: string;
    fields: TextPromptField[];
    confirmText?: string;
    onConfirm: (values: Record<string, string>) => void;
}

export class TextPromptModal extends Modal {
    private readonly inputs: Record<string, HTMLInputElement> = {};
    private readonly areas: Record<string, HTMLTextAreaElement> = {};

    constructor(app: App, private opts: TextPromptOptions) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('seqtk-modal');
        if (this.opts.title) this.setTitle(this.opts.title);
        if (this.opts.desc) contentEl.createEl('p', { text: this.opts.desc });

        for (const f of this.opts.fields) {
            // 多行：正文这类整段文本。**不套 Setting** —— Setting 是「左名称 + 右控件」两列布局，
            // 文本框会被挤成半宽；直接挂到 contentEl 上才能占满弹窗宽度。
            if (f.type === 'textarea') {
                const area = contentEl.createEl('textarea', {
                    cls: 'seqtk-prompt-textarea',
                    attr: { rows: '16', placeholder: f.placeholder ?? '', 'aria-label': f.label },
                });
                area.value = f.value ?? '';
                this.areas[f.key] = area;
                continue;
            }

            const setting = new Setting(contentEl).setName(f.label);
            let inputEl: HTMLInputElement | null = null;
            setting.addText((t: TextComponent) => {
                t.setPlaceholder(f.placeholder ?? '').setValue(f.value ?? '');
                this.inputs[f.key] = t.inputEl;
                inputEl = t.inputEl;
            });
            if (f.type === 'file' && inputEl) {
                // 库内文件：接管输入框的下拉，边打字边给候选（与 Obsidian 内链输入一致）
                new FileInputSuggest(this.app, inputEl, () => {
                    /* 值已由 suggest 回填；此处仅用于触发「确定」按钮重新判定可用性 */
                });
            }
        }

        const collect = (): Record<string, string> => {
            const out: Record<string, string> = {};
            for (const f of this.opts.fields) {
                const el = this.inputs[f.key] ?? this.areas[f.key];
                out[f.key] = el?.value.trim() ?? '';
            }
            return out;
        };

        new Setting(contentEl)
            .addButton((b) =>
                b.setButtonText(this.opts.confirmText ?? '确认').setCta().onClick(() => {
                    this.close();
                    this.opts.onConfirm(collect());
                }),
            )
            .addButton((b) => b.setButtonText('取消').onClick(() => this.close()));

        // 单字段时直接把焦点放进输入框；回车提交 —— 多行字段除外，那里的回车是换行
        const firstKey = this.opts.fields[0]?.key ?? '';
        const first: HTMLInputElement | HTMLTextAreaElement | undefined =
            this.inputs[firstKey] ?? this.areas[firstKey];
        if (first) {
            first.focus();
            first.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && this.inputs[firstKey]) {
                    e.preventDefault();
                    this.close();
                    this.opts.onConfirm(collect());
                }
            });
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
