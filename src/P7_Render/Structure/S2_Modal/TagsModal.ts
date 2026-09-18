/**
 * TagsModal — 管理某个节点的标签
 *
 * 标签就是行上节点名之后那串徽章的来源。这里做三件事：增、删、调顺序。
 * 改动**即时写盘**（没有「保存」按钮），与 ExternalSourcesModal 保持一致。
 */

import { App, Modal, setIcon } from 'obsidian';

export interface TagsModalOptions {
    /** 列表变化时回调（添加 / 删除 / 上移 / 下移都立即触发一次） */
    onChange: (tags: string[]) => void;
}

export class TagsModal extends Modal {
    /** 弹窗自己维护一份副本：写盘触发的视图重绘与本弹窗无关，列表由这里重画 */
    private list: string[];
    private listEl!: HTMLElement;

    constructor(app: App, tags: string[], private opts: TagsModalOptions) {
        super(app);
        this.list = [...tags];
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('seqtk-modal');
        this.setTitle('管理标签');
        contentEl.createEl('p', { text: '顺序即行上徽章的显示顺序，改动立即生效。' });

        this.listEl = contentEl.createDiv({ cls: 'seqtk-tag-manage' });
        this.render();

        // 新增：输入框 + 「添加」，回车同效
        const addRow = contentEl.createDiv({ cls: 'seqtk-tag-manage-add' });
        const input = addRow.createEl('input', {
            cls: 'seqtk-tag-manage-input',
            attr: { type: 'text', placeholder: '新标签名（不必写 #）' },
        });
        const submit = (): void => {
            // 允许用户顺手带上 #；空名与重复名直接忽略，不弹提示打断
            const name = input.value.trim().replace(/^#+/, '');
            if (name === '' || this.list.includes(name)) return;
            input.value = '';
            this.commit([...this.list, name]);
            input.focus();
        };
        addRow.createEl('button', { cls: 'mod-cta', text: '添加' }).addEventListener('click', submit);
        input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            submit();
        });
        window.setTimeout(() => input.focus(), 30);
    }

    /** 整表重画：条目不多，重画比逐行打补丁省事，也不会出现半新半旧的状态 */
    private render(): void {
        this.listEl.empty();
        if (this.list.length === 0) {
            this.listEl.createDiv({
                cls: 'seqtk-tag-manage-empty',
                text: '暂无标签；可在下方添加，或在行内重命名时直接写 #标签。',
            });
            return;
        }

        this.list.forEach((tag, index) => {
            const row = this.listEl.createDiv({ cls: 'seqtk-tag-manage-row' });
            row.createEl('span', { cls: 'seqtk-tag-badge', text: tag });
            row.createDiv({ cls: 'seqtk-tag-manage-spacer' });

            const actions = row.createDiv({ cls: 'seqtk-tag-manage-actions' });
            this.iconButton(actions, 'chevron-up', '上移', index > 0, () => this.move(index, -1));
            this.iconButton(actions, 'chevron-down', '下移', index < this.list.length - 1, () => this.move(index, 1));
            this.iconButton(actions, 'trash-2', '删除', true, () => this.remove(index));
        });
    }

    /** 只带图标的按钮；不可用时置灰而不是隐藏（首条不能上移、末条不能下移） */
    private iconButton(parent: HTMLElement, icon: string, title: string, enabled: boolean, run: () => void): void {
        // 只给 aria-label：Obsidian 用它弹自己的 tooltip；再写原生 title 会同时冒出浏览器
        // 那个小方块，两个提示叠在一起（ExternalSourcesModal 里同款写法）
        const btn = parent.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': title } });
        setIcon(btn, icon);
        if (!enabled) {
            btn.setAttribute('disabled', 'true');
            btn.addClass('is-disabled');
            return;
        }
        btn.addEventListener('click', run);
    }

    private move(index: number, delta: number): void {
        const to = index + delta;
        if (to < 0 || to >= this.list.length) return;
        const next = [...this.list];
        [next[index], next[to]] = [next[to], next[index]];
        this.commit(next);
    }

    private remove(index: number): void {
        this.commit(this.list.filter((_, i) => i !== index));
    }

    private commit(next: string[]): void {
        this.list = next;
        this.render();
        this.opts.onChange(next);
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
