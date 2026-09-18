/**
 * core/template.ts — 模板子树克隆核心 + 占位符语法
 *
 * 供「事务设计（DesignView）右键：创建/使用模板」与「模板模式（TemplateView）」共用。
 *
 * ── 模板语义 ──
 * - 模板单元 = 模板框架（framework-template）的 follows 直属子树：
 *   顶层节点即模板单元，其下（含全部后代）为该模板要重建的结构。
 *   模板内容即普通节点（kind/desc/body/state/estate/nature/at），MD 文件仍为事实源，
 *   模板框架与普通框架同构，无需专用序列化格式。
 * - 「存为模板」时把子树中出现的源根名自动参数化为 {{frame}}（无出现则原样保留）。
 *
 * ── 占位符语法（desc / body 通用；收集与替换都走本文件） ──
 * 关键字一律**短英文**，避免与正文里的中文撞车：
 * ```
 * {{frame}}            插入处父节点的名称（旧的中文写法已不再识别）
 * {{p.字段}}           插入处父节点的字段值（白名单 TEMPLATE_PARENT_FIELDS）
 * {{变量}}             插入时由使用方输入（变量名自起，名字里别带 : 或 |）
 * {{变量名:提示}}        输入时显示提示语
 * {{变量名:提示|默认值}} 输入时显示提示语并预填默认值
 * ```
 * 同名变量只询问一次，取值应用到它出现的每一处；未取到值且无默认值时替换为空串
 * （「必填」由插入前的界面层把关，见 P7_Render/Structure/S2_Modal/TemplateModals.ts）。
 *
 * ── 插入时行为 ──
 * - 冲突处理（TemplateConflictPolicy）：追加（默认，直接新建）/ 覆写同名同类型 / 跳过
 * - 字段保留（TemplateFieldPolicy）：copy（默认，复制表意字段）/ reset（回默认）/
 *   copyExpected（copy + 计划调度字段）
 * - 插入位置（TemplateInsertPolicy.position）：追加到末尾（默认）或插到父的指定同级位置
 *
 * 以上行为的默认值 = 旧版行为（仅替换 {{frame}}、原样复制语义字段、全部追加新建），
 * 因此旧模板不变。新增行为一律在此文件扩展，保持 cloneSubtree 对视图的单一入口。
 */

import type {DataPipe} from "../../P5_Data/CoPipe/DataPipe";
import type {SeqtkNode} from "../../P4_Nodes/Node";
import {FieldKeys} from "../../P4_Nodes/NodeField/FieldKeys";
import {
    EVENT_NATURE_LABELS,
    NODE_ESTATE_LABELS,
    NODE_STATE_LABELS,
} from "../../P4_Nodes/NodeField/StateKeys";
import type {
    EventNature,
    SeqtkEstate,
    SeqtkState,
} from "../../P4_Nodes/NodeField/StateKeys";

/** 目标框架名占位符：使用模板时替换为插入处父节点名（短英文；旧的中文写法已不再识别） */
export const TEMPLATE_FRAMEWORK_NAME_TOKEN = '{{frame}}';

/** 取「插入处父节点字段」的占位前缀：`{{p.desc}}` */
export const TEMPLATE_PARENT_PREFIX = 'p.';

/**
 * 可作为 `{{p.<字段>}}` 的白名单
 *
 * 取 FieldKeys 里的**值型**字段：结构字段（follows / parent / links）不属于「属性」，
 * 插进正文既无意义又容易误导，故不列入。白名单化而非「任意字段」是为了让写错的字段名
 * 在编辑时就被指出来（见 COLLECT_TemplateSlots 的 issues）。
 */
export const TEMPLATE_PARENT_FIELDS: string[] = [
    FieldKeys.desc,
    FieldKeys.state,
    FieldKeys.estate,
    FieldKeys.nature,
    FieldKeys.at,
    FieldKeys.tags,
    FieldKeys.indicators,
    FieldKeys.pmarks,
    FieldKeys.clear,
    FieldKeys.from,
    FieldKeys.create,
    FieldKeys.modify,
    FieldKeys.progress,
];

// ============================================================
// 占位符：收集（预览 / 校验 / 取值弹窗共用）
// ============================================================

