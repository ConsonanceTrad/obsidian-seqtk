/**
 * 临时自测脚本（不入库；跑完即删）
 *
 * 覆盖 P2_Tools/Parse 的模板纯逻辑：占位符收集 / 替换、文本树往返与类型链校验、
 * cloneSubtree 的插入策略（追加 / 跳过 / 覆写 / 字段保留 / 插入位置）。
 */
import { COLLECT_TemplateSlots, RESOLVE_TemplateText, cloneSubtree } from '../src/P2_Tools/Parse/TempParse';
import { PARSE_TextTree, SERIALIZE_TextTree, VALIDATE_TemplateTree } from '../src/P2_Tools/Parse/TextTree';

let fails = 0;
function eq(actual: unknown, expected: unknown, label: string) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) console.log('ok   ' + label);
    else {
        fails++;
        console.log('FAIL ' + label + '\n  actual:   ' + a + '\n  expected: ' + e);
    }
}
function ok(cond: boolean, label: string) {
    if (cond) console.log('ok   ' + label);
    else {
        fails++;
        console.log('FAIL ' + label);
    }
}

type MockNode = { kind: string; data: Record<string, unknown>; body: string };

function makePipe() {
    const nodes = new Map<string, MockNode>();
    let seq = 0;
    const pipe = {
        GET_Node: (id: string) => nodes.get(id)?.data,
        GET_NodeBody: (id: string) => nodes.get(id)?.body ?? '',
        GET_Children: (id: string) => {
            const follows = (nodes.get(id)?.data.follows as string[] | undefined) ?? [];
            return follows
                .filter((c) => nodes.has(c))
                .map((c) => ({ kind: nodes.get(c)!.data.kind, nodeId: c, data: nodes.get(c)!.data }));
        },
        EXEC_Create: async (input: { kind: string; data: Record<string, unknown>; body?: string; parentId?: string }) => {
            const id = 'n' + ++seq;
            nodes.set(id, { kind: input.kind, data: { ...input.data }, body: input.body ?? '' });
            if (input.parentId) {
                const p = nodes.get(input.parentId)!;
                p.data.follows = [...((p.data.follows as string[]) ?? []), id];
            }
            return id;
        },
        EXEC_Mutation: (m: { op: string; nodeId: string; updates?: Record<string, unknown>; body?: string }) => {
            if (m.op === 'update') Object.assign(nodes.get(m.nodeId)!.data, m.updates);
            else if (m.op === 'setBody') nodes.get(m.nodeId)!.body = m.body ?? '';
            else if (m.op === 'remove') nodes.delete(m.nodeId);
        },
    };
    const add = (id: string, kind: string, data: Record<string, unknown>, body = '') => {
        nodes.set(id, { kind, data: { kind, ...data }, body });
    };
    return { pipe, nodes, add };
}

