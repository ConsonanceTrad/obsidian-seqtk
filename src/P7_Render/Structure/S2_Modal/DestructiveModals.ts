/**
 * DestructiveConfirmModal — 破坏性操作的确认弹窗
 *
 * 两级提示（级别见 P4_Nodes/NodeField/DeletionPolicy 的 ConfirmLevel）：
 * - `simple`：显示影响范围 + 确认 / 取消
 * - `strict`：另需手动输入确认词，输入匹配前确认按钮保持禁用
 *
 * 保持 Obsidian 原生 Modal（与 S2_Modal 下其它弹窗一致，见 dec-db13741643639699）；
 * 不做任何数据读写 —— 是否执行由调用方在 onConfirm 里决定。
 */

import { App, ButtonComponent, Modal, Setting, TextComponent } from 'obsidian';

export interface DestructiveConfirmOptions {
    title: string;
    /** 影响范围说明（如「将一并删除 12 个后代节点」） */
    message: string;
    /** 需要手动输入的确认词；缺省 = simple 级（仅确认 / 取消） */
    requiredWord?: string;
    /** 确认按钮文案，缺省「确认」 */
    confirmText?: string;
    onConfirm: () => void;
}

export class DestructiveConfirmModal extends Modal {
    constructor(app: App, private opts: DestructiveConfirmOptions) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('seqtk-modal');
        this.setTitle(this.opts.title);
        contentEl.createEl('p', { text: this.opts.message });

        // 用对象持有引用：赋值发生在 Setting 的回调里，直接写 let 变量会被 TS 控制流收窄为 null
        const refs: { input?: TextComponent; confirm?: ButtonComponent } = {};

        if (this.opts.requiredWord) {
            new Setting(contentEl)
                .setName(`输入「${this.opts.requiredWord}」以确认`)
                .addText((t) => {
                    refs.input = t;
                    t.onChange((v) => {
                        refs.confirm?.setDisabled(v.trim() !== this.opts.requiredWord);
                    });
                });
        }

        new Setting(contentEl)
            .addButton((b) => {
                refs.confirm = b;
                b.setButtonText(this.opts.confirmText ?? '确认');
                // 破坏性操作：用警示样式，且在 strict 级别下初始禁用
                if (typeof b.setWarning === 'function') b.setWarning();
                if (this.opts.requiredWord) b.setDisabled(true);
                b.onClick(() => {
                    const typed = (refs.input?.getValue() ?? '').trim();
                    const ok = !this.opts.requiredWord || typed === this.opts.requiredWord;
                    if (!ok) return;
                    this.close();
                    this.opts.onConfirm();
                });
            })
            .addButton((b) => b.setButtonText('取消').onClick(() => this.close()));

        refs.input?.inputEl.focus();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
