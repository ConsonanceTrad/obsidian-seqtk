/**
 * design/externalInfo — 设计视图「外部信息源」切片
 *
 * 从 DesignView 拆出的外部信息源读写与入口：
 * 关联（URL / 库内文件）· 创建时间戳笔记 · 管理（排序 / 删除）· 行内列出并跳转。
 *
 * 时间戳笔记**不再路由核心插件的命令**：那条命令只认它自己的设置、无法指定目录与格式，
 * 而且建完一定打开新笔记。这里改为读核心插件「时间戳笔记生成器」的配置并遵循它自己建文件；
 * 读不到（或用户在设置里选了用本插件配置）就落到本插件那份配置。
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

import { Menu, Notice, moment } from 'obsidian';
import {
    GET_SourceLabel,
    GET_SourceTarget,
    type ExternalSource,
} from '../../../../P4_Nodes/NodeField/AttriGroup/External';
import { ExternalSourcesModal } from '../../../../P7_Render/Structure/S2_Modal/ExternalSourcesModal';
import { TextPromptModal } from '../../../../P7_Render/Structure/S2_Modal/TextPromptModal';
import type { PluginSettings } from '../../../../P3_Settings/Settings';
import type { NodeEditHost } from './actions';

/**
 * 关联一条外部信息源（URL 或库内文件路径）
 *
 * 函数名保留 `addExternalSource`：它只是内部标识符，改它要牵动菜单的 import；
 * 用户看到的文案是「关联库内文件或 URL」，与标识符各归各的。
 *
 * 「外部信息源」是独立列表字段，不与 follows / parent 那一簇混用 ——
 * 前者描述节点之间的关系，后者描述节点与节点体系之外材料的关联。
 */
