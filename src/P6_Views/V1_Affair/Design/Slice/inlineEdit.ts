/**
 * design/inlineEdit — 行内编辑切片
 *
 * 从 DesignView 拆出的「行内瞬时编辑态」：重命名 · 附加行新建（含连续输入）· 正文浮层。
 * 只维护「当前处于哪种编辑态」，数据落盘仍交给 design/actions。
 *
 * 共用范围（关键）：行内新建与重命名**不绑设计视图** —— 宿主只要求实现 `InlineEditView`
 * （见下），因此设计视图、被委托出去的那棵树（DelegateTreeController）与模板模式左栏
 * 共用同一套实现，三处的行为不会各自漂移。正文浮层仍只服务设计视图，形参保持 DesignView。
 *
 * 约定:
 * - 本文件函数以 view(InlineEditView 实现)为第一参数,只读写它上公开的状态
 *   （pipe / app / refresh / expandedLeft / expandedRight / rename / creating /
 *   suppressRefresh）；「提交后刷新一次」的职责留在这里，数据面不做重绘
 * - 新建落盘统一走 design/actions.createNode；重命名统一走 saveNodeDesc + saveTags
 * - 连续输入靠 seq 递增换 key 重建附加行（见 commitCreate 的说明），不要改成复用同一 key
 *
 * 功能增补指引:
 * - 新增一种行内编辑态 → 在此加「进入 / 提交 / 取消」三件套，并在宿主的行覆盖信息
 *   （overlayFor）里反映出来
 */

import { TextPromptModal } from '../../../../P7_Render/Structure/S2_Modal/TextPromptModal';
import { getAllowedChildKinds } from '../../../../P4_Nodes/NodeFacade';
import { buildNode } from '../Tool/tree';
import { createNode, saveNodeBody, saveNodeDesc, type NodeEditHost } from './actions';
import { PARSE_NameTags, saveTags } from './tags';
import type { NodeKindValue } from '../../../../P4_Nodes/NodeKind/NodeKind';
import type { NodeLineCtx } from '../../../../P7_Render/Composition/C1_NodeLine/NodeLine';
import type { DesignInlineCreating, TreeSide } from '../Core/DesignPanel';

/**
 * 行内编辑切片的最小宿主
 *
 * = NodeEditHost（数据面 + 两组展开集合 + 重绘入口）再加两个瞬时编辑态：由宿主持有，
 * 渲染件要读它们才画得出输入框 —— 属于「宿主自己的状态」，切片只改不存。
 */
export interface InlineEditView extends NodeEditHost {
    /** 行内重命名态（哪一行正在改名） */
    rename: { nodeId: string; side: TreeSide } | null;
    /** 行内新建态：附加行插在哪个父节点、什么类型、哪一栏发起 */
    creating: DesignInlineCreating | null;
    /** 写盘期间压掉重绘（提交后由本切片统一刷一次，见 commitCreate） */
    suppressRefresh?: boolean;
}

/**
 * 再往上一层：宿主还得持有一个**正文编辑态**
 *
 * 与 rename / creating 同类，但只有「行上直接编辑正文」的宿主才有 —— 委托面板与模板视图
 * 不给正文入口，所以单独一个接口而不是塞进 InlineEditView：否则那两个宿主也得凭空长出
 * 一个用不到的字段（写了就是自欺的占位）。菜单宿主（menuHost）建在它之上。
 */
export interface BodyEditHost extends InlineEditView {
    /** 行内正文编辑态（哪一行正在改正文、已输入什么） */
    bodyEditing: { nodeId: string; value: string } | null;
}

/** 进入行内重命名态（由菜单「重命名」触发） */
export function startRename(view: InlineEditView, nodeId: string, side: TreeSide): void {
    const data = view.pipe.GET_Node(nodeId);
    if (!data) return;
    view.rename = { nodeId, side };
    view.refresh();
}

/**
 * 提交行内重命名
 *
 * 以输入框内容为准（全量）：`名称 #甲 #乙` 里的标签段就是该节点的全部标签，
 * 删掉那一段就等于删除该标签；初始值由 Tool/viewModel 用 FORMAT_NameTags 拼好，
 * 所以进编辑时就能看见现有标签。
 * 名称为空（整行只剩标签）时保留原名 —— 免得手滑把名字删没。
 */
export function commitRename(view: InlineEditView, nodeId: string, value: string): void {
    const data = view.pipe.GET_Node(nodeId);
    view.rename = null;
    if (!data || !value) {
        view.refresh();
        return;
    }

    const { desc, tags } = PARSE_NameTags(value);
    const name = desc ?? data.desc;
    if (name !== data.desc) {
        saveNodeDesc(view, buildNode(view.pipe, nodeId, data), name);
    }
    if ((data.tags ?? []).join('\u0000') !== tags.join('\u0000')) {
        saveTags(view, nodeId, tags);
    }
    view.refresh();
}

