/**
 * SyntaxGuide — 文本树 / 模板文本的语法速查（设置面板「语法指南」页的数据源）
 *
 * 条目**由各处语法常量与解析器派生**，不手写一份文档：状态标记来自 TextTree 的
 * STATE_TO_MARK、类型短名来自 GET_KindShortNames、占位符与行内指令来自 TempParse / TextTree。
 * 改语法时这一页跟着变，不会出现「指南还写着旧写法」的漂移。
 *
 * 展示口径：**一个语法点一条**，不在同一行里并列多项（状态、@field 的取值、父字段白名单
 * 都逐条展开）—— 并列会把一行撑成横向长条，读起来要来回找，也就失去了「速查」的意义。
 */

import { NODE_STATE_LABELS, type SeqtkState } from '../../P4_Nodes/NodeField/StateKeys';
import { NODE_KIND_LABELS } from '../../P4_Nodes/NodeKind/NodeLabel';
import { GET_KindShortNames, STATE_TO_MARK } from './TextTree';
import {
    TEMPLATE_FRAMEWORK_NAME_TOKEN,
    TEMPLATE_PARENT_FIELDS,
    TEMPLATE_PARENT_PREFIX,
} from './TempParse';

/** 一条语法速查 */
export interface SyntaxGuideEntry {
    /** 分组标题（同组连续列出） */
    group: string;
    /** 语法片段（等宽显示） */
    syntax: string;
    /** 说明 */
    detail: string;
}

/** 全部语法条目（顺序 = 展示顺序；每个语法点一条） */
export function GET_SyntaxGuide(): SyntaxGuideEntry[] {
    const stateRows: SyntaxGuideEntry[] = (Object.keys(STATE_TO_MARK) as SeqtkState[]).map((s) => ({
        group: '状态',
        syntax: `[${STATE_TO_MARK[s]}]`,
        detail: `${NODE_STATE_LABELS[s]}（写在行首）`,
    }));

    const parentFieldRows: SyntaxGuideEntry[] = TEMPLATE_PARENT_FIELDS.map((field) => ({
        group: '占位符 · 父字段',
        syntax: `{{${TEMPLATE_PARENT_PREFIX}${field}}}`,
        detail: '插入处父节点的该字段值',
    }));

    return [
        { group: '行结构', syntax: '- ', detail: '每行以「- 」或「* 」开头' },
        { group: '行结构', syntax: '两个空格', detail: '每级缩进 2 个空格（tab 视作 2 个空格）；不能跨级' },

        ...stateRows,

        ...GET_KindShortNames().map(({ short, kind }) => ({
            group: '类型',
            syntax: `K:${short}`,
            detail: `指定为「${NODE_KIND_LABELS[kind]}」；省略时按层级推断`,
        })),

        {
            group: '行内 @ 指令',
            syntax: '@start',
            detail: '这一行作为插入起点（多树模板每棵都要）；指令写在名称任意位置，前后要有空白',
        },
        { group: '行内 @ 指令', syntax: '@field:copy', detail: '插入时复制状态 / 性质字段（默认）' },
        { group: '行内 @ 指令', syntax: '@field:reset', detail: '插入时清空这些字段' },
        { group: '行内 @ 指令', syntax: '@field:expected', detail: '连预期时间 / 重复 / 时长一起复制' },
        { group: '行内 @ 指令', syntax: '@pos:<n>', detail: '插入位置：同级第 n 个之后' },

        { group: '占位符', syntax: TEMPLATE_FRAMEWORK_NAME_TOKEN, detail: '插入时替换为目标框架名' },
        { group: '占位符', syntax: '{{变量}}', detail: '插入时由使用方输入（变量名自起）' },
        { group: '占位符', syntax: '{{变量:提示}}', detail: '输入时显示提示语' },
        { group: '占位符', syntax: '{{变量:提示|默认值}}', detail: '显示提示语并预填默认值；同名变量只问一次' },

        ...parentFieldRows,

        { group: '名称标记', syntax: '#tag:名称', detail: '给这一项打标签；与名称、其它标签之间要有空白' },
    ];
}