/** 变量占位定义（同名变量只在首次出现处记定义，count 记出现次数） */
export interface TemplateVariableSlot {
    name: string;
    /** 提示语（`{{变量名:提示|默认值}}` 中 `:` 与 `|` 之间的部分；可省） */
    prompt?: string;
    /** 默认值（`{{变量名:提示|默认值}}` 中 `|` 之后的部分；可省） */
    default?: string;
    /** 在文本中出现的次数 */
    count: number;
}

/** 占位符语法问题（带行号与字符偏移，供编辑区定位） */
export interface TemplateSlotIssue {
    /** 1 起行号 */
    line: number;
    /** 0 起字符偏移 */
    offset: number;
    message: string;
}

/** 一段文本的占位符收集结果 */
export interface TemplateSlots {
    /** 需要插入时询问的变量（按首次出现顺序） */
    variables: TemplateVariableSlot[];
    /** 引用的插入处父字段（按首次出现顺序） */
    parentFields: string[];
    /** `{{frame}}` 出现次数 */
    frameworkNameCount: number;
    /** 语法问题（非空时不应插入） */
    issues: TemplateSlotIssue[];
}

/** 占位符整体语法：`{{ ... }}`（内容不含花括号，嵌套写法交给未闭合检测报错） */
const SLOT_RE_SOURCE = '\\{\\{([^{}]*)\\}\\}';

/**
 * 收集文本里的全部占位符
 *
 * 只做语法与去重，不取值：取值的时机（插入时询问）在界面层，本函数因此可被预览、
 * 校验、取值弹窗三处共用，三处口径不会漂移。
 */
export function COLLECT_TemplateSlots(text: string): TemplateSlots {
    const variables: TemplateVariableSlot[] = [];
    const parentFields: string[] = [];
    const issues: TemplateSlotIssue[] = [];
    let frameworkNameCount = 0;

    /** 字符偏移 → 1 起行号（编辑区按行提示） */
    const lineOf = (offset: number): number => text.slice(0, offset).split('\n').length;

    const addSlot = (body: string, offset: number): void => {
        const content = body.trim();
        if (!content) {
            issues.push({
                line: lineOf(offset), offset,
                message: `占位符内容为空：应写 ${TEMPLATE_FRAMEWORK_NAME_TOKEN}、{{${TEMPLATE_PARENT_PREFIX}字段}} 或 {{变量名}}`,
            });
            return;
        }
        // 关键字由 token 派生（`{{frame}}` → `frame`），免得两处各写一份
        if (content === TEMPLATE_FRAMEWORK_NAME_TOKEN.slice(2, -2)) {
            frameworkNameCount++;
            return;
        }
        if (content.startsWith(TEMPLATE_PARENT_PREFIX)) {
            const field = content.slice(TEMPLATE_PARENT_PREFIX.length).trim();
            if (!TEMPLATE_PARENT_FIELDS.includes(field)) {
                issues.push({
                    line: lineOf(offset), offset,
                    message: `未知的父字段「${TEMPLATE_PARENT_PREFIX}${field}」；可用：${TEMPLATE_PARENT_FIELDS.join('、')}`,
                });
                return;
            }
            if (!parentFields.includes(field)) parentFields.push(field);
            return;
        }

        const colon = content.indexOf(':');
        const name = (colon === -1 ? content : content.slice(0, colon)).trim();
        if (!name) {
            issues.push({ line: lineOf(offset), offset, message: '变量名为空：{{:提示}} 这样写取不到值' });
            return;
        }
        if (/\s/.test(name)) {
            issues.push({ line: lineOf(offset), offset, message: `变量名「${name}」含空白：变量名请用一个词` });
            return;
        }

        // 提示与默认值：`变量:提示|默认值`（两者都可省；默认值允许为空串）
        let prompt: string | undefined;
        let preset: string | undefined;
        if (colon !== -1) {
            const spec = content.slice(colon + 1);
            const bar = spec.indexOf('|');
            if (bar === -1) {
                prompt = spec.trim() || undefined;
            } else {
                prompt = spec.slice(0, bar).trim() || undefined;
                preset = spec.slice(bar + 1);
            }
        }

        const existing = variables.find((v) => v.name === name);
        if (!existing) {
            variables.push({ name, prompt, default: preset, count: 1 });
            return;
        }
        existing.count++;
        // 裸写（只出现名字、不带定义）只计次数：同一变量在正文多处出现、
        // 只在其中一处写提示，是正常写法而非冲突
        if (prompt === undefined && preset === undefined) return;
        // 首次是裸写 → 本次定义把它补齐
        if (existing.prompt === undefined && existing.default === undefined) {
            existing.prompt = prompt;
            existing.default = preset;
            return;
        }
        // 两处都给了定义：不一致才算问题
        if ((existing.prompt ?? '') !== (prompt ?? '') || (existing.default ?? '') !== (preset ?? '')) {
            issues.push({
                line: lineOf(offset), offset,
                message: `同名变量「${name}」的提示/默认值与首次定义不一致`,
            });
        }
    };

    const re = new RegExp(SLOT_RE_SOURCE, 'g');
    const ranges: Array<[number, number]> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        ranges.push([m.index, m.index + m[0].length]);
        addSlot(m[1], m.index);
    }

    // 未闭合检测：把已匹配的区间抠掉后，残留的 {{ / }} 都是语法错（如 `{{变量}` 或孤立的 `}}`）
    const scanStray = (chunk: string, base: number): void => {
        const strayRe = /\{\{|\}\}/g;
        let sm: RegExpExecArray | null;
        while ((sm = strayRe.exec(chunk)) !== null) {
            const offset = base + sm.index;
            issues.push({
                line: lineOf(offset), offset,
                message: sm[0] === '{{' ? '未闭合的 {{：缺少对应的 }}' : '多出的 }}：前面没有 {{',
            });
        }
    };
    let cursor = 0;
    for (const [start, end] of ranges) {
        scanStray(text.slice(cursor, start), cursor);
        cursor = end;
    }
    scanStray(text.slice(cursor), cursor);

    return { variables, parentFields, frameworkNameCount, issues };
}

