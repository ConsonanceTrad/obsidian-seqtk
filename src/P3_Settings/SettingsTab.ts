/**
 * SettingsTab — 插件设置面板（声明式）
 *
 * 用 `getSettingDefinitions()` 声明设置，取代已废弃的 `display()`（Obsidian 1.13.0 起）。
 * 声明式带来三件命令式写法得不到的事：
 *   - 每项自动进入 Obsidian 的**设置搜索**（名称 / 描述 / aliases）
 *   - 值的读写与持久化由框架接管：条目里写 key，框架调 getControlValue / setControlValue
 *     （PluginSettingTab 的默认实现就是读写 this.plugin.settings 并保存），不必逐项写 onChange
 *   - 分组与子页由框架渲染，导航与样式与官方设置一致
 *
 * 两处仍需命令式渲染（都是"任意条数的编辑器"，声明式表达不了）：
 *   - **状态传播规则**：可增删的规则表，放在一个 sub-page 里用 Setting 渲染
 *   - **类型显示名**：全部类型名逐项可改，同样一个 sub-page，每项带「恢复默认」按钮
 * 两者的 render 回调都不会自动保存，改动要自己落盘（见各自的 render 方法）。
 *
 * manifest 的 minAppVersion 已提到 1.13.0 —— 该 API 的下限。
 */

import { App, Notice, PluginSettingTab, Setting, type SettingDefinitionItem } from 'obsidian';
import type SeqtkPlugin from "../main";
import {Save_Setting, DELEGATE_TARGET_LABELS} from "./Settings";
import { NODE_STATE_LABELS, STATE_VALUES, type SeqtkState } from "../P4_Nodes/NodeField/StateKeys";
import {
    DETECT_RuleConflicts,
    type PropagationDirection,
    type StatePropagationRule,
} from "../P4_Nodes/NodeField/Propagation";
import {
    ARCHIVE_CHILDREN_LABELS,
    CONFIRM_LEVEL_LABELS,
    DELETE_CHILDREN_LABELS,
} from "../P4_Nodes/NodeField/DeletionPolicy";
import { GET_KindLabelGroups, NODE_KIND_LABELS } from "../P4_Nodes/NodeKind/NodeLabel";
import type { NodeKindValue } from "../P4_Nodes/NodeKind/NodeKind";

/** 生成一个不会与现有规则撞车的 id */
function nextRuleId(rules: StatePropagationRule[]): string {
    let n = 1;
    while (rules.some((r) => r.id === `rule-${n}`)) n++;
    return `rule-${n}`;
}

const SORT_LABELS: Record<string, string> = {
    create: '创建时间',
    modify: '修改时间',
    desc: '名称',
    state: '状态',
};

export class SettingsTab extends PluginSettingTab {
    plugin: SeqtkPlugin;

