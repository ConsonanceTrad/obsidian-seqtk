/**
 * ExternalSourcesModal — 管理某个节点的外部信息源
 *
 * 外部信息源是「节点体系之外、但支撑这个节点」的材料（链接 / 库内文件 / 时间戳文档），
 * 列表顺序即展示顺序。这里只做两件事：调顺序、删掉过时或引入错误的条目。
 *
 * 每次操作**即时写盘**（没有「保存」按钮）：这类小改动即时生效比先攒后存更符合预期，
 * 改错了再改回来也不比按保存麻烦。
 */

import { App, Modal, setIcon } from 'obsidian';
import {
    GET_SourceLabel,
    GET_SourceTarget,
    type ExternalSource,
} from '../../../P4_Nodes/NodeField/AttriGroup/External';

export interface ExternalSourcesModalOptions {
    /** 列表变化时回调（上移 / 下移 / 删除都立即触发一次） */
    onChange: (sources: ExternalSource[]) => void;
}

export class ExternalSourcesModal extends Modal {
    /** 弹窗自己维护一份副本：写盘触发的视图重绘与本弹窗无关，列表由这里重画 */
    private list: ExternalSource[];
    private listEl!: HTMLElement;

    constructor(app: App, sources: ExternalSource[], private opts: ExternalSourcesModalOptions) {
        super(app);
        this.list = [...sources];
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('seqtk-modal');
        this.setTitle('管理外部信息源');
        contentEl.createEl('p', {
            text: '顺序即展示顺序，改动立即生效。' +
                '删除只移除关联，不删除文件本身。',
        });
        this.listEl = contentEl.createDiv({ cls: 'seqtk-source-manage' });
        this.render();

        // 这个模态框里没有输入框，但 Obsidian 打开时会把焦点给第一个可聚焦元素 ——
        // 也就是首个「上移」图标按钮：一进来就像它被选中，还顺带弹出它的 tooltip。
        // 把焦点收在模态框本身；Tab 依然从第一个按钮开始（按钮自己没动）。
        // 延迟 30ms 与 TagsModal 同理：得晚于框架那一次聚焦。
        this.modalEl.tabIndex = -1;
        window.setTimeout(() => this.modalEl.focus(), 30);
    }

    /** 整表重画：条目不多，重画比逐行打补丁省事，也不会出现半新半旧的状态 */
    private render(): void {
        this.listEl.empty();
        if (this.list.length === 0) {
            this.listEl.createDiv({
                cls: 'seqtk-source-manage-empty',
                text: '暂无外部信息源；可用「关联库内文件或 URL」引入。',
            });
            return;
        }

        this.list.forEach((source, index) => {
            const row = this.listEl.createDiv({ cls: 'seqtk-source-manage-row' });

            const info = row.createDiv({ cls: 'seqtk-source-manage-info' });
            info.createDiv({ cls: 'seqtk-source-manage-label', text: GET_SourceLabel(source) });
            const target = GET_SourceTarget(source);
            if (target) info.createDiv({ cls: 'seqtk-source-manage-target', text: target.value });

            const actions = row.createDiv({ cls: 'seqtk-source-manage-actions' });
            this.iconButton(actions, 'chevron-up', '上移', index > 0, () => this.move(index, -1));
            this.iconButton(actions, 'chevron-down', '下移', index < this.list.length - 1, () => this.move(index, 1));
            this.iconButton(actions, 'trash-2', '删除', true, () => this.remove(index));
        });
    }

    /** 只带图标的按钮；不可用时置灰而不是隐藏（首条不能上移、末条不能下移） */
    private iconButton(parent: HTMLElement, icon: string, title: string, enabled: boolean, run: () => void): void {
        // 只给 aria-label：Obsidian 用它弹自己的 tooltip；再写原生 title 会同时冒出浏览器
        // 那个小方块，两个提示叠在一起（见 TagsModal 里同款写法）
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

    private commit(next: ExternalSource[]): void {
        this.list = next;
        this.render();
        this.opts.onChange(next);
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
