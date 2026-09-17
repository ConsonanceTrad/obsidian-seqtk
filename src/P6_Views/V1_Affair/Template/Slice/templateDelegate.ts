/**
 * Template/Slice/templateDelegate — 模板来源的委托描述
 *
 * 模板左栏（模板框架树）被委托到侧栏时，委托面板按这份描述渲染：树取模板框架树口径，
 * 标题是「模板框架」，行菜单是模板自己的那四项（应用此模板 / 打开正文 /
 * 新建子模板框架 / 删除此模板框架）。
 *
 * 状态（展开 / 选中）来自 TemplateTreeShared，与模板视图同源，因此两处天然一致。
 * 菜单动作走模板切片（templateActions / templateApply），宿主由面板给的
 * app / pipe / settings 临时拼出 —— 模板视图关掉之后，面板里的管理动作照旧可用。
 */

import { NODE_KIND } from '../../../../P4_Nodes/NodeFacade';
import { BUILD_Menu, type MenuDefinition } from '../../../../P7_Render/Composition/C3_RightClickMenu/MenuDefinition';
import { DELEGATE, type DelegateSource, type DelegateTreeHost } from '../../../Special/Delegate/DelegateRegistry';
import { BUILD_TemplateLeftItems } from './templateModel';
import { DELETE_TemplateTree, OPEN_NodeFile } from './templateActions';
import { APPLY_Template } from './templateApply';
import { TEMPLATE_TREE } from './TemplateTreeShared';
import type { TemplateHost } from './TemplateHost';

/** 面板侧的最小宿主：模板视图不在场时，管理动作仍走同一套切片 */
function panelHost(host: DelegateTreeHost): TemplateHost {
    return {
        app: host.app,
        pipe: host.pipe,
        settings: host.settings,
        collapseSelectionIfGone: () => {
            const id = TEMPLATE_TREE.selectedId;
            if (id && !host.pipe.GET_Node(id)) TEMPLATE_TREE.selectedId = null;
        },
    };
}

export const TEMPLATE_DELEGATE: DelegateSource = {
    owner: 'template',
    title: '模板框架',
    childKind: NODE_KIND.TEMP,
    get expanded(): Set<string> {
        return TEMPLATE_TREE.expanded;
    },
    getSelectedId: () => TEMPLATE_TREE.selectedId,
    setSelectedId: (nodeId) => {
        TEMPLATE_TREE.selectedId = nodeId;
    },
    markExpandedChanged: () => TEMPLATE_TREE.markExpandedChanged(),
    subscribe: (cb) => TEMPLATE_TREE.store.subscribe(cb),
    buildItems: (ctx) =>
        BUILD_TemplateLeftItems(ctx.pipe, TEMPLATE_TREE.expanded, TEMPLATE_TREE.selectedId, ctx.overlayFor),
    emptyText: (ctx) =>
        ctx.pipe.GET_ByKind(NODE_KIND.TEMP).length === 0
            ? '暂无模板框架：点标题栏「新建」，或先在事务设计里「存为模板」'
            : undefined,
    rowMenu: (host, ctx, e) => {
        const view = panelHost(host);
        const defs: MenuDefinition[] = [
            {
                name: '应用此模板到框架…',
                icon: 'paste',
                section: 'use',
                action: () => APPLY_Template(view, ctx.nodeId),
            },
            {
                name: '打开正文',
                icon: 'file-text',
                section: 'use',
                action: () => OPEN_NodeFile(view, ctx.nodeId),
            },
            {
                name: '新建子模板框架',
                icon: 'folder-plus',
                section: 'new',
                action: () => host.startCreateChild(ctx),
            },
            {
                name: '删除此模板框架（含内容）',
                icon: 'trash-2',
                section: 'danger',
                warning: true,
                action: () => DELETE_TemplateTree(view, ctx.nodeId),
            },
        ];
        BUILD_Menu(defs, e);
    },
    release: () => {
        // 委托标记由登记处摘牌即复位（delegated 是派生的）；展开与选中保留 ——
        // 取消委托只是把树交还模板视图左栏，不该顺手丢掉用户的位置
    },
};

// 模块顶层注册：模板视图的委托按钮走 DELEGATE.delegate('template')，先注册才找得到来源
DELEGATE.register('template', () => TEMPLATE_DELEGATE);
