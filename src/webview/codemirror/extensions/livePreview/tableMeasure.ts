/**
 * 表格（从 tableRender.ts 拆出）：量宽基础设施：DOM 标尺 / cellWidthCache / measureCells。
 *
 * @module webview/codemirror/extensions/livePreview/tableMeasure
 */

import { columnWidthCache } from './tableColumns.js';
import { renderInlineMarkdown } from './inlineEngine.js';
import { getMeasureContext } from './textMeasure.js';
import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

// =============================================================================
// 量列宽
// =============================================================================

/**
 * 量尺：屏幕外的隐藏盒子，量「单元格渲染出来有多宽」。
 *
 * 必须用真实布局量，不能用 canvas：单元格里可能有加粗（换字重）、行内代码
 * （等宽字体 + 0.95em 字号 + 左右各 6px 内边距）、公式（KaTeX 排版）、复选框，
 * 这些都是样式表算出来的，canvas 量不到。量尺里塞的就是 `renderInlineMarkdown`
 * 产出的 HTML。
 *
 * **两把尺子**，因为一列要量两个宽度：
 *
 * - `pre` 那把 `white-space: pre`，量出「一个字符都不折」时多宽（自然宽）；
 * - `min` 那把让每个格子 `width: min-content`，量出「折到最狠还能多宽」。
 *   这个值不能自己算 —— 中英文混排怎么断、`overflow-wrap` 怎么生效、行内代码
 *   里面还能不能断，规则全在浏览器肚子里，问它最省事也最准。
 *
 * 两把尺子挂在同一个宿主下，而宿主**抄了编辑器身上那几个主题类名**：
 * `.cm-md-*` 那套规则来自 `EditorView.baseTheme`，选择器形如 `.ͼN .cm-md-code`
 * （后代选择器，N 是 CodeMirror 生成的随机类名）。量尺直接挂 `document.body` 上，
 * 一条规则都命中不了 —— 行内代码会漏掉左右各 6px 的内边距、复选框按浏览器默认
 * 尺寸算，量出来天然比真渲染窄，格子白白折行。抄类名比手写一份「量尺专用样式」
 * 更不容易和正文走散。
 *
 * 为什么不干脆挂进 `.cm-editor` 里面：CodeMirror 的 DOMObserver 盯着那块 DOM，
 * 多一个节点会被当成「DOM 被外部改过」，白白触发一次重新解读。
 */
let rulerHost: HTMLElement | null = null;

/** 两把量尺。随宿主一起生死，字体一变（换字号/字体缩放）整个重建。 */
const rulers: { pre: HTMLElement | null; min: HTMLElement | null } = { pre: null, min: null };

/** 建两把尺子时用的字体，用来判断要不要重建。 */
let rulerFont = '';

/**
 * 取（必要时创建 / 刷新）量尺宿主。
 *
 * @returns 挂量尺的宿主元素
 */
