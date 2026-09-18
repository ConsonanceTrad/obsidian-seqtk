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
 *   - **类型外观**：类型名与配色按大类聚合在一起，同样一个 sub-page，每项带「恢复默认」按钮
 * 两者的 render 回调都不会自动保存，改动要自己落盘（见各自的 render 方法）。
 *
 * ── sub-page 里命令式渲染的四条硬约束（同一个坑踩过三次，写在这里免得再来一遍）──
 *   1. **先改流向**：`render` 拿到的是那条 setting-item，**默认横向 flex** —— 不先
 *      `el.addClass('seqtk-settings-<页名>')` 并在 styles.css 里给它 `display: block`，
 *      追加进去的多块内容会被并排成一整条横排（踩三次的就是这个）。
 *   2. **纵向排布**：自己造的一条 = 名称一行 + 说明一行（column），且**一个条目一个语法/字段**，
 *      不要在同一行里用分隔符并列多项。
 *   3. **字体与颜色随官方**：说明 `var(--font-ui-smaller)` + `var(--text-muted)`，
 *      代码片段 `var(--font-monospace)`；不要用正文色、更不要放大成标题。
 *   4. **优先用官方组件**：`new Setting(el).setName(...).setDesc(...)` 能表达的就不手写 DOM；
 *      只有自定义控件（取色器、代码片段、可增删的表）才手写，且沿用官方行的字体与间距。
 *   详见 `P3_Settings/Settings.md` 的「子页面的特殊性」一节。
 *
 * update() 的代价：它是"重建整个设置面板"，所有设置项 DOM 会换一遍 —— 焦点与滚动位置
 * 随之回到面板开头。因此**只有会改变可见项结构**的改动才调它（规则增删、方向切换），
 * 单纯改值一律就地更新（见 commit / commitKindLabel / commitKindColor / renderKindSummary）。
 *
 * manifest 的 minAppVersion 已提到 1.13.0 —— 该 API 的下限。
 */

import {
    App,
    Notice,
    PluginSettingTab,
    Setting,
    type ColorComponent,
    type SettingDefinitionItem,
    type ToggleComponent,
} from 'obsidian';
import type SeqtkPlugin from "../main";
import { Save_Setting, DELEGATE_TARGET_LABELS, TIMESTAMP_CONFIG_LABELS, GET_TimestampSummary } from "./Settings";
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
import { NODE_KIND_LABELS } from "../P4_Nodes/NodeKind/NodeLabel";
import { GET_KindAppearanceGroups, type KindAppearanceType, type KindColorItem } from "../P4_Nodes/NodeKind/KindColors";
import type { NodeKindValue } from "../P4_Nodes/NodeKind/NodeKind";
import { HUB_CATEGORIES, type HubCategory } from "../P6_Views/panelRegistry";
import { GET_SyntaxGuide } from "../P2_Tools/Parse/SyntaxGuide";

/** 生成一个不会与现有规则撞车的 id */
function nextRuleId(rules: StatePropagationRule[]): string {
    let n = 1;
    while (rules.some((r) => r.id === `rule-${n}`)) n++;
    return `rule-${n}`;
}

/** 覆盖表里有几项是"真改过的"（空串等于没改，与落盘口径一致） */
function COUNT_CustomEntries(table: Record<string, string> | undefined): number {
    return Object.values(table ?? {}).filter((v) => typeof v === 'string' && v.trim() !== '').length;
}

/** 中控台里一共隐藏了多少项（口径与落盘一致：空列表等于没配过） */
function COUNT_HiddenEntries(hub: Record<string, { hidden: string[] }> | undefined): number {
    return Object.values(hub ?? {}).reduce((n, cfg) => n + (cfg?.hidden?.length ?? 0), 0);
}

/**
 * 取色器落盘的防抖窗口（ms）
 *
 * ColorComponent 只暴露 onChange，而拖动取色时它会连续触发；逐次写盘等于一路敲磁盘。
 * 内存里的覆盖值当场更新，所以效果是即时的，防的只是写盘频率。
 */
