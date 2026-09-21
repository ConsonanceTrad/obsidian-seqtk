/**
 * flowDesign/scriptMode — 右栏「脚本程序」态
 *
 * 脚本是事实源：这里编辑的就是节点的正文文本（flow 语法），LAD 态只是它的投影。
 * 所以本态只做两件事：把当前文本铺进 textarea、随手解析一遍并把错误标出来 ——
 * 不写盘（保存由视图的「保存」按钮统一负责，与 LAD 态共用一个出口）。
 */

import { parseFlowScript } from '../../../../P2_Tools/Script/parser';
import type { FlowDesignHost } from './host';

/** 渲染脚本态：textarea + 解析错误红标 */
export function RENDER_ScriptMode(host: FlowDesignHost, el: HTMLElement): void {
    const wrap = el.createDiv('seqtk-flow-script');
    const textArea = wrap.createEl('textarea', {
        cls: 'seqtk-flow-textarea',
        attr: { spellcheck: 'false' },
    });
    textArea.value = host.currentText;
    const errorEl = wrap.createDiv('seqtk-flow-errors');

    const showParseErrors = (): void => {
        errorEl.empty();
        const ast = parseFlowScript(host.currentText);
        if (ast.errors.length === 0) {
            errorEl.createEl('div', { cls: 'seqtk-flow-ok', text: '语法正确' });
        } else {
            for (const err of ast.errors) {
                errorEl.createEl('div', {
                    cls: 'seqtk-flow-err',
                    text: `第 ${err.line} 行：${err.message}`,
                });
            }
        }
    };
    textArea.addEventListener('input', () => {
        host.currentText = textArea.value;
        showParseErrors();
    });
    showParseErrors();
}
