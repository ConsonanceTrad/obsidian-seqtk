/**
 * design/textEdit — 设计视图文本批量编辑切片
 *
 * 从 DesignView 拆出的「节点树 ⇄ 文本树」双向通道：
 * - 复制子树为文本（剪贴板）
 * - 以文本批量编辑某节点子树 / 某框架的全部内容（导出 → 编辑 → 按差异回写）
 * - 从编辑器选中文本提取为节点组（命令入口，不需要视图实例，只需 plugin）
 *
 * 约定:
 * - 本文件函数以 view(DesignView 实例)为第一参数,只读写 view 上公开的状态
 *   （pipe / app / refresh）；提取命令那条路径只依赖 plugin
 * - 回写一律走 design/textTree 的 PLAN / APPLY，不在此另写对齐逻辑
 * - 弹窗只负责「收集文本」，放置位置与放置动作仍由这里编排（见 openTextTreeImport）
 *
 * 功能增补指引:
 * - 新增一种「批量改某棵子树」的入口 → 复用 EXPORT/PLAN/APPLY 三件套，不要新开回写实现
 */

import { Notice } from 'obsidian';
import type SeqtkPlugin from '../../../../main';
import { NodePickModal } from '../../../../P7_Render/Structure/S2_Modal/NodePickModal';
import { TextTreeImportModal } from '../../../../P7_Render/Structure/S2_Modal/TextTreeImportModal';
import type { TextTreeNode } from '../../../../P2_Tools/Parse/TextTree';
import { FRAMEWORK_TREE } from './FrameworkTreeShared';
import {
    APPLY_TextTreeEdit,
    DELIVER_TextTree,
    EXPORT_ChildrenAsText,
    EXPORT_SubtreeAsText,
    PLAN_TextTreeEdit,
} from './textTree';
import type { DesignView } from '../Core/Design';

/**
 * 打开文本树导入流程：解析预览 → 选放置位置 → 投递
 *
 * 拆成两段弹窗而不是一个巨型弹窗：「文本能不能解析」与「放到哪里」是两个独立的决定，
 * 混在一个界面里用户不容易判断此刻该看哪一块。
 */
export function openTextTreeImport(plugin: SeqtkPlugin, text: string): void {
    const pipe = plugin.allDeps.dataPipe;
    new TextTreeImportModal(plugin.app, {
        title: '提取为节点组',
        desc: '类型按层级推断（构想 → 方向 → 目标 → 工序；清单 → 事项）；越出链条的行需写 K:<短名>。确认无误后选择放置位置。',
        initialText: text,
        onConfirm: (roots) => {
            new NodePickModal(plugin.app, pipe, {
                title: '放置到哪个父节点下',
                allowTop: true,
                emptyText: '没有可用节点；也可选「顶层」直接放到顶层',
                onPick: (parentId) => void deliverTextTree(pipe, roots, parentId),
            }).open();
        },
    }).open();
}

/** 投递并回报结果（失败时说明已建了多少，避免用户以为整批都没成功） */
async function deliverTextTree(
    pipe: SeqtkPlugin['allDeps']['dataPipe'],
    roots: Parameters<typeof DELIVER_TextTree>[1],
    parentId: string,
): Promise<void> {
    const result = await DELIVER_TextTree(pipe, roots, parentId || null);
    if (result.error) {
        new Notice(`导入中断：已建 ${result.created} 个节点，失败原因：${result.error}`);
    } else {
        new Notice(`已导入 ${result.created} 个节点`);
    }
    // 导入后把落点节点整棵完全展开，导完就能直接查阅。
    // 父子两层都加：既铺开导入进来的层级，也铺开落点原有的折叠子节点 —— 否则「完全展开」
    // 会名不副实。这条路径只有 pipe（编辑器命令调用），拿不到 DesignView 那份右栏展开状态，
    // 所以只写左栏共享集合；落点选「顶层」时无可展开对象，跳过。
    if (parentId) {
        FRAMEWORK_TREE.expandedLeft.add(parentId);
        for (const d of pipe.COLLECT_Descendants(parentId)) FRAMEWORK_TREE.expandedLeft.add(d.nodeId);
        FRAMEWORK_TREE.markExpandedChanged();
    }
}

/**
 * 复制子树为文本树到剪贴板（可再粘到别处导入）
 *
 * 类型只在推断不出来时才写 `K:xxx`（见 SERIALIZE_TextTree）：沿链路的行读起来干净，
 * 岔出链路的部分仍能无损往返。
 */
export async function copySubtreeAsText(view: DesignView, nodeId: string): Promise<void> {
    const text = EXPORT_SubtreeAsText(view.pipe, nodeId);
    if (text === null) return;
    try {
        await navigator.clipboard.writeText(text);
        new Notice('已复制为文本树（可粘贴到别处再导入）');
    } catch (err) {
        console.error('[SeqTK] 复制失败:', err);
        new Notice('复制失败，请查看控制台');
    }
}

/**
 * 以文本批量编辑：导出整棵子树 → 编辑 → 按差异回写
 *
 * 只允许改**内容**（名称、状态、结构），不允许改根节点自身的类型 —— 那等于换了一棵树，
 * 语义上不是「编辑」而是「删除 + 新建」，容易误操作（用户改了根行类型时下面的提示会拦住）。
 *
 * 类型不逐行标注：起始链路由「进入时的层级 + 放置位置」表明，沿链路走的行都能推断出来；
 * 只有岔出链路的类型才写 `K:` —— 那才是跨层级搬运时必须显式带上、推断不出来的信息。
 */
