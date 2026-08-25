/**
 * clickDouble — 单击/双击区分绑定
 *
 * 树行上的单击动作（选中/展开）若立即执行并触发整树重渲染，会吞掉随后
 * 到达的 dblclick 事件（行元素被重建）。因此单击延迟 delay 毫秒执行，
 * 双击到达时取消未执行的单击定时器，保证两种手势互不叠加。
 */

export function bindClickDouble(
  el: HTMLElement,
  onClick: () => void,
  onDoubleClick: () => void,
  delay = 200,
): void {
  let timer: number | null = null;
  el.addEventListener('click', () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      onClick();
    }, delay);
  });
  el.addEventListener('dblclick', () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    onDoubleClick();
  });
}
