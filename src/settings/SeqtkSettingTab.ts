/**
 * SeqtkSettingTab — 插件设置面板
 *
 * 当前仅含「中控台管理」区：
 * - 按章节（对应操作口目录）分组展示中控台全部面板
 * - 每项可显隐（toggle；隐藏后仍在此处可恢复）
 * - 每项可组内上移/下移调整顺序
 * 变更即时写入 settings.hub 并保存。
 */

import { App, PluginSettingTab, Setting } from 'obsidian';
import SeqtkPlugin from '../main';
import { PANEL_REGISTRY, HUB_CATEGORIES } from '../views/panelRegistry';
import type { PanelEntry } from '../views/panelRegistry';

interface HubCfg {
  hidden: string[];
  order: string[];
}

export class SeqtkSettingTab extends PluginSettingTab {
  plugin: SeqtkPlugin;

  constructor(app: App, plugin: SeqtkPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('seqtk-settings-compact');

    containerEl.createEl('h2', { text: 'SeqTK 设置' });

    containerEl.createEl('h3', { text: '中控台管理' });
    containerEl.createEl('div', {
      cls: 'setting-item-description',
      text: '控制中控台各分栏中面板的显示与组内顺序（隐藏仅影响中控台展示，命令仍可用）。拖动行调整顺序。',
    });

    for (const cat of HUB_CATEGORIES) {
      const entries = PANEL_REGISTRY.filter((e) => e.category === cat);
      if (entries.length === 0) continue;
      containerEl.createEl('h4', { text: cat });
      const cfg = this.getCfg(cat);
      const ordered = this.orderedEntries(entries, cfg.order);
      for (const entry of ordered) {
        this.renderEntryRow(entry, cfg, entries);
      }
    }
  }

  private getCfg(cat: string): HubCfg {
    const existing = this.plugin.settings.hub[cat];
    if (existing) return existing;
    const fresh: HubCfg = { hidden: [], order: [] };
    this.plugin.settings.hub[cat] = fresh;
    return fresh;
  }

  /** 组内排序：先按 order 中出现的顺序，其余按 registry 声明顺序 */
  private orderedEntries(entries: PanelEntry[], order: string[]): PanelEntry[] {
    const byOrder = order
      .map((vt) => entries.find((e) => e.viewType === vt))
      .filter((e): e is PanelEntry => !!e);
    const rest = entries.filter((e) => !order.includes(e.viewType));
    return [...byOrder, ...rest];
  }

  private renderEntryRow(entry: PanelEntry, cfg: HubCfg, groupEntries: PanelEntry[]): void {
    const hidden = cfg.hidden.includes(entry.viewType);
    const name = entry.title + (entry.placeholder ? '（规划中）' : '') + (hidden ? '（已隐藏）' : '');

    const setting = new Setting(this.containerEl)
      .setName(name)
      .setDesc(entry.description)
      .addToggle((t) =>
        t.setValue(!hidden).onChange(async (v) => {
          if (v) {
            cfg.hidden = cfg.hidden.filter((id) => id !== entry.viewType);
          } else if (!cfg.hidden.includes(entry.viewType)) {
            cfg.hidden.push(entry.viewType);
          }
          await this.plugin.saveSettings();
          this.display();
        }));

    // 拖拽排序：整行可拖动，拖到目标行上松手即插入该位置
    const rowEl = setting.settingEl;
    rowEl.addClass('seqtk-settings-dragrow');
    rowEl.draggable = true;
    rowEl.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', entry.viewType);
      e.dataTransfer!.effectAllowed = 'move';
      rowEl.addClass('seqtk-settings-dragrow-source');
    });
    rowEl.addEventListener('dragend', () => {
      rowEl.removeClass('seqtk-settings-dragrow-source');
    });
    rowEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      rowEl.addClass('seqtk-settings-dragrow-over');
    });
    rowEl.addEventListener('dragleave', () => {
      rowEl.removeClass('seqtk-settings-dragrow-over');
    });
    rowEl.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      rowEl.removeClass('seqtk-settings-dragrow-over');
      const from = e.dataTransfer?.getData('text/plain') ?? '';
      if (!from || from === entry.viewType) return;
      const cur = this.orderedEntries(groupEntries, cfg.order).map((x) => x.viewType);
      const fi = cur.indexOf(from);
      const ti = cur.indexOf(entry.viewType);
      if (fi < 0 || ti < 0) return;
      cur.splice(fi, 1);
      cur.splice(ti, 0, from);
      cfg.order = cur;
      void this.plugin.saveSettings().then(() => this.display());
    });
  }
}
