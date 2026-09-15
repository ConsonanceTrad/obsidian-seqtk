/**
 * IconButton — 无边框图标按钮（共用件）
 *
 * 图标必须经 host.setIcon 注入：Obsidian 的图标是 SVG，只写 data-icon attribute 不会渲染。
 * 因此用 ref + effect 把图标塞进按钮，并在图标 / 提示变化时重设。
 *
 * 与 NodeLine 同层：它依赖 NodeLineHost 这个宿主接口，放在这里免得 C1 之上的模块各写一份。
 */

import { useEffect, useRef } from "react";
import type { NodeLineHost } from "./NodeLine";

export interface IconButtonProps {
    icon: string;
    tip: string;
    host: NodeLineHost;
    className?: string;
    onClick: () => void;
}

export function IconButton({ icon, tip, host, className, onClick }: IconButtonProps) {
    const ref = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.empty();
        // host 上的这两个方法在类型上是可选的（宿主未注入时不应崩）
        host.setIcon?.(el, icon);
        host.setTooltip?.(el, tip);
    }, [icon, tip, host]);

    return <button ref={ref} className={className} onClick={onClick} />;
}
