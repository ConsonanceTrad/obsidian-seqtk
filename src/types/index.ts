/**
 * SeqTK 节点类型与概念定义
 *
 * 节点是 SeqTK 中主要的信息访问存储单元：
 * - 节点为独立 MD 文档，带有 YAML frontmatter
 * - 节点必须设置一个确定类型（kind），不存在无类型节点
 * - 节点表示一段独立的信息片段，节点间通过 YAML 表示相关关系
 *
 * 六类节点体系：
 * - 框架节点（framework）：容纳事务、证据的容器，表示同类或相似概念归纳
 *   - 事务框架：存储事务节点树 + 与事务强相关的证据节点
 *   - 信息框架：存储纯证据节点
 *   - 模板框架：存储可用模板组
 * - 事务节点（transaction）：描述待执行的规划分支设计
 *   - 项目节点：构想 > 方向 > 目标 > 工序 的细化过程，支持同级任意深度嵌套
 *   - 清单节点：一组可重复执行的任务组，仅支持 清单 > 事项 两层嵌套
 *   - 事件节点：已完成或临时被派发的任务
 * - 证据节点（evidence）：表示背景的信息组（对象 / 条件 / 信息 / 状态）
 * - 标记节点（mark）：标记上级节点的预配置信息
 * - 运行节点（runtime）：运行过程中的衍生数据（编辑日志 / 行为日志 / 流程状态）
 * - 脚本节点（script）：输出、查询或输入的顺序编撰（流程 / 执行 / 查询）
 *
 * 节点文件命名（nodeId）：
 *   {细分类型名}-{YYYYMMDD-HHmmss-SSS}-{2位防重16进制数}
 *   示例：project-20240819-103025-123-1a
 */

// ============================================================
// 节点类型（kind）定义
// ============================================================

/** 框架节点类型 */
export type FrameworkKind =
  | 'framework-transaction'
  | 'framework-info'
  | 'framework-template';

/**
 * 事务节点类型
 *
 * 项目类层级：concept（构想，顶层）→ direction（方向）→ target（目标）
 * → process（工序）；工序节点支持同级任意深度嵌套，其余严格逐级向下。
 * concept 是项目类独立顶层类型，project 保留作为旧版占位（兼容）。
 */
export type TransactionKind =
  | 'concept'
  | 'project'
  | 'direction'
  | 'target'
  | 'process'
  | 'checklist'
  | 'item'
  | 'event';

/**
 * 证据节点类型 — 描述事务相关的背景信息组
 * - factor：对象（影响因子）
 * - requirement：条件（成立所需条件）
 * - clue：信息（信息片段）
 * - snapshot：状态（某个时间点的某个现实对象所处的状态，经 at 字段记录时间点）
 */
export type EvidenceKind =
  | 'factor'
  | 'requirement'
  | 'clue'
  | 'snapshot';

/** 运行节点类型 */
export type RuntimeKind =
  | 'runtime-editlog'
  | 'runtime-behaviorlog'
  | 'runtime-flowstate';

/** 脚本节点类型 */
export type ScriptKind =
  | 'script-flow'
  | 'script-exec'
  | 'script-query';

/** 全部节点类型（kind） */
export type NodeKind =
  | FrameworkKind
  | TransactionKind
  | EvidenceKind
  | 'mark'
  | RuntimeKind
  | ScriptKind;

/** 节点大类（category） */
export type NodeCategory =
  | 'framework'
  | 'transaction'
  | 'evidence'
  | 'mark'
  | 'runtime'
  | 'script';

/** 各大类包含的细分类型 */
export const CATEGORY_KINDS: Record<NodeCategory, NodeKind[]> = {
  framework: ['framework-transaction', 'framework-info', 'framework-template'],
  transaction: ['concept', 'project', 'direction', 'target', 'process', 'checklist', 'item', 'event'],
  evidence: ['factor', 'requirement', 'clue', 'snapshot'],
  mark: ['mark'],
  runtime: ['runtime-editlog', 'runtime-behaviorlog', 'runtime-flowstate'],
  script: ['script-flow', 'script-exec', 'script-query'],
};