    constructor(app: App, plugin: SeqtkPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * 设置声明
     *
     * 框架会在每次 update() 以及注册时（供搜索索引）各调一次，因此这里必须便宜：
     * 不做 I/O、不读磁盘 —— 规则表只从内存设置里取。
     */
    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            {
                type: 'group',
                heading: '数据与写入',
                items: [
                    {
                        name: '数据根文件夹',
                        desc: '节点 Markdown 文件与插件数据文件（布局缓存等）所在的文件夹，相对于库根目录。',
                        aliases: ['root', 'folder', '路径'],
                        control: {
                            type: 'text',
                            key: 'rootFolder',
                            placeholder: '例如：seqtk',
                            validate: (v) => (v.trim() ? undefined : '不能为空'),
                        },
                    },
                    {
                        name: '默认排序方式',
                        control: {
                            type: 'dropdown',
                            key: 'defaultSort',
                            options: SORT_LABELS,
                        },
                    },
                    {
                        name: '默认排序方向',
                        control: {
                            type: 'dropdown',
                            key: 'defaultSortDirection',
                            options: { asc: '升序', desc: '降序' },
                        },
                    },
                ],
            },
            {
                type: 'group',
                heading: '显示',
                items: [
                    {
                        name: '在左栏显示「全部事务」入口',
                        desc: '开启后，事务设计在未选中框架时展示全部事务总览。',
                        control: { type: 'toggle', key: 'showAllOverview' },
                    },
                    {
                        name: '委托落点',
                        desc:
                            '框架树被委托出去时渲染在哪里。借用中控台容器是默认：不额外占一个侧栏视图，' +
                            '而中控台本就常驻；独立视图便于把框架树与中控台分开摆放。',
                        aliases: ['委托', '中控台', '侧栏'],
                        control: {
                            type: 'dropdown',
                            key: 'delegateTarget',
                            defaultValue: 'hub',
                            options: DELEGATE_TARGET_LABELS,
                        },
                    },
                ],
            },
            {
                type: 'group',
                heading: '归档与删除',
                items: [
                    // 与「状态传播」分开：这条管子树怎么被带走、要不要拦一道
                    {
                        name: '归档时，后代节点',
                        desc: '破坏性操作对后代节点的处理方式。删除的文件会移入系统回收站。',
                        control: {
                            type: 'dropdown',
                            key: 'archiveChildren',
                            options: ARCHIVE_CHILDREN_LABELS,
                        },
                    },
                    {
                        name: '删除时，后代节点',
                        control: {
                            type: 'dropdown',
                            key: 'deleteChildren',
                            options: DELETE_CHILDREN_LABELS,
                        },
                    },
                    {
                        name: '归档时的提示',
                        control: { type: 'dropdown', key: 'archiveConfirm', options: CONFIRM_LEVEL_LABELS },
                    },
                    {
                        name: '删除时的提示',
                        control: { type: 'dropdown', key: 'deleteConfirm', options: CONFIRM_LEVEL_LABELS },
                    },
                ],
            },
            {
                // 子页：规则表是「任意条数的编辑器」，声明式表达不了，交给命令式渲染
                type: 'page',
                name: '状态传播规则',
                desc: '按状态类型配置父子传播。',
                displayValue: () => `${(this.plugin.settings.stateRules ?? []).length} 条规则`,
                items: [
                    {
                        name: '规则列表',
                        render: (setting) => {
                            // render 不自动保存，也不会自动重画 —— 改完自己存、自己 update()
                            this.renderRules(setting.settingEl);
                            return undefined;
                        },
                    },
                ],
            },
            {
                // 子页：类型名逐项可改，同样是声明式表达不了的"任意条数的编辑器"
                type: 'page',
                name: '类型显示名',
                desc: '给各类型换个叫法；只影响界面显示，不改文件内容。',
                displayValue: () => {
                    const overrides = this.plugin.settings.kindLabels ?? {};
                    const n = Object.values(overrides).filter(
                        (v) => typeof v === 'string' && v.trim() !== '',
                    ).length;
                    return n > 0 ? `${n} 项已自定义` : '全部默认';
                },
                items: [
                    {
                        name: '类型名',
                        render: (setting) => {
                            // 同上：render 不自动保存、不自动重画
                            this.renderKindLabels(setting.settingEl);
                            return undefined;
                        },
                    },
                ],
            },
        ];
    }

    // ============================================================
    // 状态传播规则（sub-page 的命令式部分）
    // ============================================================

    /** 冲突提示的槽位：每次 renderRules 时重建，供 renderConflicts 就地重画 */
    private conflictsEl: HTMLElement | null = null;

    private renderRules(el: HTMLElement): void {
        // setting-item 默认是横向 flex：这里追加的是「说明 + 提示 + 若干条规则」多块内容，
        // 若不改流向会被并排成一行（见 styles.css 的 .seqtk-settings-rules）
        el.addClass('seqtk-settings-rules');
        // 框架在 update() 后会复用同一个 settingEl 再调一次本回调：
        // 不清空就会把整张规则表又追加一份到下方（表现为「每次改动都在最下面重渲染一遍」）
        el.empty();

        el.createEl('p', {
            cls: 'setting-item-description',
            text:
                '按状态类型配置父子传播。\n' +
                '「父 → 子」：父进入触发状态时，把处于指定状态的后代一并改掉；\n' +
                '「子 → 父」：全部直接子节点都达到触发状态时，把父节点改掉。',
        });

        const rules = this.plugin.settings.stateRules ?? [];

        // 冲突提示占一个固定槽位：改触发 / 目标 / 复选 / 规则名都会影响它的内容，
        // 但都不改变规则表结构，因此只在原位重画它（见 renderConflicts）
        this.conflictsEl = el.createDiv();
        this.renderConflicts(rules);

        if (rules.length === 0) {
            el.createEl('p', { cls: 'setting-item-description', text: '尚未配置规则，状态变更不会传播。' });
        }

        rules.forEach((rule, index) => this.renderRule(el, rule, index));

        new Setting(el).addButton((b) =>
            b.setButtonText('添加规则').setCta().onClick(async () => {
                rules.push({
                    id: nextRuleId(rules),
                    enabled: true,
                    direction: 'down',
                    trigger: 'done',
                    from: ['plan', 'open'],
                    to: 'done',
                });
                await this.save();
            }),
        );
    }

    /**
     * 冲突 / 冗余提示：就地在固定槽位里重画
     *
     * 提示内容依赖触发状态 / 目标状态 / 复选集合 / 规则名，这些改动都不改变规则表结构，
     * 因此原地重画这一块即可，不必重建设置面板（也不会打断正在输入的规则名）。
     */
    private renderConflicts(rules: StatePropagationRule[]): void {
        const slot = this.conflictsEl;
        if (!slot) return;
        slot.empty();
        const conflicts = DETECT_RuleConflicts(rules);
        if (conflicts.length === 0) return;
        const box = slot.createDiv({ cls: 'seqtk-settings-conflict' });
        box.createEl('div', { text: '规则存在冲突或冗余：' });
        for (const c of conflicts) {
            box.createEl('div', { text: `· ${c.reason}（${c.ruleIds.join(' / ')}）` });
        }
    }

    /** 原地落盘：只保存并重画冲突提示，不重建设置面板（开关 / 触发 / 目标 / 复选 / 改名用） */
    private async commit(): Promise<void> {
        await Save_Setting(this.plugin);
        this.renderConflicts(this.plugin.settings.stateRules ?? []);
    }

    /** 一条规则的编辑行 */
    private renderRule(el: HTMLElement, rule: StatePropagationRule, index: number): void {
        const rules = this.plugin.settings.stateRules;

        const head = new Setting(el).setName(`规则 ${index + 1}`);
        // 规则名（即 rule.id）：只用于界面显示与冲突报告，改名不影响传播逻辑。
        // 走 commit() 而不是 save() —— 后者会重建设置面板，输入框会当场失焦；
        // 冲突提示里显示的名字由 commit() 原地重画跟上。
        head.addText((t) => {
            t.setPlaceholder('规则名');
            t.setValue(rule.id);
            t.inputEl.addClass('seqtk-rule-name');
            t.onChange(async (v) => {
                const name = v.trim();
                const bad = name === '' || rules.some((r) => r !== rule && r.id === name);
                t.inputEl.toggleClass('seqtk-input-invalid', bad);
                if (bad) return; // 空名 / 重名不落盘：标红提示，保持原名字
                rule.id = name;
                await this.commit();
            });
        });
        head.addToggle((t) =>
            t.setValue(rule.enabled).onChange(async (v) => {
                rule.enabled = v;
                await this.commit();
            }),
        );
        // 删除后少一行，规则表结构变了 —— 这一处仍需整体重建
        head.addExtraButton((b) =>
            b
                .setIcon('trash')
                .setTooltip('删除此规则')
                .onClick(async () => {
                    const i = rules.indexOf(rule);
                    if (i >= 0) rules.splice(i, 1);
                    await this.save();
                }),
        );

        // 方向：只有 down 才有「仅当子节点处于」那一行，切换会改变可见项 → 整体重建
        new Setting(el)
            .setName('方向')
            .setDesc(rule.direction === 'down' ? '父状态变化时向下传播' : '子节点全部达标时向上聚合')
            .addDropdown((d) =>
                d
                    .addOptions({ down: '父 → 子', up: '子 → 父' })
                    .setValue(rule.direction)
                    .onChange(async (v) => {
                        rule.direction = v as PropagationDirection;
                        await this.save();
                    }),
            );

        new Setting(el)
            .setName(rule.direction === 'down' ? '父进入此状态时触发' : '子全部达到此状态时触发')
            .addDropdown((d) => {
                for (const s of STATE_VALUES) d.addOption(s, NODE_STATE_LABELS[s]);
                d.setValue(rule.trigger).onChange(async (v) => {
                    rule.trigger = v as SeqtkState;
                    await this.commit();
                });
            });

        new Setting(el)
            .setName('改写为')
            .addDropdown((d) => {
                for (const s of STATE_VALUES) d.addOption(s, NODE_STATE_LABELS[s]);
                d.setValue(rule.to).onChange(async (v) => {
                    rule.to = v as SeqtkState;
                    await this.commit();
                });
            });

        // 「从」集合：仅 down 方向有意义（状态只有四种，用复选比多选框更直观）
        if (rule.direction === 'down') {
            const box = new Setting(el).setName('仅当子节点处于').setDesc('全不勾选 = 任意状态都改写');
            box.settingEl.addClass('seqtk-setting-stack');
            const chips = box.settingEl.createDiv({ cls: 'seqtk-state-checks' });
            for (const s of STATE_VALUES) {
                const label = chips.createEl('label', { cls: 'seqtk-state-check' });
                const cb = label.createEl('input', { type: 'checkbox' });
                cb.checked = rule.from.includes(s);
                cb.addEventListener('change', async () => {
                    const set = new Set(rule.from);
                    if (cb.checked) set.add(s);
                    else set.delete(s);
                    rule.from = [...set];
                    await this.commit();
                });
                label.createSpan({ text: NODE_STATE_LABELS[s] });
            }
        }
    }

    /** 保存并重建定义（规则条数/方向变化会影响可见项，整体重建最省心） */
    private async save(): Promise<void> {
        await Save_Setting(this.plugin);
        this.update();
    }

    // ============================================================
    // 类型显示名（sub-page 的命令式部分）
    // ============================================================

    /**
     * 类型名编辑器：按大类分组列出全部类型，每项一个文本框 + 一个「恢复默认」按钮
     *
     * 两点与规则页同源的讲究：
     * - 落盘时机在**失焦 / 回车**，而不是 onChange：onChange 每敲一个字都会触发，
     *   拿它写盘等于每敲一个字写一次磁盘。onChange 这里只做即时校验（重名标红）。
     * - 编辑过程中不 update() 重建 —— 重建会把正在编辑的输入框换掉；
     *   只有「恢复默认」按钮在点击完成后才重建（输入框要显示回默认名）。
     */
    private renderKindLabels(el: HTMLElement): void {
        // 与规则页同理：setting-item 默认是横向 flex，这里要塞多块内容
        el.addClass('seqtk-settings-kind-labels');
        // 框架在 update() 后会复用同一个 settingEl 再调一次本回调：不清空会追加第二份
        el.empty();

        el.createEl('p', {
            cls: 'setting-item-description',
            text:
                '给各类型换个叫法：徽章、右键菜单、行内新建下拉、导入预览等处都会跟着变。\n' +
                '只影响界面显示 —— 节点文件里存的是类型值本身，既有数据不受影响、也不会被改写。\n' +
                '留空即用回默认名。改完需要重开视图（或重载插件），已经打开的界面才会跟着变。\n' +
                '框架类型不在此列：它们在界面上统一显示「框架」。',
        });

        const overrides = this.plugin.settings.kindLabels;

        for (const group of GET_KindLabelGroups()) {
            el.createEl('h4', { text: group.title });
            for (const item of group.kinds) {
                this.renderKindLabelRow(el, item.kind, item.defaultLabel, overrides);
            }
        }
    }

    /** 一个类型名的编辑行 */
    private renderKindLabelRow(
        el: HTMLElement,
        kind: NodeKindValue,
        defaultLabel: string,
        overrides: Record<string, string>,
    ): void {
        const row = new Setting(el).setName(defaultLabel).setDesc(`类型值 ${kind} · 留空即用回默认名。`);
        // 当前生效名（改过就是改后的名字）：既是输入框初值，也是"没动就失焦"时要提交的值
        const current = NODE_KIND_LABELS[kind] ?? defaultLabel;

        row.addText((t) => {
            t.setPlaceholder(defaultLabel);
            t.setValue(current);
            t.inputEl.addClass('seqtk-kind-label-input');
            // 即时校验：与规则名一致，重名标红（不落盘在下面的提交里再拦一次）
            t.onChange((v) => t.inputEl.toggleClass('seqtk-input-invalid', this.isDuplicateKindLabel(kind, v)));
            // 落盘放在失焦 / 回车 —— onChange 是每敲一个字一次，用它写盘太吵
            t.inputEl.addEventListener('blur', () => void this.commitKindLabel(kind, defaultLabel, t.inputEl));
            t.inputEl.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                // 回车等于"改完了"：走同一条提交路径，不额外写一份逻辑
                e.preventDefault();
                t.inputEl.blur();
            });
        });

        row.addExtraButton((b) =>
            b
                .setIcon('rotate-ccw')
                .setTooltip('恢复默认名')
                .onClick(async () => {
                    delete overrides[kind];
                    await Save_Setting(this.plugin);
                    // 这里可以重建：输入框要显示回默认名，页头的"N 项已自定义"也要跟上。
                    // 重建发生在点击之后，不会出现"点按钮时被换掉"的情形。
                    this.update();
                }),
        );
    }

    /** 名字是否已被别的类型占用（空名不算重名：那是"用回默认"） */
    private isDuplicateKindLabel(kind: NodeKindValue, raw: string): boolean {
        const name = raw.trim();
        if (name === '') return false;
        return (Object.keys(NODE_KIND_LABELS) as NodeKindValue[]).some(
            (k) => k !== kind && NODE_KIND_LABELS[k] === name,
        );
    }

    /**
     * 类型名落盘
     *
     * 空串、与默认名相同都视为"没改"—— 直接从覆盖表里删掉，不去存一个等于默认值的项，
     * 这样设置文件里只留真正改过的类型，"恢复默认"也不必额外清理。
     */
    private async commitKindLabel(
        kind: NodeKindValue,
        defaultLabel: string,
        inputEl: HTMLInputElement,
    ): Promise<void> {
        const name = inputEl.value.trim();
        if (this.isDuplicateKindLabel(kind, name)) {
            inputEl.addClass('seqtk-input-invalid');
            new Notice(`「${name}」已经是另一个类型的显示名，未保存`);
            return;
        }
        inputEl.removeClass('seqtk-input-invalid');

        const overrides = this.plugin.settings.kindLabels;
        if (name === '' || name === defaultLabel) delete overrides[kind];
        else overrides[kind] = name;
        // Save_Setting 内部会 APPLY_KindLabels：存下来的与生效的始终是同一份名字
        await Save_Setting(this.plugin);
    }
}

export const Register_SettingsTab = (p: SeqtkPlugin) => p.addSettingTab(new SettingsTab(p.app, p));
