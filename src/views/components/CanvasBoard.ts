/**
 * CanvasBoard — 通用节点白板组件（基于 Cytoscape.js）
 *
 * 供聚焦 / 总览 / 线路模式复用：
 * - 节点按 kind 着色，边按类型区分（links 无向 / follows 有向带箭头）
 * - 交互：缩放平移、节点拖拽、连线模式（点源→点目标建边）、边点击删除、
 *   双击节点、右键菜单、重置布局
 * - 布局策略：初始 cose 力导向（固定 seed 可复现）→「凝固定格」；
 *   新节点增量插入对应关系区域的边缘（邻居包围盒），不触发全局重排
 * - 位置持久化：经注入的 loadLayout/saveLayout 回调读写（插件数据目录 JSON，
 *   非 frontmatter pos、非 canvas 文件）
 */

import cytoscape from 'cytoscape';
import type { Core } from 'cytoscape';
import type { NodeKind } from '../../types/index';

/** 白板节点 */
export interface BoardNode {
  id: string;
  kind: NodeKind;
  desc: string;
}

/** 白板边 */
export interface BoardEdge {
  source: string;
  target: string;
  /** true = 有向（带箭头）；false/undefined = 无向 */
  directed?: boolean;
  /** 关系类型：follows 树边 / links 关联 / route 线路关联 */
  rel?: 'follows' | 'links' | 'route';
  /** 边标签（route 线路关联的描述文本） */
  label?: string;
}

/** 布局位置缓存 */
export type BoardPositions = Record<string, { x: number; y: number }>;

/** 布局缓存（位置 + 视口缩放/平移） */
export interface BoardLayout {
  positions: BoardPositions;
  /** 缩放与平移（记忆当前视口） */
  viewport?: { zoom: number; pan: { x: number; y: number } };
}

/** CanvasBoard 选项 */
export interface CanvasBoardOptions {
  /** 布局缓存 key（视图类型 + 上下文，如 focus-<txnId>） */
  cacheKey: string;
  /** 加载布局缓存 */
  loadLayout: (key: string) => Promise<BoardLayout | null>;
  /** 保存布局缓存 */
  saveLayout: (key: string, layout: BoardLayout) => Promise<void>;
  /** 建边回调（连线模式拖出） */
  onEdgeAdd?: (source: string, target: string) => void;
  /** 断边回调（连线模式点击边删除；directed=有向边，rel=关系类型） */
  onEdgeRemove?: (source: string, target: string, directed: boolean, rel: string) => void;
  /** 双击节点回调 */
  onNodeDblClick?: (nodeId: string) => void;
  /** 节点右键回调（携带原生鼠标事件用于菜单定位） */
  onNodeContextMenu?: (nodeId: string, e: MouseEvent) => void;
  /** 拖动父节点时 follows 子树跟随移动（线路模式） */
  followChildrenOnDrag?: boolean;
}

/** 节点 kind 配色 */
const KIND_COLORS: Record<string, string> = {
  // 事务
  concept: '#7c6ff0',
  project: '#7c6ff0',
  checklist: '#4a9eff',
  item: '#4a9eff',
  event: '#4ac3c3',
  // 证据
  factor: '#f07c6f',
  requirement: '#f0b24a',
  clue: '#4ac36a',
  snapshot: '#9a6ff0',
  // 框架
  'framework-transaction': '#8a8a8a',
  'framework-info': '#a0a0a0',
  'framework-template': '#b8b8b8',
};

const DEFAULT_COLOR = '#d0d0d0';

