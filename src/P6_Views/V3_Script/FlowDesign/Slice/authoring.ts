/**
 * flowDesign/authoring — 「拖入组件」到 AST 的构造
 *
 * LAD 面板上拖一个组件进来，要问用户几个字段、把新节点塞进 AST 的对应位置、
 * 再序列化写回脚本。本切片管的就是这一段：**入参是 AST 里的目标数组或目标节点**，
 * 而不是 DOM —— 渲染与落点判定在 Slice/ladRender 与 Slice/palette。
 *
 * 切片契约（见 P6_Views/Views.md）：以 host 为第一参数、只认识 Slice/host 的接口。
 */

import { FlowPromptModal } from './modals';
import type { FlowDesignHost } from './host';
import type { FlowContentBlock, FlowLine, FlowLineItem, FlowTimeNode } from '../../../../P2_Tools/Script/parser';

/** 时间节点四类的判定（LAD 里「时间轴」区与「线路行」区接受的类型不同） */
export function IS_TimeNodeType(type: string): boolean {
    return type === 'at' || type === 'span' || type === 'repeat' || type === 'when';
}

/**
 * 把内容块归位到时间节点的 do 输出
 *
 * 内容块在语法上不直接挂在时间节点下，而是**do 的输出**（见 P2_Tools/Script/parser 的
 * 同一约定）。所以这里要做三件事：没有线路行就补一条、线路行里没有 do 就补一个
 * 哑 do（`if true` → do）、最后把块追加到那个 do 的 contents。
 */
export function ADD_ContentToNode(node: FlowTimeNode, block: FlowContentBlock): void {
    if (node.lines.length === 0) {
        node.lines.push({ type: 'line', items: [] });
    }
    const line = node.lines[0];
    let doItem: FlowLineItem | null = null;
    for (let k = line.items.length - 1; k >= 0; k--) {
        const it = line.items[k];
        if (it.type === 'if' && it.do !== undefined) {
            doItem = it;
            break;
        }
    }
    if (!doItem) {
        const item: FlowLineItem = { type: 'if', not: false, cond: 'true', do: '', contents: [] };
        line.items.push(item);
        doItem = item;
    }
    if (doItem.type === 'if') {
        doItem.contents = [...(doItem.contents ?? []), block];
    }
}

/** 根据拖入类型在时间节点列表插入节点（insertIndex 指定位置；缺省追加末尾） */
export function ADD_TimeNodeByDrop(host: FlowDesignHost, type: string, siblings: FlowTimeNode[], insertIndex?: number): void {
    const commit = (node: FlowTimeNode): void => {
        if (insertIndex !== undefined) siblings.splice(insertIndex, 0, node);
        else siblings.push(node);
        host.commitAst();
    };
    switch (type) {
        case 'at':
            new FlowPromptModal(host.app, [{ label: '时间点（如 08:00）', defaultValue: '08:00' }], ([time]) => {
                if (!time) return;
                commit({ type: 'at', time, lines: [], contents: [], children: [] });
            }).open();
            break;
        case 'span':
            new FlowPromptModal(host.app, [
                { label: '时间段名称', defaultValue: '' },
                { label: '开始（如 09:00）', defaultValue: '09:00' },
                { label: '结束（如 12:00）', defaultValue: '12:00' },
            ], ([name, from, to]) => {
                if (!from || !to) return;
                commit({ type: 'span', name: name || undefined, from, to, lines: [], contents: [], children: [] });
            }).open();
            break;
        case 'repeat':
            new FlowPromptModal(host.app, [
                { label: '周期规则名称', defaultValue: '' },
                { label: '周期（如 day/week）', defaultValue: 'day' },
                { label: '时刻（如 18:00）', defaultValue: '18:00' },
            ], ([name, every, time]) => {
                if (!every || !time) return;
                commit({ type: 'repeat', name: name || undefined, every, time, lines: [], contents: [], children: [] });
            }).open();
            break;
        case 'when':
            new FlowPromptModal(host.app, [{ label: '条件（如 工作日）', defaultValue: '' }], ([cond]) => {
                if (!cond) return;
                commit({ type: 'when', when: cond, lines: [], contents: [], children: [] });
            }).open();
            break;
        default:
            return;
    }
}

/** 拖入线路行元素：step / if / not / do */
export function ADD_LineItemByDrop(host: FlowDesignHost, type: string, line: FlowLine): void {
    const commit = (item: FlowLineItem): void => {
        line.items.push(item);
        host.commitAst();
    };
    switch (type) {
        case 'step':
            new FlowPromptModal(host.app, [{ label: '步骤名称', defaultValue: '' }], ([name]) => {
                if (!name) return;
                commit({ type: 'step', name, next: '', nextKind: 'seq' });
            }).open();
            break;
        case 'if':
        case 'not':
            new FlowPromptModal(host.app, [{ label: type === 'not' ? 'NOT 条件' : 'IF 条件', defaultValue: '' }], ([cond]) => {
                if (!cond) return;
                commit({ type: 'if', not: type === 'not', cond, do: undefined });
            }).open();
            break;
        case 'do':
            new FlowPromptModal(host.app, [{ label: 'DO 动作', defaultValue: '' }], ([act]) => {
                if (!act) return;
                commit({ type: 'if', not: false, cond: 'true', do: act });
            }).open();
            break;
        default:
            return;
    }
}

/** 拖入例程：新建线路行到指定数组（弹窗询问名称） */
export function ADD_LineByDrop(host: FlowDesignHost, getTarget: () => FlowLine[]): void {
    new FlowPromptModal(host.app, [{ label: '例程名称', defaultValue: '' }], ([name]) => {
        getTarget().push({ type: 'line', name: name || undefined, items: [] });
        host.commitAst();
    }).open();
}

/** 拖入内容块：lst / task → 归位到 do 输出 */
export function ADD_ContentByDrop(host: FlowDesignHost, type: string, node: FlowTimeNode): void {
    if (type !== 'lst' && type !== 'task') return;
    new FlowPromptModal(host.app, [{ label: `${type.toUpperCase()} 内容文本`, defaultValue: '' }], ([text]) => {
        if (!text) return;
        ADD_ContentToNode(node, { kind: type, text: text.trim() } as FlowContentBlock);
        host.commitAst();
    }).open();
}