export function addExternalSource(view: NodeEditHost, nodeId: string): void {
    if (!view.pipe.GET_Node(nodeId)) return;
    new TextPromptModal(view.app, {
        title: '关联库内文件或 URL',
        desc: 'URL 与库内文件路径二选一填写；名称留空时显示地址或文件名。库内文件可用右侧按钮搜索选择，也可直接粘贴路径。',
        fields: [
            { key: 'label', label: '名称', placeholder: '可留空' },
            { key: 'url', label: 'URL', placeholder: 'https://…' },
            // type: 'file' → 该行右侧多一个「在库内选择文件」的搜索按钮
            { key: 'path', label: '库内文件', placeholder: 'docs/某文件.md', type: 'file' },
        ],
        onConfirm: ({ label, url, path }) => {
            if (!url && !path) {
                new Notice('请填写 URL 或库内文件路径');
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

// ============================================================
// 创建时间戳笔记
// ============================================================

/** 核心插件「时间戳笔记生成器」的插件 id（命名空间沿用旧 id，官方为兼容一直保留） */
const CORE_PLUGIN_ID = 'zk-prefixer';

/** 它的数据文件（相对库根）：运行时配置取不到时的第二路 */
const CORE_DATA_PATH = `.obsidian/plugins/${CORE_PLUGIN_ID}/data.json`;

/** 格式无效时的兜底（与设置默认值一致） */
const FALLBACK_TIMESTAMP_FORMAT = 'YYYYMMDDHHmmss';

/** 落点目录留空时的位置：库根下的这个文件夹 */
const DEFAULT_TIMESTAMP_FOLDER = 'Timestamp';

/** 时间戳笔记的配置：目录 + 文件名格式 */
export interface TimestampConfig {
    /** 落点目录（vault 相对路径；空串 = 库根的 Timestamp 文件夹） */
    folder: string;
    /** 文件名格式（moment 的 token） */
    format: string;
}

/** 取字符串字段；不是字符串就当没读到 */
const PICK_String = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * 从一份（来源不定的）配置对象里取出目录与格式
 *
 * 字段名不写死：不同版本用过 `prefixFormat` / `format` 与 `folder` / `newFileLocation`。
 * 任一项取不到就返回 null —— 这里**绝不猜默认值**，否则会造出一份「看着像跟随核心、
 * 其实是我编的」配置：用户改核心插件的设置却毫无效果，还查不出为什么。
 */
function READ_TimestampConfig(raw: Record<string, unknown> | undefined): TimestampConfig | null {
    if (!raw) return null;
    const format = PICK_String(raw.prefixFormat) ?? PICK_String(raw.format);
    const folder = PICK_String(raw.folder) ?? PICK_String(raw.newFileLocation);
    if (format === null || folder === null) return null;
    return { folder, format };
}

/**
 * 读核心插件「时间戳笔记生成器」的配置
 *
 * 两路：插件表（已启用时最直接）优先，读不到再读它的 data.json ——
 * 插件未启用、或内部结构变了时，还有一条路可走。
 */
export async function READ_CoreTimestampConfig(app: NodeEditHost['app']): Promise<TimestampConfig | null> {
    const holder = app as unknown as {
        plugins?: { plugins?: Record<string, { settings?: Record<string, unknown> }> };
    };
    const fromRuntime = READ_TimestampConfig(holder.plugins?.plugins?.[CORE_PLUGIN_ID]?.settings);
    if (fromRuntime) return fromRuntime;

    try {
        const raw = await app.vault.adapter.read(CORE_DATA_PATH);
        return READ_TimestampConfig(JSON.parse(raw) as Record<string, unknown>);
    } catch {
        return null;
    }
}

/**
 * 这次用哪份配置
 *
 * 用户选了「使用本插件配置」→ 用本插件那份；否则能用核心配置就用核心的，
 * 读不到才回退（回退是静默的，不弹提示打断操作）。
 */
export function RESOLVE_TimestampConfig(settings: PluginSettings, core: TimestampConfig | null): TimestampConfig {
    if (settings.timestampConfig !== 'own' && core) return core;
    return { folder: settings.timestampFolder, format: settings.timestampFormat };
}

/**
 * 取当前时间并按 moment 格式格式化
 *
 * obsidian 导出的 `moment` 在 d.ts 里声明成命名空间（`typeof moment`），直接调用会报
 * 「no call signatures」；运行时它就是可调用的函数，所以这里显式转一次类型。
 */
const FORMAT_Now = (pattern: string): string => {
    const m = moment as unknown as () => { format(p: string): string };
    return m().format(pattern);
};

/** 按 moment 格式生成文件名；格式无效、产出空串或含路径分隔符时退回兜底格式 */
function FORMAT_TimestampName(format: string): string {
    const wanted = format.trim() === '' ? FALLBACK_TIMESTAMP_FORMAT : format;
    let name = '';
    try {
        name = FORMAT_Now(wanted);
    } catch {
        name = '';
    }
    return name !== '' && !/[/\\]/.test(name) ? name : FORMAT_Now(FALLBACK_TIMESTAMP_FORMAT);
}

/** 从路径取文件名（去扩展名），作为信息源的展示名 */
const NAME_FromPath = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/, '');

/**
 * 按配置建一个空的时间戳笔记，返回它的路径
 *
 * 重名时追加 `-1` / `-2`：核心插件那套自己保证唯一，自建就得自己兜 ——
 * 同一秒内连点两次、或格式只精确到天，都会撞名。
 */
async function CREATE_TimestampFile(view: NodeEditHost, config: TimestampConfig): Promise<string | null> {
    // 目录留空 = 库根目录下的 Timestamp 文件夹。时间戳笔记是**独立笔记**，
    // 不该混进 SeqTK 的数据目录（settings.rootFolder）里，所以这里用自己那个固定落点
    const folder = config.folder || DEFAULT_TIMESTAMP_FOLDER;
    const stem = FORMAT_TimestampName(config.format);
    const base = `${folder}/${stem}`;

    try {
        if (folder && !view.app.vault.getFolderByPath(folder)) await view.app.vault.createFolder(folder);
        let path = `${base}.md`;
        for (let i = 1; view.app.vault.getFileByPath(path); i++) path = `${base}-${i}.md`;
        await view.app.vault.create(path, '');
        return path;
    } catch (err) {
        console.error('[SeqTK] 创建时间戳笔记失败:', err);
        new Notice('创建时间戳笔记失败，请查看控制台');
        return null;
    }
}

/**
 * 建一篇时间戳笔记并挂成该节点的外部信息源
 *
 * 目录与文件名格式取自 `RESOLVE_TimestampConfig`（核心插件配置，或本插件配置）。
 *
 * `open` 决定建完之后停在哪：
 * - `false`（「快速创建」）：留在操作前那篇笔记里 —— 自建文件本身不切换视图，
 *   但用户可能正开着别的笔记，这里显式还原一次，行为才可预期
 * - `true`（「创建并打开」）：打开刚建好的这篇
 */
export async function createTimestampDoc(view: NodeEditHost, nodeId: string, open: boolean): Promise<void> {
    if (!view.pipe.GET_Node(nodeId)) return;
    const prevFile = view.app.workspace.getActiveFile();

    const core = await READ_CoreTimestampConfig(view.app);
    const config = RESOLVE_TimestampConfig(view.settings, core);
    const path = await CREATE_TimestampFile(view, config);
    if (!path) return;

    appendSource(view, nodeId, {
        label: NAME_FromPath(path),
        path,
        added: new Date().toISOString(),
    });

    if (open) {
        const file = view.app.vault.getFileByPath(path);
        if (file) void view.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
        return;
    }
    if (prevFile) void view.app.workspace.getLeaf(false)?.openFile(prevFile, { state: { mode: 'source' } });
}

// ============================================================
// 列表：追加 / 写回 / 管理 / 跳转
// ============================================================

/** 追加一条外部信息源（写意图与其它字段更新同构） */
function appendSource(view: NodeEditHost, nodeId: string, source: ExternalSource): void {
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
function saveSources(view: NodeEditHost, nodeId: string, sources: ExternalSource[]): void {
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
export function manageExternalSources(view: NodeEditHost, nodeId: string): void {
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
export function showSourcesMenu(view: NodeEditHost, nodeId: string, e: MouseEvent): void {
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
function openSource(view: NodeEditHost, target: { kind: 'url' | 'path'; value: string } | null): void {
    if (!target) return;
    if (target.kind === 'url') {
        window.open(target.value, '_blank');
        return;
    }
    const file = view.app.vault.getFileByPath(target.value);
    if (file) void view.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
    else new Notice(`未找到文件：${target.value}`);
}
