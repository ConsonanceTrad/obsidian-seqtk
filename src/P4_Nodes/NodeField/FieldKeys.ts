
/**
 * 属性名常量，涉及文件操作时使用
 */
export const FieldKeys = {
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
    // ── 外部信息源 ──
    sources: 'sources',
} as const;