const COLOR_SAVE_DEBOUNCE_MS = 300;

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
                heading: '基础配置',
                items: [
                    {
                        name: '存储路径',
                        desc: '相对路径。节点文件与插件缓存数据的存储位置。',
                        aliases: ['root', 'folder', '路径'],
                        control: {
                            type: 'text',
                            key: 'rootFolder',
                            placeholder: '例如：seqtk',
                            validate: (v) => (v.trim() ? undefined : '不能为空'),
                        },
                    },
                    {
                        name: '渲染委托',
                        desc:
                            '双栏视图，左栏框架树被委托拆分到其他位置渲染的目标位置，默认借用中控台容器。',
                        aliases: ['委托', '中控台', '侧栏'],
                        control: {
                            type: 'dropdown',
                            key: 'delegateTarget',
                            defaultValue: 'hub',
                            options: DELEGATE_TARGET_LABELS,
                        },
                    }
                ],
            },
            {
                type: 'group',
                heading: '归档与删除',
                items: [
                    // 与「状态传播」分开：这条管子树怎么被带走、要不要拦一道
                    {
                        name: '连带归档',
                        desc: '归档时，后代如何处理。',
                        control: {
                            type: 'dropdown',
                            key: 'archiveChildren',
                            options: ARCHIVE_CHILDREN_LABELS,
                        },
                    },
                    {
                        name: '归档提示',
                        desc: '归档时如何进行提示。',
                        control: { type: 'dropdown', key: 'archiveConfirm', options: CONFIRM_LEVEL_LABELS },
                    },
                    {
                        name: '连带删除',
                        // 选项里既有「后代脱离父级」也有「后代一并删除」，不能只说「归档」
                        desc: '删除时，后代如何处理。',
                        control: {
                            type: 'dropdown',
                            key: 'deleteChildren',
                            options: DELETE_CHILDREN_LABELS,
                        },
                    },
                    {
                        name: '删除提示',
                        desc: '删除时如何进行提示。',
                        control: { type: 'dropdown', key: 'deleteConfirm', options: CONFIRM_LEVEL_LABELS },
                    },
                ],
            },
            {
                type: 'group',
                heading: '其他配置',
                items: [
                    {
                        // 子页：规则表是「任意条数的编辑器」，声明式表达不了，交给命令式渲染
                        type: 'page',
                        name: '状态传播规则',
                        desc: '配置父子状态传播的自动规则。',
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
                        // 子页：类型名与配色逐项可改，同样是声明式表达不了的"任意条数的编辑器"
                        // （框架类型不参与命名，理由见 P4_Nodes/NodeKind/NodeLabel 的分组顺序说明）
                        type: 'page',
                        name: '类型外观',
                        desc: '更改类型命名与标签调色。',
                        // 页头摘要：统计"真改过的"项数（口径与落盘一致）。
                        // 它只在本页被重画时才读一次，页内的即时摘要见 renderKindSummary。
                        displayValue: () => {
                            const parts: string[] = [];
                            const names = COUNT_CustomEntries(this.plugin.settings.kindLabels);
                            const colors = COUNT_CustomEntries(this.plugin.settings.kindColors);
                            const inverted = Object.values(this.plugin.settings.kindTextInverted ?? {}).filter(Boolean).length;
                            if (names > 0) parts.push(`名 ${names}`);
                            if (colors > 0) parts.push(`色 ${colors}`);
                            if (inverted > 0) parts.push(`黑字 ${inverted}`);
                            return parts.length > 0 ? `${parts.join(' / ')} 项已自定义` : '全部默认';
                        },
                        items: [
                            {
                                name: '类型名与配色',
                                render: (setting) => {
                                    // 同上：render 不自动保存、不自动重画
                                    this.renderKindAppearance(setting.settingEl);
                                    return undefined;
                                },
                            },
                        ],
                    },
                    {
                        // 子页：条目由解析器的常量派生（见 P2_Tools/Parse/SyntaxGuide），
                        // 改语法时这一页跟着变；命令式渲染成一张速查表
                        type: 'page',
                        name: '语法指南',
                        desc: '文本树与模板文本里能写的全部语法。',
                        displayValue: () => `${GET_SyntaxGuide().length} 条`,
                        items: [
                            {
                                name: '速查表',
                                render: (setting) => {
                                    this.renderSyntaxGuide(setting.settingEl);
                                    return undefined;
                                },
                            },
                        ],
                    },
                    {
                        // 子页：条目数由 plugin.panelRegistry 决定（谁注册了带 category 的 metas，
                        // 谁就在这一页上），声明式表达不了，同样交给命令式渲染
                        type: 'page',
                        name: '中控台显示',
                        desc: '控制中控台目录里显示哪些面板。',
                        // 页头摘要：只在本页被重画时读一次；页内的即时摘要见 renderHubSummary
                        displayValue: () => {
                            const n = COUNT_HiddenEntries(this.plugin.settings.hub);
                            return n > 0 ? `已隐藏 ${n} 项` : '全部显示';
                        },
                        items: [
                            {
                                name: '按视图开关',
                                render: (setting) => {
                                    // 同上：render 不自动保存、不自动重画
                                    this.renderHubVisibility(setting.settingEl);
                                    return undefined;
                                },
                            },
                        ],
                    },
                    {
                        // 本页**只用声明式 control**（dropdown / text）：框架负责渲染与保存，
                        // 因而不写 render，也就不涉及上面那四条 sub-page 约束（改流向 / 纵排 / 字体 / 官方组件）；
                        // 页头摘要也用 displayValue（同属声明式）。
                        // 两个文本框始终显示，切换来源不改变可见项结构 —— 因此也不需要 update()
                        type: 'page',
                        name: '时间戳',
                        desc: '「创建关联时间戳」用哪份目录与格式建笔记，「快速创建」与「创建并打开」共用这份配置。',
                        displayValue: () => GET_TimestampSummary(this.plugin.settings),
                        items: [
                            {
                                name: '配置来源',
                                desc: '跟随核心插件时读它的目录与格式；读不到或未启用时自动回退到下面两项。',
                                control: {
                                    type: 'dropdown',
                                    key: 'timestampConfig',
                                    options: TIMESTAMP_CONFIG_LABELS,
                                },
                            },
                            {
                                name: '文件名格式',
                                desc: 'moment 的 token，例如 YYYYMMDDHHmmss。',
                                control: { type: 'text', key: 'timestampFormat' },
                            },
                            {
                                name: '落点目录',
                                desc: '相对库根目录；留空 = 库根的 Timestamp 文件夹。',
                                control: { type: 'text', key: 'timestampFolder' },
                            },
                        ],
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

    /**
     * 一条规则的编辑块
     *
     * 一条规则有 4~5 行内容（名字 / 方向 / 触发 / 改写为 / 可选的状态集合），它们同属一件事，
     * 所以全部挂进**同一个 `.seqtk-rule-block`**，由样式表把块内的分隔线去掉 ——
     * 否则框架会在每两行之间画一条线，一条规则看着像五条互不相干的设置。
     */
    private renderRule(el: HTMLElement, rule: StatePropagationRule, index: number): void {
        const rules = this.plugin.settings.stateRules;
        const block = el.createDiv({ cls: 'seqtk-rule-block' });

        const head = new Setting(block).setName(`规则 ${index + 1}`);
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
        new Setting(block)
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

        new Setting(block)
            .setName(rule.direction === 'down' ? '父进入此状态时触发' : '子全部达到此状态时触发')
            .addDropdown((d) => {
                for (const s of STATE_VALUES) d.addOption(s, NODE_STATE_LABELS[s]);
                d.setValue(rule.trigger).onChange(async (v) => {
                    rule.trigger = v as SeqtkState;
                    await this.commit();
                });
            });

        new Setting(block)
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
            const box = new Setting(block).setName('仅当子节点处于').setDesc('全不勾选 = 任意状态都改写');
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
    // 类型外观：更名 + 配色（sub-page 的命令式部分）
    // ============================================================

    /** 页内摘要槽位：每次 renderKindAppearance 时重建，供 renderKindSummary 就地更新 */
    private kindSummaryEl: HTMLElement | null = null;

    /**
     * 类型外观编辑器：按大类分组，每个类型一行装完
     *
     * 结构（每组先给大类基色，随后是组内各类型，一个类型一行）：
     *   框架    大类基色 [色块] [字体反色] [⟲]
     *   事务    构想   [名称] [色块] [字体反色] [⟲]
     *           项目   [名称] [色块] [字体反色] [⟲]
     *           …
     * 名字、颜色、字色同处一行 —— 拆成「名字一行、颜色一行」的话，框架会在两行之间自动画
     * 一条分隔线，同一个类型的信息看着像两件不相干的事。
     * 大类基色仍单独一行：它不是"某个类型的颜色"，而是该大类下的共用底色。
     *
     * 三点与规则页同源的讲究：
     * - 名字的落盘时机在**失焦 / 回车**，而不是 onChange：onChange 每敲一个字都会触发，
     *   拿它写盘等于每敲一个字写一次磁盘。onChange 这里只做即时校验（重名标红）。
     *   取色器的落盘同样做了防抖（见 renderKindTypeRow）。
     * - 全程**不调 update()**：它会把整页重建一遍，正在编辑的输入框会被换掉、
     *   焦点与滚动也会跑回面板开头。所有变化都就地更新（控件值、页内摘要）。
     * - 页内摘要自己维护一份（见 renderKindSummary）：页头的 displayValue 只在重画时才读。
     *
     * 生效时机不同：**配色与字色立即生效**（Save_Setting 会把颜色推进 CSS 变量，徽章当场变色）；
     * **名字要重开视图**才生效（已经渲染好的 DOM 不会自己重画）—— 这条只在页面顶部说明一次。
     */
    private renderKindAppearance(el: HTMLElement): void {
        // 与规则页同理：setting-item 默认是横向 flex，这里要塞多块内容。
        // 类名沿用样式表里的钩子 .seqtk-settings-kind-labels
        el.addClass('seqtk-settings-kind-labels');
        // 框架在 update() 后会复用同一个 settingEl 再调一次本回调：不清空会追加第二份
        el.empty();

        // 页内摘要：与页头的 displayValue 同义，但它是**即时**的（本页刻意不重画设置面板）
        this.kindSummaryEl = el.createEl('p', { cls: 'setting-item-description' });
        this.renderKindSummary();

        // 生效时机只说一次（每行都写就成噪音了）：
        // 配色走 CSS 变量所以立即生效；名字要等界面重画，因此得重开视图
        el.createEl('p', {
            cls: 'setting-item-description',
            text: '配色与字体反色改完立即生效；名字改完需要重开视图（或重载插件）才生效。',
        });

        const labelOverrides = this.plugin.settings.kindLabels;
        const inverted = this.plugin.settings.kindTextInverted ?? {};

        for (const group of GET_KindAppearanceGroups(inverted)) {
            el.createEl('h4', { text: group.title });
            // 大类基色：事务组没有这一行（它的类型全部各有角色色，见 KindColors 的 NO_CATEGORY_COLOR）
            if (group.categoryItem) this.renderKindColorRow(el, group.categoryItem, group.title);
            // 每个类型一行装完：名称 + 配色 + 字体反色 + 恢复默认
            for (const item of group.kinds) this.renderKindTypeRow(el, item, labelOverrides);
        }
    }

    /**
     * 页内摘要（"已自定义：显示名 N 项 · 配色 M 项 · 黑字 K 项"）—— 就地更新，不重建设置面板
     *
     * 页头的 displayValue 只在框架重画设置页时被读一次；而本页的改动刻意不重画
     * （重建会把所有设置项换掉、焦点与滚动跟着跑掉），所以页内自己维护一份即时的。
     * 口径与落盘一致：空串等于没改。
     */
    private renderKindSummary(): void {
        const slot = this.kindSummaryEl;
        if (!slot) return;
        const parts: string[] = [];
        const names = COUNT_CustomEntries(this.plugin.settings.kindLabels);
        const colors = COUNT_CustomEntries(this.plugin.settings.kindColors);
        const inverted = Object.values(this.plugin.settings.kindTextInverted ?? {}).filter(Boolean).length;
        if (names > 0) parts.push(`显示名 ${names} 项`);
        if (colors > 0) parts.push(`配色 ${colors} 项`);
        if (inverted > 0) parts.push(`黑字 ${inverted} 项`);
        slot.setText(parts.length > 0 ? `已自定义：${parts.join(' · ')}。` : '当前全部使用默认外观。');
    }

    /**
     * 一个类型的外观行：名称 + 配色 + 字体反色 + 恢复默认，全部挂**同一个 `Setting`**
     *
     * 不再拆成「名字一行、颜色一行」—— Obsidian 的设置在相邻 `setting-item` 之间自动画分隔线，
     * 那样会把同一个类型的信息切成两半，看着像两个不相干的东西。
     *
     * 三类改动的落盘时机各不相同，理由写在各自回调旁：
     * 名称走**失焦 / 回车**、配色走 **300ms 防抖**、字体反色立即落盘。
     * 全程**不调 `update()`**：它会把整页重建，刚点的按钮连同整页消失、焦点与滚动回到开头。
     *
     * 没有自己配色的类型（非事务大类的类型走大类基色，`roleItem` 为 null）只渲染名字那半。
     */
    private renderKindTypeRow(
        el: HTMLElement,
        item: KindAppearanceType,
        overrides: Record<string, string>,
    ): void {
        const kind = item.kind;
        const defaultLabel = item.defaultLabel;
        const role = item.roleItem;
        const row = new Setting(el).setName(defaultLabel).setDesc(`${kind}`);
        // 当前生效名（改过就是改后的名字）：既是输入框初值，也是"没动就失焦"时要提交的值
        const current = NODE_KIND_LABELS[kind] ?? defaultLabel;

        const colors = this.plugin.settings.kindColors;
        const invertedTable = this.plugin.settings.kindTextInverted;
        // 「恢复默认」要就地复位这几个控件，所以把引用留到各自回调之外
        let inputEl: HTMLInputElement | null = null;
        let picker: ColorComponent | null = null;
        let toggle: ToggleComponent | null = null;
        // 取色器的落盘防抖（拖动期间 onChange 连续触发，逐次写盘太吵）
        let saveTimer = 0;

        row.addText((t) => {
            inputEl = t.inputEl;
            t.setPlaceholder(defaultLabel);
            t.setValue(current);
            t.inputEl.addClass('seqtk-kind-label-input');
            // 即时校验：与规则名一致，重名标红（不落盘在下面的提交里再拦一次）
            t.onChange((v) => t.inputEl.toggleClass('seqtk-input-invalid', this.isDuplicateKindLabel(kind, v)));
            // 落盘放在失焦 / 回车 —— onChange 是每敲一个字一次，用它写盘太吵
            t.inputEl.addEventListener('blur', () => void this.commitKindLabel(kind, defaultLabel, t.inputEl));
            t.inputEl.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                // 回车等于"改完了"：走同一条提交路径，不另写一份逻辑
                e.preventDefault();
                t.inputEl.blur();
            });
        });

        if (role) {
            row.addColorPicker((cp) => {
                picker = cp;
                cp.setValue(role.value || role.defaultColor);
                // 取色器没有原生 label，而 ColorComponent 也不像 ToggleComponent 那样暴露
                // 自己的元素（只有 setValue / onChange），所以按类型找到那个 input，插在它**前面** ——
                // 控制区里第一个是名称输入框，插到最前面会让这行字落在输入框旁、指错对象
                row.settingEl
                    .querySelector<HTMLElement>('.setting-item-control input[type="color"]')
                    ?.insertAdjacentElement(
                        'beforebegin',
                        createSpan({ cls: 'seqtk-control-label', text: '标签底色' }),
                    );
                //
                // 落盘做 300ms 防抖：ColorComponent 只暴露 onChange，而它在拖动取色时连续触发，
                // 逐次落盘等于一路敲磁盘（组件也没给出原生 input，拿不到"关闭取色器"那一次 change）。
                // 内存里的覆盖值当场更新，所以真正的效果是即时的；防抖的只是写盘。
                //
                cp.onChange((value) => {
                    const next = (value ?? '').trim();
                    if (next && next !== role.defaultColor) colors[role.key] = next;
                    else delete colors[role.key];
                    if (saveTimer) window.clearTimeout(saveTimer);
                    saveTimer = window.setTimeout(() => {
                        saveTimer = 0;
                        void this.commitKindColor();
                    }, COLOR_SAVE_DEBOUNCE_MS);
                });
            });

            row.addToggle((t) => {
                toggle = t;
                // 同样没有原生 label：插一行小字说明它管什么
                t.toggleEl.insertAdjacentElement(
                    'beforebegin',
                    createSpan({ cls: 'seqtk-control-label', text: '字体反色' }),
                );
                t.setValue(role.inverted).onChange(async (v) => {
                    if (v) invertedTable[role.key] = true;
                    else delete invertedTable[role.key];
                    await this.commitKindColor();
                });
            });
        }

        row.addExtraButton((b) =>
            b
                .setIcon('rotate-ccw')
                .setTooltip(role ? '恢复默认名与配色' : '恢复默认名')
                .onClick(async () => {
                    // 取色器可能还有一次待落盘的防抖在排队：取消掉，免得刚复位又被写回
                    if (saveTimer) {
                        window.clearTimeout(saveTimer);
                        saveTimer = 0;
                    }
                    delete overrides[kind];
                    if (role) {
                        delete colors[role.key];
                        delete invertedTable[role.key];
                    }
                    await Save_Setting(this.plugin);
                    //
                    // 就地复位，**不**调 update()：
                    // update() 的语义是"重建整个设置面板"，所有设置项 DOM 会换一遍 ——
                    // 刚被点的那个按钮连同整页一起消失，焦点与滚动回到面板开头，
                    // 表现出来就是"不管点哪一行的按钮，焦点都跳去第一个输入框（构想）"。
                    // 这里真正要变的只有这几样：输入框的值、取色器、反色开关、页内摘要。
                    //
                    if (inputEl) {
                        inputEl.value = defaultLabel;
                        inputEl.removeClass('seqtk-input-invalid');
                    }
                    if (role) {
                        picker?.setValue(role.defaultColor);
                        toggle?.setValue(false);
                    }
                    this.renderKindSummary();
                }),
        );
    }

    /**
     * 一条「配色 + 字体反色 + 恢复默认」的行
     *
     * 现在只有**大类基色**走这条路 —— 类型自己的颜色已经并进 renderKindTypeRow 的那一行；
     * 函数本身仍按通用写法，将来若要单独摆一行配色可直接复用。
     *
     * 与名字一样全程不调 update()，所有要变的东西都就地改（取色器值、开关、页内摘要）。
     * 差别在生效时机：配色**改完立即生效** —— Save_Setting 会把新色推进 CSS 变量，
     * 徽章与附加行预览当场变色，不必重开视图。
     *
     * @param ownerLabel 这一行归属谁（当前是大类名）：只用于把描述说清楚
     */
    private renderKindColorRow(el: HTMLElement, item: KindColorItem, ownerLabel: string): void {
        const desc =
            item.label === '大类基色'
                ? `${ownerLabel}下的共用底色 · 默认为 ${item.defaultColor}`
                : `默认为 ${item.defaultColor}`;
        const row = new Setting(el).setName(item.label).setDesc(desc);
        const colors = this.plugin.settings.kindColors;
        const inverted = this.plugin.settings.kindTextInverted;
        // 「恢复默认」要就地复位这两样，所以把组件引用留到回调之外
        let picker: ColorComponent | null = null;
        let toggle: ToggleComponent | null = null;
        // 取色器的落盘防抖（拖动期间 onChange 连续触发，逐次写盘太吵）
        let saveTimer = 0;

        row.addColorPicker((cp) => {
            picker = cp;
            cp.setValue(item.value || item.defaultColor);
            //
            // 落盘做 300ms 防抖：ColorComponent 只暴露 onChange，而它在拖动取色时连续触发，
            // 逐次落盘等于一路敲磁盘（组件也没给出原生 input，拿不到"关闭取色器"那一次 change）。
            // 内存里的覆盖值当场更新，所以真正的效果是即时的；防抖的只是写盘。
            //
            cp.onChange((value) => {
                const next = (value ?? '').trim();
                if (next && next !== item.defaultColor) colors[item.key] = next;
                else delete colors[item.key];
                if (saveTimer) window.clearTimeout(saveTimer);
                saveTimer = window.setTimeout(() => {
                    saveTimer = 0;
                    void this.commitKindColor();
                }, COLOR_SAVE_DEBOUNCE_MS);
            });
        });

        row.addToggle((t) => {
            toggle = t;
            // 同样没有原生 label：插一行小字说明它管什么
            t.toggleEl.insertAdjacentElement(
                'beforebegin',
                createSpan({ cls: 'seqtk-control-label', text: '字体反色' }),
            );
            t.setValue(item.inverted).onChange(async (v) => {
                if (v) inverted[item.key] = true;
                else delete inverted[item.key];
                await this.commitKindColor();
            });
        });

        row.addExtraButton((b) =>
            b
                .setIcon('rotate-ccw')
                .setTooltip('恢复默认')
                .onClick(async () => {
                    // 取色器可能还有一次待落盘的防抖在排队：取消掉，免得刚复位又被写回
                    if (saveTimer) {
                        window.clearTimeout(saveTimer);
                        saveTimer = 0;
                    }
                    delete colors[item.key];
                    delete inverted[item.key];
                    await Save_Setting(this.plugin);
                    // 就地复位：取色器回默认为色、反色开关回白字（关）
                    picker?.setValue(item.defaultColor);
                    toggle?.setValue(false);
                    this.renderKindSummary();
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
        // 页内摘要即时跟上（页头的 displayValue 要等下次重画，见 renderKindSummary）
        this.renderKindSummary();
    }

    /**
     * 配色落盘
     *
     * Save_Setting 内部会 APPLY_KindColors 并把生效色推进 CSS 变量 ——
     * 所以调用之后徽章立刻变色，不必重开视图。
     */
    private async commitKindColor(): Promise<void> {
        await Save_Setting(this.plugin);
        this.renderKindSummary();
    }

    // ============================================================
    // 中控台显示（sub-page 的命令式部分）
    // ============================================================

    /** 页内摘要槽位：每次 renderHubVisibility 时重建，供 renderHubSummary 就地更新 */
    private hubSummaryEl: HTMLElement | null = null;

    /**
     * 中控台显隐：按分栏列出注册进来的视图，逐条一个开关
     *
     * 条目来自 plugin.panelRegistry（谁注册了带 category 的 metas，谁就在这一页上）——
     * 条目数是运行时定的，声明式表达不了，所以与规则页、类型外观页一样走命令式。
     * **顺序不归这一页管**：中控台的排列由代码里的 HUB_DEFAULT_ORDER 决定。
     *
     * 与另两个子页同源的讲究：开关改完立即落盘，且**不调 update()** ——
     * update() 会把整页重建，焦点与滚动位置跟着跑掉。
     */
    private renderHubVisibility(el: HTMLElement): void {
        // setting-item 默认横向 flex，这里要塞多块内容（见 styles.css 的 .seqtk-settings-hub）
        el.addClass('seqtk-settings-hub');
        // 框架在 update() 后会复用同一个 settingEl 再调一次本回调：不清空会追加第二份
        el.empty();

        // 页内摘要：与页头的 displayValue 同义，但它是**即时**的（本页刻意不重画设置面板）
        this.hubSummaryEl = el.createEl('p', { cls: 'setting-item-description' });
        this.renderHubSummary();

        el.createEl('p', {
            cls: 'setting-item-description',
            text: '关掉的视图不再出现在中控台目录里。排列顺序不在这里调 —— 它由代码中的 HUB_DEFAULT_ORDER 决定。',
        });

        const entries = this.plugin.panelRegistry.filter((e) => e.category);
        for (const cat of HUB_CATEGORIES) {
            const inCat = entries.filter((e) => e.category === cat);
            if (inCat.length === 0) continue;
            el.createEl('h4', { text: cat });
            const hidden = new Set(this.plugin.settings.hub[cat]?.hidden ?? []);
            for (const entry of inCat) {
                const row = new Setting(el)
                    .setName(entry.title)
                    .setDesc(`${entry.viewType}${entry.placeholder ? ' · 规划中' : ''}`);
                row.addToggle((t) =>
                    // 开关「开」= 显示：初值取反，改动时把 hidden 写回去
                    t.setValue(!hidden.has(entry.viewType)).onChange(async (v) => {
                        this.SET_HubHidden(cat, entry.viewType, !v);
                        await Save_Setting(this.plugin);
                        this.renderHubSummary();
                    }),
                );
            }
        }
    }

    /**
     * 就地改 hidden 列表：隐藏时加入、显示时移除
     *
     * 空列表就把该分栏的键整个删掉 —— 与落盘口径一致（"没配过"与"配了个空数组"
     * 不该在设置文件里长得不一样）。
     */
    private SET_HubHidden(cat: HubCategory, viewType: string, hide: boolean): void {
        const hub = this.plugin.settings.hub;
        const set = new Set(hub[cat]?.hidden ?? []);
        if (hide) set.add(viewType);
        else set.delete(viewType);
        if (set.size === 0) delete hub[cat];
        else hub[cat] = { hidden: [...set] };
    }

    /** 页内摘要（"已隐藏 N 项"）—— 就地更新，不重建设置面板 */
    private renderHubSummary(): void {
        const slot = this.hubSummaryEl;
        if (!slot) return;
        const n = COUNT_HiddenEntries(this.plugin.settings.hub);
        slot.setText(n > 0 ? `已隐藏 ${n} 项。` : '中控台当前显示全部面板。');
    }

    // ============================================================
    // 语法指南（sub-page 的命令式部分）
    // ============================================================

    /**
     * 语法速查表（只读）
     *
     * 条目来自解析器（`GET_SyntaxGuide()`，由语法常量派生），这里只负责排版：按分组连续
     * 列出，一条一行（语法在上、说明在下）—— 指南与解析不会各说各话。
     *
     * 注意 `el` 是那条 **setting-item**（默认横向 flex）：不先改流向，下面这些行会被并排
     * 成一整条横排（踩过三次的坑，见 P3_Settings/Settings.md「子页面的特殊性」）。
     */
    private renderSyntaxGuide(el: HTMLElement): void {
        el.addClass('seqtk-settings-syntax');
        el.empty();
        el.createEl('p', {
            cls: 'setting-item-description',
            text: '这些语法在「模板模式」右栏文本区与「以文本批量编辑」里通用；在文本区里输入 @ 会唤出补全。',
        });

        let lastGroup = '';
        for (const entry of GET_SyntaxGuide()) {
            if (entry.group !== lastGroup) {
                el.createEl('h4', { text: entry.group });
                lastGroup = entry.group;
            }
            const row = el.createDiv('seqtk-syntax-row');
            row.createEl('code', { cls: 'seqtk-syntax-code', text: entry.syntax });
            row.createSpan({ cls: 'seqtk-syntax-detail', text: entry.detail });
        }
    }
}

export const Register_SettingsTab = (p: SeqtkPlugin) =>
    p.addSettingTab(new SettingsTab(p.app, p));