export function editSubtreeAsText(view: DesignView, nodeId: string): void {
    const node = view.pipe.GET_Node(nodeId);
    if (!node) return;
    const text = EXPORT_SubtreeAsText(view.pipe, nodeId);
    if (text === null) return;

    new TextTreeImportModal(view.app, {
        title: `以文本批量编辑 · ${node.desc}`,
        desc:
            '直接改这段文本：改名、改状态（[ ] [/] [x] [-]）、调整缩进改变从属。' +
            '回写按「同层同位置」对齐，因此在中间插入一行，会让其后的同级行顺移一位' +
            '（被视为修改而非删旧建新 —— 这样才不会丢正文）。改动量会在下方实时预告。',
        initialText: text,
        notice: (roots) => {
            if (roots.length !== 1) {
                return [`根节点必须恰好一个（当前 ${roots.length} 个）；请保持首行不缩进。`];
            }
            const plan = PLAN_TextTreeEdit(view.pipe, nodeId, roots[0]);
            const lines = [
                `将更新 ${plan.updated} 个、新增 ${plan.created} 个、删除 ${plan.removed} 个节点。`,
            ];
            if (plan.removed > 0) {
                const more = plan.removed > plan.removedSample.length ? ' 等' : '';
                lines.push(`注意：将删除 —— ${plan.removedSample.join('、')}${more}`);
            }
            return lines;
        },
        // 批量编辑：点到弹窗外不关闭（那段文本可能改了很久，误点丢不起）
        closeOnClickOutside: false,
        onConfirm: (roots) => void applySubtreeEdit(view, nodeId, roots),
    }).open();
}

/**
 * 以文本编辑某个框架**内部**的元素（根可多个）
 *
 * 与「以文本批量编辑」的区别只在根的数量：那条路径从某个节点写起，根只有一个；
 * 这条把框架自身那行藏起来，直接编辑它的内容，于是根可以多个 ——
 * 框架里元素通常很多，每次都从框架节点那个根写起、每行多一层缩进太别扭。
 *
 * 实现上不新增回写逻辑：把框架节点当「假根」——它的 kind/desc/state 原样带入，
 * children 就是编辑后的多根列表。于是现有 PLAN/APPLY 的递归对齐原封不动可用，
 * 而框架自身那行因为字段没变，不会被改到。
 */
export function editFrameworkContentAsText(view: DesignView, frameworkId: string): void {
    const framework = view.pipe.GET_Node(frameworkId);
    if (!framework) return;
    const text = EXPORT_ChildrenAsText(view.pipe, frameworkId);
    if (text === null) return;

    /** 把编辑后的多根包成框架节点的形状，交给现成的回写路径 */
    const asFakeRoot = (roots: TextTreeNode[]): TextTreeNode => ({
        kind: framework.kind,
        state: framework.state ?? 'plan',
        desc: framework.desc,
        line: 0,
        children: roots,
    });

    new TextTreeImportModal(view.app, {
        title: `批量编辑 · ${framework.desc}`,
        desc:
            '直接改这段文本：改名、改状态（[ ] [/] [x] [-]）、调整缩进改变从属。' +
            '这里每一行都是框架的一级内容（框架本身那行不出现，根可以多个）。' +
            '回写按「同层同位置」对齐，中间插入一行会让其后的同级行顺移一位' +
            '（被视为修改而非删旧建新 —— 这样才不会丢正文）。' +
            '改动量会在下方实时预告。',
        initialText: text,
        notice: (roots) => {
            const plan = PLAN_TextTreeEdit(view.pipe, frameworkId, asFakeRoot(roots));
            const lines = [
                `框架内共 ${roots.length} 个根；将更新 ${plan.updated} 个、新增 ${plan.created} 个、删除 ${plan.removed} 个节点。`,
            ];
            if (plan.removed > 0) {
                const more = plan.removed > plan.removedSample.length ? ' 等' : '';
                lines.push(`注意：将删除 —— ${plan.removedSample.join('、')}${more}`);
            }
            return lines;
        },
        // 同上：框架内容通常更多，误点一下更丢不起
        closeOnClickOutside: false,
        onConfirm: (roots) => void applyFrameworkContentEdit(view, frameworkId, roots),
    }).open();
}

/** 执行框架内容回写（多根） */
async function applyFrameworkContentEdit(view: DesignView, frameworkId: string, roots: TextTreeNode[]): Promise<void> {
    const framework = view.pipe.GET_Node(frameworkId);
    if (!framework) return;
    const result = await APPLY_TextTreeEdit(view.pipe, frameworkId, {
        kind: framework.kind,
        state: framework.state ?? 'plan',
        desc: framework.desc,
        line: 0,
        children: roots,
    });
    if (result.error) {
        new Notice(
            `回写中断：已更新 ${result.updated}、新增 ${result.created}、删除 ${result.removed}；失败：${result.error}`,
        );
        return;
    }
    new Notice(`已回写：更新 ${result.updated}、新增 ${result.created}、删除 ${result.removed}`);
    view.refresh();
}

/** 执行子树回写并回报（失败时说明已完成的部分，便于判断要不要重来） */
async function applySubtreeEdit(view: DesignView, nodeId: string, roots: TextTreeNode[]): Promise<void> {
    if (roots.length !== 1) {
        new Notice('根节点必须恰好一个，未做任何修改');
        return;
    }
    const result = await APPLY_TextTreeEdit(view.pipe, nodeId, roots[0]);
    if (result.error) {
        new Notice(
            `回写中断：已更新 ${result.updated}、新增 ${result.created}、删除 ${result.removed}；失败：${result.error}`,
        );
        return;
    }
    new Notice(`已回写：更新 ${result.updated}、新增 ${result.created}、删除 ${result.removed}`);
    view.refresh();
}
