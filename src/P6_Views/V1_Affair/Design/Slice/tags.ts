/**
 * design/tags — 节点标签切片
 *
 * 标签存在 `NodeBase.tags`（string[]），数据层早已具备：SQLite 有 tags 列、
 * FileWrite 会写进 frontmatter、模糊搜索也匹配它。本切片只补两件事：
 * 「名称与标签之间的文本互转」与「行上的编辑入口」。
 *
 * 约定:
 * - 写盘与 design/externalInfo 的 saveSources 同构：一次字段更新，不新增第二条写盘路径
 * - 名称与标签的互转是纯函数（PARSE_NameTags / FORMAT_NameTags），便于将来单测
 * - 行内重命名以**输入框内容为准**（全量）：框里出现的标签就是该节点的全部标签，
 *   因此进入重命名态时必须用 FORMAT_NameTags 把现有标签拼进初始值（见 Tool/viewModel）
 */

import { TagsModal } from '../../../../P7_Render/Structure/S2_Modal/TagsModal';
import type { NodeEditHost } from './actions';
import type { DesignView } from '../Core/Design';

/**
 * 标签前缀：`#标签`。
 *
 * 与**文本块**那套 `#tag:标签`（见 P2_Tools/Parse/SyntaxGuide、TextComplete）**故意不同**：
 * 那里是给文本树里的一行打标记，这里是给节点本身打标签。两套写法分开，就不会在正文里
 * 被 Obsidian 顺手当成真标签，也不会与行内语法的补全互相抢触发。
 *
 * 前面必须有空白才算标签，这样 `C#`、`a#b` 这类名称不会被切开。
 */
const TAG_PREFIX = '#';

/**
 * 把「名称 … #标签…」拆成名称与标签
 *
 * 规则：
 * - 以空白切分，`#` 开头且其后还有内容的段视为标签，其余段拼回名称
 * - 因此 `#` 前必须是空白；`C#`、`a#b`、单独的 `#` 都留在名称里
 * - 标签去重（保持出现顺序）
 * - 整段都是标签时返回 `desc: null`，由调用方保留原名 —— 免得手滑把名字删没
 * - 不做 `tag:` 前缀剥离：手写 `#tag:甲` 时标签名就是 `tag:甲`，两套语法严格互不干扰
 */
export function PARSE_NameTags(text: string): { desc: string | null; tags: string[] } {
    const tags: string[] = [];
    let desc = '';

    for (const part of text.split(/\s+/)) {
        if (part.length === 0) continue;
        if (part.startsWith(TAG_PREFIX) && part.length > TAG_PREFIX.length) {
            const name = part.slice(TAG_PREFIX.length);
            if (!tags.includes(name)) tags.push(name);
            continue;
        }
        desc = desc === '' ? part : `${desc} ${part}`;
    }

    return { desc: desc === '' ? null : desc, tags };
}

/** 名称与标签 → 行内重命名框的初始值（`名称 #甲 #乙`） */
export function FORMAT_NameTags(desc: string, tags: string[]): string {
    return [desc, ...tags.map((t) => `${TAG_PREFIX}${t}`)].join(' ').trim();
}

/**
 * 写回整份标签列表（增删与排序都走这里，仍是一次字段更新）
 *
 * 参数取 NodeEditHost 而非 DesignView：委托树也要按同一条规则解析行内重命名，
 * 而它实现的是同一个最小接口（与 saveNodeDesc 的取值口径一致）。
 */
export function saveTags(view: NodeEditHost, nodeId: string, tags: string[]): void {
    const node = view.pipe.GET_Node(nodeId);
    if (!node) return;
    view.pipe.EXEC_Mutation({
        op: 'update',
        kind: node.kind,
        nodeId,
        updates: { tags, modify: new Date().toISOString() },
    });
}

/** 管理标签：打开弹窗调顺序、增删条目；改动即时写盘并让行重新渲染 */
export function manageTags(view: DesignView, nodeId: string): void {
    const node = view.pipe.GET_Node(nodeId);
    if (!node) return;
    new TagsModal(view.app, node.tags ?? [], {
        onChange: (next) => {
            saveTags(view, nodeId, next);
            view.refresh();
        },
    }).open();
}
