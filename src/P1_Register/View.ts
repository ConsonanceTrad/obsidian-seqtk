import type SeqtkPlugin from "../main";
import type {ItemView, WorkspaceLeaf} from "obsidian";
import type {PanelEntry} from "../P6_Views/panelRegistry";

/* ============================================================
 * 视图散布式注册 —— @AutoView()
 *
 * 视图类声明（与命令装饰器 @AutoRegister 叠用，互不干扰）：
 *   static metas: PanelEntry[]      面板目录条目，可多条（一个类服务多个 viewType）
 *   static create(leaf, plugin, viewType): ItemView   视图工厂
 *
 * 装饰器只做声明收集；Register_View 在此执行注册
 * （registerView + 将带 category 的条目写入插件面板目录）。
 * ============================================================ */

/** 单条视图注册声明：一条目录条目 + 对应视图工厂 */
export interface ViewRegistrar {
    /** 面板目录条目（viewType 与 create 工厂一一对应） */
    meta: PanelEntry;
    /** 视图工厂：Obsidian 注册视图时以 (leaf) 调用；viewType 指明当前注册的条目 */
    create: (leaf: WorkspaceLeaf, plugin: SeqtkPlugin, viewType: string) => ItemView;
}

/** 视图注册条目收集池（由 @AutoView 装饰器填充） */
export const viewRegistrars: ViewRegistrar[] = [];

/**
 * 视图散布式注册
 *
 * 在视图类上添加装饰器标记，声明面板目录条目与视图工厂；
 * 装饰器仅在模块被 import 时执行，因此各视图文件需在装配入口
 * （P1_Register/Zxport.ts）被副作用导入。
 */
export function AutoView() {
    return function (constructor: any, context?: ClassDecoratorContext) {
        const metas: PanelEntry[] | undefined = constructor.metas;
        if (!metas?.length || !constructor.create) return;
        for (const meta of metas) {
            viewRegistrars.push({meta, create: constructor.create});
        }
    };
}

/**
 * 视图散布式注册 —— 执行端
 *
 * 遍历 @AutoView 收集的视图注册条目：
 *  - p.registerView：将视图类型注册为 Obsidian 可打开的视图；
 *  - 带 category 的条目写入插件实例级面板目录 p.panelRegistry（中控台据此渲染）。
 *
 * 视图类的打开命令不自动派生，由各视图类的 static registerCommands 手写
 * （统一经 p.activateView 打开/聚焦）。
 */
export function Register_View(p: SeqtkPlugin){
    for (const r of viewRegistrars) {
        const vt = r.meta.viewType;
        p.registerView(vt, (leaf) => r.create(leaf, p, vt));
        // 仅带 category 的条目进入中控台目录（如 hub / hub-side 自身不进入）
        if (r.meta.category) {
            p.panelRegistry.push(r.meta);
        }
    }
}
