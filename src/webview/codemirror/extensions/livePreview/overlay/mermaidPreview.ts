/**
 * 预览浮层（从 previewOverlay.ts 拆出）：Mermaid 预览入口 openMermaidPreviewOverlay + 失败兜底。
 *
 * @module webview/codemirror/extensions/livePreview/mermaidPreview
 */

import { getMermaidTheme, mermaidInitialized, mermaidRenderPromises, mermaidSvgCache, rememberMermaidSvg, setMermaidInitialized } from '../state.js';
import { MermaidPreviewOverlayOptions, closeActivePreviewOverlay, copyMermaidRenderedImageSafely, createOverlayShell, mountOverlayRoot, resolvePreviewTitle, setActiveOverlayRoot } from './overlayShell.js';
import { attachPanZoom, createPreviewActionGroup, queuePreviewFit } from './overlayControls.js';
import { previewTitleFallbackText } from './overlayShell.js';

let mermaidRenderSequence = 0;

/**
 * 右侧代码改动后多久重渲染（ms）。
 *
 * 太短会在连着敲字时反复启动 mermaid 渲染（它内部有布局计算，不便宜），
 * 太长又会显得"改完半天不动"。0.3 秒是「看着像即时」和「不卡」的折中。
 */
const MERMAID_LIVE_RENDER_DELAY_MS = 300;

/**
 * 右侧代码改动后多久把源码写回文档（ms）。
 *
 * 回写会触发整篇装饰重建，比渲染还贵，所以比渲染再慢一拍；
 * 反正用户的注意力在左边的图上，晚一点落盘看不出来。
 */
const MERMAID_LIVE_COMMIT_DELAY_MS = 800;

/**
 * 关闭当前活动的预览浮层。
 *
 * @returns void
 */

export function openMermaidPreviewOverlay(options: MermaidPreviewOverlayOptions): void {
    closeActivePreviewOverlay();

    const cleanupBag: Array<() => void> = [];
    const overlay = createOverlayShell(
        {
            text: resolvePreviewTitle(options.titleText, previewTitleFallbackText),
            editable: false,
        },
        () => {
            for (const cleanup of cleanupBag.reverse()) {
                cleanup();
            }
            closeActivePreviewOverlay();
        }
    );

    const root = overlay.root;

    const viewport = overlay.viewport;
    const stage = overlay.stage;
    const contentHost = overlay.contentHost;
    const panZoom = attachPanZoom(viewport, stage);
    cleanupBag.push(panZoom.cleanup);

    // -------------------------------------------------------------------------
    // 2:1 分栏：viewport 整体搬进左栏，右栏放一个 textarea
    // -------------------------------------------------------------------------
    // 搬 viewport 而不是重建：缩放 / 拖动那一整套（attachPanZoom、stage、content）
    // 一行都不用改，而且变换只作用在左栏里，右栏的 textarea 不受影响。
    const split = document.createElement('div');
    split.className = 'cm-md-preview-split';
    const mainColumn = document.createElement('div');
    mainColumn.className = 'cm-md-preview-split-main';
    const sideColumn = document.createElement('div');
    sideColumn.className = 'cm-md-preview-split-side';
    const editor = document.createElement('textarea');
    editor.className = 'cm-md-preview-mermaid-editor';
    editor.spellcheck = false;
    editor.setAttribute('aria-label', 'Mermaid 源码');
    editor.value = options.source;
    sideColumn.appendChild(editor);
    // viewport 原本是 panel 的直接子节点：先用 split 把它换下来，再收进左栏
    viewport.replaceWith(split);
    mainColumn.appendChild(viewport);
    split.append(mainColumn, sideColumn);

    // 左栏的三个常驻节点：图、提示条（加载中 / 渲染失败 / 空图表）、右下角按钮组
    const rendered = document.createElement('div');
    rendered.className = 'cm-md-preview-mermaid-rendered';
    const message = createPreviewFallback('正在渲染 Mermaid 图表...');
    message.classList.add('cm-md-preview-loading');
    const actions = createPreviewActionGroup('放大图表', '复制 Mermaid 图', panZoom.zoomIn, async () => {
        const success = await copyMermaidRenderedImageSafely(contentHost);
        if (!success) {
            throw new Error('copy failed');
        }
    });
    contentHost.replaceChildren(rendered, message, actions);

    /**
     * 显示 / 隐藏左栏的提示条。
     *
     * @param text - 提示文案；空串表示不提示
     * @param isError - 是否是错误提示（红色）
     */
    const showMessage = (text: string, isError: boolean): void => {
        message.textContent = text;
        message.classList.toggle('cm-md-preview-error', isError);
        message.style.display = text ? '' : 'none';
    };

    // -------------------------------------------------------------------------
    // 即时渲染
    // -------------------------------------------------------------------------
    /** 渲染序号：mermaid 渲染是异步的，连着敲字会有好几次同时在飞，只认最后一次。 */
    let renderSeq = 0;
    /** 用户自己滚轮缩放过 / 拖动过之后，实时渲染不再自动回正。 */
    let userAdjusted = false;
    const markUserAdjusted = (): void => {
        userAdjusted = true;
    };
    viewport.addEventListener('wheel', markUserAdjusted, { passive: true });
    viewport.addEventListener('mousedown', markUserAdjusted);
    cleanupBag.push(() => {
        viewport.removeEventListener('wheel', markUserAdjusted);
        viewport.removeEventListener('mousedown', markUserAdjusted);
    });

    /**
     * 渲染一份 Mermaid 源码并换掉左栏的图。
     *
     * 失败不抛给外面：语法错是编辑过程中的常态，左边红字提示、右边继续编辑即可。
     *
     * @param source - 要渲染的源码
     */
    const applySource = async (source: string): Promise<void> => {
        const seq = ++renderSeq;
        if (!source.trim()) {
            rendered.innerHTML = '';
            showMessage('（空图表）', false);
            return;
        }
        try {
            const svg = await renderMermaidSource(source);
            // 期间又有更新的输入 → 这一次的结果已经过期，丢掉
            if (seq !== renderSeq) return;
            rendered.innerHTML = svg;
            showMessage('', false);
            // 只在用户没自己调过视角时回正：不然每敲一个字，画面就弹回默认缩放
            if (!userAdjusted) queuePreviewFit(() => panZoom.fitToViewport());
        } catch (error) {
            if (seq !== renderSeq) return;
            const detail = error instanceof Error ? error.message : String(error);
            showMessage(`Mermaid 渲染失败: ${detail}`, true);
        }
    };

    // -------------------------------------------------------------------------
    // 输入：重渲染（300ms）与回写文档（800ms）两条防抖链
    // -------------------------------------------------------------------------
    let renderTimer = 0;
    let commitTimer = 0;
    cleanupBag.push(() => {
        window.clearTimeout(renderTimer);
        window.clearTimeout(commitTimer);
        // 关闭前把还没写回的那一次补上，否则最后不到 0.8 秒里敲的字会丢
        if (options.onSourceCommit) {
            options.onSourceCommit(editor.value);
        }
    });

    editor.addEventListener('input', () => {
        window.clearTimeout(renderTimer);
        renderTimer = window.setTimeout(
            () => void applySource(editor.value),
            MERMAID_LIVE_RENDER_DELAY_MS
        );

        // 回写会重建整篇装饰（比渲染贵），所以更慢一拍
        if (options.onSourceCommit) {
            window.clearTimeout(commitTimer);
            commitTimer = window.setTimeout(() => {
                options.onSourceCommit?.(editor.value);
            }, MERMAID_LIVE_COMMIT_DELAY_MS);
        }
    });
    // 代码框自己吃键盘事件，别冒泡到编辑器的快捷键上；**Esc 要放行**，
    // 那是在外壳上监听的"关闭浮层"
    editor.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') {
            event.stopPropagation();
        }
    });

    // 挂载（挂到 body 时自动套主题 portal，见 mountOverlayRoot）
    setActiveOverlayRoot(mountOverlayRoot(options.mountHost, root, options.themeScope));
    root.tabIndex = -1;
    root.focus({ preventScroll: true });

    void applySource(options.source);
}