async function main() {
    // ── A. 占位符收集 ──
    {
        const slots = COLLECT_TemplateSlots('{{框架名}} 的 {{变量:请输入名称|默认}} 与 {{父.desc}}、{{父.state}}、{{变量}}');
        eq(slots.variables, [{ name: '变量', prompt: '请输入名称', default: '默认', count: 2 }], 'A1 变量定义（提示/默认值/次数）');
        eq(slots.parentFields, ['desc', 'state'], 'A2 父字段去重');
        eq(slots.frameworkNameCount, 1, 'A3 框架名计数');
        eq(slots.issues, [], 'A4 无语法问题');
    }
    {
        const unclosed = COLLECT_TemplateSlots('{{变量}');
        ok(
            unclosed.issues.length === 1 && unclosed.issues[0].message.includes('未闭合') && unclosed.issues[0].line === 1,
            'A5 未闭合 {{ 报错',
        );
        const stray = COLLECT_TemplateSlots('x }}');
        ok(stray.issues.length === 1 && stray.issues[0].message.includes('多出的'), 'A6 多余 }} 报错');
        const unknown = COLLECT_TemplateSlots('{{父.nope}}');
        ok(unknown.issues.length === 1 && unknown.issues[0].message.includes('未知的父字段'), 'A7 未知父字段报错');
        const empty = COLLECT_TemplateSlots('{{}}');
        ok(empty.issues.length === 1 && empty.issues[0].message.includes('为空'), 'A8 空占位报错');
        const dup = COLLECT_TemplateSlots('{{x:提示1|a}}\n{{x:提示2|b}}');
        ok(dup.issues.length === 1 && dup.issues[0].line === 2 && dup.issues[0].message.includes('不一致'), 'A9 同名变量定义冲突（带行号）');
        const bare = COLLECT_TemplateSlots('{{x}} {{x:提示}}');
        ok(bare.issues.length === 0 && bare.variables[0].count === 2 && bare.variables[0].prompt === '提示', 'A10 先裸写后定义不算冲突');
    }

    // ── B. 占位替换 ──
    {
        const parent = { kind: 'AFFAIR_CONCEPT', desc: '甲构想', state: 'done', tags: ['a', 'b'], create: '2024-01-01T00:00:00.000Z' };
        const out = RESOLVE_TemplateText(
            '{{框架名}}|{{父.desc}}|{{父.state}}|{{父.tags}}|{{父.create}}|{{甲:提示|默认}}|{{乙}}',
            { parentName: '甲构想', parent: parent as never, values: { 乙: '手填' } },
        );
        eq(out, '甲构想|甲构想|完成|a、b|2024-01-01T00:00:00.000Z|默认|手填', 'B1 替换：框架名/父字段/默认值/取值');
        eq(RESOLVE_TemplateText('{{父.nope}}', { parentName: 'x', parent: parent as never }), '{{父.nope}}', 'B2 未知父字段原样保留');
        eq(RESOLVE_TemplateText('{{框架名}}/{{父.desc}}', { parentName: 'y' }), 'y/', 'B3 无父节点时父字段为空串');
    }

    // ── C. 文本树往返与类型链校验 ──
    {
        const text = '- [ ] 构想\n  - [/] 方向\n    - [ ] 目标\n      - [ ] 工序';
        const parsed = PARSE_TextTree(text);
        eq(parsed.issues, [], 'C1 解析无问题');
        eq(SERIALIZE_TextTree(parsed.roots), text, 'C2 序列化往返一致');
        eq(VALIDATE_TemplateTree(parsed.roots), [], 'C3 合法链（顶层不校验）');
        eq(VALIDATE_TemplateTree(parsed.roots, 'FRAMEWORK_TRANS' as never), [], 'C4 顶层可插入事务框架');
        const rejected = VALIDATE_TemplateTree(parsed.roots, 'FRAMEWORK_INFO' as never);
        ok(rejected.length === 1 && rejected[0].message.includes('不能插入此处'), 'C5 顶层类型不被目标框架接纳');
        const broken = PARSE_TextTree('- [ ] 构想\n  - [ ] K:process 工序');
        const chain = VALIDATE_TemplateTree(broken.roots);
        ok(chain.length === 1 && chain[0].line === 2 && chain[0].message.includes('不能挂在'), 'C6 内部链不成立（带行号）');
    }

    // ── D. cloneSubtree 的插入策略 ──
    {
        const { pipe, nodes, add } = makePipe();
        add('t1', 'FRAMEWORK_TRANS', { desc: '事务框架' });
        add('s1', 'AFFAIR_CHECK', { desc: '清单', follows: ['s1a'] });
        add('s1a', 'AFFAIR_ITEM', { desc: '行动', state: 'done' });
        const newId = await cloneSubtree({ sourceId: 's1', parentId: 't1', pipe: pipe as never });
        eq(newId, 'n1', 'D1 顶层克隆返回新 nodeId');
        eq(nodes.get('t1')!.data.follows, ['n1'], 'D1b 父 follows 追加');
        eq(nodes.get('n1')!.data.state, undefined, 'D1c 清单本身无 state');
        eq(nodes.get('n2')!.data.state, 'done', 'D1d 子节点 state 随 copy 复制');
        eq(nodes.get('n2')!.data.parent, 'n1', 'D1e 子节点 parent 指向新父');
    }
    {
        const a = makePipe();
        a.add('t', 'FRAMEWORK_TRANS', { desc: 'F' });
        a.add('s', 'AFFAIR_TARGET', { desc: 'T', state: 'open', estate: 'hold', expectedTime: '2025-01-01' });
        await cloneSubtree({ sourceId: 's', parentId: 't', pipe: a.pipe as never, policy: { fields: 'reset' } });
        eq(a.nodes.get('n1')!.data.state, undefined, 'D2 fields=reset 不带 state');
        eq(a.nodes.get('n1')!.data.estate, undefined, 'D2b fields=reset 不带 estate');
        eq(a.nodes.get('n1')!.data.expectedTime, undefined, 'D2c fields=reset 不带 expectedTime');

        const b = makePipe();
        b.add('t', 'FRAMEWORK_TRANS', { desc: 'F' });
        b.add('s', 'AFFAIR_TARGET', { desc: 'T', state: 'open', expectedTime: '2025-01-01' });
        await cloneSubtree({ sourceId: 's', parentId: 't', pipe: b.pipe as never, policy: { fields: 'copyExpected' } });
        eq(b.nodes.get('n1')!.data.expectedTime, '2025-01-01', 'D2d fields=copyExpected 带上 expectedTime');
    }
    {
        const { pipe, nodes, add } = makePipe();
        add('t', 'FRAMEWORK_TRANS', { desc: 'F', follows: ['e1'] });
        add('e1', 'AFFAIR_CHECK', { desc: '同名清单' });
        add('s', 'AFFAIR_CHECK', { desc: '同名清单', follows: ['sc'] });
        add('sc', 'AFFAIR_ITEM', { desc: '行动' });
        const before = nodes.size;
        const got = await cloneSubtree({ sourceId: 's', parentId: 't', pipe: pipe as never, policy: { conflict: 'skip' } });
        eq(got, 'e1', 'D3 conflict=skip 返回命中的已有节点');
        eq(nodes.get('t')!.data.follows, ['e1'], 'D3b 未新建同级');
        ok(nodes.size === before + 1, 'D3c 只补建了后代');
        eq(nodes.get('e1')!.data.follows, ['n1'], 'D3d 后代挂到已有节点下');
    }
    {
        const { pipe, nodes, add } = makePipe();
        add('t', 'FRAMEWORK_TRANS', { desc: 'F', follows: ['e1'] });
        add('e1', 'AFFAIR_CHECK', { desc: '同名清单', state: 'plan' });
        add('s', 'AFFAIR_CHECK', { desc: '同名清单', state: 'open' }, '新正文');
        const got = await cloneSubtree({ sourceId: 's', parentId: 't', pipe: pipe as never, policy: { conflict: 'overwrite' } });
        eq(got, 'e1', 'D4 conflict=overwrite 命中已有节点');
        eq(nodes.get('e1')!.data.state, 'open', 'D4b 表意字段被覆写');
        eq(nodes.get('e1')!.body, '新正文', 'D4c 正文被覆写');
        eq(nodes.get('t')!.data.follows, ['e1'], 'D4d 未新增同级');
    }
    {
        const { pipe, nodes, add } = makePipe();
        add('t', 'FRAMEWORK_TRANS', { desc: 'F', follows: ['a', 'b'] });
        add('a', 'AFFAIR_CHECK', { desc: 'A' });
        add('b', 'AFFAIR_CHECK', { desc: 'B' });
        add('s', 'AFFAIR_CHECK', { desc: 'X' });
        await cloneSubtree({ sourceId: 's', parentId: 't', pipe: pipe as never, policy: { position: 1 } });
        eq(nodes.get('t')!.data.follows, ['a', 'n1', 'b'], 'D5 position 指定同级插入位');
    }
    {
        const { pipe, nodes, add } = makePipe();
        add('t', 'FRAMEWORK_TRANS', { desc: 'F' });
        add('s', 'AFFAIR_CHECK', { desc: '{{框架名}}清单' }, '正文：{{框架名}}');
        await cloneSubtree({
            sourceId: 's',
            parentId: 't',
            pipe: pipe as never,
            resolveText: (t) => t.split('{{框架名}}').join('甲'),
        });
        eq(nodes.get('n1')!.data.desc, '甲清单', 'D6 desc 占位替换');
        eq(nodes.get('n1')!.body, '正文：甲', 'D6b body 占位替换');
    }

    console.log(fails === 0 ? '\n全部通过' : '\n失败 ' + fails + ' 项');
    if (fails > 0) process.exit(1);
}

void main();
