/**
 * design/externalInfo — 设计视图「外部信息源」切片
 *
 * 从 DesignView 拆出的外部信息源读写与入口：
 * 添加（链接 / 库内文件）· 创建关联时间戳文档 · 管理（排序 / 删除）· 行内列出并跳转。
 *
 * 约定:
 * - 本文件函数以 view(DesignView 实例)为第一参数,只读写 view 上公开的状态
 *   （pipe / app / settings / refresh）
 * - 字段读写一律经 view.pipe.EXEC_Mutation（一次字段更新），不直连 nodeCache / fileManager
 * - 「外部信息源」是独立列表字段，不与 follows / parent 那一簇混用 ——
 *   前者描述节点之间的关系，后者描述节点与节点体系之外材料的关联
 *
 * 功能增补指引:
 * - 新增一类外部材料入口 → 在此追加 export function，并让菜单（design/menuDefinitions）接线
 */

import { Menu, Notice } from 'obsidian';
import {
    GET_SourceLabel,
    GET_SourceTarget,
    type ExternalSource,
} from '../../../P4_Nodes/NodeField/AttriGroup/External';
import { ExternalSourcesModal } from '../../../P7_Render/Structure/S2_Modal/ExternalSourcesModal';
import { TextPromptModal } from '../../../P7_Render/Structure/S2_Modal/TextPromptModal';
import type { DesignView } from '../Design';

/**
 * 添加一条外部信息源（链接或库内文件路径）
 *
 * 「外部信息源」是独立列表字段，不与 follows / parent 那一簇混用 ——
 * 前者描述节点之间的关系，后者描述节点与节点体系之外材料的关联。
 */
export function addExternalSource(view: DesignView, nodeId: string): void {
    if (!view.pipe.GET_Node(nodeId)) return;
    new TextPromptModal(view.app, {
        title: '添加外部信息源',
        desc: '链接与库内文件路径二选一填写；名称留空时显示地址或文件名。库内文件可用右侧按钮搜索选择，也可直接粘贴路径。',
        fields: [
            { key: 'label', label: '名称', placeholder: '可留空' },
            { key: 'url', label: '链接', placeholder: 'https://…' },
            // type: 'file' → 该行右侧多一个「在库内选择文件」的搜索按钮
            { key: 'path', label: '库内文件', placeholder: 'docs/某文件.md', type: 'file' },
        ],
        onConfirm: ({ label, url, path }) => {
            if (!url && !path) {
                new Notice('请填写链接或库内文件路径');
                return;
            }
            appendSource(view, nodeId, {
                label: label || url || path,
                ...(url ? { url } : {}),
                ...(path ? { path } : {}),
                added: new Date().toISOString(),
            });
        },
    }).open();
}

/**
 * 用核心插件创建时间戳文档并挂为信息源
 *
 * 优先借用核心插件「唯一笔记」（zk-prefixer）的创建命令（即「借助核心插件」）；
 * 未启用该插件时回退为按 ISO 时间戳自建文件，功能不至于因此中断。
 */
export async function createTimestampDoc(view: DesignView, nodeId: string): Promise<void> {
    if (!view.pipe.GET_Node(nodeId)) return;

    // App 类型未公开 commands（核心插件命令注册在此），按其运行时形态断言后调用
    const commands = (view.app as unknown as {
        commands?: {
            commands?: Record<string, unknown>;
            executeCommandById(id: string): unknown;
        };
    }).commands;
    for (const cmd of ['zk-prefixer:create-new-unique-note', 'zk-prefixer:create-new-zettelkasten-note']) {
        if (!commands?.commands?.[cmd] || typeof commands.executeCommandById !== 'function') continue;
        commands.executeCommandById(cmd);
        const file = view.app.workspace.getActiveFile();
        if (file) {
            appendSource(view, nodeId, { label: file.basename, path: file.path, added: new Date().toISOString() });
            return;
        }
    }

    // 回退：自建时间戳命名的空文档
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const folder = view.settings.rootFolder || '';
    const path = `${folder ? `${folder}/` : ''}${stamp}.md`;
    try {
        const file = await view.app.vault.create(path, '');
        appendSource(view, nodeId, { label: file.basename, path: file.path, added: new Date().toISOString() });
        new Notice('已创建时间戳文档（未检测到核心插件「唯一笔记」，改用时间戳命名）');
    } catch (err) {
        console.error('[SeqTK] 创建时间戳文档失败:', err);
        new Notice('创建时间戳文档失败，请查看控制台');
    }
}

/** 追加一条外部信息源（写意图与其它字段更新同构） */
function appendSource(view: DesignView, nodeId: string, source: ExternalSource): void {
    const node = view.pipe.GET_Node(nodeId);
    if (!node) return;
    view.pipe.EXEC_Mutation({
        op: 'update',
        kind: node.kind,
        nodeId,
        updates: { sources: [...(node.sources ?? []), source], modify: new Date().toISOString() },
    });
    new Notice('已添加外部信息源');
}

/** 写回整份外部信息源列表（顺序调整与删除都走这里，仍是一次字段更新） */
function saveSources(view: DesignView, nodeId: string, sources: ExternalSource[]): void {
    const node = view.pipe.GET_Node(nodeId);
    if (!node) return;
    view.pipe.EXEC_Mutation({
        op: 'update',
        kind: node.kind,
        nodeId,
        updates: { sources, modify: new Date().toISOString() },
    });
}

/**
 * 管理外部信息源：调整顺序、删掉过时或引入错误的条目
 *
 * 弹窗里每次操作即时写盘（没有「保存」按钮）—— 这类小改动即时生效比先攒后存更符合预期，
 * 改错了再改回来也不比按保存麻烦。
 */
export function manageExternalSources(view: DesignView, nodeId: string): void {
    const node = view.pipe.GET_Node(nodeId);
    if (!node) return;
    new ExternalSourcesModal(view.app, node.sources ?? [], {
        onChange: (next) => {
            saveSources(view, nodeId, next);
            view.refresh();
        },
    }).open();
}

/**
 * 列出某节点的外部信息源并跳转
 *
 * 行内只出一个链接图标，条目名在这里展开（只显示末段名，见 GET_SourceLabel）；
 * url 交给系统浏览器，path 交给 workspace 打开（库内文件）。
 */
export function showSourcesMenu(view: DesignView, nodeId: string, e: MouseEvent): void {
    const sources = view.pipe.GET_Node(nodeId)?.sources ?? [];
    if (sources.length === 0) return;

    // 一律弹列表（哪怕只有一条）：列表里能看清是哪个文件，也避免"一点就跳走"不可预期
    const menu = new Menu();
    for (const s of sources) {
        const target = GET_SourceTarget(s);
        menu.addItem((item) =>
            item
                .setTitle(GET_SourceLabel(s))
                .setIcon(target?.kind === 'path' ? 'file-text' : 'external-link')
                .onClick(() => openSource(view, target)),
        );
    }
    menu.showAtMouseEvent(e);
}

/** 打开一条信息源（url → 系统浏览器；path → 库内文件） */
function openSource(view: DesignView, target: { kind: 'url' | 'path'; value: string } | null): void {
    if (!target) return;
    if (target.kind === 'url') {
        window.open(target.value, '_blank');
        return;
    }
    const file = view.app.vault.getFileByPath(target.value);
    if (file) void view.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
    else new Notice(`未找到文件：${target.value}`);
}
