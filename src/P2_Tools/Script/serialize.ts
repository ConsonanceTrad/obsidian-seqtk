/**
 * AST → 脚本文本序列化（逆向转换的基础：解析→序列化往返保持语义）
 */

import type { FlowScript, FlowLine, FlowLineItem, FlowTimeNode, FlowContentBlock } from './parser';

const q = (s?: string): string => (s !== undefined ? `"${s}"` : '');

function serializeLineItems(items: FlowLineItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.type === 'step') {
      const arrow = { seq: '->', branch: '=>', parallel: '||' }[it.nextKind];
      out.push(`step ${it.name}${it.next ? ` ${arrow} ${it.next}` : ''}`);
      continue;
    }
    const cond = it.not ? `if not [${it.cond}]` : `if [${it.cond}]`;
    // do 可能为空字符串（内容块载体），用 !== undefined 判断
    out.push(it.do !== undefined ? `${cond} do [${it.do}]` : cond);
    // do 的输出内容块紧跟其后
    if (it.do !== undefined && it.contents) {
      for (const c of it.contents) {
        out.push(`  ${c.kind} ${c.text}`);
      }
    }
  }
  return out;
}

function serializeLine(line: FlowLine): string {
  const head = `line ${q(line.name)}${line.on ? ` on <${line.on}>` : ''} {`;
  return [head, ...serializeLineItems(line.items).map((l) => `  ${l}`), '}'].join('\n');
}

function serializeTimeNodeBody(node: FlowTimeNode): string[] {
  const out: string[] = [];
  for (const line of node.lines) {
    out.push(serializeLine(line));
  }
  for (const c of node.contents) {
    out.push(`  ${c.kind} ${c.text}`);
  }
  for (const child of node.children) {
    out.push(serializeTimeNode(child));
  }
  return out;
}

function serializeTimeNode(node: FlowTimeNode): string {
  let head = '';
  switch (node.type) {
    case 'at':
      head = `at ${q(node.time)} {`;
      break;
    case 'span':
      head = `span ${q(node.name)} from ${q(node.from)} to ${q(node.to)} {`;
      break;
    case 'repeat':
      head = `repeat ${q(node.name)} every ${q(node.every)} at ${q(node.time)} {`;
      break;
    case 'when':
      head = `when [${node.when}] {`;
      break;
  }
  const body = serializeTimeNodeBody(node).map((l) => `  ${l}`);
  return [head, ...body, '}'].join('\n');
}

/** 序列化完整流程脚本为文本 */
export function serializeFlowScript(script: FlowScript): string {
  const out: string[] = [];
  for (const line of script.lines) {
    out.push(serializeLine(line));
  }
  for (const node of script.timeNodes) {
    out.push(serializeTimeNode(node));
  }
  return out.join('\n\n');
}

/** 序列化内容块行（供编辑器增删内容块使用） */
export function serializeContentBlock(c: FlowContentBlock): string {
  return `${c.kind} ${c.text}`;
}
