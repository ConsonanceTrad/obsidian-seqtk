/**
 * LAD 母线渲染器（自绘 DOM，流程脚本的渲染投影）
 *
 * 渲染语义（旧版脚本设计案 6.3）：
 * - 纵向 = 时间次序（母线 = 时间轴，默认全接通）
 * - 最上方区域 = 常通线路行（line，始终激活）
 * - 时间轴主体 = at / span / repeat / when（含嵌套）
 * - 横向 = 流程次序（线路行内步骤从左到右，显式箭头）
 * - 条件元件渲染为带边框文本块（阅读直觉优先）：
 *   IF（常开，真则通过）↔ if [条件]；NOT（常闭，假则通过）↔ if not [条件]；
 *   DO（输出动作）↔ do [动作]
 */

import type { FlowScript, FlowLine, FlowLineItem, FlowTimeNode } from '../../core/flow/parser';

const el = (tag: string, cls: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** 时间节点标签（阅读友好） */
function timeNodeLabel(node: FlowTimeNode): { icon: string; text: string; name?: string } {
  switch (node.type) {
    case 'at':
      return { icon: '●', text: node.time ?? '' };
    case 'span':
      return { icon: '●', text: `${node.from ?? ''} → ${node.to ?? ''}`, name: node.name };
    case 'repeat':
      return { icon: '◇', text: `每${node.every ?? ''} ${node.time ?? ''}`, name: node.name };
    case 'when':
      return { icon: '◈', text: `当 [${node.when ?? ''}]` };
  }
}

/** 渲染线路行内元素（step / IF / NOT / DO + 输出内容块） */
function renderLineItem(item: FlowLineItem): HTMLElement {
  if (item.type === 'step') {
    const wrap = el('div', 'seqtk-lad-item');
    wrap.appendChild(el('div', 'seqtk-lad-step', item.name));
    if (item.next) {
      const arrow = { seq: '→', branch: '⇒', parallel: '‖' }[item.nextKind];
      wrap.appendChild(el('div', `seqtk-lad-arrow seqtk-lad-arrow-${item.nextKind}`, arrow));
      wrap.appendChild(el('div', 'seqtk-lad-step seqtk-lad-step-next', item.next));
    }
    return wrap;
  }
  // 条件元件 / 输出线圈：带边框文本块
  const wrap = el('div', 'seqtk-lad-item');
  if (item.not) {
    wrap.appendChild(el('div', 'seqtk-lad-elem seqtk-lad-not', `NOT ${item.cond}`));
  } else if (item.cond === 'true' && item.do) {
    wrap.appendChild(el('div', 'seqtk-lad-elem seqtk-lad-do', `DO ${item.do}`));
  } else {
    wrap.appendChild(el('div', 'seqtk-lad-elem seqtk-lad-if', `IF ${item.cond}`));
    if (item.do) wrap.appendChild(el('div', 'seqtk-lad-elem seqtk-lad-do', `DO ${item.do}`));
  }
  // do 的输出内容块紧跟其后
  if (item.do !== undefined && item.contents && item.contents.length > 0) {
    for (const c of item.contents) {
      renderContent(wrap, c.kind, c.text);
    }
  }
  return wrap;
}

/** 渲染一条线路行（横向步骤序列） */
function renderLine(parent: HTMLElement, line: FlowLine): void {
  const row = el('div', 'seqtk-lad-line');
  const head = el('div', 'seqtk-lad-line-head');
  head.textContent = `例程：${line.name ?? '(未命名)'}`;
  if (line.on) head.appendChild(el('span', 'seqtk-lad-on', ` on <${line.on}>`));
  row.appendChild(head);
  if (line.items.length === 0) {
    row.appendChild(el('div', 'seqtk-lad-empty', '（空）'));
  } else {
    const items = el('div', 'seqtk-lad-items');
    for (const it of line.items) items.appendChild(renderLineItem(it));
    row.appendChild(items);
  }
  parent.appendChild(row);
}

/** 渲染内容块（lst/task 等） */
function renderContent(parent: HTMLElement, kind: string, text: string): void {
  const block = el('div', 'seqtk-lad-content');
  block.appendChild(el('span', 'seqtk-lad-content-kind', kind));
  block.appendChild(document.createTextNode(` ${text}`));
  parent.appendChild(block);
}

/** 渲染时间节点（含嵌套 line / 内容块 / 子时间节点） */
function renderTimeNode(parent: HTMLElement, node: FlowTimeNode): void {
  const block = el('div', `seqtk-lad-timenode seqtk-lad-tn-${node.type}`);
  const head = el('div', 'seqtk-lad-tn-head');
  const label = timeNodeLabel(node);
  head.appendChild(el('span', 'seqtk-lad-tn-icon', label.icon));
  head.appendChild(el('span', 'seqtk-lad-tn-time', label.text));
  if (label.name) head.appendChild(el('span', 'seqtk-lad-tn-name', label.name));
  block.appendChild(head);

  const body = el('div', 'seqtk-lad-tn-body');
  for (const line of node.lines) renderLine(body, line);
  for (const c of node.contents) renderContent(body, c.kind, c.text);
  for (const child of node.children) renderTimeNode(body, child);
  if (node.lines.length === 0 && node.contents.length === 0 && node.children.length === 0) {
    body.appendChild(el('div', 'seqtk-lad-empty', '（空）'));
  }
  block.appendChild(body);
  parent.appendChild(block);
}

/** 渲染完整流程脚本为 LAD 母线图 */
export function renderLad(container: HTMLElement, script: FlowScript): void {
  container.empty();

  // 常通线路区（最上方，始终激活）
  if (script.lines.length > 0) {
    const top = el('div', 'seqtk-lad-top');
    top.appendChild(el('div', 'seqtk-lad-section-title', '例程（始终激活）'));
    for (const line of script.lines) renderLine(top, line);
    container.appendChild(top);
  }

  // 时间轴主体（纵向时间次序）
  if (script.timeNodes.length > 0 || script.lines.length === 0) {
    const axis = el('div', 'seqtk-lad-axis');
    if (script.timeNodes.length > 0) {
      axis.appendChild(el('div', 'seqtk-lad-section-title', '时间轴'));
    }
    for (const node of script.timeNodes) renderTimeNode(axis, node);
    if (script.timeNodes.length === 0 && script.lines.length === 0) {
      axis.appendChild(el('div', 'seqtk-lad-empty', '脚本内容为空'));
    }
    container.appendChild(axis);
  }
}
