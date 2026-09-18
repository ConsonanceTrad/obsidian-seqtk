/**
 * Template/Slice/templateApply — 把模板内容插进目标框架
 *
 * 以「宿主」为第一参数、只 `import type` 宿主契约（见 TemplateHost；视图与委托面板
 * 都能充当宿主）。克隆本身全部交给 `P2_Tools/Parse/TempParse` 的 cloneSubtree
 * （单一入口），本文件只管「读分支、问清落到哪儿、把细则翻成 policy」。
 *
 * 分支与细则（行内 `@` 指令，语法见 P2_Tools/Parse/TextTree）：
 * - 文本的每个根是一棵树 = 一个分支；单树直接应用，多树先让用户选分支
 * - `@start` 指明从树内哪个节点开始嵌（缺省 = 整棵树）
 * - `@field` / `@pos` 翻成 TemplateInsertPolicy 的 fields / position
 * - 同名冲突策略来自设置（右栏预览区底部可改）
 * - 插入时把 `@` 指令从名称里剥掉（它只是元标记）
 *
 * 校验口径：起点节点的 kind 必须能被目标框架接纳（NodeFacade 的 getAllowedChildKinds），
 * 与事务设计右键「使用模板」保持一致 —— 两处入口的判定不许各写一份。
 */

import { Notice } from 'obsidian';
import {
    NODE_KIND,
    NODE_KIND_LABELS,
    getAllowedChildKinds,
} from '../../../../P4_Nodes/NodeFacade';
import {
    cloneSubtree,
    TEMPLATE_FRAMEWORK_NAME_TOKEN,
    type TemplateInsertPolicy,
} from '../../../../P2_Tools/Parse/TempParse';
import {
    PARSE_TextTree,
    STRIP_AtTokens,
    VALIDATE_TemplateInstr,
} from '../../../../P2_Tools/Parse/TextTree';
import {
    SelectFrameworkModal,
    SelectOptionModal,
} from '../../../../P7_Render/Structure/S2_Modal/TemplateModals';
import {
    BRANCHES_TemplateText,
    EXPORT_TemplateFrameworkText,
    type TemplateBranch,
} from './templateText';
import type { DataPipe } from '../../../../P5_Data/CoPipe/DataPipe';
import type { TemplateHost } from './TemplateHost';

/** 可作为模板落点的目标框架（事务框架 / 信息框架） */
export function LIST_TargetFrameworks(view: TemplateHost): { nodeId: string; label: string }[] {
    return [
        ...view.pipe.GET_ByKind(NODE_KIND.TRANS),
        ...view.pipe.GET_ByKind(NODE_KIND.INFO),
    ].map((f) => ({ nodeId: f.nodeId, label: f.data.desc }));
}

/** 目标框架能否接纳这个节点类型（预检用；判定与拖拽落点同一条） */
export function CAN_InsertUnit(view: TemplateHost, targetId: string, unitId: string): boolean {
    const target = view.pipe.GET_Node(targetId);
    const unit = view.pipe.GET_Node(unitId);
    if (!target || !unit) return false;
    return getAllowedChildKinds(target.kind).includes(unit.kind);
}

/** 分支的展示名（多树选择时用）：树名 + 起点 */
function BRANCH_Label(branch: TemplateBranch): string {
    const rootName = STRIP_AtTokens(branch.root.desc);
    if (branch.startPath.length === 0) return `${rootName}（整棵树）`;
    const last = branch.startPath[branch.startPath.length - 1];
    return `${rootName}（起点：${STRIP_AtTokens(last)}）`;
}

/**
 * 按名称路径在模板框架的内容里找节点
 *
 * 文本就是从这棵树导出的，名称按原文保留 —— 用名称逐级往下找，比按子节点下标稳：
 * 用户重排内容后，index 会错位而名称不会。
 */
function NODE_ByPath(pipe: DataPipe, frameworkId: string, path: string[]): string | null {
    let parent = frameworkId;
    let found: string | null = null;
    for (const desc of path) {
        const child = pipe.GET_Children(parent).find((c) => c.data?.desc === desc);
        if (!child) return null;
        found = child.nodeId;
        parent = child.nodeId;
    }
    return found;
}