/** 生成 data-URI SVG 图标（黑色描边线条图标） */
function iconSvg(paths: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 四类证据的节点内图标（区分类型） */
const EVIDENCE_ICONS: Record<string, string> = {
  // 对象：闪电（影响因子）
  factor: iconSvg('<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>'),
  // 条件：对勾（成立条件）
  requirement: iconSvg('<path d="M20 6 9 17l-5-5"/>'),
  // 信息：放大镜（信息片段）
  clue: iconSvg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/>'),
  // 状态：时钟（时间点）
  snapshot: iconSvg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
};

function kindColor(kind: NodeKind): string {
  return KIND_COLORS[kind] ?? DEFAULT_COLOR;
}

export class CanvasBoard {
  readonly cy: Core;
  private options: CanvasBoardOptions;
  private lastNodes = new Set<string>();
  private lastEdges = new Set<string>();
  /** 连线模式：true 时节点不可拖拽，点两个节点建边 */
  private linkingMode = false;
  private readonly minZoom = 0.2;
  private readonly maxZoom = 2.5;
  /** 底部缩放条拖拽状态 */
  private zoomDrag: { startX: number; startZoom: number } | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private canvasEl!: HTMLElement;
  /**
   * 布局缓存暂存：打开视图时数据源尚未就绪（缓存懒加载未完成，nodes 为空），
   * 无法立即恢复布局——暂存待首次 update 有节点时延迟应用，避免空视图覆盖缓存
   */
  private pendingLayout: BoardLayout | null = null;
  /** 节点最小圆心距（节点直径 38 + 间距缓冲，防视觉重叠） */
  private readonly minNodeDist = 52;
  /** 同批无邻居节点的角落网格游标（避免同一批节点共享同一格导致重叠） */
  private cornerCursor = 0;

  constructor(container: HTMLElement, options: CanvasBoardOptions) {
    this.options = options;

    // 内部结构：画布 + 底部缩放拖拽条
    container.empty();
    const wrap = container.createDiv('seqtk-board-wrap');
    this.canvasEl = wrap.createDiv('seqtk-board-canvas');
    const zoomBar = wrap.createDiv('seqtk-zoom-bar');
    zoomBar.createEl('span', { cls: 'seqtk-zoom-bar-icon', text: '⇄ 拖拽缩放' });
    this.buildZoomBar(zoomBar);

    this.cy = cytoscape({
      container: this.canvasEl,
      // 使用默认 wheel sensitivity（避免自定义值导致主流鼠标缩放不自然）
      minZoom: this.minZoom,
      maxZoom: this.maxZoom,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': (el: any) => kindColor(el.data('kind')),
            'label': 'data(label)',
            'color': '#000',
            'text-opacity': 0.95,
            'font-size': 11,
            'text-valign': 'bottom',
            'text-margin-y': 3,
            'width': 38,
            'height': 38,
            'border-width': 2,
            'border-color': '#333',
            'shape': 'ellipse',
          },
        },
        {
          // 事务节点用菱形区分（证据仍为圆形）
          selector: 'node[kind="concept"], node[kind="project"], node[kind="checklist"], node[kind="item"], node[kind="event"]',
          style: { 'shape': 'diamond' },
        },
        // 四类证据节点内图标（区分类型）
        {
          selector: 'node[kind="factor"]',
          style: { 'background-image': EVIDENCE_ICONS.factor, 'background-width': '46%', 'background-height': '46%' },
        },
        {
          selector: 'node[kind="requirement"]',
          style: { 'background-image': EVIDENCE_ICONS.requirement, 'background-width': '46%', 'background-height': '46%' },
        },
        {
          selector: 'node[kind="clue"]',
          style: { 'background-image': EVIDENCE_ICONS.clue, 'background-width': '46%', 'background-height': '46%' },
        },
        {
          selector: 'node[kind="snapshot"]',
          style: { 'background-image': EVIDENCE_ICONS.snapshot, 'background-width': '46%', 'background-height': '46%' },
        },
        {
          selector: 'edge',
          style: {
            'width': 2,
            'line-color': '#000',
            'target-arrow-color': '#000',
            'target-arrow-shape': (el: any) => (el.data('directed') ? 'triangle' : 'none'),
            'curve-style': 'bezier',
            'opacity': 0.28,
          },
        },
        {
          selector: 'edge[directed="true"]',
          style: { 'line-color': '#000' },
        },
        {
          selector: 'edge[directed!="true"]',
          style: { 'line-color': '#000' },
        },
        {
          // route 线路关联边：紫色虚线 + 描述标签
          selector: 'edge[rel="route"]',
          style: {
            'line-style': 'dashed',
            'line-color': '#c084fc',
            'target-arrow-color': '#c084fc',
            'label': 'data(label)',
            'font-size': 9,
            'color': '#c084fc',
            'text-background-color': '#1e1e1e',
            'text-background-opacity': 0.8,
            'text-background-padding': '2px',
          },
        },
      ],
    });

    this.bindEvents();
  }

  // ============================================================
  // 初始化 / 更新
  // ============================================================

  /**
   * 首次渲染：加载布局缓存或执行 cose 布局，然后凝固定格。
   * @returns 是否应用了保存的布局缓存（true 时调用方不应再执行重排布局）
   */
  async init(nodes: BoardNode[], edges: BoardEdge[]): Promise<boolean> {
    this.cy.add(nodes.map((n) => ({ data: { id: n.id, kind: n.kind, label: n.desc } })));
    this.cy.add(edges.map((e) => ({ data: this.edgeData(e) })));
    this.lastNodes = new Set(nodes.map((n) => n.id));
    this.lastEdges = new Set(this.edgeKeyList(edges));

    const saved = await this.options.loadLayout(this.options.cacheKey);
    let hasLayout = false;
    if (saved) {
      if (this.cy.nodes().length > 0) {
        this.applyLayout(saved);
        hasLayout = true;
      } else {
        // 视图打开早于数据源就绪（缓存懒加载未完成）：暂存布局，
        // 待首次 update 有节点时延迟应用，避免空视图保存覆盖布局缓存
        this.pendingLayout = saved;
      }
    } else {
      this.runCose();
    }
    if (this.cy.nodes().length > 0) {
      // 已应用缓存时保留记忆视口，不做 fit 覆盖
      if (!hasLayout) this.cy.fit(undefined, 40);
      // 仅在画布确有内容时落盘：空视图保存会清空既有布局缓存
      await this.saveLayout();
    }

    // 容器尺寸可能因 flex 布局延迟确定：重新测量后再次 fit，
    // 避免布局/视口基于 0 尺寸容器计算导致节点不可见
    requestAnimationFrame(() => {
      this.cy.resize();
      if (this.cy.nodes().length > 0 && !hasLayout) {
        this.cy.fit(undefined, 40);
      }
    });
    return hasLayout;
  }

  /**
   * 差异更新：删除移除的元素，新增节点按「增量插入」定位
   * （新节点放到其邻居包围盒边缘；无邻居放角落），不触发全局重排。
   */
  async update(nodes: BoardNode[], edges: BoardEdge[]): Promise<void> {
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edgeIds = new Set(this.edgeKeyList(edges));

    // 删除移除的节点与边
    for (const id of this.lastNodes) {
      if (!nodeIds.has(id)) this.cy.getElementById(id).remove();
    }
    for (const key of this.lastEdges) {
      if (!edgeIds.has(key)) {
        const [rel, s, t] = this.parseEdgeKey(key);
        this.cy.getElementById(`e-${rel}-${s}-${t}`).remove();
      }
    }

    // 新增节点（必须先加：新边的 source/target 可能引用新节点）
    const newNodes = nodes.filter((n) => !this.lastNodes.has(n.id));
    if (newNodes.length > 0) {
      this.cy.add(newNodes.map((n) => ({ data: { id: n.id, kind: n.kind, label: n.desc } })));
    }

    // 新增边（后加：此时节点已全部存在，避免 "nonexistent target" 错误）
    const newEdges = edges.filter((e) => !this.lastEdges.has(this.edgeKey(e)));
    if (newEdges.length > 0) {
      this.cy.add(newEdges.map((e) => ({ data: this.edgeData(e) })));
    }

    // 新节点定位（此时边已加，可正确计算邻居包围盒）
    for (const n of newNodes) {
      this.positionNewNode(n.id);
    }

    // 延迟恢复布局：init 时无数据暂存的缓存布局，此刻有节点了，应用保存的位置/视口
    if (this.pendingLayout) {
      this.applyLayout(this.pendingLayout);
      this.pendingLayout = null;
    }

    // 更新已有节点标签
    this.cy.nodes().forEach((el) => {
      const node = nodes.find((n) => n.id === el.id());
      if (node) el.data('label', node.desc);
    });

    this.lastNodes = nodeIds;
    this.lastEdges = edgeIds;
    await this.saveLayout();
  }

  // ============================================================
  // 布局
  // ============================================================

  /** 应用保存的布局（节点位置 + 记忆视口） */
  private applyLayout(layout: BoardLayout): void {
    this.cy.nodes().forEach((n) => {
      const p = layout.positions[n.id()];
      if (p) n.position(p);
    });
    if (layout.viewport) {
      this.cy.zoom(layout.viewport.zoom);
      this.cy.pan(layout.viewport.pan);
    }
  }

  /** 布局动画即时完成（避免重建/销毁时进行中动画导致 Cytoscape null 错误） */
  runCose(): void {
    this.cy.layout({
      name: 'cose',
      animate: false,
      randomize: false,
      fit: false,
      // 防重叠：增强节点斥力、拉长理想边距、加大组件间距，使初始/重置布局更稀疏
      nodeRepulsion: () => 12000,
      idealEdgeLength: () => 80,
      edgeElasticity: () => 120,
      nodeOverlap: 10,
      gravity: 0.2,
      componentSpacing: 80,
    }).run();
  }

  /**
   * 层级方块布局（线路模式）：子孙紧邻父级成相邻方块簇，邻接象征从属。
   * 按 follows 树递归——父在块左上，子子树在父下方横向连续排列。
   *
   * @param roots 根节点 id（按序横向放置）
   * @param edges 当前边数据（用于构建 follows 子映射）
   */
  layoutTree(roots: string[], edges: BoardEdge[]): void {
    const childMap = new Map<string, string[]>();
    for (const e of edges) {
      if (e.rel === 'follows' && e.directed) {
        const list = childMap.get(e.source) ?? [];
        list.push(e.target);
        childMap.set(e.source, list);
      }
    }
    const CELL_W = 110;
    const CELL_H = 80;
    const GAP = 14;

    const place = (id: string, x: number, y: number): number => {
      const node = this.cy.getElementById(id);
      if (node.length > 0) node.position({ x, y });
      const children = childMap.get(id) ?? [];
      if (children.length === 0) return CELL_W;
      let cx = x;
      let total = 0;
      for (const c of children) {
        const w = place(c, cx, y + CELL_H);
        cx += w + GAP;
        total += w + GAP;
      }
      return Math.max(CELL_W, total - GAP);
    };

    let x = 60;
    const y = 60;
    for (const r of roots) {
      x += place(r, x, y) + 40;
    }
    this.cy.fit(undefined, 40);
    void this.saveLayout();
  }

  /** 重置布局并保存 */
  async resetLayout(): Promise<void> {
    this.runCose();
    await this.saveLayout();
  }

  /** 增量定位新节点：邻居包围盒右侧 / 角落网格，落点经碰撞检测避开现有节点 */
  private positionNewNode(nodeId: string): void {
    const node = this.cy.getElementById(nodeId);
    if (node.length === 0) return;

    // 有边的邻居（含出/入边）
    const neighbors = node.neighborhood().nodes().filter((n) => n.id() !== nodeId);
    let base: { x: number; y: number };
    if (neighbors.length > 0) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      neighbors.forEach((n) => {
        const p = n.position();
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      });
      base = {
        x: maxX + 70 + (Math.random() - 0.5) * 30,
        y: (minY + maxY) / 2 + (Math.random() - 0.5) * 90,
      };
    } else {
      // 无邻居：角落网格（同批游标递增，避免同批节点共享同一格）
      const idx = (this.cornerCursor++ % 25);
      const col = idx % 5;
      const row = Math.floor(idx / 5);
      base = { x: 60 + col * 90, y: 60 + row * 90 };
    }
    node.position(this.findFreePosition(base, nodeId));
  }

  /**
   * 在 base 附近寻找不与现有节点重叠的落点：
   * base 无碰撞则直接返回；否则按螺旋（步长 18）向外逐环扫描首个空位。
   */
  private findFreePosition(base: { x: number; y: number }, excludeId: string): { x: number; y: number } {
    if (!this.collides(base, excludeId)) return base;
    const step = 18;
    for (let ring = 1; ring < 64; ring++) {
      let x = base.x + ring * step;
      let y = base.y;
      // 环形四边：下 → 左 → 上 → 右
      for (let i = 0; i < 2 * ring; i++) { const p = { x, y }; if (!this.collides(p, excludeId)) return p; y += step; }
      for (let i = 0; i < 2 * ring; i++) { const p = { x, y }; if (!this.collides(p, excludeId)) return p; x -= step; }
      for (let i = 0; i < 2 * ring; i++) { const p = { x, y }; if (!this.collides(p, excludeId)) return p; y -= step; }
      for (let i = 0; i < 2 * ring; i++) { const p = { x, y }; if (!this.collides(p, excludeId)) return p; x += step; }
    }
    // 兜底：极密集场景未找到空位，退回 base（视觉上仍比强制塞入更可接受）
    return base;
  }

  /** 检查位置是否与任一现有节点（排除 excludeId）圆心距小于阈值 */
  private collides(pos: { x: number; y: number }, excludeId: string): boolean {
    const minDistSq = this.minNodeDist * this.minNodeDist;
    let hit = false;
    this.cy.nodes().forEach((n) => {
      if (hit || n.id() === excludeId) return;
      const p = n.position();
      const dx = p.x - pos.x;
      const dy = p.y - pos.y;
      if (dx * dx + dy * dy < minDistSq) hit = true;
    });
    return hit;
  }

  /** 收集全部节点位置 */
  collectPositions(): BoardPositions {
    const positions: BoardPositions = {};
    this.cy.nodes().forEach((n) => {
      positions[n.id()] = n.position();
    });
    return positions;
  }

  /** 收集当前视口（缩放 + 平移） */
  private collectViewport(): { zoom: number; pan: { x: number; y: number } } {
    return { zoom: this.cy.zoom(), pan: this.cy.pan() };
  }

  /** 节流保存（位置 + 视口） */
  private async saveLayout(): Promise<void> {
    // 画布仍为空且有待恢复的缓存布局（数据源未就绪）：不落盘，避免空数据覆盖缓存
    if (this.cy.nodes().length === 0 && this.pendingLayout) return;
    try {
      await this.options.saveLayout(this.options.cacheKey, {
        positions: this.collectPositions(),
        viewport: this.collectViewport(),
      });
    } catch (err) {
      console.warn('[SeqTK] 保存白板布局失败:', err);
    }
  }

  /** 视口变化后节流保存（记忆缩放/平移） */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveLayout();
    }, 400);
  }

  // ============================================================
  // 底部缩放拖拽条
  // ============================================================

  private buildZoomBar(bar: HTMLElement): void {
    bar.addEventListener('pointerdown', (e) => {
      this.zoomDrag = { startX: e.clientX, startZoom: this.cy.zoom() };
      bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    bar.addEventListener('pointermove', (e) => {
      if (!this.zoomDrag) return;
      const dx = e.clientX - this.zoomDrag.startX;
      const barW = bar.clientWidth || 1;
      // 拖动距离映射到缩放范围
      const range = this.maxZoom - this.minZoom;
      const next = Math.min(this.maxZoom, Math.max(this.minZoom,
        this.zoomDrag.startZoom + (dx / barW) * range));
      this.cy.zoom(next);
      this.scheduleSave();
    });
    const end = () => { this.zoomDrag = null; };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  // ============================================================
  // 交互
  // ============================================================

  private bindEvents(): void {
    // 连线模式：点源节点 → 点目标节点建边
    this.cy.on('tap', 'node', (evt) => {
      if (!this.linkingMode) return;
      const node = evt.target;
      if (this.pendingLinkSource === null) {
        this.pendingLinkSource = node.id();
      } else if (this.pendingLinkSource !== node.id()) {
        this.options.onEdgeAdd?.(this.pendingLinkSource, node.id());
        this.pendingLinkSource = null;
      }
    });

    // 双击节点
    this.cy.on('dbltap', 'node', (evt) => {
      if (this.linkingMode) return;
      this.options.onNodeDblClick?.(evt.target.id());
    });

    // 节点右键
    this.cy.on('cxttap', 'node', (evt) => {
      if (this.linkingMode) return;
      this.options.onNodeContextMenu?.(evt.target.id(), evt.originalEvent as MouseEvent);
    });

    // 边点击删除（仅连线模式生效，防止误触）
    this.cy.on('tap', 'edge', (evt) => {
      if (!this.linkingMode) return;
      const edge = evt.target;
      this.options.onEdgeRemove?.(
        edge.data('source'),
        edge.data('target'),
        !!edge.data('directed'),
        edge.data('rel') ?? '',
      );
    });

    // 节点移动后保存布局
    this.cy.on('dragfree', 'node', () => {
      void this.saveLayout();
    });

    // 缩放/平移变化后节流保存（记忆当前视口）
    this.cy.on('zoom pan', () => this.scheduleSave());

    // 子树跟随拖动（线路模式）：拖动父节点时 follows 后代实时平移
    if (this.options.followChildrenOnDrag) {
      this.cy.on('dragstart', 'node', (evt) => {
        this.dragState = { id: evt.target.id(), last: { ...evt.target.position() } };
      });
      this.cy.on('drag', 'node', (evt) => {
        if (!this.dragState || this.dragState.id !== evt.target.id()) return;
        const pos = evt.target.position();
        const dx = pos.x - this.dragState.last.x;
        const dy = pos.y - this.dragState.last.y;
        this.dragState.last = { x: pos.x, y: pos.y };
        if (dx !== 0 || dy !== 0) {
          this.moveFollowsDescendants(evt.target.id(), dx, dy);
        }
      });
      this.cy.on('dragfree', 'node', () => { this.dragState = null; });
    }
  }

  private dragState: { id: string; last: { x: number; y: number } } | null = null;

  /** 递归平移 follows 子树（沿 directed 边） */
  private moveFollowsDescendants(id: string, dx: number, dy: number): void {
    this.cy.edges(`edge[source="${id}"][directed="true"][rel="follows"]`).forEach((e) => {
      const child = this.cy.getElementById(e.data('target'));
      if (child.length > 0) {
        const p = child.position();
        child.position({ x: p.x + dx, y: p.y + dy });
        this.moveFollowsDescendants(child.id(), dx, dy);
      }
    });
  }

  private pendingLinkSource: string | null = null;

  /** 设置连线模式（由外部工具栏切换） */
  setLinkingMode(on: boolean): void {
    this.linkingMode = on;
    this.pendingLinkSource = null;
    this.cy.nodes().forEach((n) => {
      if (on) n.ungrabify();
      else n.grabify();
    });
  }

  /** 将节点移动到指定模型坐标并保存布局（供「空白右键创建节点」等外部落位使用） */
  positionNode(nodeId: string, pos: { x: number; y: number }): void {
    const el = this.cy.getElementById(nodeId);
    if (el.length === 0) return;
    el.position(pos);
    void this.saveLayout();
  }

  /** 是否处于连线模式 */
  get isLinkingMode(): boolean {
    return this.linkingMode;
  }

  // ============================================================
  // 工具
  // ============================================================

  /** 构造边的 cytoscape data */
  private edgeData(e: BoardEdge): Record<string, any> {
    return {
      id: `e-${e.rel ?? 'x'}-${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
      directed: e.directed ?? false,
      rel: e.rel ?? (e.directed ? 'follows' : 'links'),
      label: e.label,
    };
  }

  private edgeKey(e: BoardEdge): string {
    return `${e.rel ?? 'x'}->${e.source}->${e.target}`;
  }

  private edgeKeyList(edges: BoardEdge[]): string[] {
    return edges.map((e) => this.edgeKey(e));
  }

  private parseEdgeKey(key: string): [string, string, string] {
    const parts = key.split('->');
    return [parts[0], parts[1], parts[2]];
  }

  /** 释放 Cytoscape 实例 */
  destroy(): void {
    this.cy.destroy();
  }
}