function ensureRulerHost(): HTMLElement {
    if (!rulerHost || !rulerHost.isConnected) {
        const host = document.createElement('div');
        host.setAttribute('aria-hidden', 'true');
        // 给复现页留个抓手：量尺是不是真的「脱离排版」了，从外面才看得出来
        host.dataset.livewritemdRuler = '1';
        // 容器本身不参与页面排版：绝对定位 + 移出可视区 + 不可见，
        // `contain: layout style` 再把它和外界隔开（不然字体、行高都可能被继承污染）
        // 注意 `!important`：下面抄过来的主题类名里带着 baseTheme 的 `&` 规则，
        // 那条规则把 `position: relative !important` 和 `display: flex !important`
        // 按在宿主身上 —— 不写 !important 的话内联样式压不住它，宿主会掉回文档流里，
        // 一把几千像素宽的尺子就这么插进页面（实测会把整页撑出横向滚动条）。
        // 同一条规则还带 `display:flex`，会让两把尺子变成 flex item，也一并压回去。
        host.style.cssText = [
            'position:absolute !important',
            'display:block !important',
            'left:-99999px',
            'top:0',
            'visibility:hidden',
            'pointer-events:none',
            // 三保险：就算位置那几条将来又被什么规则顶掉，一个 0×0 且裁剪的盒子里
            // 也漏不出东西去影响页面。尺子里的元素都是自带宽度的（pre 不折行、
            // min-content 是显式宽度），父盒 0 宽不影响它们的盒宽。
            'width:0',
            'height:0',
            'overflow:hidden',
            'contain:layout style',
        ].join(';');
        document.body.appendChild(host);
        rulerHost = host;
        // 宿主是新造的，里面那两把尺子跟着作废；字体缓存也一起清掉，
        // 让下面重新按当前字体建一遍
        rulers.pre = null;
        rulers.min = null;
        rulerFont = '';
    }

    // 每次重建都同步一遍主题类名：第一次量的时候（EditorState.create 阶段）
    // 编辑器可能还没挂进 DOM，那份「没有类名」的宿主不能一直用下去；
    // 换主题时 CodeMirror 也会换掉其中一个类名。
    const editor = document.querySelector('#editor .cm-editor');
    const classes = editor
        ? Array.from(editor.classList)
              .filter((name) => name.startsWith('ͼ'))
              .join(' ')
        : '';
    if (rulerHost.className !== classes) rulerHost.className = classes;

    return rulerHost;
}

/**
 * 取（必要时创建 / 刷新）两把量尺。
 *
 * @returns 量不换行宽的尺子和量 min-content 宽的尺子
 */
function ensureRulers(): { pre: HTMLElement; min: HTMLElement } {
    const host = ensureRulerHost();
    // 字体要和正文一致，否则量出来的宽度没有意义
    const ctx = getMeasureContext();
    const font = [
        `font-size:${ctx?.size ?? 14}px`,
        `font-family:${ctx?.family ?? 'monospace'}`,
        // 正文那一档字重（可能是用户调过的 --livewritemd-font-weight）；
        // 表头行的 600 在条目上单独加，见 measureCells
        `font-weight:${ctx?.weight ?? '400'}`,
        'line-height:1',
    ].join(';');

    if (rulers.pre?.isConnected && rulers.min?.isConnected && rulerFont === font) {
        return { pre: rulers.pre, min: rulers.min };
    }

    rulers.pre?.remove();
    rulers.min?.remove();

    const pre = document.createElement('div');
    pre.style.cssText = `${font}; white-space:pre; width:auto; height:auto;`;

    const min = document.createElement('div');
    min.style.cssText = [
        font,
        'white-space:normal',
        'word-break:normal',
        // 必须和 .cm-md-tcell 上的值保持一致（styles.ts 里是 break-word）——
        // 换成 anywhere 的话 min-content 会退化成「一个字符宽」，下限就没意义了
        'overflow-wrap:break-word',
        'width:auto',
        'height:auto',
    ].join(';');

    host.appendChild(pre);
    host.appendChild(min);
    rulers.pre = pre;
    rulers.min = min;
    rulerFont = font;
    return { pre, min };
}

/** 一条待量的单元格。 */
export interface CellMeasureRequest {
    /** 单元格源码（不含管道线和两侧空白） */
    text: string;
    /** 是不是表头行：表头格子是 600 字重，比正文宽，量的时候得按 600 量 */
    header: boolean;
}

/**
 * 单元格宽度缓存：同一段「源码 + 字重 + 字体」只量一次。
 *
 * 量一次 = 挂两次 DOM + 读两次盒宽 = **一次强制布局**，很贵。
 * 同一个词在几十个格子里重复出现是常态，缓存能省掉绝大部分。
 *
 * key 里带字体是必须的：首次构建发生在视图挂进 DOM 之前，`getMeasureContext()`
 * 那时只能退到 body 上取字体（界面字体 ≠ 编辑器字体，宽得不是一点），
 * 量出来的宽度是错的。视图挂上来之后字体一变，key 就变了，那份错的自然作废。
 */
const cellWidthCache = new Map<string, { max: number; min: number }>();