/** 根据细分类型获取所属大类 */
export function getCategoryOf(kind: NodeKind): NodeCategory {
  if (CATEGORY_KINDS.framework.includes(kind as any)) return 'framework';
  if (CATEGORY_KINDS.transaction.includes(kind as any)) return 'transaction';
  if (CATEGORY_KINDS.evidence.includes(kind as any)) return 'evidence';
  if (CATEGORY_KINDS.mark.includes(kind as any)) return 'mark';
  if (CATEGORY_KINDS.runtime.includes(kind as any)) return 'runtime';
  return 'script';
}

// ============================================================
// 状态定义
// ============================================================

/** 节点过程状态（适用：框架、事务） */
export const STATE_VALUES = ['plan', 'open', 'done', 'drop'] as const;
export type SeqtkState = (typeof STATE_VALUES)[number];

/** 节点附加状态（适用：框架、事务）— 描述部分节点的特殊进行状态标记 */
export const ESTATE_VALUES = ['normal', 'hold', 'blocked'] as const;
export type SeqtkEstate = (typeof ESTATE_VALUES)[number];

/** 指标值 — 数字或布尔量，使展示名或描述进行条件显示 */
export type SeqtkIndicator = number | boolean;

/**
 * 事件性质（仅 event 节点）
 *
 * - temp：临时事件 — 临时被派发的任务
 * - retro：补录事件 — 已经完成过的任务，事后补录
 */
export const EVENT_NATURE_VALUES = ['temp', 'retro'] as const;
export type EventNature = (typeof EVENT_NATURE_VALUES)[number];

/** 事件性质中文名 */
export const EVENT_NATURE_LABELS: Record<EventNature, string> = {
  temp: '临时',
  retro: '补录',
};

/** 过程状态流转：plan → open → done/drop，done 可重新打开 */
export const STATE_FLOW: Record<SeqtkState, SeqtkState[]> = {
  plan: ['open', 'drop'],
  open: ['done', 'drop'],
  done: ['open'],
  drop: [],
};

/** 获取某状态可流转到的下一状态列表 */
export function getNextStates(current: string): SeqtkState[] {
  return STATE_FLOW[current as SeqtkState] ?? [];
}

// ============================================================
// YAML 属性名常量
// ============================================================

/**
 * YAML frontmatter 属性名常量
 *
 * 属性分类（参见 doc/数据定义与持久化/节点存储.md）：
 * - 基本信息：id、desc、kind、open、from
 * - 文件信息：create、modify
 * - 从属关系：follows、parent、links、progress
 * - 表意信息：state、estate、clear、tags、indicators、pmarks
 */
export const YamlKeys = {
  // ── 基本信息 ──
  id: 'id',
  desc: 'desc',
  kind: 'kind',
  open: 'open',
  from: 'from',
  // ── 文件信息 ──
  create: 'create',
  modify: 'modify',
  // ── 从属关系 ──
  follows: 'follows',
  parent: 'parent',
  links: 'links',
  progress: 'progress',
  // ── 表意信息 ──
  state: 'state',
  estate: 'estate',
  clear: 'clear',
  tags: 'tags',
  indicators: 'indicators',
  pmarks: 'pmarks',
  nature: 'nature',
  at: 'at',
  // ── 预期属性（表意） ──
  expectedTime: 'expectedTime',
  expectedRepeat: 'expectedRepeat',
  expectedSpan: 'expectedSpan',
} as const;

// ============================================================
// 节点基础接口
// ============================================================

/** 所有节点共有的基础字段 */
export interface NodeBase {
  /** 节点类型 */
  kind: NodeKind;
  /** 节点展示名（用户自行输入） */
  desc: string;
  /** 节点启用/禁用状态 */
  open: boolean;
  /** 添加来源（脚本、模板、补全等非手动创建时记录） */
  from?: string;
  /** 创建时间 ISO datetime */
  create: string;
  /** 最后修改时间 ISO datetime */
  modify: string;
}