// ============================================================
// 占位符：替换（插入时按取值渲染）
// ============================================================

/** 替换占位符时的取值来源 */
export interface ResolveTemplateOptions {
    /** 插入处父节点名称（`{{frame}}` 与 `{{p.desc}}` 都取它） */
    parentName: string;
    /** 插入处父节点；省略时 `{{p.<字段>}}` 替换为空串 */
    parent?: SeqtkNode | null;
    /** 变量取值（键 = 变量名）；未给且无默认值时替换为空串 */
    values?: Record<string, string>;
}

/** 把复杂字段值转成可读文本（数组用「、」连接，对象退化为紧凑 JSON） */
const STRINGIFY_FieldValue = (value: unknown): string => {
    if (Array.isArray(value)) return value.map((v) => STRINGIFY_FieldValue(v)).join('、');
    if (typeof value === 'object' && value !== null) {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
};

/**
 * 取插入处父节点的字段值并转成可读文本
 *
 * 状态类字段（state / estate / nature）取中文名：模板正文里写「已完成」比写 `done`
 * 更贴近它的读法；时间与来源类字段原样输出，保持可再被引用 / 解析。
 */
export function FORMAT_ParentField(parent: SeqtkNode | null, field: string): string {
    if (!parent) return '';
    const value = (parent as unknown as Record<string, unknown>)[field];
    if (value === undefined || value === null) return '';
    switch (field) {
        case FieldKeys.state:
            return NODE_STATE_LABELS[value as SeqtkState] ?? String(value);
        case FieldKeys.estate:
            return NODE_ESTATE_LABELS[value as SeqtkEstate] ?? String(value);
        case FieldKeys.nature:
            return EVENT_NATURE_LABELS[value as EventNature] ?? String(value);
        default:
            return STRINGIFY_FieldValue(value);
    }
}

/**
 * 按取值替换文本里的全部占位符
 *
 * 未知父字段原样保留（语法错由 COLLECT_TemplateSlots 报出，这里不静默吞掉用户写的字）；
 * 变量未取到值但有默认值 → 用默认值，否则空串 —— 于是插入结果里不会残留 `{{...}}`。
 */
export function RESOLVE_TemplateText(text: string, opts: ResolveTemplateOptions): string {
    const values = opts.values ?? {};
    const re = new RegExp(SLOT_RE_SOURCE, 'g');
    return text.replace(re, (raw, body: string) => {
        const content = body.trim();
        if (!content) return '';
        if (content === TEMPLATE_FRAMEWORK_NAME_TOKEN.slice(2, -2)) return opts.parentName;
        if (content.startsWith(TEMPLATE_PARENT_PREFIX)) {
            const field = content.slice(TEMPLATE_PARENT_PREFIX.length).trim();
            if (!TEMPLATE_PARENT_FIELDS.includes(field)) return raw;
            return FORMAT_ParentField(opts.parent ?? null, field);
        }
        const colon = content.indexOf(':');
        const name = (colon === -1 ? content : content.slice(0, colon)).trim();
        const given = values[name];
        if (given !== undefined) return given;
        if (colon !== -1) {
            const spec = content.slice(colon + 1);
            const bar = spec.indexOf('|');
            if (bar !== -1) return spec.slice(bar + 1);
        }
        return '';
    });
}

// ============================================================
// 子树克隆（含插入时行为）
// ============================================================

/** 插入时的冲突处理 */
export type TemplateConflictPolicy = 'append' | 'overwrite' | 'skip';

/** 插入时的字段保留策略 */
export type TemplateFieldPolicy = 'copy' | 'reset' | 'copyExpected';

/** 插入时行为（默认值 = 旧版行为） */
export interface TemplateInsertPolicy {
    /** 同名同类型子节点已存在时：追加（默认）/ 覆写 / 跳过 */
    conflict?: TemplateConflictPolicy;
    /** 语义字段保留：copy（默认）/ reset / copyExpected */
    fields?: TemplateFieldPolicy;
    /** 顶层插入位置（父 follows 中的索引）；省略 = 追加到末尾。仅对顶层生效，后代始终追加 */
    position?: number;
}

/** 插入时行为的默认值（旧模板的既有行为） */
export const DEFAULT_TEMPLATE_POLICY: Required<Omit<TemplateInsertPolicy, 'position'>> = {
    conflict: 'append',
    fields: 'copy',
};

/** cloneSubtree 参数 */
export interface CloneSubtreeOptions {
  /** 源节点 nodeId（其子树将整体克隆） */
  sourceId: string;
  /** 目标父节点 nodeId；null = 无父（克隆为顶层节点） */
  parentId: string | null;
  /** 数据面唯一入口（读写一律经它；本模块不碰 nodeCache / fileManager / operationQueue） */
  pipe: DataPipe;
  /** 文本解析：应用于每个克隆节点的 desc 与 body（默认原样保留） */
  resolveText?: (text: string) => string;
  /** 插入时行为（冲突处理 / 字段保留 / 插入位置），省略即旧版行为 */
  policy?: TemplateInsertPolicy;
}

/**
 * 将源节点的整棵子树递归克隆到 parentId 下，并维护双向从属关系
 * （新节点 frontmatter parent 指向父、父节点 follows 追加新节点）。
 *
 * 克隆字段：
 *   kind / desc（经 resolveText）/ body（经 resolveText）/ open: true / parent（由入参决定）/
 *   create、modify（取当前时间）；
 *   表意字段随 `policy.fields`：
 *   - copy（默认）：state / estate / nature / at
 *   - reset：以上一概不带（新节点回到各自默认值）
 *   - copyExpected：copy + expectedTime / expectedRepeat / expectedSpan
 *
 * 冲突处理（`policy.conflict`，仅在目标父已有同 type 同名的直接子节点时生效）：
 *   - append（默认）：照常新建
 *   - overwrite：更新已有节点的名称 / 表意字段 / 正文，后代挂到已有节点下（保住原 nodeId 与引用）
 *   - skip：完全不碰已有节点，后代同样挂到它下面
 *
 * @returns 顶层节点 nodeId（冲突命中「覆写 / 跳过」时是命中的那个已有节点）；源节点不存在时返回 null
 */
export async function cloneSubtree(opts: CloneSubtreeOptions): Promise<string | null> {
  const { sourceId, parentId, pipe } = opts;
  const resolveText = opts.resolveText ?? ((t: string) => t);
  const policy = opts.policy ?? {};
  const conflict: TemplateConflictPolicy = policy.conflict ?? DEFAULT_TEMPLATE_POLICY.conflict;
  const fieldPolicy: TemplateFieldPolicy = policy.fields ?? DEFAULT_TEMPLATE_POLICY.fields;
  const now = (): string => new Date().toISOString();

  /** 按字段保留策略挑出要一并复制的表意字段 */
  const semanticFields = (node: SeqtkNode): Record<string, unknown> => {
    if (fieldPolicy === 'reset') return {};
    const n = node as unknown as {
      nature?: string;
      at?: string;
      expectedTime?: string;
      expectedRepeat?: string;
      expectedSpan?: unknown;
    };
    const out: Record<string, unknown> = {};
    if (node.state !== undefined) out[FieldKeys.state] = node.state;
    if (node.estate !== undefined) out[FieldKeys.estate] = node.estate;
    if (n.nature !== undefined) out[FieldKeys.nature] = n.nature;
    if (n.at !== undefined) out[FieldKeys.at] = n.at;
    if (fieldPolicy === 'copyExpected') {
      if (n.expectedTime !== undefined) out[FieldKeys.expectedTime] = n.expectedTime;
      if (n.expectedRepeat !== undefined) out[FieldKeys.expectedRepeat] = n.expectedRepeat;
      if (n.expectedSpan !== undefined) out[FieldKeys.expectedSpan] = n.expectedSpan;
    }
    return out;
  };

  /** 目标父下是否已有同类型 + 同名的直接子节点（冲突判据） */
  const findExisting = (parentNodeId: string, kind: SeqtkNode['kind'], desc: string): string | null => {
    for (const child of pipe.GET_Children(parentNodeId)) {
      if (child.data && child.data.kind === kind && child.data.desc === desc) return child.nodeId;
    }
    return null;
  };

  /** 把新建的顶层节点从 follows 末尾挪到指定同级位置（去掉自身后按索引插入） */
  const moveChild = (parentNodeId: string, childId: string, position: number): void => {
    const parent = pipe.GET_Node(parentNodeId);
    if (!parent) return;
    const follows = (parent.follows ?? []).filter((id) => id !== childId);
    const at = Math.max(0, Math.min(position, follows.length));
    follows.splice(at, 0, childId);
    pipe.EXEC_Mutation({
      op: 'update',
      kind: parent.kind,
      nodeId: parentNodeId,
      updates: { follows, modify: now() } as never,
    });
  };

  const cloneOne = async (
    sourceNodeId: string,
    targetParentId: string | null,
    /** 顶层插入位置；后代不传（始终追加） */
    position?: number,
  ): Promise<string | null> => {
    const node = pipe.GET_Node(sourceNodeId);
    if (!node) return null;
    const desc = resolveText(node.desc);
    const body = resolveText(pipe.GET_NodeBody(sourceNodeId));

    // 冲突命中：不新建，处理已有节点，后代照旧挂下去（结构不丢）
    if (targetParentId && conflict !== 'append') {
      const existingId = findExisting(targetParentId, node.kind, desc);
      if (existingId) {
        if (conflict === 'overwrite') {
          const updates: Record<string, unknown> = { desc, ...semanticFields(node), modify: now() };
          pipe.EXEC_Mutation({
            op: 'update',
            kind: node.kind,
            nodeId: existingId,
            updates: updates as never,
          });
          if (body) pipe.EXEC_Mutation({ op: 'setBody', kind: node.kind, nodeId: existingId, body });
        }
        for (const child of pipe.GET_Children(sourceNodeId)) {
          await cloneOne(child.nodeId, existingId);
        }
        return existingId;
      }
    }

    const data = {
      kind: node.kind,
      desc,
      open: true,
      ...semanticFields(node),
      create: now(),
      modify: now(),
      ...(targetParentId ? { parent: targetParentId } : {}),
    } as SeqtkNode;

    let newNodeId: string;
    try {
      // 文件先行 + 父 follows 双向维护 + 缓存写入，统一由 EXEC_Create 承担
      newNodeId = await pipe.EXEC_Create({
        kind: node.kind,
        data,
        body,
        parentId: targetParentId ?? undefined,
      });
    } catch (err) {
      console.error('[SeqTK] 克隆模板节点失败:', err);
      return null;
    }

    if (targetParentId && position !== undefined) moveChild(targetParentId, newNodeId, position);

    // 递归克隆后代（GET_Children 返回 follows 顺序，保持源树相对次序）
    for (const child of pipe.GET_Children(sourceNodeId)) {
      await cloneOne(child.nodeId, newNodeId);
    }
    return newNodeId;
  };

  return cloneOne(sourceId, parentId, policy.position);
}

/**
 * 将文本中出现的源根名参数化为 {{frame}} 占位
 * （「存为模板」时调用；sourceRootDesc 为空则原样返回）。
 */
export function parameterizeText(text: string, sourceRootDesc: string): string {
  return sourceRootDesc ? text.split(sourceRootDesc).join(TEMPLATE_FRAMEWORK_NAME_TOKEN) : text;
}
