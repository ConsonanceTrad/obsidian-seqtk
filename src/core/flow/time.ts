/**
 * 统一时间标记语法（旧版脚本设计案 6.2.6）
 *
 * 格式：`@<主时间><单位> [-s 开始时点] [-i 补充定义...] [-d 持续时长] [-e 结束时点] [l 倒数]`
 * 单位：Y / M / W / D / h / m（年/月/周/日/时/分）
 * 示例：`@202505YM-s01d-i14h-i2m-d08d` = 2025 年 5 月第 1 天第 14 小时第 2 分钟起，持续 8 天
 */

export interface TimeMarkPart {
  value: number;
  unit: string; // Y / M / W / D / h / m
}

/** 解析后的时间标记 */
export interface TimeMark {
  /** 主时间数值（如 202505） */
  main: number;
  /** 主时间单位（如 YM / D / h / m） */
  mainUnit: string;
  /** -s 开始时点 */
  s: TimeMarkPart[];
  /** -i 补充定义 */
  i: TimeMarkPart[];
  /** -d 持续时长 */
  d: TimeMarkPart[];
  /** -e 结束时点 */
  e: TimeMarkPart[];
  /** l 倒数标记 */
  l: boolean;
}

const UNIT_RE = '([YMWDdhmy])';

function parseParts(input: string): TimeMarkPart[] {
  const parts: TimeMarkPart[] = [];
  const re = new RegExp(`(\\d+)${UNIT_RE}`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    parts.push({ value: parseInt(m[1], 10), unit: m[2] });
  }
  return parts;
}

/** 解析时间标记文本（形如 @202505YM-s01d-i14h...），失败返回 null */
export function parseTimeMark(input: string): TimeMark | null {
  if (!input.startsWith('@')) return null;
  const rest = input.slice(1);
  const mainM = rest.match(/^(\d+)([YMWDdhmy]+)/);
  if (!mainM) return null;
  const main = parseInt(mainM[1], 10);
  const mainUnit = mainM[2];
  let rest2 = rest.slice(mainM[0].length);

  const mark: TimeMark = { main, mainUnit, s: [], i: [], d: [], e: [], l: false };
  // 依次提取 -s / -i / -d / -e / l
  while (rest2.length > 0) {
    const secM = rest2.match(/^-([side])([^-\s]+)/);
    if (secM) {
      const key = secM[1] as 's' | 'i' | 'd' | 'e';
      // 同一段可多次出现（如多个 -i 细分），追加而非覆盖
      mark[key] = [...mark[key], ...parseParts(secM[2])];
      rest2 = rest2.slice(secM[0].length);
      continue;
    }
    if (rest2.startsWith('l')) {
      mark.l = true;
      rest2 = rest2.slice(1);
      continue;
    }
    rest2 = rest2.slice(1);
  }
  return mark;
}

/** 单位对应中文名 */
const UNIT_LABEL: Record<string, string> = {
  Y: '年', M: '月', W: '周', D: '天', h: '小时', m: '分', y: '年', d: '天',
};

/** 渲染为阅读友好形式（如「2025/05/01 14:02 起，8 天」） */
export function formatTimeMark(mark: TimeMark): string {
  const pad = (v: number, w = 2): string => String(v).padStart(w, '0');
  const mainText = (): string => {
    // YM → 年/月；其余拼接数值+单位
    if (mark.mainUnit === 'YM') {
      const y = Math.floor(mark.main / 100);
      const mo = mark.main % 100;
      return `${y}/${pad(mo)}`;
    }
    return `${mark.main}${UNIT_LABEL[mark.mainUnit] ?? mark.mainUnit}`;
  };
  const parts = (list: TimeMarkPart[]): string =>
    list.map((p) => `${pad(p.value)}${UNIT_LABEL[p.unit] ?? p.unit}`).join('');
  const sTxt = parts(mark.s);
  const iTxt = parts(mark.i);
  const dTxt = parts(mark.d);
  const eTxt = parts(mark.e);

  let out = mainText();
  if (sTxt) out += ` 第${sTxt}起`;
  if (iTxt) out += ` ${iTxt}`;
  if (dTxt) out += `，持续${dTxt}`;
  if (eTxt) out += `，至${eTxt}`;
  if (mark.l) out += '（倒数）';
  return out;
}

/** 便捷入口：解析并格式化 */
export function formatTimeMarkText(input: string): string | null {
  const m = parseTimeMark(input);
  return m ? formatTimeMark(m) : null;
}