/**
 * 从属关系字段
 *
 * 事务、框架节点内部及互相之间，因高频双向查询，需同时输入上级和下级
 * （在上级标注拥有下级、下级标注从属上级），以便查询时双向检索定位。
 * 其他节点不做强制约束。
 */
export interface AffiliationFields {
  /** 有向直属下属（适用：框架、事务、证据） */
  follows?: string[];
  /** 有向直属上级（适用：框架、事务、证据） */
  parent?: string;
  /** 无向关联（适用：证据） */
  links?: string[];
  /** 标记插入（适用：事务） */
  progress?: string[];
}

/**
 * 表意信息字段
 *
 * 各字段适用类型见 doc/数据定义与持久化/节点存储.md：
 * - state / estate：框架、事务
 * - clear：清单、事项
 * - tags：框架、事务、证据
 * - indicators：事务
 * - pmarks：标记
 */
export interface MeaningFields {
  /** 过程状态 */
  state?: SeqtkState;
  /** 附加状态 */
  estate?: SeqtkEstate;
  /** 条件清空启用 — 此清单或事项是否支持被恢复到 open 状态 */
  clear?: boolean;
  /** 标签 — 描述节点特性的一系列短词 */
  tags?: string[];
  /** 指标 — 数个数字或布尔量，可通过配置脚本控制实现复杂变化 */
  indicators?: SeqtkIndicator[];
  /** 流程属性 — 键值对，标记节点的流程属性 */
  pmarks?: Record<string, string>;
  /** 事件性质（仅 event 节点）：temp=临时派发，retro=事后补录 */
  nature?: EventNature;
  /** 时间点（仅 snapshot 状态节点）：记录状态对应的 ISO 时间，与节点 create 时间独立 */
  at?: string;
  /** 预期时间（仅事务节点）：ISO 日期/时间，描述事务预期何时完成或发生 */
  expectedTime?: string;
  /** 预期重复（仅事务节点）：循环规则字符串，描述事务预期重复周期，语法见 utils/cycleRuleParser */
  expectedRepeat?: string;
  /** 预期时间段（仅框架节点）：起止 ISO 时间，描述框架整体预期跨度 */
  expectedSpan?: { from?: string; to?: string };
}

// ============================================================
// 六类节点接口
// ============================================================

/**
 * 框架节点 — 容纳事务、证据的容器
 *
 * 检索优化：进行节点检索时优先在框架内匹配，再进行外部匹配以加快速度。
 * 一个事务节点只能同时直接属于一个框架；框架允许子框架嵌套。
 */
export interface FrameworkNode extends NodeBase, AffiliationFields, MeaningFields {
  kind: FrameworkKind;
}

/**
 * 事务节点 — 描述待执行的规划分支设计
 *
 * - 构想节点（concept）：项目类顶层，描述一个模糊概念，是「新建项目」创建的类型
 * - 方向节点（direction）：构想下的细化层级，严格逐级向下到目标
 * - 目标节点（target）：方向下的细化层级，可容纳事件
 * - 工序节点（process）：目标下的可执行步骤，支持同级任意深度嵌套
 * - 项目节点（project）：旧版占位类型，保留兼容
 * - 清单节点（checklist）：一组可重复执行的任务组，通过模板框架、条件清空功能实现复用
 * - 事项节点（item）：从属于清单，清单不支持深嵌套（仅 清单 > 事项）
 * - 事件节点（event）：已完成或临时被派发的任务，可从属于框架或目标
 */
export interface TransactionNode extends NodeBase, AffiliationFields, MeaningFields {
  kind: TransactionKind;
}

/**
 * 证据节点 — 表示与事务相关的背景信息组
 * - factor（对象）：影响因子
 * - requirement（条件）：成立所需条件
 * - clue（信息）：信息片段
 * - snapshot（状态）：某个时间点的某个现实对象所处的状态（at 记录时间点）
 */
export interface EvidenceNode extends NodeBase, AffiliationFields, MeaningFields {
  kind: EvidenceKind;
}

