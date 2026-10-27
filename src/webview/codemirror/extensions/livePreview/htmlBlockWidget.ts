/**
 * Live Preview Widget（从 widgets.ts 拆出）：HTML 块 widget：标签白名单 + 安全 href + 片段构建。
 *
 * @module webview/codemirror/extensions/livePreview/htmlBlockWidget
 */

import { resolvePreviewImageUrl } from './state.js';
import { EditorView, WidgetType } from '@codemirror/view';

// =============================================================================
// HTML Block Widget
// =============================================================================

/** HTML 块里允许保留的标签（README 徽章 / 居中排版那一类）。 */
const HTML_BLOCK_TAGS = new Set([
    'p', 'div', 'center', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'del',
    'ins', 'mark', 'small', 'sub', 'sup', 'kbd', 'code', 'pre', 'br', 'hr',
    'img', 'a', 'picture', 'source', 'figure', 'figcaption',
    'blockquote', 'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

/** 允许保留的属性：全部是展示属性，`on*` / `style` 一律丢弃。 */
const HTML_BLOCK_ATTRS = new Set([
    'align', 'valign', 'width', 'height', 'src', 'alt', 'title',
    'href', 'colspan', 'rowspan', 'start', 'type',
]);

/**
 * 内容本身就不该出现的标签：连同子树整个丢掉。
 *
 * 其它不认识的标签（比如自定义元素）走「保留子节点」的降级路径，
 * 这样 `<unknown><b>粗体</b></unknown>` 至少还能显示粗体文字。
 */
const HTML_BLOCK_DROP_TAGS = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta',
    'base', 'form', 'input', 'button', 'textarea', 'select', 'option',
]);

/** 链接允许的协议（其它（尤其是 javascript:）直接丢掉 href）。 */
function safeHtmlHref(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.startsWith('#')) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^mailto:/i.test(trimmed)) return trimmed;
    return '';
}

/**
 * 把一段 HTML 块源码变成安全的 DOM 片段。
 *
 * 用 DOMParser 解析（不会执行脚本），再按白名单**重建**一棵树：
 * 只保留展示标签与无害属性，图片地址经 resolvePreviewImageUrl 换成
 * webview 可访问地址。返回 null 表示这段块没有可渲染内容，调用方应保持
 * 源码显示（避免把普通文本 / 注释替换成一片空白）。
 *
 * @param raw - HTML 块原文
 * @returns 安全片段；没有可渲染元素时为 null
 */
export function buildHtmlBlockFragment(raw: string): DocumentFragment | null {
    let parsed: Document;
    try {
        parsed = new DOMParser().parseFromString(raw, 'text/html');
    } catch {
        return null;
    }
    const fragment = document.createDocumentFragment();
    /** 成功保留的元素数量：0 表示没东西可画。 */
    let kept = 0;

    const copy = (source: Node, target: Node): void => {
        if (source.nodeType === Node.TEXT_NODE) {
            target.appendChild(document.createTextNode(source.textContent ?? ''));
            return;
        }
        if (source.nodeType !== Node.ELEMENT_NODE) return;
        const sourceEl = source as HTMLElement;
        const tag = sourceEl.tagName.toLowerCase();
        if (HTML_BLOCK_DROP_TAGS.has(tag)) return;
        if (!HTML_BLOCK_TAGS.has(tag)) {
            // 不认识的包装标签：保留里面的内容
            for (const child of Array.from(sourceEl.childNodes)) copy(child, target);
            return;
        }

        const el = document.createElement(tag);
        for (const attr of Array.from(sourceEl.attributes)) {
            const name = attr.name.toLowerCase();
            if (!HTML_BLOCK_ATTRS.has(name)) continue;
            if (name === 'src') {
                // 相对路径 / 远程地址 / data URI 统一交给已有的图片解析
                const resolved = resolvePreviewImageUrl(attr.value);
                if (resolved) el.setAttribute('src', resolved);
            } else if (name === 'href') {
                const href = safeHtmlHref(attr.value);
                if (href) {
                    // 复用 live 的链接点击逻辑（Ctrl+点击打开 / #锚点跳转），
                    // 但不保留真实 href，防止 webview 里整页跳转
                    el.classList.add('cm-md-link');
                    el.setAttribute('data-href', href);
                    el.setAttribute('title', `${href} (Ctrl+Click to open)`);
                }
            } else {
                el.setAttribute(name, attr.value);
            }
        }
        // align 是过时属性但浏览器仍认；显式映射成 inline style，主题覆盖时更稳
        const align = sourceEl.getAttribute('align');
        if (align) el.style.textAlign = align;

        for (const child of Array.from(sourceEl.childNodes)) copy(child, el);
        target.appendChild(el);
        kept += 1;
    };

    for (const child of Array.from(parsed.body.childNodes)) copy(child, fragment);
    return kept > 0 ? fragment : null;
}

/**
 * HTML 块渲染 widget。
 *
 * HTML 块（`<p align="center">…</p>` / shields.io 徽章行）在非聚焦时
 * 整体替换成渲染结果；点一下（mousedown 放行）光标进入该块，
 * 聚焦区间覆盖它时 applyTreeDecorations 会跳过，源码自然展开 ——
 * 与水平线 widget 的交互一致。
 *
 * 导图节点用的是同一套 live 扩展，所以 html 媒体节点里的内容无需
 * 额外渲染逻辑，mini-CM 会自动走到这里。
 */
export class HtmlBlockWidget extends WidgetType {
    constructor(private readonly raw: string) {
        super();
    }

    eq(other: HtmlBlockWidget): boolean {
        return this.raw === other.raw;
    }

    ignoreEvent(event: Event): boolean {
        // 只放行 mousedown：让点击能把光标放进块里，从而展开源码。
        return event.type !== 'mousedown';
    }

    toDOM(view: EditorView): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cm-md-html-block';
        const fragment = buildHtmlBlockFragment(this.raw);
        if (fragment) {
            wrapper.appendChild(fragment);
        } else {
            // 理论上调用方已经筛过；兜底仍然显示原文，绝不吞内容
            wrapper.textContent = this.raw;
        }
        // 图片是异步加载的：加载完高度才定，通知 CM 重新量一次
        for (const img of Array.from(wrapper.querySelectorAll('img'))) {
            if (!img.complete) {
                img.addEventListener('load', () => view.requestMeasure(), {
                    once: true,
                });
                img.addEventListener('error', () => view.requestMeasure(), {
                    once: true,
                });
            }
        }
        return wrapper;
    }
}
