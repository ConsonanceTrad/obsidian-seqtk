/**
 * YAML 工具 — 解析和序列化节点 md 文件
 *
 * 节点文件格式：
 * ```
 * ---
 * id: project-20240819-103025-123-1a
 * kind: project
 * desc: 提升健康水平
 * open: true
 * create: 2024-08-19T10:30:25.000Z
 * modify: 2024-08-19T10:30:25.000Z
 * state: plan
 * follows: ["[[...]]"]
 * ---
 *
 * Markdown body 正文（即描述）...
 * ```
 */

import { parseYaml, stringifyYaml, getFrontMatterInfo } from 'obsidian';
import type { NodeKind } from '../types/index';
import { getFolderName, getParentFolder } from '../types/index';

// Re-export from types for backward compatibility
export { getFolderName, getParentFolder };

/**
 * 解析节点 md 文件内容为 frontmatter + body
 */
export function parseNodeFile(content: string): { data: Record<string, any>; body: string } {
  const info = getFrontMatterInfo(content);

  let data: Record<string, any> = {};
  if (info.exists && info.from !== undefined && info.to !== undefined) {
    const yamlContent = content.substring(info.from, info.to);
    data = parseYaml(yamlContent) ?? {};
  }

  const body = content.substring(info.contentStart ?? 0).trimStart();
  return { data, body };
}

/**
 * 序列化 frontmatter + body 为完整的 md 文件内容
 */
export function serializeNodeFile(data: Record<string, any>, body: string): string {
  const yamlStr = stringifyYaml(data);
  const bodyContent = body ? `\n${body}\n` : '\n';
  return `---\n${yamlStr}---${bodyContent}`;
}

/**
 * 从双链引用中提取 nodeId
 */
export function extractWikiLinkName(ref: string): string {
  const match = ref.match(/^\[\[(.+)\]\]$/);
  return match ? match[1] : ref;
}

/**
 * 将 nodeId 转换为双链引用格式
 */
export function toWikiLink(nodeId: string): string {
  return `[[${nodeId}]]`;
}

/**
 * 验证 YAML frontmatter 中的 kind 字段是否与预期类型一致
 */
export function validateKindConsistency(
  data: Record<string, any>,
  expectedKind: NodeKind
): boolean {
  if (!data.kind) return true;
  return data.kind === expectedKind;
}