/** 标记节点 — 标记上级节点的预配置信息 */
export interface MarkNode extends NodeBase, AffiliationFields, MeaningFields {
  kind: 'mark';
  /**
   * 流程属性（必填语义）
   * 被推荐进入流程信息：优先级、插入方式、推荐标签组、用户状态匹配组（高效、正常、混乱）等
   * 标记作为模板被插入时，从插入处获取并使用的信息与使用方式。
   */
  pmarks: Record<string, string>;
}

/** 运行节点 — 运行过程中的衍生数据 */
export interface RuntimeNode extends NodeBase, AffiliationFields, MeaningFields {
  kind: RuntimeKind;
}

/** 脚本节点 — 输出、查询或输入的顺序编撰 */
export interface ScriptNode extends NodeBase, AffiliationFields, MeaningFields {
  kind: ScriptKind;
}

/** 所有节点的联合 */
export type SeqtkNode =
  | FrameworkNode
  | TransactionNode
  | EvidenceNode
  | MarkNode
  | RuntimeNode
  | ScriptNode;

// ============================================================
// 文件包装类型
// ============================================================

/** 节点文件 — 包含 nodeId、frontmatter 数据和 Markdown body */
export interface NodeFile<T extends NodeBase = SeqtkNode> {
  /** 节点唯一标识（也是文件名，不含 .md） */
  nodeId: string;
  /** YAML frontmatter 中的节点数据 */
  data: T;
  /** Markdown body 内容（frontmatter 之后的部分） */
  body: string;
}

// ============================================================
// 文件夹路径常量
// ============================================================

/** 默认根文件夹路径 */
export const DEFAULT_ROOT_FOLDER = '_Root/_Plugin/SeqTK';

/** 各节点大类的中间文件夹名 */
export const CATEGORY_FOLDER_MAP: Record<NodeCategory, string> = {
  framework: 'Framework',
  transaction: 'Transaction',
  evidence: 'Evidence',
  mark: 'Mark',
  runtime: 'Runtime',
  script: 'Script',
};

/** 各节点类型的子文件夹名 */
export const NODE_FOLDER_MAP: Record<NodeKind, string> = {
  'framework-transaction': 'Transaction',
  'framework-info': 'Info',
  'framework-template': 'Template',
  concept: 'Concept',
  project: 'Project',
  direction: 'Direction',
  target: 'Target',
  process: 'Process',
  checklist: 'Checklist',
  item: 'Item',
  event: 'Event',
  factor: 'Factor',
  requirement: 'Requirement',
  clue: 'Clue',
  snapshot: 'Snapshot',
  mark: 'Mark',  'runtime-editlog': 'EditLog',
  'runtime-behaviorlog': 'BehaviorLog',
  'runtime-flowstate': 'FlowState',
  'script-flow': 'Flow',
  'script-exec': 'Exec',
  'script-query': 'Query',
};

/** 根据节点类型获取大类文件夹名 */
export function getParentFolder(kind: NodeKind): string {
  return CATEGORY_FOLDER_MAP[getCategoryOf(kind)];
}

/** 根据节点类型获取其子文件夹名 */
export function getFolderName(kind: NodeKind): string {
  return NODE_FOLDER_MAP[kind];
}

// ============================================================
// 类型守卫
// ============================================================

export function isFrameworkKind(kind: NodeKind): kind is FrameworkKind {
  return CATEGORY_KINDS.framework.includes(kind as any);
}

export function isTransactionKind(kind: NodeKind): kind is TransactionKind {
  return CATEGORY_KINDS.transaction.includes(kind as any);
}

export function isEvidenceKind(kind: NodeKind): kind is EvidenceKind {
  return CATEGORY_KINDS.evidence.includes(kind as any);
}

export function isMarkKind(kind: NodeKind): kind is 'mark' {
  return kind === 'mark';
}

export function isRuntimeKind(kind: NodeKind): kind is RuntimeKind {
  return CATEGORY_KINDS.runtime.includes(kind as any);
}

export function isScriptKind(kind: NodeKind): kind is ScriptKind {
  return CATEGORY_KINDS.script.includes(kind as any);
}

/** 节点是否属于框架大类 */
export function isFrameworkNode(node: SeqtkNode): node is FrameworkNode {
  return isFrameworkKind(node.kind);
}

