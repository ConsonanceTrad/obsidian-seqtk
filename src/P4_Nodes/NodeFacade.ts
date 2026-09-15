/**
 * NodeFacade — 节点 API 的旧名门面（**迁移过渡层**）
 *
 * `P6_Views/V1_Affair/design/*`（约 1300 行交互层：树渲染 / 右键菜单 / 拖拽 / 引导线）
 * 在迁移时保留了旧符号名，以把一次性改动面压到最小、降低回归风险。
 * 本文件把 `P4_Nodes` 的新 API 以旧名重新导出，使这些文件只需改 import 路径。
 *
 * 收敛方式（收尾阶段）：把 design/* 里的 `NODE_KIND_LABELS` / `getAllowedChildKinds` /
 * `isFrameworkKind` / `getCategoryOf` 等改用新名，然后删除本文件。
 */

import { IS_KindOfCategory } from './NodeKind/NodeKind';
import type { NodeKindValue } from './NodeKind/NodeKind';

// ── 值重导出 ──
export { NODE_KIND } from './NodeKind/NodeKind';
export { NODE_KIND_LABELS } from './NodeKind/NodeLabel';
export { GET_AllowedChildKinds as getAllowedChildKinds } from './NodeKind/NodeChildAllow';
export { GET_CategoryOfNode as getCategoryOf } from './NodeKind/NodeKind';
export {
    STATE_VALUES,
    NODE_STATE_LABELS,
    NODE_ESTATE_LABELS,
    EVENT_NATURE_LABELS,
} from './NodeField/StateKeys';

// ── 类型重导出（旧名 → 新名） ──
export type { NodeKindValue as NodeKind } from './NodeKind/NodeKind';
export type { SeqtkNode } from './Node';
export type { SeqtkState, EventNature } from './NodeField/StateKeys';

// ── 旧名断言函数 → 新分类判定 ──
export const isFrameworkKind = (kind: NodeKindValue): boolean => IS_KindOfCategory(kind, 'FRAMEWORK');
export const isTransactionKind = (kind: NodeKindValue): boolean => IS_KindOfCategory(kind, 'AFFAIR');
export const isEvidenceKind = (kind: NodeKindValue): boolean => IS_KindOfCategory(kind, 'EVIDENCE');
export const isScriptKind = (kind: NodeKindValue): boolean => IS_KindOfCategory(kind, 'SCRIPT');
export const isRuntimeKind = (kind: NodeKindValue): boolean => IS_KindOfCategory(kind, 'RUNTIME');
