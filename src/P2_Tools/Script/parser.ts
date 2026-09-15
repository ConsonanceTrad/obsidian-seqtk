/**
 * flow 脚本语法解析器（流程脚本域，LAD 渲染投影的事实源）
 *
 * 语法基线（旧版脚本设计案 6.3.1 / 5.1 流程域草案）：
 * - line "名称" on <流程节点> { step ... }   常通线路行（最上方区，始终激活）
 * - at "08:00" { ... }                       单时间点
 * - span "名称" from "09:00" to "12:00" {...} 时间段（区段使能）
 * - repeat "名称" every "day" at "18:00" {...} 周期规则
 * - when [条件] { ... }                      条件使能（母线通断）
 * - step A -> B 顺序 / => 分支 / || 并行       流向关系
 * - if [条件] / if not [条件] / do [动作]      条件元件与输出线圈（LAD 元件级）
 * - 内容块：`lst 文本` / `task 文本` 等前缀行
 *
 * 解析为行级（换行有意义），块用 `{ ... }` 界定（支持嵌套）。
 */

// ============================================================
// AST 类型
// ============================================================

/** 解析错误（行号 + 消息） */
export interface FlowParseError {
  line: number;
  message: string;
}

/** 内容块（lst/task 等前缀行） */
export interface FlowContentBlock {
  kind: string; // lst / task / ...
  text: string;
}

/** 线路行内元素：步骤或条件元件+输出 */
export type FlowLineItem =
  | { type: 'step'; name: string; next: string; nextKind: 'seq' | 'branch' | 'parallel' }
  | { type: 'if'; not: boolean; cond: string; do?: string; contents?: FlowContentBlock[] };

/** 常通线路行（最上方区） */
export interface FlowLine {
  type: 'line';
  name?: string;
  on?: string;
  items: FlowLineItem[];
}

/** 时间轴主体节点（at / span / repeat / when） */
export interface FlowTimeNode {
  type: 'at' | 'span' | 'repeat' | 'when';
  name?: string;
  time?: string; // at "08:00" 或 repeat at "18:00"
  from?: string;
  to?: string;
  every?: string; // repeat every "day"
  when?: string; // when [条件]
  lines: FlowLine[]; // 嵌套线路行
  contents: FlowContentBlock[]; // 直接内容块
  children: FlowTimeNode[]; // 嵌套时间节点（when/span 内可再切分）
}

/** 完整流程脚本 */
export interface FlowScript {
  lines: FlowLine[]; // 常通线路区
  timeNodes: FlowTimeNode[]; // 时间轴主体
  errors: FlowParseError[];
}

// ============================================================
// 词法 / 解析工具
// ============================================================