/** 节点是否属于事务大类 */
export function isTransactionNode(node: SeqtkNode): node is TransactionNode {
  return isTransactionKind(node.kind);
}

/** 节点是否属于证据大类 */
export function isEvidenceNode(node: SeqtkNode): node is EvidenceNode {
  return isEvidenceKind(node.kind);
}

/** 节点是否属于标记大类 */
export function isMarkNode(node: SeqtkNode): node is MarkNode {
  return isMarkKind(node.kind);
}

/** 节点是否属于运行大类 */
export function isRuntimeNode(node: SeqtkNode): node is RuntimeNode {
  return isRuntimeKind(node.kind);
}

/** 节点是否属于脚本大类 */
export function isScriptNode(node: SeqtkNode): node is ScriptNode {
  return isScriptKind(node.kind);
}

// ============================================================
// 中文标签
// ============================================================

/** 节点类型中文名 */
export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  'framework-transaction': '事务框架',
  'framework-info': '信息框架',
  'framework-template': '模板框架',
  concept: '构想',
  project: '项目',
  direction: '方向',
  target: '目标',
  process: '工序',
  checklist: '清单',
  item: '事项',
  event: '事件',
  factor: '对象',
  requirement: '条件',
  clue: '信息',
  snapshot: '状态',
  mark: '标记',
  'runtime-editlog': '编辑日志',
  'runtime-behaviorlog': '行为日志',
  'runtime-flowstate': '流程状态',
  'script-flow': '流程脚本',
  'script-exec': '执行脚本',
  'script-query': '查询脚本',
};

/** 节点大类中文名 */
export const NODE_CATEGORY_LABELS: Record<NodeCategory, string> = {
  framework: '框架',
  transaction: '事务',
  evidence: '证据',
  mark: '标记',
  runtime: '运行',
  script: '脚本',
};

/** 过程状态中文名 */
export const NODE_STATE_LABELS: Record<SeqtkState, string> = {
  plan: '规划',
  open: '进行',
  done: '完成',
  drop: '放弃',
};

/** 附加状态中文名 */
export const NODE_ESTATE_LABELS: Record<SeqtkEstate, string> = {
  normal: '正常',
  hold: '搁置',
  blocked: '阻塞',
};

// ============================================================
// 插件设置
// ============================================================

/** 插件配置 */
export interface PluginSettings {
  /** 数据根文件夹路径（相对于 vault 根目录） */
  rootFolder: string;

  /** FileQueue 防抖时间（毫秒） */
  fileQueueDebounce: number;

  /** 默认排序方式 */
  defaultSort: 'create' | 'modify' | 'desc' | 'state';

  /** 默认排序方向 */
  defaultSortDirection: 'asc' | 'desc';

  /** 状态联级：自动传播父子节点状态变更 */
  stateCascade: boolean;

  /** 状态跟随：手动变更父节点状态时，非终态子孙节点自动标记为目标状态 */
  statusFollow: boolean;

  /** 状态跟随目标状态：done 或 drop */
  statusFollowTarget: 'done' | 'drop';

  /** 归档父节点时是否弹出子孙节点计数确认提示 */
  archiveConfirmPrompt: boolean;

  /** 是否在事务设计左侧栏显示「全部事务」入口（默认隐藏） */
  showAllOverview: boolean;

  /** 左侧栏顶级框架顺序（nodeId 数组；未列入的按创建时间排尾部） */
  topFrameworkOrder: string[];

  /** 中控台管理：各章节的显隐与组内顺序（key=章节名；空 = 默认全部显示/registry 顺序） */
  hub: Record<string, { hidden: string[]; order: string[] }>;
}

/** 默认设置 */
export const DEFAULT_SETTINGS: PluginSettings = {
  rootFolder: DEFAULT_ROOT_FOLDER,
  fileQueueDebounce: 300,
  defaultSort: 'create',
  defaultSortDirection: 'desc',
  stateCascade: true,
  statusFollow: true,
  statusFollowTarget: 'done',
  archiveConfirmPrompt: true,
  showAllOverview: false,
  topFrameworkOrder: [],
  hub: {},
};
