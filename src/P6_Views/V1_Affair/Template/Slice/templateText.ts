/**
 * Template/Slice/templateText — 模板模式右栏下半「文本区」的数据面
 *
 * 与设计视图的「以文本编辑框架内容」是同一条通道：文本区编辑的就是**选中模板框架的内容**
 * （框架自身那行不出现，于是根可以多个）。导出 / 差异预告 / 回写全部复用
 * `design/Slice/textTree` 的 EXPORT / PLAN / APPLY —— 不在此另写一套对齐逻辑；
 * 本文件只补两件模板特有的事：
 * 1. 占位符校验（`{{变量}}` / `{{父.字段}}` 写错了要在编辑时看见）
 * 2. 类型链校验：模板框架下可放任意类型的单元（顶层不校验），但**单元内部的链**必须成立
 */

import type { DataPipe } from '../../../../P5_Data/CoPipe/DataPipe';
import { COLLECT_TemplateSlots } from '../../../../P2_Tools/Parse/TempParse';
import {
    PARSE_TextTree,
    PREVIEW_TextTree,
    VALIDATE_TemplateTree,
    type TextTreeIssue,
    type TextTreeNode,
} from '../../../../P2_Tools/Parse/TextTree';
import {
    APPLY_TextTreeEdit,
    EXPORT_ChildrenAsText,
    PLAN_TextTreeEdit,
    type ApplyResult,
} from '../../Design/Slice/textTree';

/** 文本区预览行（缩进层级 + 类型 + 状态） */
export type TemplateTextPreviewRow = ReturnType<typeof PREVIEW_TextTree>[number];

/** 文本区校验结果 */
export interface TemplateTextCheck {
    /** 全部问题（语法 + 类型链 + 占位符），已按行号排序 */
    issues: TextTreeIssue[];
    /** 解析出的预览行 */
    preview: TemplateTextPreviewRow[];
    /** 差异预告（更新 / 新增 / 删除），随输入实时刷新 */
    notice: string[];
    /** 解析出的根数量（框架的一级内容数） */
    rootCount: number;
    /** 无校验错误（是否"有改动"由视图比对基线后决定） */
    canApply: boolean;
}

/** 文本区初值：选中框架的内容（不含框架自身那行） */
export function EXPORT_TemplateFrameworkText(pipe: DataPipe, frameworkId: string): string {
    return EXPORT_ChildrenAsText(pipe, frameworkId) ?? '';
}

/**
 * 把编辑后的多根包成框架节点的形状
 *
 * 与设计视图的框架内容编辑同一手法：框架自身那行字段原样带入，children 就是编辑结果，
 * 于是现成的 PLAN / APPLY 递归对齐原封不动可用，而框架自身不会被改到。
 */
function AS_FakeRoot(
    pipe: DataPipe,
    frameworkId: string,
    roots: TextTreeNode[],
): TextTreeNode | null {
    const framework = pipe.GET_Node(frameworkId);
    if (!framework) return null;
    return {
        kind: framework.kind,
        state: framework.state ?? 'plan',
        desc: framework.desc,
        line: 0,
        children: roots,
    };
}

/**
 * 占位符问题（按节点所在行报出）
 *
 * 模板单元的 desc 里写了未知父字段或坏了花括号时，解析层看不出来（那是纯文本），
 * 但插进目标框架后会原样落进节点名 —— 所以在这一层就报出来。同名问题去重，
 * 避免一个单元反复刷屏。
 */
export function COLLECT_PlaceholderIssues(roots: TextTreeNode[]): TextTreeIssue[] {
    const out: TextTreeIssue[] = [];
    const seen = new Set<string>();
    const walk = (node: TextTreeNode): void => {
        for (const issue of COLLECT_TemplateSlots(node.desc).issues) {
            const message = `「${node.desc}」：${issue.message}`;
            if (seen.has(message)) continue;
            seen.add(message);
            out.push({ line: node.line, message });
        }
        for (const child of node.children) walk(child);
    };
    for (const root of roots) walk(root);
    return out;
}

/** 校验文本区内容并给出预览与差异预告（**只算不写**） */
export function CHECK_TemplateFrameworkText(
    pipe: DataPipe,
    frameworkId: string,
    text: string,
): TemplateTextCheck {
    const { roots, issues } = PARSE_TextTree(text);
    const chain = VALIDATE_TemplateTree(roots);
    const slots = COLLECT_PlaceholderIssues(roots);
    const all = [...issues, ...chain, ...slots].sort((a, b) => a.line - b.line);

    const notice: string[] = [];
    // 语法有错时算差异没有意义（解析出的树是残缺的，预告会误导）
    if (issues.length === 0) {
        const fakeRoot = AS_FakeRoot(pipe, frameworkId, roots);
        if (fakeRoot) {
            const plan = PLAN_TextTreeEdit(pipe, frameworkId, fakeRoot);
            notice.push(`将更新 ${plan.updated} 个、新增 ${plan.created} 个、删除 ${plan.removed} 个节点。`);
            if (plan.removed > 0) {
                const more = plan.removed > plan.removedSample.length ? ' 等' : '';
                notice.push(`注意：将删除 —— ${plan.removedSample.join('、')}${more}`);
            }
        }
    }

    return {
        issues: all,
        preview: PREVIEW_TextTree(roots),
        notice,
        rootCount: roots.length,
        canApply: all.length === 0,
    };
}

/** 回写文本区内容（失败时回报已完成的部分，便于判断要不要重来） */
export async function APPLY_TemplateFrameworkText(
    pipe: DataPipe,
    frameworkId: string,
    roots: TextTreeNode[],
): Promise<ApplyResult> {
    const fakeRoot = AS_FakeRoot(pipe, frameworkId, roots);
    if (!fakeRoot) {
        return { updated: 0, created: 0, removed: 0, removedSample: [], error: '模板框架不存在' };
    }
    return APPLY_TextTreeEdit(pipe, frameworkId, fakeRoot);
}
