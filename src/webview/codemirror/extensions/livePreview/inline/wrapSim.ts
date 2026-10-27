/**
 * WrapSim —— CJK 折行模拟器（从 openWrap.ts 拆出）。
 *
 * 在离屏容器里用探针 span 模拟「给定宽度下这段文本怎么折行」，
 * 一次跨行补偿共三个模拟器（选档 / 斜率 / 验证），共 3 次。
 *
 * @module webview/codemirror/extensions/livePreview/wrapSim
 */

import type { ISegment, ILineGeometry, IProbeRead } from './openWrap.js';

/**
 * 折行模拟器：往一个隐藏容器里登记「前缀段 + 探针」的模拟行，一次性读出
 * 全部探针的「行数 + 末行右端」。
 *
 * 容器的折行三件套 `white-space: break-spaces; word-break: break-word;
 * overflow-wrap: anywhere` 与 CodeMirror `lineWrapping` 挂在 `.cm-content`
 * 上的逐字相同（已从 @codemirror/view 源码核对），同样的字符序列、同样的宽度，
 * 浏览器给出的断点就是正文里真实的断点。
 *
 * 和 layoutMetrics.MeasureBatch 一样，**所有块挂完才读一次**：中途每读一次
 * 都会强制一次布局。一个模拟器从建到拆恰好一次强制布局，
 * 一次跨行补偿共三个模拟器（选档 / 斜率 / 验证），共 3 次。
 */
export class WrapSim {
    private box: HTMLDivElement;
    private probes: HTMLSpanElement[] = [];

    /**
     * @param width - 一行的折行宽度（px）
     */
    constructor(width: number) {
        const box = document.createElement('div');
        box.style.cssText =
            'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;' +
            'contain:layout style;' +
            `width:${width.toFixed(2)}px;white-space:break-spaces;word-break:break-word;overflow-wrap:anywhere;`;
        box.setAttribute('aria-hidden', 'true');
        this.box = box;
    }

    /**
     * 登记一块模拟行：前缀各段在前、探针在后（探针就是要量的那一段）。
     *
     * @param segments - 前缀的渲染态分段（可为空，元素在行首时）
     * @param probeText - 待量的文字
     * @param probeCss - 探针的字体样式（fontSpec 拼的，可附加字距）
     * @param geom - 本块的行几何（内容宽 + 左右内边距）；不同上下文（引用更窄、
     *               带 border）不同，传入则让块完全复刻行盒；不传用容器默认
     * @returns 探针下标，flush() 之后按它取读数
     */
    add(
        segments: ISegment[],
        probeText: string,
        probeCss: string,
        geom?: ILineGeometry
    ): number {
        const block = document.createElement('div');
        if (geom) {
            // border-box 宽 = 内容宽 + 左右内边距；用 padding 复刻 border 空间
            block.style.boxSizing = 'border-box';
            block.style.paddingLeft = `${geom.insetL.toFixed(2)}px`;
            block.style.paddingRight = `${geom.insetR.toFixed(2)}px`;
            block.style.width = `${(geom.width + geom.insetL + geom.insetR).toFixed(2)}px`;
            if (geom.hang > 0) {
                // 复刻列表行的悬挂缩进：padding 已含 marker 列偏移（insetL 是从
                // 真实 .cm-line 量的），text-indent 只把首行拉回 —— 首行保持满宽，
                // 续行从 marker 列开始折，折行点才与真实行一致
                block.style.textIndent = `${(-geom.hang).toFixed(2)}px`;
            }
        }
        for (const seg of segments) {
            const span = document.createElement('span');
            span.style.cssText = seg.css;
            span.textContent = seg.text;
            block.appendChild(span);
        }
        const probe = document.createElement('span');
        probe.style.cssText = probeCss;
        probe.textContent = probeText;
        block.appendChild(probe);
        this.box.appendChild(block);
        this.probes.push(probe);
        return this.probes.length - 1;
    }

    /**
     * 挂上 DOM、一次性读出全部探针的读数，再拆掉（一次强制布局）。
     *
     * 行数读数 = `getClientRects()` 的矩形个数：无双向文字的内联 span
     * 恰好每个视觉行一个矩形；末行右端 = 最后一个矩形的右缘（相对容器左缘）。
     *
     * @returns 与登记顺序一一对应的读数；探针读不到（空矩形）时该位为 null
     */
    flush(): Array<IProbeRead | null> {
        const host = document.body;
        if (!host) return this.probes.map(() => null);
        host.appendChild(this.box);
        const originX = this.box.getBoundingClientRect().left;
        const reads = this.probes.map((probe) => {
            const rects = probe.getClientRects();
            if (rects.length === 0) return null;
            const last = rects[rects.length - 1];
            return { lines: rects.length, endX: last.right - originX };
        });
        this.box.remove();
        this.probes = [];
        return reads;
    }
}
