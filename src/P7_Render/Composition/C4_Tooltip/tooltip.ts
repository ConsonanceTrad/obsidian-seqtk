/**
 * 正文预览 tooltip 文本处理
 *
 * 规则：默认单行（换行压缩为空格）；正文过长（单行化后超过 120 字符）时
 * 保留原始换行以分行显示；总长度最多 300 字符，超出截断并加省略号。
 */
export function tooltipBodyText(body: string): string {
  const single = body.replace(/\s*\n+\s*/g, ' ');
  // 多行显示时去掉尾部空白（含末尾空行）—— 否则 tooltip 最下会多渲染一条空行
  const text = single.length <= 120 ? single : body.replace(/\s+$/, '');
  return text.length > 300 ? text.slice(0, 300) + '…' : text;
}
