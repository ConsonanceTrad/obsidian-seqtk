/**
 * FileWrite — 文件管理器模块组分：新建写入
 *
 * 创建节点文件：先确保 kind 文件夹存在，再 vault.create 新文件。
 * ENSURE_Folder 为共享辅助（创建新文件 / 恢复归档时建目录共用），独立导出。
 */

import {Vault} from 'obsidian';
import type {PluginSettings} from "../../../P3_Settings/Settings";
import type {NodeKindValue} from "../../../P4_Nodes/NodeKind/NodeKind";
import type {NodeBase} from "../../../P4_Nodes/Node";
import {serializeNodeFile} from "../../../P2_Tools/Parse/YamlParse";
import {generateNodeId} from "../../../P2_Tools/Time/Timestamp";
import {GET_KindToPath} from "../PathTools/PathParse";

/** 确保目录存在（逐级创建；Obsidian vault 无法一次创建深层不存在的目录） */
export async function ENSURE_Folder(vault: Vault, folderPath: string): Promise<void> {
    // 过滤空段：rootFolder 为空或带尾斜杠时不产生 '' 这一级
    const parts = folderPath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (vault.getFolderByPath(current)) continue;
        try {
            await vault.createFolder(current);
        } catch (err) {
            // 本函数被 CREATE_Node / 归档恢复 / ENSURE_RootFolder 共用，且这些调用方
            // 会并发触发（如数据加载与新建节点同时进行）。此外 vault 索引未必及时
            // 反映刚创建的目录——两种情况下「已存在」都不是失败，其余错误照抛。
            const exists = vault.getFolderByPath(current) !== null;
            const message = err instanceof Error ? err.message : String(err);
            if (!exists && !/already exists/i.test(message)) throw err;
        }
    }
}

export class FileWrite {
    constructor(
        private vault: Vault,
        private settings: PluginSettings,
    ) {}

    /** 创建节点文件（nodeId 缺省时自动生成），返回 nodeId */
    async CREATE_Node(
        kind: NodeKindValue,
        data: Partial<NodeBase>,
        body = '',
        nodeId?: string,
    ): Promise<string> {
        const id = nodeId ?? generateNodeId(kind);
        const now = new Date().toISOString();

        const frontmatter: Record<string, any> = {
            kind,
            desc: data.desc ?? '未命名',
            open: (data as any).open ?? true,
            create: data.create ?? now,
            modify: now,
            ...this.GET_ExtraFields(data),
        };

        const content = serializeNodeFile(frontmatter, body);
        const folderPath = GET_KindToPath(kind, this.settings);
        await ENSURE_Folder(this.vault, folderPath);
        await this.vault.create(`${folderPath}/${id}.md`, content);

        return id;
    }

    /** 抽取节点可选业务字段（只写入有值的字段） */
    private GET_ExtraFields(data: Partial<NodeBase>): Record<string, any> {
        const extras: Record<string, any> = {};
        const d = data as any;

        if (d.from) extras.from = d.from;
        // 外部信息源（独立列表字段；空数组不落盘，保持 frontmatter 干净）
        if (Array.isArray(d.sources) && d.sources.length > 0) extras.sources = d.sources;
        if (d.follows) extras.follows = d.follows;
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

    /** settings 替换时同步（由门面 NodeFileManager 统一调用） */
    UPDATE_Settings(settings: PluginSettings): void {
        this.settings = settings;
    }
}