/**
 * 创建预览失败或加载中的提示块。
 *
 * @param text - 提示文案
 * @returns 提示节点
 */
export function createPreviewFallback(text: string): HTMLElement {
    const fallback = document.createElement('div');
    fallback.className = 'cm-md-preview-fallback';
    fallback.textContent = text;
    return fallback;
}

/**
 * 渲染 Mermaid 源码为 SVG。
 *
 * @param source - Mermaid 源文本
 * @returns SVG 字符串
 */
async function renderMermaidSource(source: string): Promise<string> {
    const cached = mermaidSvgCache.get(source);
    if (cached) {
        return cached;
    }

    const inflight = mermaidRenderPromises.get(source);
    if (inflight) {
        return inflight;
    }

    const mermaid = await import('mermaid');
    if (!mermaidInitialized) {
        const theme = getMermaidTheme();
        mermaid.default.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: theme === 'dark' ? 'dark' : 'default',
            themeVariables:
                theme === 'dark'
                    ? {
                          primaryColor: '#1f2020',
                          primaryBorderColor: '#555',
                          primaryTextColor: '#d4d4d4',
                          lineColor: '#666',
                          secondaryColor: '#2a2d35',
                          tertiaryColor: '#30353f',
                      }
                    : {
                          primaryColor: '#ffffff',
                          primaryBorderColor: '#d0d7de',
                          primaryTextColor: '#24292e',
                          lineColor: '#656d76',
                          secondaryColor: '#f6f8fa',
                          tertiaryColor: '#eff1f3',
                      },
        });
        setMermaidInitialized(true);
    }

    const renderId = `mermaid-preview-${mermaidRenderSequence++}`;
    const promise = mermaid.default.render(renderId, source).then(({ svg }) => {
        rememberMermaidSvg(source, svg);
        return svg;
    });
    mermaidRenderPromises.set(source, promise);

    try {
        return await promise;
    } finally {
        mermaidRenderPromises.delete(source);
    }
}