/** 内存统计用：两张表的缓存条目数（cellWidth / columnWidth）。 */
export function tableCacheStats(): { cellWidthEntries: number; columnWidthEntries: number } {
    return {
        cellWidthEntries: cellWidthCache.size,
        columnWidthEntries: columnWidthCache.size,
    };
}

/**
 * 当前字体环境的指纹（量宽度必须用它，缓存 key 里也要带上它）。
 *
 * @returns 形如 `14|Menlo, monospace|400|Consolas` 的指纹
 */
function fontKey(): string {
    const ctx = getMeasureContext();
    return `${ctx?.size ?? 14}|${ctx?.family ?? ''}|${ctx?.weight ?? '400'}|${ctx?.codeFamily ?? ''}`;
}

/**
 * 一次量一批单元格：`max` 是不换行时的宽，`min` 是折到最狠时的宽。
 *
 * 两把尺子一起写、一起读：**所有的挂载（写）全做完再统一读盒宽，中途一次都不读**
 * —— 读一次就强制一次布局，文档越大越贵。所以整批只付一次强制布局的钱。
 *
 * @param requests - 待量的单元格（顺序即返回顺序）
 * @returns 与 requests 一一对应的内容宽度（px，不含内边距边框，调用方自己加）
 */
export function measureCells(requests: CellMeasureRequest[]): Array<{ max: number; min: number }> {
    const results = requests.map(() => ({ max: 0, min: 0 }));
    const pending: number[] = [];
    // 字体进 key：换字号/字体缩放/换主题，量出来的宽度就全不作数了
    const font = fontKey();
    const keyOf = (request: CellMeasureRequest): string =>
        `${font}|${request.header ? 'h' : 'b'}|${request.text}`;

    requests.forEach((request, index) => {
        if (!request.text) return; // 空格子：两个宽度都是 0，不用量
        const cached = cellWidthCache.get(keyOf(request));
        if (cached) {
            results[index] = cached;
            return;
        }
        pending.push(index);
    });
    if (pending.length === 0) return results;

    const { pre, min } = ensureRulers();
    pre.textContent = '';
    min.textContent = '';

    /**
     * 挂一个条目，返回**要读宽度**的那个元素。
     *
     * @param ruler - 挂到哪把尺子上
     * @param index - 条目下标
     * @param boxed - min-content 那把尺子上要额外套一层容器，见下面的说明
     * @returns 读宽度用的元素
     */
    const mount = (ruler: HTMLElement, index: number, boxed: boolean): HTMLElement => {
        const html = renderInlineMarkdown(requests[index].text);
        // 表头按 600 量：styles.ts 的 `.cm-md-table-header .cm-md-tcell` 是 600，
        // 同一个汉字 400 和 600 能差 7%，不补回来的话表头那一行会莫名其妙折行
        const content = requests[index].header
            ? `<span style="font-weight:600">${html}</span>`
            : html;
        if (boxed) {
            // min-content 必须**一格一个容器**：几个格子共用一个 width:min-content
            // 的父元素时，父元素的 min-content 取的是所有格子里最大的那个，
            // 短格子会被撑到那个宽度，量出来的就不是它自己的下限了
            const box = document.createElement('div');
            box.style.cssText = 'width:min-content';
            box.innerHTML = content;
            ruler.appendChild(box);
            return box;
        }
        const span = document.createElement('span');
        span.innerHTML = content;
        ruler.appendChild(span);
        return span;
    };

    const preEls = pending.map((index) => mount(pre, index, false));
    const minEls = pending.map((index) => mount(min, index, true));

    // ↓ 这两行之间不能再碰 DOM，否则每读一次就多强制一次布局
    const preWidths = preEls.map((el) => el.getBoundingClientRect().width);
    const minWidths = minEls.map((el) => el.getBoundingClientRect().width);

    pre.textContent = '';
    min.textContent = '';

    if (cellWidthCache.size > 500) cellWidthCache.clear();
    pending.forEach((index, slot) => {
        const value = { max: preWidths[slot], min: minWidths[slot] };
        cellWidthCache.set(keyOf(requests[index]), value);
        // 同一段文字在别的列里也出现时，不用再等下一次才命中缓存
        results[index] = value;
    });
    return results;
}
