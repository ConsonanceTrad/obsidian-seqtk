/**
 * FileInputSuggest — 库内文件的输入建议（边打字边列候选）
 *
 * 做成「输入时提示」而不是「点按钮展开选择器」：后者要先把鼠标移出输入框点一下，
 * 再回到列表里找，与 Obsidian 内链输入的手感不一致。这里接管输入框的下拉，
 * 直接按路径模糊列出候选，回车或点击即回填。
 *
 * 与 S2_Modal 下其它组件一致，保持 Obsidian 原生能力（AbstractInputSuggest）。
 */

import { AbstractInputSuggest, App, TFile } from 'obsidian';

export class FileInputSuggest extends AbstractInputSuggest<TFile> {
    /** 候选上限：库很大时不必全量渲染下拉 */
    private static readonly MAX = 30;

    constructor(
        app: App,
        private inputEl2: HTMLInputElement,
        private onPick: (file: TFile) => void,
    ) {
        super(app, inputEl2);
    }

    getSuggestions(query: string): TFile[] {
        const q = query.trim().toLowerCase();
        const files = this.app.vault.getFiles().sort((a, b) => a.path.localeCompare(b.path));
        if (!q) return files.slice(0, FileInputSuggest.MAX);
        return files
            .filter((f) => f.path.toLowerCase().includes(q))
            .slice(0, FileInputSuggest.MAX);
    }

    renderSuggestion(file: TFile, el: HTMLElement): void {
        // 主行给文件名，次行给目录 —— 同名的文件在不同目录里很常见，只给路径不好认
        el.createDiv({ text: file.basename });
        el.createDiv({ cls: 'seqtk-suggest-path', text: file.parent?.path ?? '/' });
    }

    selectSuggestion(file: TFile): void {
        this.inputEl2.value = file.path;
        this.inputEl2.dispatchEvent(new Event('input'));
        this.onPick(file);
        this.close();
    }
}
