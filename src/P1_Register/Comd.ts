import type SeqtkPlugin from "../main";
import { Notice } from "obsidian";
import { REBUILD_Cache_Data } from "./Data";

export type CommandRegistrar = (plugin: SeqtkPlugin, deps: any) => void;
export const commandRegistrars: CommandRegistrar[] = [];

/*
 * 命令散布式注册的用法示例（视图散布式注册 @AutoView 见 ./View.ts）：
 *
 * @AutoRegister()
 * export class HubView extends ItemView {
 *     // 打开命令（不自动派生，手写；打开/聚焦统一走 plugin.activateView）
 *     static registerCommands(plugin: SeqtkPlugin, deps: any) {
 *         plugin.addCommand({
 *             id: 'open-hub-side',
 *             name: '打开中控台',
 *             callback: () => plugin.activateView(VIEW_TYPE_HUB_SIDE, 'left'),
 *         });
 *     }
 * }
 *
 * @AutoRegister 收集命令 → Register_Comd 执行 addCommand。
 */

/**
 *  命令散布式注册
 *
 *  在需要注册命令的地方添加装饰器标记
 *  Deps 代表需要使用的依赖，见 main.ts 的 allDeps
 */
export function AutoRegister() {
    return function (constructor: any, context?: ClassDecoratorContext) {
        if (constructor.registerCommands) {
            commandRegistrars.push(constructor.registerCommands);
        }
    };
}

function Register_Global_Command(p: SeqtkPlugin){
    // 手动重建查询缓存：丢弃持久化缓存 → 清空内存库 → 全量重扫 → 落盘
    // 常规启动已走「onload 加载 + onReady 指纹对账」；本命令是缓存疑似失配
    // （如文件指纹不可靠导致漏更新）时的兜底手段，重建期间写入被闸门暂缓
    p.addCommand({
        id: 'seqtk-rebuild-cache',
        name: '重建查询缓存',
        callback: async () => {
            try {
                const count = await REBUILD_Cache_Data(p);
                new Notice(`[SeqTK] 查询缓存已重建（${count} 个节点）`);
            } catch (err) {
                console.error('[SeqTK] 重建缓存失败:', err);
                new Notice(`[SeqTK] 重建缓存失败: ${err}`);
            }
        },
    });

}


export function Register_Comd(p: SeqtkPlugin) {
    // 注册命令 —— 散布式入口
    commandRegistrars.forEach(fn => fn(p, p.allDeps));
    // 注册全局命令
    Register_Global_Command(p);
}
