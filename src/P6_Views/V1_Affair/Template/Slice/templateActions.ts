/**
 * Template/Slice/templateActions — 模板模式的数据写操作切片
 *
 * 按 P6_Views/Views.md 的切片契约组织：以「宿主」为第一参数、只 `import type` 宿主契约
 * （见 TemplateHost —— 视图本就是它的实现，委托面板则用 app / pipe / settings 拼一个），
 * 数据面读写一律经 `view.pipe`（不碰 nodeCache / fileManager / operationQueue）。
 *
 * 覆盖模板库的**打开正文**（归档走 design/actions.archiveNode；模板的删除入口已取消）。
 * **新建不在这里**：左栏的新建是行内的，走
 * `design/inlineEdit` 的 commitCreate → `design/actions.createNode` ——
 * 「建一个模板框架」的落盘路径与设计视图、委托面板是同一条，不另写一份。
 * 「应用模板」另在 templateApply，文本区回写在 templateText。
 */

import { TFile } from 'obsidian';
import { GET_FileByPath } from '../../../../P5_Data/MdFile/PathTools/PathParse';
import type { TemplateHost } from './TemplateHost';

/** 打开节点文件编辑（模板单元正文；模板库里的单元没有别的编辑入口） */
export function OPEN_NodeFile(view: TemplateHost, nodeId: string): void {
    const node = view.pipe.GET_Node(nodeId);
    if (!node) return;
    const filePath = GET_FileByPath(node.kind, nodeId, view.settings);
    const file = view.app.vault.getFileByPath(filePath);
    if (file instanceof TFile) {
        void view.app.workspace.getLeaf('tab')?.openFile(file, { state: { mode: 'source' } });
    }
}
