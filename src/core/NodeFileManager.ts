/**
 * NodeFileManager — 节点文件读写操作
 *
 * 职责：
 * - 计算节点文件路径
 * - 读取/创建/更新/归档节点文件
 * - 扫描所有节点目录
 * - 级联归档子树
 *
 * 所有文件操作优先使用 vault.process() 实现原子读改写，
 * 仅创建新文件时使用 vault.create()
 */

import { App, Vault, TFile, TFolder } from 'obsidian';
import type {
  NodeKind,
  SeqtkNode,
  NodeBase,
  NodeFile,
  PluginSettings,
} from '../types/index';
import {
  NODE_FOLDER_MAP,
  getParentFolder,
  getFolderName,
} from '../types/index';
import {
  parseNodeFile,
  serializeNodeFile,
  validateKindConsistency,
} from './yaml-utils';
import { generateNodeId } from '../utils/timestamp';

/** 子树删除时的子节点获取函数 */
export type GetChildrenFn = (nodeId: string) => { kind: NodeKind; nodeId: string }[];

export class NodeFileManager {
  private app: App;
  private vault: Vault;
  private settings: PluginSettings;

  constructor(app: App, settings: PluginSettings) {
    this.app = app;
    this.vault = app.vault;
    this.settings = settings;
  }

  // ============================================================
  // 路径计算
  // ============================================================

  /**
   * 获取某类型节点的文件夹完整路径
   * 如 "_Root/_Plugin/SeqTK/Transaction/Project"
   */
  getNodeFolderPath(kind: NodeKind): string {
    const parent = getParentFolder(kind);
    const folder = getFolderName(kind);
    return `${this.settings.rootFolder}/${parent}/${folder}`;
  }

  /**
   * 获取某节点的完整文件路径
   */
  getNodeFilePath(kind: NodeKind, nodeId: string): string {
    return `${this.getNodeFolderPath(kind)}/${nodeId}.md`;
  }

  /**
   * 从文件路径反推节点类型（根据路径中的文件夹名）
   */
  getKindFromPath(filePath: string): NodeKind | null {
    const parts = filePath.split('/');
    for (const part of parts) {
      for (const [kind, folder] of Object.entries(NODE_FOLDER_MAP)) {
        if (folder === part) return kind as NodeKind;
      }
    }
    return null;
  }

  /**
   * 从文件路径提取 nodeId（文件名不含 .md）
   */
  getNodeIdFromPath(filePath: string): string | null {
    const match = filePath.match(/\/([^/]+)\.md$/);
    return match ? match[1] : null;
  }

  /**
   * 判断文件路径是否属于本插件管理的节点文件
   */
  isManagedPath(filePath: string): boolean {
    if (!filePath.startsWith(this.settings.rootFolder + '/')) return false;
    if (!filePath.endsWith('.md')) return false;
    return this.getKindFromPath(filePath) !== null;
  }

  // ============================================================
  // 文件读取
  // ============================================================

  async readNode(kind: NodeKind, nodeId: string): Promise<NodeFile | null> {
    const filePath = this.getNodeFilePath(kind, nodeId);
    const file = this.vault.getFileByPath(filePath);
    if (!file) return null;

    try {
      const content = await this.vault.read(file);
      const { data, body } = parseNodeFile(content);
      return {
        nodeId,
        data: data as unknown as SeqtkNode,
        body,
      };
    } catch (err) {
      console.error(`[SeqTK] Failed to read node ${nodeId}:`, err);
      return null;
    }
  }

  private async readNodeFromFile(file: TFile, expectedKind: NodeKind): Promise<NodeFile | null> {
    try {
      const content = await this.vault.read(file);
      const { data, body } = parseNodeFile(content);

      if (!validateKindConsistency(data, expectedKind)) {
        console.warn(
          `[SeqTK] Kind mismatch in ${file.path}: ` +
          `expected "${expectedKind}" but got "${data.kind}". Skipping.`
        );
        return null;
      }

      data.kind = expectedKind;

      const nodeId = this.getNodeIdFromPath(file.path);
      if (!nodeId) return null;

      return {
        nodeId,
        data: data as unknown as SeqtkNode,
        body,
      };
    } catch (err) {
      console.error(`[SeqTK] Failed to read file ${file.path}:`, err);
      return null;
    }
  }

  // ============================================================
  // 扫描
  // ============================================================

  async scanAllNodes(): Promise<NodeFile[]> {
    const allKinds = Object.keys(NODE_FOLDER_MAP) as NodeKind[];

    const scanResults = await Promise.all(
      allKinds.map(kind => this.scanFolder(kind))
    );

    return scanResults.flat();
  }

