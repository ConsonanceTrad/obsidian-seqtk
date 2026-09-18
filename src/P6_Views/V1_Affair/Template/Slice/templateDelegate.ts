/**
 * Template/Slice/templateDelegate — 模板来源的委托描述
 *
 * 模板左栏（模板框架树）被委托到侧栏时，委托面板按这份描述渲染：树取模板框架树口径，
 * 标题是「模板框架」，行菜单与左栏同一套（应用此模板 / 打开正文 / 新建子模板框架 /
 * 重命名 / 归档此模板框架）—— 新建与改名都是行内的，走面板的 InlineEditView 那条路。
 * 归类容器（含子框架）在面板里同样只给结构类动作，与左栏口径一致。
 *
 * 状态（展开 / 选中）来自 TemplateTreeShared，与模板视图同源，因此两处天然一致。
 * 菜单动作走模板切片（templateActions / templateApply），宿主由面板给的
 * app / pipe / settings 临时拼出 —— 模板视图关掉之后，面板里的管理动作照旧可用。
 */

import { NODE_KIND } from '../../../../P4_Nodes/NodeFacade';
import { BUILD_Menu, type MenuDefinition } from '../../../../P7_Render/Composition/C3_RightClickMenu/MenuDefinition';
import { HAS_TemplateUnits, IS_TemplateContainer } from '../../../../P7_Render/Structure/S2_Modal/TemplateModals';
import { DELEGATE, type DelegateSource, type DelegateTreeHost } from '../../../Special/Delegate/DelegateRegistry';
import { BUILD_TemplateLeftItems, EMPTY_TemplateTreeText } from './templateModel';
import { OPEN_NodeFile } from './templateActions';
import { archiveNode } from '../../Design/Slice/actions';
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
            // 与左栏同一口径：选中项没了、或变成了归类容器，都清掉
            if (id && (!host.pipe.GET_Node(id) || IS_TemplateContainer(host.pipe, id))) {
                TEMPLATE_TREE.selectedId = null;
            }
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
        ctx.pipe.GET_ByKind(NODE_KIND.TEMP).length === 0 ? EMPTY_TemplateTreeText : undefined,
    rowMenu: (host, ctx, e) => {
        const view = panelHost(host);
        const defs: MenuDefinition[] = [];
        // 归类容器不是可用模板：不给「应用」与「打开正文」，只留结构类动作（与左栏一致）
        if (!IS_TemplateContainer(host.pipe, ctx.nodeId)) {
            defs.push({
                name: '应用此模板到框架…',
                icon: 'paste',
                section: 'use',
                action: () => APPLY_Template(view, ctx.nodeId),
            });
            defs.push({
                name: '打开正文',
                icon: 'file-text',
                section: 'use',
                action: () => OPEN_NodeFile(view, ctx.nodeId),
            });
        }
        // 已经装了模板单元的框架不再提供「新建子框架」（与左栏同一口径）：
        // 要么当分类目录、要么当模板库，别混在一起
        if (!HAS_TemplateUnits(host.pipe, ctx.nodeId)) {
            defs.push({
                name: '新建子模板框架',
                icon: 'folder-plus',
                section: 'new',
                action: () => host.startCreateChild(ctx),
            });
        }
        defs.push(
            {
                name: '重命名',
                icon: 'pencil',
                section: 'new',
                action: () => host.startRename(ctx.nodeId),
            },
            {
                name: '归档此模板框架（含内容）',
                icon: 'archive',
                section: 'danger',
                warning: true,
                action: () => archiveNode(host.editHost, ctx.nodeId),
            },
        );
        BUILD_Menu(defs, e);
    },
    release: () => {
        // 委托标记由登记处摘牌即复位（delegated 是派生的）；展开与选中保留 ——
        // 取消委托只是把树交还模板视图左栏，不该顺手丢掉用户的位置
    },
};

// 模块顶层注册：模板视图的委托按钮走 DELEGATE.delegate('template')，先注册才找得到来源
DELEGATE.register('template', () => TEMPLATE_DELEGATE);