export function cancelRename(view: InlineEditView): void {
    view.rename = null;
    view.refresh();
}

/** 空白处新建（左栏空白 → 顶级框架；右栏空白 → 选中框架的直属子节点） */
export function startCreateBlank(view: InlineEditView, kind: NodeKindValue, side: TreeSide, parentId?: string): void {
    const parent = parentId ?? '';
    view.creating = { parentId: parent, kinds: [kind], kind, depth: 0, side };
    view.refresh();
}

/** 在某个子节点的子列表末尾新建（未展开则先展开） */
export function startCreateChild(
    view: InlineEditView,
    ctx: NodeLineCtx,
    side: TreeSide,
    kindsOverride?: NodeKindValue[],
): void {
    const data = view.pipe.GET_Node(ctx.nodeId);
    if (!data) return;
    const kinds = kindsOverride ?? getAllowedChildKinds(data.kind);
    if (kinds.length === 0) return;
    const set = side === 'left' ? view.expandedLeft : view.expandedRight;
    set.add(ctx.nodeId);
    view.creating = { parentId: ctx.nodeId, kinds: [...kinds], kind: kinds[0], depth: ctx.depth + 1, side };
    view.refresh();
}

export function setCreateKind(view: InlineEditView, kind: NodeKindValue): void {
    if (!view.creating) return;
    view.creating = { ...view.creating, kind };
    view.refresh();
}

/** 行内新建：切换「连续输入」（提交后保留附加行） */
export function setCreateRepeat(view: InlineEditView, repeat: boolean): void {
    if (!view.creating) return;
    view.creating = { ...view.creating, repeat };
    view.refresh();
}

export function cancelCreate(view: InlineEditView): void {
    view.creating = null;
    view.refresh();
}

/** 落盘新节点（数据写在 design/actions，本文件只转交意图） */
export async function commitCreate(
    view: InlineEditView,
    parentId: string,
    kind: NodeKindValue,
    name: string,
): Promise<void> {
    const prev = view.creating;
    // 写盘期间保持画面不动：附加行不撤、缓存订阅也刷不进来（见 suppressRefresh）。
    // 数据一到就"附加行原地变成新节点"——输入行消失与新行出现落在同一次重绘里。
    view.suppressRefresh = true;
    try {
        await createNode(
            view,
            { kind, desc: name, state: 'plan', afterCreate: 'direct' },
            parentId || undefined,
            // 宿主下面自己刷新一次就够；createNode 内部那两栏重绘与它重复，跳过
            { skipRender: true, side: prev?.side },
        );
    } finally {
        view.suppressRefresh = false;
    }
    view.creating = null;
    // 连续输入：按同一父级/层级/栏恢复附加行，便于逐条录入（类型以本次实际提交者为准）
    if (prev?.repeat) {
        // seq 递增 → 附加行换 key 重建：上一轮的「提交已完成」保护位与残留输入随之清掉，
        // 否则第二次回车会被组件自己拦下（附加行不再卸载，保护位不会自然失效）
        view.creating = { ...prev, kind, repeat: true, seq: (prev.seq ?? 0) + 1 };
    }
    view.refresh();
}

/**
 * 修改描述：走模态框（菜单「修改描述」的入口）
 *
 * 描述是整段 Markdown，弹窗里改比行内浮层从容；行内浮层那条链（startBodyEdit）
 * 留给行上的直接编辑入口。本函数只需要数据面与重绘，故收 NodeEditHost。
 */
export function openBodyEdit(view: NodeEditHost, nodeId: string): void {
    const data = view.pipe.GET_Node(nodeId);
    if (!data) return;
    new TextPromptModal(view.app, {
        title: `修改描述 · ${data.desc}`,
        // 不设说明：整片区域留给正文
        fields: [
            {
                key: 'body',
                label: '',
                type: 'textarea',
                value: view.pipe.GET_NodeBody(nodeId) ?? '',
            },
        ],
        confirmText: '保存',
        onConfirm: (values) => {
            saveNodeBody(view, buildNode(view.pipe, nodeId, data), values.body ?? '');
            view.refresh();
        },
    }).open();
}

/** 进入正文编辑态（行内浮层，见 openBodyEdit 的说明） */
export function startBodyEdit(view: BodyEditHost, nodeId: string): void {
    view.bodyEditing = { nodeId, value: view.pipe.GET_NodeBody(nodeId) ?? '' };
    view.refresh();
}

export function commitBody(view: BodyEditHost, nodeId: string, body: string): void {
    const prev = view.bodyEditing?.value ?? '';
    const data = view.pipe.GET_Node(nodeId);
    view.bodyEditing = null;
    if (data && body !== prev) {
        saveNodeBody(view, buildNode(view.pipe, nodeId, data), body);
    }
    view.refresh();
}

export function cancelBody(view: BodyEditHost): void {
    view.bodyEditing = null;
    view.refresh();
}