  private async scanFolder(kind: NodeKind): Promise<NodeFile[]> {
    const folderPath = this.getNodeFolderPath(kind);
    const folder = this.vault.getFolderByPath(folderPath);
    if (!folder) return [];

    const nodes: NodeFile[] = [];

    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'md') {
        const nodeFile = await this.readNodeFromFile(child, kind);
        if (nodeFile) {
          nodes.push(nodeFile);
        }
      }
    }

    return nodes;
  }

  // ============================================================
  // 创建
  // ============================================================

  async createNode(kind: NodeKind, data: Partial<NodeBase>, body = '', nodeId?: string): Promise<string> {
    const id = nodeId ?? generateNodeId(kind);
    const now = new Date().toISOString();

    const frontmatter: Record<string, any> = {
      kind,
      desc: data.desc ?? '未命名',
      open: (data as any).open ?? true,
      create: data.create ?? now,
      modify: now,
      ...this.getExtraFields(data),
    };

    const content = serializeNodeFile(frontmatter, body);
    const filePath = this.getNodeFilePath(kind, id);

    await this.ensureFolder(this.getNodeFolderPath(kind));
    await this.vault.create(filePath, content);

    return id;
  }

  private getExtraFields(data: Partial<NodeBase>): Record<string, any> {
    const extras: Record<string, any> = {};
    const d = data as any;

    if (d.from) extras.from = d.from;
    if (d.follows) extras.follows = d.follows;
    if (d.parent) extras.parent = d.parent;
    if (d.links) extras.links = d.links;
    if (d.progress) extras.progress = d.progress;
    if (d.state) extras.state = d.state;
    if (d.estate) extras.estate = d.estate;
    if (d.clear !== undefined) extras.clear = d.clear;
    if (d.tags) extras.tags = d.tags;
    if (d.indicators) extras.indicators = d.indicators;
    if (d.pmarks) extras.pmarks = d.pmarks;
    if (d.nature) extras.nature = d.nature;
    if (d.at) extras.at = d.at;

    return extras;
  }

  // ============================================================
  // 更新（原子操作）
  // ============================================================

  async updateNode(kind: NodeKind, nodeId: string, updates: Partial<SeqtkNode>): Promise<void> {
    const filePath = this.getNodeFilePath(kind, nodeId);
    const file = this.vault.getFileByPath(filePath);
    if (!file) {
      console.error(`[SeqTK] Node file not found: ${filePath}`);
      return;
    }

    await this.vault.process(file, (content: string) => {
      const { data, body } = parseNodeFile(content);
      Object.assign(data, updates, {
        modify: new Date().toISOString(),
      });
      return serializeNodeFile(data, body);
    });
  }

  /**
   * 更新节点正文（描述），使用 vault.process 原子操作
   */
  async updateNodeBody(kind: NodeKind, nodeId: string, body: string): Promise<void> {
    const filePath = this.getNodeFilePath(kind, nodeId);
    const file = this.vault.getFileByPath(filePath);
    if (!file) {
      console.error(`[SeqTK] Node file not found: ${filePath}`);
      return;
    }

    await this.vault.process(file, (content: string) => {
      const { data } = parseNodeFile(content);
      data.modify = new Date().toISOString();
      return serializeNodeFile(data, body);
    });
  }

  // ============================================================
  // 删除 / 归档
  // ============================================================

  /**
   * 归档节点文件 — 移动到 rootFolder/Trash 目录
   */
  async archiveNode(kind: NodeKind, nodeId: string): Promise<void> {
    const filePath = this.getNodeFilePath(kind, nodeId);
    const file = this.vault.getFileByPath(filePath);
    if (!file) return;

    const trashFolder = `${this.settings.rootFolder}/Trash`;
    const trashPath = `${trashFolder}/${nodeId}.md`;

    // 确保 Trash 目录存在
    if (!this.vault.getAbstractFileByPath(trashFolder)) {
      await this.vault.createFolder(trashFolder);
    }

    await this.vault.rename(file, trashPath);
  }

  async deleteNode(kind: NodeKind, nodeId: string): Promise<void> {
    const filePath = this.getNodeFilePath(kind, nodeId);
    const file = this.vault.getFileByPath(filePath);
    if (!file) return;
    await this.vault.trash(file, true);
  }

  /**
   * 恢复归档节点文件 — 从 Trash 移回原始类型文件夹
   */
  async restoreNode(file: TFile, nodeKind: NodeKind): Promise<void> {
    const targetFolder = this.getNodeFolderPath(nodeKind);
    await this.ensureFolder(targetFolder);
    const targetPath = `${targetFolder}/${file.basename}.md`;
    await this.vault.rename(file, targetPath);
  }

  async deleteNodeTree(
    kind: NodeKind,
    rootNodeId: string,
    getChildrenFn: GetChildrenFn
  ): Promise<string[]> {
    const deletedIds: string[] = [];

    const deleteRecursive = async (nodeKind: NodeKind, nodeId: string) => {
      const children = getChildrenFn(nodeId);
      for (const child of children) {
        await deleteRecursive(child.kind, child.nodeId);
      }
      await this.deleteNode(nodeKind, nodeId);
      deletedIds.push(nodeId);
    };

    await deleteRecursive(kind, rootNodeId);
    return deletedIds;
  }

  // ============================================================
  // 辅助方法
  // ============================================================

  private async ensureFolder(folderPath: string): Promise<void> {
    const parts = folderPath.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.vault.getFolderByPath(current);
      if (!existing) {
        await this.vault.createFolder(current);
      }
    }
  }

  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
  }

  /** 当前数据根文件夹（用户配置） */
  get rootFolder(): string {
    return this.settings.rootFolder;
  }

  /** 确保数据根文件夹存在（供布局缓存等写入前调用） */
  async ensureRootFolder(): Promise<void> {
    await this.ensureFolder(this.settings.rootFolder);
  }
}
