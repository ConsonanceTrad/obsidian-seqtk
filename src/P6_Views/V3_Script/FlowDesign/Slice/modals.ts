/**
 * flowDesign/modals — 流程设计视图专用的输入弹窗
 *
 * 「通用多字段输入」的载体：窗口 prompt 在 Obsidian Electron 里不可用，各处的
 * 「新增步骤 / 新增时间节点 / 重命名 / 改导通期」都要问用户要一个或几个值，于是收在这里。
 *
 * 字段有两种类型：
 * - text：普通文本框（大部分指令参数）
 * - datetime：原生 `<input type="datetime-local">`，用于 START / END 的导通时刻，
 *   值形如 `2026-08-24T00:00`
 *
 * 切片契约（见 P6_Views/Views.md）：以 view 为第一参数的才是切片；本文件是纯 UI 部件，
 * 不持有数据、也不认识视图 —— 调用方给出字段定义与回调即可，因此无需 view 参数。
 */

import { Modal, Setting, TextComponent, type App } from "obsidian";

/** 弹窗字段：标签 + 初值 + 输入类型 */
export interface FlowPromptField {
    label: string;
    defaultValue?: string;
    /** 缺省 text；datetime 用原生日期时间选择器 */
    type?: 'text' | 'datetime';
}

export class FlowPromptModal extends Modal {
    constructor(
        app: App,
        private fields: FlowPromptField[],
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
                if (f.type === 'datetime') tc.inputEl.type = 'datetime-local';
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
