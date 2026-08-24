/**
 * SettingsTab — 插件设置面板
 * 
 * 选项卡：
 * - 基础配置：根文件夹路径、防抖时间、默认排序
 * - 归档恢复：扫描 Trash 目录，表格展示已归档节点，支持恢复
 */

import { App, PluginSettingTab, Setting, TFile, Notice } from 'obsidian';
import type LikeDuplicantPlugin from '../main';
import type { NodeType } from '../types/index';
import { NODE_TYPE_LABELS } from '../types/index';
import { parseNodeId, formatDate } from '../utils/timestamp';

interface ArchivedNode {
  nodeId: string;
  displayName: string;
  nodeType: NodeType;
  timestamp: number;
  file: TFile;
}

export class LikeDuplicantSettingTab extends PluginSettingTab {
  plugin: LikeDuplicantPlugin;
  private activeTab: 'basic' | 'auto' | 'archive' = 'basic';

  // 归档恢复 — 搜索与分页状态
  private archiveSearchQuery = '';
  private archiveCurrentPage = 0;
  private archivePageSize = 10;
  private archivedNodesCache: ArchivedNode[] = [];

  constructor(app: App, plugin: LikeDuplicantPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    this.activeTab = 'basic';
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Like-Duplicant 设置' });

    // 选项卡按钮栏
    const tabBar = containerEl.createEl('div', { cls: 'duplicant-settings-tabs' });
    const btnBasic = tabBar.createEl('button', {
      cls: 'duplicant-settings-tab',
      text: '基础配置',
    });
    const btnAuto = tabBar.createEl('button', {
      cls: 'duplicant-settings-tab',
      text: '自动管理',
    });
    const btnArchive = tabBar.createEl('button', {
      cls: 'duplicant-settings-tab',
      text: '归档恢复',
    });

    const updateTabStyle = () => {
      btnBasic.classList.toggle('duplicant-settings-tab-active', this.activeTab === 'basic');
      btnAuto.classList.toggle('duplicant-settings-tab-active', this.activeTab === 'auto');
      btnArchive.classList.toggle('duplicant-settings-tab-active', this.activeTab === 'archive');
    };
    updateTabStyle();

    // 内容容器
    const contentEl = containerEl.createEl('div', { cls: 'duplicant-settings-content' });

    btnBasic.addEventListener('click', () => {
      this.activeTab = 'basic';
      updateTabStyle();
      this.renderBasicTab(contentEl);
    });

    btnAuto.addEventListener('click', () => {
      this.activeTab = 'auto';
      updateTabStyle();
      this.renderAutoTab(contentEl);
    });

    btnArchive.addEventListener('click', () => {
      this.activeTab = 'archive';
      updateTabStyle();
      this.renderArchiveTab(contentEl);
    });

    // 默认渲染基础配置
    this.renderBasicTab(contentEl);
  }

  // ============================================================
  // 基础配置选项卡
  // ============================================================