/** 读模板内容 → 分支；文本有问题时提示并返回 null（不带着残缺的树去改库） */
function READ_Branches(view: TemplateHost, frameworkId: string): TemplateBranch[] | null {
    const { roots, issues } = PARSE_TextTree(EXPORT_TemplateFrameworkText(view.pipe, frameworkId));
    const instr = VALIDATE_TemplateInstr(roots);
    const all = [...issues, ...instr];
    if (all.length > 0) {
        const first = all[0];
        new Notice(`文本区还有问题，先修好再应用：第 ${first.line} 行 ${first.message}`);
        return null;
    }
    if (roots.length === 0) {
        new Notice('这个模板还没有内容');
        return null;
    }
    return BRANCHES_TemplateText(roots);
}

/** 应用入口：读分支 →（多树时先选分支）→ 选目标框架 → 插入 */
export function APPLY_Template(view: TemplateHost, templateId: string): void {
    const branches = READ_Branches(view, templateId);
    if (!branches) return;

    const toTarget = (branch: TemplateBranch): void => {
        const frameworks = LIST_TargetFrameworks(view);
        if (frameworks.length === 0) {
            new Notice('请先创建目标框架（事务框架 / 信息框架）');
            return;
        }
        new SelectFrameworkModal(view.app, {
            title: `应用模板到框架 · ${STRIP_AtTokens(branch.root.desc)}`,
            frameworks,
            onSelect: (targetId) => {
                void APPLY_Branch(view, templateId, targetId, branch);
            },
        }).open();
    };

    if (branches.length === 1) {
        toTarget(branches[0]);
        return;
    }
    // 多树：先把分支区分开（每棵树一项），选了再问落点
    new SelectOptionModal(view.app, {
        title: '选择插入分支',
        label: '分支',
        options: branches.map((b, i) => ({ nodeId: String(i), label: BRANCH_Label(b) })),
        onSelect: (id) => toTarget(branches[Number(id)]),
    }).open();
}

/** 把一个分支插进目标框架（细则 = 该分支的 @field / @pos + 设置里的冲突策略） */
export async function APPLY_Branch(
    view: TemplateHost,
    frameworkId: string,
    targetId: string,
    branch: TemplateBranch,
): Promise<void> {
    // 起点缺省 = 整棵树：用根的名称当路径
    const path = branch.startPath.length > 0 ? branch.startPath : [branch.root.desc];
    const sourceId = NODE_ByPath(view.pipe, frameworkId, path);
    if (!sourceId) {
        new Notice('找不到插入起点对应的节点（模板内容可能刚被改过，先「确认」回写一次）');
        return;
    }
    const source = view.pipe.GET_Node(sourceId);
    const target = view.pipe.GET_Node(targetId);
    if (!source || !target) return;
    if (!getAllowedChildKinds(target.kind).includes(source.kind)) {
        new Notice(`起点类型「${NODE_KIND_LABELS[source.kind]}」不能插入「${NODE_KIND_LABELS[target.kind]}」`);
        return;
    }

    const policy: TemplateInsertPolicy = {
        conflict: view.settings.templatePolicy ?? 'append',
        ...(branch.field ? { fields: branch.field === 'expected' ? 'copyExpected' : branch.field } : {}),
        ...(branch.pos !== undefined ? { position: branch.pos } : {}),
    };

    const rootId = await cloneSubtree({
        sourceId,
        parentId: targetId,
        pipe: view.pipe,
        // {{frame}} 替换 + 剥掉行内 @ 指令（元标记不该进新节点的名称）
        resolveText: (text) => STRIP_AtTokens(text.split(TEMPLATE_FRAMEWORK_NAME_TOKEN).join(target.desc)),
        policy,
    });
    new Notice(rootId ? `模板已应用（${STRIP_AtTokens(branch.root.desc)}）` : '应用模板失败');
}

/**
 * 整棵子树按「整棵树 + 当前冲突策略」插入
 *
 * 供「使用模板」那条链（选中某个单元直接落地）复用：它没有分支与 `@` 指令的概念，
 * 走的就是分支的缺省形态。
 */
export async function APPLY_TemplateTo(
    view: TemplateHost,
    targetId: string,
    targetDesc: string,
    templateId: string,
): Promise<void> {
    const rootId = await cloneSubtree({
        sourceId: templateId,
        parentId: targetId,
        pipe: view.pipe,
        resolveText: (text) => STRIP_AtTokens(text.split(TEMPLATE_FRAMEWORK_NAME_TOKEN).join(targetDesc)),
        policy: { conflict: view.settings.templatePolicy ?? 'append' },
    });
    new Notice(rootId ? '模板已应用' : '应用模板失败');
}