/** 提取引号内文本（"..." 或 '...'），返回 {value, rest} */
function readQuoted(input: string): { value?: string; rest: string } {
  const m = input.match(/^([""'])([\s\S]*?)\1/);
  if (!m) return { rest: input };
  return { value: m[2], rest: input.slice(m[0].length).trim() };
}

/** 提取方括号内文本 [条件]，返回 {value, rest} */
function readBracket(input: string): { value?: string; rest: string } {
  const m = input.match(/^\[([^\]]*)\]/);
  if (!m) return { rest: input };
  return { value: m[1], rest: input.slice(m[0].length).trim() };
}

/** 行内剩余部分（去掉前缀后） */
function restOf(input: string, prefix: string): string {
  return input.slice(prefix.length).trim();
}

// ============================================================
// 解析器
// ============================================================

/** 解析流程脚本文本为 AST（不抛异常，错误收集进 errors） */
export function parseFlowScript(source: string): FlowScript {
  const script: FlowScript = { lines: [], timeNodes: [], errors: [] };
  const rawLines = source.split('\n');
  let idx = 0;

  const err = (lineNo: number, message: string): void => {
    script.errors.push({ line: lineNo, message });
  };

  /** 解析一行内容块：`lst 文本` / `task 文本` */
  const parseContentBlock = (line: string): FlowContentBlock | null => {
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9]*)\s+(.+)$/);
    if (m) return { kind: m[1].toLowerCase(), text: m[2].trim() };
    return null;
  };

  /** 解析线路行元素（step / if / if not / do） */
  const parseLineItem = (line: string, lineNo: number): FlowLineItem | null => {
    const stepM = line.match(/^step\s+([^\s]+)\s*(->|=>|\|\|)?\s*([^\s]*)/);
    if (stepM) {
      const kind = stepM[2]
        ? { '->': 'seq', '=>': 'branch', '||': 'parallel' }[stepM[2]] as 'seq' | 'branch' | 'parallel'
        : 'seq';
      return { type: 'step', name: stepM[1], next: stepM[3] ?? '', nextKind: kind };
    }
    const parseIf = (not: boolean): FlowLineItem | null => {
      const b = readBracket(restOf(line, not ? 'if not' : 'if'));
      let doAct: string | undefined;
      const rest = b.rest;
      const doM = rest.match(/^do\s+\[([^\]]*)\]/);
      if (doM) {
        doAct = doM[1];
      }
      if (!b.value) { err(lineNo, not ? 'if not 缺少条件' : 'if 缺少条件'); return null; }
      return { type: 'if', not, cond: b.value, do: doAct };
    };
    if (line.startsWith('if not')) return parseIf(true);
    if (line.startsWith('if')) return parseIf(false);
    const doM2 = line.match(/^do\s+\[([^\]]*)\]/);
    if (doM2) {
      return { type: 'if', not: false, cond: 'true', do: doM2[1] };
    }
    return null;
  };

  /** 解析 `{ ... }` 块内各行（支持嵌套大括号，遇到配对的 `}` 返回） */
  const parseBlock = (): string[] => {
    const body: string[] = [];
    let depth = 0;
    while (idx < rawLines.length) {
      const ln = rawLines[idx].trim();
      if (ln === '') { idx++; continue; }
      if (ln.startsWith('//')) { idx++; continue; }
      if (ln === '}') {
        if (depth === 0) { idx++; break; }
        depth--;
        body.push(ln);
        idx++;
        continue;
      }
      if (ln.includes('{')) depth++;
      body.push(ln);
      idx++;
    }
    return body;
  };

  /** 解析线路行元素集合（每行一个 step/if/do；内容块行紧跟 do 之后，归位为 do 的输出内容） */
  const parseLineItems = (body: string[]): FlowLineItem[] => {
    const items: FlowLineItem[] = [];
    for (const ln of body) {
      const item = parseLineItem(ln, 0);
      if (item) {
        items.push(item);
        continue;
      }
      // 内容块行（lst/task 等）：紧跟 do 之后 → 附加到上一个 do 元素
      const cb = parseContentBlock(ln);
      if (cb && items.length > 0) {
        const last = items[items.length - 1];
        if (last.type === 'if' && last.do !== undefined) {
          last.contents = [...(last.contents ?? []), cb];
        }
      }
    }
    return items;
  };

  /** 确保线路行存在一个 do 元素，返回它（内容块的归位载体） */
  const ensureDoItem = (line: FlowLine): FlowLineItem => {
    for (let k = line.items.length - 1; k >= 0; k--) {
      const it = line.items[k];
      if (it.type === 'if' && it.do !== undefined) return it;
    }
    const item: FlowLineItem = { type: 'if', not: false, cond: 'true', do: '', contents: [] };
    line.items.push(item);
    return item;
  };

  /** 解析线路行头：line "名称" on <节点> { */
  const parseLineHead = (head: string): { name?: string; on?: string } => {
    const name = readQuoted(head);
    const rest = name.rest;
    let on: string | undefined;
    if (rest.startsWith('on ')) {
      on = rest.slice(3).trim().replace(/[<>{}\s]/g, '') || undefined;
    }
    return { name: name.value, on };
  };

  /** 解析时间节点头：at / span / repeat / when，返回骨架或 null */
  const matchTimeNodeHead = (line: string): Omit<FlowTimeNode, 'lines' | 'contents' | 'children'> | null => {
    if (line.startsWith('when ')) {
      const b = readBracket(restOf(line, 'when'));
      return b.value !== undefined ? { type: 'when', when: b.value } : null;
    }
    const atM = line.match(/^at\s+([^\s{]+)/);
    if (atM) {
      const t = readQuoted(atM[1]);
      return { type: 'at', time: t.value ?? atM[1].replace(/"/g, '') };
    }
    if (line.startsWith('span ')) {
      const name = readQuoted(restOf(line, 'span'));
      const fM = name.rest.match(/^from\s+([^\s]+)/);
      const tM = name.rest.match(/to\s+([^\s]+)/);
      return {
        type: 'span',
        name: name.value,
        from: fM ? fM[1].replace(/"/g, '') : undefined,
        to: tM ? tM[1].replace(/"/g, '') : undefined,
      };
    }
    if (line.startsWith('repeat ')) {
      const name = readQuoted(restOf(line, 'repeat'));
      const eM = name.rest.match(/every\s+([^\s]+)/);
      const aM = name.rest.match(/at\s+([^\s]+)/);
      return {
        type: 'repeat',
        name: name.value,
        every: eM ? eM[1].replace(/"/g, '') : undefined,
        time: aM ? aM[1].replace(/"/g, '') : undefined,
      };
    }
    return null;
  };

  /** 从 body 数组 offset 起收集嵌套块（到配对 `}` 止，不含 `}`） */
  const collectNested = (body: string[], start: number): string[] => {
    const out: string[] = [];
    let depth = 0;
    let i = start;
    while (i < body.length) {
      const ln = body[i].trim();
      if (ln === '}') {
        if (depth === 0) return out;
        depth--;
        out.push(ln);
      } else {
        if (ln.includes('{')) depth++;
        out.push(ln);
      }
      i++;
    }
    return out;
  };

  /** 解析时间节点内容：嵌套 line 块 / 内容块 / 嵌套时间节点 */
  const parseTimeNodeBody = (
    body: string[],
  ): { lines: FlowLine[]; contents: FlowContentBlock[]; children: FlowTimeNode[] } => {
    const lines: FlowLine[] = [];
    const contents: FlowContentBlock[] = [];
    const children: FlowTimeNode[] = [];
    let i = 0;
    while (i < body.length) {
      const ln = body[i].trim();
      if (ln.startsWith('line ')) {
        const head = parseLineHead(ln.slice(4).trim());
        // 收集块内元素直到 }（含内容块归位 do）
        const innerLines: string[] = [];
        let j = i + 1;
        while (j < body.length && body[j].trim() !== '}') {
          innerLines.push(body[j]);
          j++;
        }
        lines.push({ type: 'line', name: head.name, on: head.on, items: parseLineItems(innerLines) });
        i = j + 1;
        continue;
      }
      const nestedHead = matchTimeNodeHead(ln);
      if (nestedHead) {
        const inner = collectNested(body, i + 1);
        const parsed = parseTimeNodeBody(inner);
        children.push({ ...nestedHead, lines: parsed.lines, contents: parsed.contents, children: parsed.children });
        i += 2 + inner.length; // 头行 + 嵌套行 + }
        continue;
      }
      const cb = parseContentBlock(ln);
      if (cb) {
        // 内容块不直接挂时间节点，归位为线路行 do 的输出内容；无线路行则自动创建
        if (lines.length > 0) {
          const target = ensureDoItem(lines[0]);
          if (target.type === 'if') {
            target.contents = [...(target.contents ?? []), cb];
          }
        } else {
          lines.push({ type: 'line', items: [{ type: 'if', not: false, cond: 'true', do: '', contents: [cb] }] });
        }
      }
      i++;
    }
    return { lines, contents, children };
  };

  while (idx < rawLines.length) {
    const raw = rawLines[idx];
    const line = raw.trim();
    const lineNo = idx + 1;
    idx++;
    if (line === '' || line.startsWith('//')) continue;

    // 顶层常通线路行：line "名称" on <节点> { ... }
    if (line.startsWith('line ')) {
      const head = parseLineHead(line.slice(4).trim());
      const body = parseBlock();
      script.lines.push({ type: 'line', name: head.name, on: head.on, items: parseLineItems(body) });
      continue;
    }

    // 时间轴主体：at / span / repeat / when
    const head = matchTimeNodeHead(line);
    if (head) {
      const body = parseBlock();
      const inner = parseTimeNodeBody(body);
      script.timeNodes.push({ ...head, lines: inner.lines, contents: inner.contents, children: inner.children });
      continue;
    }

    err(lineNo, `无法识别的语句：${line}`);
  }

  return script;
}
