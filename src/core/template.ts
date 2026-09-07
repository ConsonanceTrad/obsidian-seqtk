/**
 * core/template.ts — 模板子树克隆核心
 *
 * 供「事务设计（DesignView）右键：创建/使用模板」与「模板模式（TemplateView）」共用。
 *
 * ── 模板语义 ──
 * - 模板单元 = 模板框架（framework-template）的 follows 直属子树：
 *   顶层节点即模板单元，其下（含全部后代）为该模板要重建的结构。
 *   模板内容即普通节点（kind/desc/body/state/estate/nature/at），MD 文件仍为事实源，
 *   模板框架与普通框架同构，无需专用序列化格式。
 * - 占位：desc / body 中的 {{框架名}} 在「使用模板」时替换为插入处父节点名；
 *   「存为模板」时把子树中出现的源根名自动参数化为 {{框架名}}（无出现则原样保留）。
 *
 * ── 「插入时行为」预留（仅概念注释，暂不实现）──
 * 未来模板单元可能携带可编辑的插入行为配置（存于模板单元 frontmatter 或正文，
 * 需定义专用字段/语法），例如：
 *   - 占位与多变量：除 {{框架名}} 外支持多组 {{变量名}}，插入时由使用方逐一提供取值；
 *   - 覆写或附加：插入目标同名节点时选择「覆写已有」或「附加为新节点」；
 *   - 附加模式：新建节点后按规则附加证据/标记/进度信息（与模板一并插入）；
 *   - 字段保留策略：state/at/expected* 等字段原样复制、按插入时间重置或忽略。
 * 以上行为的默认实现（本文件当前行为）＝ 仅替换 {{框架名}}、原样复制语义字段、全部追加新建。
 * 新增行为时应集中在此文件扩展 clone 参数，并保持 cloneSubtree 对视图的单一入口。
 */

import type { SeqtkNode } from '../types/index';
import type { NodeCache } from './NodeCache';
import type { NodeFileManager } from './NodeFileManager';
import type { OperationQueue } from './OperationQueue';

/** 框架名占位符：使用模板时替换为插入处父节点名 */
export const TEMPLATE_FRAMEWORK_NAME_TOKEN = '{{框架名}}';

/** cloneSubtree 参数 */
export interface CloneSubtreeOptions {
  /** 源节点 nodeId（其子树将整体克隆） */
  sourceId: string;
  /** 目标父节点 nodeId；null = 无父（克隆为顶层节点） */
  parentId: string | null;
  nodeCache: NodeCache;
  fileManager: NodeFileManager;
  operationQueue: OperationQueue;
  /** 文本解析：应用于每个克隆节点的 desc 与 body（默认原样保留） */
  resolveText?: (text: string) => string;
}

/**
 * 将源节点的整棵子树递归克隆到 parentId 下，并维护双向从属关系
 * （新节点 frontmatter parent 指向父、父节点 follows 尾部追加新节点）。
 *
 * 克隆字段（与旧版模板提取一致 + snapshot 时间点 at）：
 *   kind / desc（经 resolveText）/ body（经 resolveText）/ open:true /
 *   state / estate / nature / at / parent（由入参决定）。
 * expectedTime / expectedRepeat / expectedSpan 等计划调度字段不属于结构骨架，
 * 默认不复制（「插入时行为」未来可配置为复制或重置）。
 *
 * @returns 新建的顶层节点 nodeId；源节点不存在时返回 null
 */
export async function cloneSubtree(opts: CloneSubtreeOptions): Promise<string | null> {
  const { sourceId, parentId, nodeCache, fileManager, operationQueue } = opts;
  const resolveText = opts.resolveText ?? ((t: string) => t);

  const cloneOne = async (sourceNodeId: string, targetParentId: string | null): Promise<string | null> => {
    const node = nodeCache.getNode(sourceNodeId);
    if (!node) return null;
    const now = new Date().toISOString();

    const data = {
      kind: node.kind,
      desc: resolveText(node.desc),
      open: true,
      ...(node.state !== undefined ? { state: node.state } : {}),
      ...(node.estate !== undefined ? { estate: node.estate } : {}),
      ...(node.nature !== undefined ? { nature: node.nature } : {}),
      ...(node.at !== undefined ? { at: node.at } : {}),
      create: now,
      modify: now,
      ...(targetParentId ? { parent: targetParentId } : {}),
    } as SeqtkNode;

    const body = resolveText(nodeCache.getNodeBody(sourceNodeId));

    let newNodeId: string;
    try {
      newNodeId = await fileManager.createNode(node.kind, data, body);
    } catch (err) {
      console.error('[SeqTK] 克隆模板节点失败:', err);
      return null;
    }

    // 缓存立即同步（触发响应式渲染）
    operationQueue.enqueueCacheOp(() => nodeCache.addNode(newNodeId, data, body));

    // 双向维护：父节点 follows 尾部追加新节点（父须已在缓存中，此处均为已创建节点/现存目标）
    if (targetParentId) {
      const parent = nodeCache.getNode(targetParentId);
      if (parent) {
        const follows = [...(parent.follows ?? []), newNodeId];
        operationQueue.enqueue(
          () => nodeCache.updateNode(targetParentId, { follows }),
          async () => { await fileManager.updateNode(parent.kind, targetParentId, { follows }); },
        );
      }
    }

    // 递归克隆后代（getChildren 返回 follows 顺序，保持源树相对次序）
    for (const child of nodeCache.getChildren(sourceNodeId)) {
      await cloneOne(child.nodeId, newNodeId);
    }
    return newNodeId;
  };

  return cloneOne(sourceId, parentId);
}

/**
 * 将文本中出现的源根名参数化为 {{框架名}} 占位
 * （「存为模板」时调用；sourceRootDesc 为空则原样返回）。
 */
export function parameterizeText(text: string, sourceRootDesc: string): string {
  return sourceRootDesc ? text.split(sourceRootDesc).join(TEMPLATE_FRAMEWORK_NAME_TOKEN) : text;
}
