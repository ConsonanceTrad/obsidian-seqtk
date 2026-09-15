/**
 * NodeFileManager — 节点文件模块装配容器
 *
 * 具体文件操作已按动词拆分到 FileManagerModules 五个模块，本容器只负责：
 *   - 持有 app / settings 状态
 *   - 装配各模块实例并注入依赖（FileScan←FileRead、FileDelete←ENSURE_Folder）
 *   - 提供 rootFolder / ENSURE_RootFolder / UPDATE_Settings 等状态辅助
 *
 * 各模块实例为公开字段，调用方直接使用（如 fileManager.read.READ_Node(...)）：
 *   read    单文件读取           scan   批量扫描
 *   write   新建写入             update 原子读改写
 *   delete  删除 / 归档 / 恢复
 */

import {App, Vault} from 'obsidian';
import type {PluginSettings} from "../../P3_Settings/Settings";
import {FileRead} from "./FileManagerModules/FileRead";
import {FileScan} from "./FileManagerModules/FileScan";
import {FileWrite, ENSURE_Folder} from "./FileManagerModules/FileWrite";
import {FileUpdate} from "./FileManagerModules/FileUpdate";
import {FileDelete, type GetChildrenFn} from "./FileManagerModules/FileDelete";

/** 子树删除时的子节点获取函数（re-export，保持原导出点） */
export type {GetChildrenFn};

export class NodeFileManager {
    private app: App;
    private vault: Vault;
    private settings: PluginSettings;

    /** 文件操作模块实例（按动词拆分的组分，直接调用） */
    readonly read: FileRead;
    readonly scan: FileScan;
    readonly write: FileWrite;
    readonly update: FileUpdate;
    readonly delete: FileDelete;

    constructor(app: App, settings: PluginSettings) {
        this.app = app;
        this.vault = app.vault;
        this.settings = settings;

        this.read = new FileRead(this.vault, settings);
        this.scan = new FileScan(this.vault, settings, this.read);
        this.write = new FileWrite(this.vault, settings);
        this.update = new FileUpdate(this.vault, settings);
        this.delete = new FileDelete(this.vault, settings, ENSURE_Folder);
    }

    /** 当前数据根文件夹（用户配置） */
    get rootFolder(): string {
        return this.settings.rootFolder;
    }

    /** vault 文件适配器（供 DataPipe 读写插件数据目录下的辅助文件，如布局缓存） */
    get adapter(): Vault["adapter"] {
        return this.vault.adapter;
    }

    /** 确保数据根文件夹存在（供布局缓存等写入前调用） */
    async ENSURE_RootFolder(): Promise<void> {
        await ENSURE_Folder(this.vault, this.settings.rootFolder);
    }

    /** settings 替换时同步（本容器 + 各模块） */
    UPDATE_Settings(settings: PluginSettings): void {
        this.settings = settings;
        this.read.UPDATE_Settings(settings);
        this.scan.UPDATE_Settings(settings);
        this.write.UPDATE_Settings(settings);
        this.update.UPDATE_Settings(settings);
        this.delete.UPDATE_Settings(settings);
    }
}
