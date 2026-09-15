/**
 * FileDelete — 文件管理器模块组分：删除 / 归档 / 恢复
 *
 * - 归档：移动到 rootFolder/Trash
 * - 删除：vault.trash（系统回收站）
 * - 恢复：从 Trash 移回 kind 文件夹（需 ENSURE_Folder 建目录，由门面注入）
 * - 级联删除：按子树递归先子后己
 */

import {Vault, type TFile} from 'obsidian';
import type {PluginSettings} from "../../../P3_Settings/Settings";
import type {NodeKindValue} from "../../../P4_Nodes/NodeKind/NodeKind";
import {GET_FileByPath, GET_KindToPath} from "../PathTools/PathParse";
import type {ENSURE_Folder as EnsureFolderFn} from "./FileWrite";

/** 子树删除时的子节点获取函数 */
export type GetChildrenFn = (nodeId: string) => { kind: NodeKindValue; nodeId: string }[];

export class FileDelete {
    constructor(
        private vault: Vault,
        private settings: PluginSettings,
        /** 共享建目录辅助（由门面 NodeFileManager 注入，避免模块间硬耦合） */
        private ENSURE_Folder: typeof EnsureFolderFn,
    ) {}

    /** 归档节点文件 — 移动到 rootFolder/Trash */
    async ARCHIVE_Node(kind: NodeKindValue, nodeId: string): Promise<void> {
        const file = this.vault.getFileByPath(GET_FileByPath(kind, nodeId, this.settings));
        if (!file) return;

        const trashFolder = `${this.settings.rootFolder}/Trash`;
        const trashPath = `${trashFolder}/${nodeId}.md`;

        await this.ENSURE_Folder(this.vault, trashFolder);
        await this.vault.rename(file, trashPath);
    }

    /** 删除节点文件 — 移入系统回收站 */
    async DELETE_Node(kind: NodeKindValue, nodeId: string): Promise<void> {
        const file = this.vault.getFileByPath(GET_FileByPath(kind, nodeId, this.settings));
        if (!file) return;
        await this.vault.trash(file, true);
    }

    /** 恢复归档节点文件 — 从 Trash 移回原 kind 文件夹 */
    async RESTORE_Node(file: TFile, kind: NodeKindValue): Promise<void> {
        const targetFolder = GET_KindToPath(kind, this.settings);
        await this.ENSURE_Folder(this.vault, targetFolder);
        const targetPath = `${targetFolder}/${file.basename}.md`;
        await this.vault.rename(file, targetPath);
    }

    /** 级联删除整个子树（先子后己），返回被删除的 nodeId 列表 */
    async DELETE_NodeTree(
        kind: NodeKindValue,
        rootNodeId: string,
        getChildrenFn: GetChildrenFn,
    ): Promise<string[]> {
        const deletedIds: string[] = [];

        const deleteRecursive = async (kind: NodeKindValue, nodeId: string): Promise<void> => {
            const children = getChildrenFn(nodeId);
            for (const child of children) {
                await deleteRecursive(child.kind, child.nodeId);
            }
            await this.DELETE_Node(kind, nodeId);
            deletedIds.push(nodeId);
        };

        await deleteRecursive(kind, rootNodeId);
        return deletedIds;
    }

    /** settings 替换时同步（由门面 NodeFileManager 统一调用） */
    UPDATE_Settings(settings: PluginSettings): void {
        this.settings = settings;
    }
}
