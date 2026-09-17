/**
 * Template/Slice/templateApply — 把模板单元插进目标框架
 *
 * 以「宿主」为第一参数、只 `import type` 宿主契约（见 TemplateHost；视图与委托面板
 * 都能充当宿主，判定与写盘那条线完全共用）。克隆本身全部交给
 * `P2_Tools/Parse/TempParse` 的 cloneSubtree（单一入口），本文件只管
 * 「问清落到哪儿、校验能不能落」。
 *
 * 校验口径：顶层单元的 kind 必须能被目标框架接纳（NodeFacade 的 getAllowedChildKinds），
 * 与事务设计右键「使用模板」保持一致 —— 两处入口的判定不许各写一份。
 */

import { Notice } from 'obsidian';
import {
    NODE_KIND,
    NODE_KIND_LABELS,
    getAllowedChildKinds,
} from '../../../../P4_Nodes/NodeFacade';
import { cloneSubtree, TEMPLATE_FRAMEWORK_NAME_TOKEN } from '../../../../P2_Tools/Parse/TempParse';
import { SelectFrameworkModal } from '../../../../P7_Render/Structure/S2_Modal/TemplateModals';
import type { TemplateHost } from './TemplateHost';

/** 可作为模板落点的目标框架（事务框架 / 信息框架） */
export function LIST_TargetFrameworks(view: TemplateHost): { nodeId: string; label: string }[] {
    return [
        ...view.pipe.GET_ByKind(NODE_KIND.TRANS),
        ...view.pipe.GET_ByKind(NODE_KIND.INFO),
    ].map((f) => ({ nodeId: f.nodeId, label: f.data.desc }));
}

/** 目标框架能否接纳这个顶层单元类型 */
export function CAN_InsertUnit(view: TemplateHost, targetId: string, unitId: string): boolean {
    const target = view.pipe.GET_Node(targetId);
    const unit = view.pipe.GET_Node(unitId);
    if (!target || !unit) return false;
    return getAllowedChildKinds(target.kind).includes(unit.kind);
}

/** 应用入口：选目标框架 → 校验 → 克隆整棵子树（{{框架名}} 替换为目标框架名） */
export function APPLY_Template(view: TemplateHost, templateId: string): void {
    const template = view.pipe.GET_Node(templateId);
    if (!template) return;

    const frameworks = LIST_TargetFrameworks(view);
    if (frameworks.length === 0) {
        new Notice('请先创建目标框架（事务框架 / 信息框架）');
        return;
    }

    new SelectFrameworkModal(view.app, {
        title: '应用模板到框架',
        frameworks,
        onSelect: (targetId) => {
            if (!CAN_InsertUnit(view, targetId, templateId)) {
                const target = view.pipe.GET_Node(targetId);
                new Notice(
                    `该模板顶层类型「${NODE_KIND_LABELS[template.kind]}」不能插入此框架` +
                    (target ? `（${NODE_KIND_LABELS[target.kind]}）` : ''),
                );
                return;
            }
            const target = view.pipe.GET_Node(targetId);
            void APPLY_TemplateTo(view, targetId, target?.desc ?? '', templateId);
        },
    }).open();
}

/** 递归克隆模板单元整棵子树到目标框架下 */
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
        resolveText: (text) => text.split(TEMPLATE_FRAMEWORK_NAME_TOKEN).join(targetDesc),
    });
    new Notice(rootId ? '模板已应用' : '应用模板失败');
}