  private renderBasicTab(container: HTMLElement): void {
    container.empty();

    // 根文件夹路径
    new Setting(container)
      .setName('根文件夹路径')
      .setDesc('数据存储的根目录（相对于 Vault 根目录）')
      .addText(text => text
        .setPlaceholder('_Root/_Plugin/Like Duplicant')
        .setValue(this.plugin.settings.rootFolder)
        .onChange(async (value) => {
          this.plugin.settings.rootFolder = value || '_Root/_Plugin/Like Duplicant';
          await this.plugin.saveSettings();
        })
      );

    // 规划面板节点初始状态
    new Setting(container)
      .setName('规划面板节点初始状态')
      .setDesc('控制规划面板中节点渲染时的默认展开/收起状态')
      .addDropdown(dropdown => dropdown
        .addOption('expanded', '展开')
        .addOption('collapsed', '收起')
        .setValue(this.plugin.settings.planningDefaultExpand ? 'expanded' : 'collapsed')
        .onChange(async (value) => {
          this.plugin.settings.planningDefaultExpand = value === 'expanded';
          await this.plugin.saveSettings();
        })
      );

    // 规划面板左键单击行为
    new Setting(container)
      .setName('规划面板左键单击行为')
      .setDesc('左键单击节点行时执行的操作')
      .addDropdown(dropdown => dropdown
        .addOption('edit', '编辑描述')
        .addOption('toggle', '展开/折叠')
        .setValue(this.plugin.settings.planningClickAction)
        .onChange(async (value: 'edit' | 'toggle') => {
          this.plugin.settings.planningClickAction = value;
          await this.plugin.saveSettings();
        })
      );

    // 清单面板收纳箱默认展开状态
    new Setting(container)
      .setName('收纳箱默认展开状态')
      .setDesc('控制清单面板中收纳箱打开后的默认展开/收起状态')
      .addDropdown(dropdown => dropdown
        .addOption('expanded', '展开')
        .addOption('collapsed', '收起')
        .setValue(this.plugin.settings.checklistInboxDefaultExpand ? 'expanded' : 'collapsed')
        .onChange(async (value) => {
          this.plugin.settings.checklistInboxDefaultExpand = value === 'expanded';
          await this.plugin.saveSettings();
        })
      );

    // 归档确认提示
    new Setting(container)
      .setName('归档确认提示')
      .setDesc('归档含有子孙节点的父节点时，弹出确认提示')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.archiveConfirmPrompt)
        .onChange(async (value) => {
          this.plugin.settings.archiveConfirmPrompt = value;
          await this.plugin.saveSettings();
        })
      );

  }

  // ============================================================
  // 自动管理选项卡
  // ============================================================

  private renderAutoTab(container: HTMLElement): void {
    container.empty();

    // 双向传播
    new Setting(container)
      .setName('双向传播')
      .setDesc('向上：所有子节点终态时自动标记父节点完成；向下：父节点变更为活跃状态时，活跃子节点同步变更')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.stateCascade)
        .onChange(async (value) => {
          this.plugin.settings.stateCascade = value;
          await this.plugin.saveSettings();
        })
      );

    // 状态跟随
    new Setting(container)
      .setName('状态跟随')
      .setDesc('手动将父节点设置为完成/放弃时，非终态子孙节点自动标记为目标状态')
      .addDropdown(dropdown => dropdown
        .addOption('completed', '完成')
        .addOption('giveup', '放弃')
        .setValue(this.plugin.settings.statusFollowTarget)
        .onChange(async (value) => {
          this.plugin.settings.statusFollowTarget = value as 'completed' | 'giveup';
          await this.plugin.saveSettings();
        })
      )
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.statusFollow)
        .onChange(async (value) => {
          this.plugin.settings.statusFollow = value;
          await this.plugin.saveSettings();
        })
      );

    
    // 唯一周期
    new Setting(container)
      .setName('唯一周期')
      .setDesc('确保始终只有一个周期处于进行中：新周期激活时，旧进行中周期先被变更')
      .addDropdown(dropdown => dropdown
        .addOption('paused', '已暂停')
        .addOption('pending', '待处理')
        .addOption('completed', '已完成')
        .addOption('giveup', '已放弃')
        .setValue(this.plugin.settings.uniqueCycleTarget)
        .onChange(async (value) => {
          this.plugin.settings.uniqueCycleTarget = value as 'paused' | 'pending' | 'completed' | 'giveup';
          await this.plugin.saveSettings();
        })
      )
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.uniqueCycle)
        .onChange(async (value) => {
          this.plugin.settings.uniqueCycle = value;
          await this.plugin.saveSettings();
        })
      );

  }

  // ============================================================
  // 归档恢复选项卡
  // ============================================================

  private renderArchiveTab(container: HTMLElement): void {
    container.empty();

    // ── 搜索栏 ──
    const searchRow = container.createEl('div', { cls: 'duplicant-archive-search-row' });
    const searchInput = searchRow.createEl('input', {
      cls: 'duplicant-archive-search-input',
      attr: { type: 'text', placeholder: '搜索展示名...' },
    });
    searchInput.value = this.archiveSearchQuery;
    searchInput.addEventListener('input', () => {
      this.archiveSearchQuery = searchInput.value.trim().toLowerCase();
      this.archiveCurrentPage = 0;
      this.renderArchiveTable(tableWrapper);
    });

    const tableWrapper = container.createEl('div', { cls: 'duplicant-archive-table-wrapper' });

    // 加载归档节点
    this.loadArchivedNodes().then(archived => {
      this.archivedNodesCache = archived;
      this.renderArchiveTable(tableWrapper);
    });
  }

  /**
   * 根据搜索关键词过滤归档节点
   */
  private filterArchivedNodes(): ArchivedNode[] {
    if (!this.archiveSearchQuery) return this.archivedNodesCache;
    return this.archivedNodesCache.filter(node =>
      node.displayName.toLowerCase().includes(this.archiveSearchQuery)
    );
  }

  /**
   * 渲染归档表格（含分页控件）
   */
  private renderArchiveTable(wrapper: HTMLElement): void {
    wrapper.empty();

    const filtered = this.filterArchivedNodes();

    if (filtered.length === 0) {
      wrapper.createEl('p', {
        cls: 'duplicant-archive-empty',
        text: this.archiveSearchQuery ? '没有匹配的归档节点。' : '没有已归档的节点文件。',
      });
      return;
    }

    // 分页计算
    const totalPages = Math.ceil(filtered.length / this.archivePageSize);
    if (this.archiveCurrentPage >= totalPages) this.archiveCurrentPage = totalPages - 1;
    const start = this.archiveCurrentPage * this.archivePageSize;
    const pageItems = filtered.slice(start, start + this.archivePageSize);

    // 表格
    const table = wrapper.createEl('table', { cls: 'duplicant-archive-table' });

    // 表头
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    headerRow.createEl('th', { text: '展示名' });
    headerRow.createEl('th', { text: '节点类型' });
    headerRow.createEl('th', { text: '创建时间' });
    headerRow.createEl('th', { text: '操作' });

    // 表体
    const tbody = table.createEl('tbody');
    for (const node of pageItems) {
      const row = tbody.createEl('tr');
      row.createEl('td', { text: node.displayName });
      row.createEl('td', { text: NODE_TYPE_LABELS[node.nodeType] ?? node.nodeType });
      row.createEl('td', { text: node.timestamp ? formatDate(node.timestamp) : '未知' });

      const actionCell = row.createEl('td');
      const restoreBtn = actionCell.createEl('button', {
        cls: 'duplicant-archive-restore-btn',
        text: '恢复',
      });
      restoreBtn.addEventListener('click', async () => {
        restoreBtn.disabled = true;
        restoreBtn.textContent = '恢复中...';
        try {
          await this.plugin.fileManager.restoreNode(node.file, node.nodeType);
          new Notice(`已恢复: ${node.displayName}`);
          // 从缓存中移除已恢复节点并刷新
          this.archivedNodesCache = this.archivedNodesCache.filter(n => n.nodeId !== node.nodeId);
          this.renderArchiveTable(wrapper);
        } catch (err) {
          console.error('[Like-Duplicant] Restore failed:', err);
          new Notice('恢复失败，请查看控制台');
          restoreBtn.disabled = false;
          restoreBtn.textContent = '恢复';
        }
      });
    }

    // ── 分页控件 ──
    if (totalPages > 1) {
      const pagination = wrapper.createEl('div', { cls: 'duplicant-archive-pagination' });

      const prevBtn = pagination.createEl('button', {
        cls: 'duplicant-archive-page-btn',
        text: '‹ 上一页',
      });
      prevBtn.disabled = this.archiveCurrentPage <= 0;
      prevBtn.addEventListener('click', () => {
        this.archiveCurrentPage--;
        this.renderArchiveTable(wrapper);
      });

      pagination.createEl('span', {
        cls: 'duplicant-archive-page-info',
        text: `${this.archiveCurrentPage + 1} / ${totalPages}（共 ${filtered.length} 项）`,
      });

      const nextBtn = pagination.createEl('button', {
        cls: 'duplicant-archive-page-btn',
        text: '下一页 ›',
      });
      nextBtn.disabled = this.archiveCurrentPage >= totalPages - 1;
      nextBtn.addEventListener('click', () => {
        this.archiveCurrentPage++;
        this.renderArchiveTable(wrapper);
      });
    }
  }

  private async loadArchivedNodes(): Promise<ArchivedNode[]> {
    const trashFolder = `${this.plugin.settings.rootFolder}/Trash`;
    const folder = this.app.vault.getFolderByPath(trashFolder);
    if (!folder) return [];

    const nodes: ArchivedNode[] = [];

    for (const child of folder.children) {
      if (!(child instanceof TFile) || child.extension !== 'md') continue;

      try {
        const content = await this.app.vault.read(child);
        const { frontmatter } = this.parseFrontmatter(content);

        const nodeId = child.basename;
        const parsed = parseNodeId(nodeId);
        const nodeType = (frontmatter.type as NodeType) ?? 'taskitem';

        nodes.push({
          nodeId,
          displayName: frontmatter.name ?? parsed.displayName ?? nodeId,
          nodeType,
          timestamp: parsed.timestamp,
          file: child,
        });
      } catch (err) {
        console.warn(`[Like-Duplicant] Failed to parse archived file ${child.path}:`, err);
      }
    }

    // 按时间从新到旧排序
    nodes.sort((a, b) => b.timestamp - a.timestamp);
    return nodes;
  }

  /**
   * 简单解析 YAML frontmatter（不引入完整 YAML 解析器）
   */
  private parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
    const frontmatter: Record<string, any> = {};
    let body = content;

    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return { frontmatter, body };

    const yamlContent = match[1];
    body = match[2];

    for (const line of yamlContent.split('\n')) {
      const kvMatch = line.match(/^(\w+)\s*:\s*(.+)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        let value: any = kvMatch[2].trim();
        // 去除引号
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        frontmatter[key] = value;
      }
    }

    return { frontmatter, body };
  }
}
