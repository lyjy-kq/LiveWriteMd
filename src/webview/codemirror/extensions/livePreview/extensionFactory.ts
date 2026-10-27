/**
 * Live Preview 扩展装配工厂（从 plugin.ts 拆出）。
 *
 * createLivePreviewExtension / createLivePreviewDisplayExtension /
 * livePreviewEditAddons 三个工厂：把装饰管线、表格交互、行级强制、
 * 自动配对等零散扩展按既定顺序组装成最终 Extension[]。
 *
 * @module webview/codemirror/extensions/livePreview/extensionFactory
 */

import { livePreviewPlugin } from './plugin.js';
import { livePreviewBlockDecorations } from './plugin.js';
import { tableWidthBootstrap } from './plugin.js';
import { findFileLinkAtText } from '../../../../shared/link/fileLink.js';
import { anchorFlashClearEffect, anchorFlashEffect, anchorFlashField, findHeadingPos } from './collectLinks.js';
import { createBaseThemeStyles } from './decor/styles.js';
import { ensureTokenColorCss, liveWriteMdTokenHighlight } from './decor/tokenColors.js';
import { autoPairBrackets } from './inline/autoPair.js';
import { lineForcePlugin, nativeAnchoredMouseSelection } from './interaction/lineForce.js';
import { scrollPreserverExtension } from './interaction/scrollHack.js';
import { livePreviewDisplayOnly, livePreviewInstanceField } from './state.js';
import { tableCellSelection } from './table/tableCellSelection.js';
import { tableHoverControls } from './table/tableHoverControls.js';
import { tableCompositionHandler, tablePipeEscaper, tableSourceModeHandler } from './table/tableLocate.js';
import { tableResizePlugin } from './table/tableWiring.js';
import { syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * ViewPlugin that highlights table widgets when CM6 selection extends over them
 * from outside (e.g. drag-selecting from a paragraph through a table).
 * Works by toggling a CSS class directly on the widget DOM.
 */
/**
 * Creates the live preview extension bundle.
 *
 * Returns all extensions needed for Obsidian-style live preview,
 * including the ViewPlugin, syntax highlighting, link handler, and base theme styles.
 */
export function createLivePreviewExtension(): Extension[] {
    // 共享 token 色表（CSS 变量）：代码块语法高亮与导图 mini-CM/静态渲染共用，
    // 幂等注入，多实例调用无副作用
    ensureTokenColorCss();
    return [
        // 实例状态字段（任务 4）：源码模式 / 行级强制态 / 折叠行集合都收在这里，
        // 同一套扩展挂多个 EditorView（主编辑器 + 导图 mini-CM）时互不串扰。
        // 必须排最前：后续插件的读写都经 state.field(livePreviewInstanceField)
        livePreviewInstanceField,
        scrollPreserverExtension,
        // block 装饰必须由 StateField 提供（CodeMirror 的硬限制）
        livePreviewBlockDecorations,
        // 内链跳转的目标行 1s 高亮（StateField，随文档变更映射）
        anchorFlashField,
        // 挂载后补一次表格重建（首次构建时视图还没进 DOM，量不到可用宽度）
        tableWidthBootstrap,
        // 滚动容器宽度变化时主动重建：定宽列自己不会感知 scroller 变窄
        tableResizePlugin,
        // 表格边缘「+」：悬停右边框/下边框加列/加行（live 与导图节点共用）
        tableHoverControls,
        livePreviewPlugin,
        // mousedown 记录起点、移动超阈值整行展开、双击钉住（见 lineForce.ts）
        lineForcePlugin,
        // 单击锚点用浏览器原生 hit-test（从公式后起拖不错位）
        nativeAnchoredMouseSelection(),
        // 在格子上拖鼠标 = 整格框选（选区两端吸到格子边界）
        tableCellSelection(),
        // 单元格里输入 `|` 自动转义，免得把表格切碎
        tablePipeEscaper(),
        // 中文输入法组合结束后补一次表格列宽重估（组合期间列宽是冻结的）
        tableCompositionHandler(),
        // 输入左括号自动补全右半（[ { ( 【 《 <）
        autoPairBrackets(),
        // 双击表格 → 整张表切源码模式（改结构时看源码更直接）
        tableSourceModeHandler(),
        // 单个 HighlightStyle：颜色全是 var(--lwm-tok-*) 引用，
        // 深浅色随 body 的 vscode-light 类翻转（tokenColors.ts）
        syntaxHighlighting(liveWriteMdTokenHighlight),
        // Click handler for links
        EditorView.domEventHandlers({
            mousedown(event: MouseEvent, view: EditorView) {
                const target = event.target;
                const targetElement =
                    target instanceof HTMLElement
                        ? target
                        : target instanceof Node
                          ? target.parentElement
                          : null;
                if (!targetElement) return false;

                // 水平分割线 `---` 在渲染态被替换成一条 `.cm-md-hr`。
                // 不拦截的话，CodeMirror 默认把光标落在被替换区间的**行首**
                // （无头实测：点线的正中央 head=line.from），而用户要的是
                // 「渲染态转回文本态时，光标聚焦到文本末尾」——所以在这里
                // 主动把光标送到这一行的行尾。
                const hrEl = targetElement.closest('.cm-md-hr');
                if (
                    hrEl &&
                    // 只接管左键的普通点击：右键要留给原生上下文菜单，
                    // Shift/Ctrl/Meta 点击要留给原生的选区扩展/多光标行为
                    event.button === 0 &&
                    !event.shiftKey &&
                    !event.ctrlKey &&
                    !event.metaKey
                ) {
                    // 优先按点击坐标取文档位置；取不到时退回 widget DOM 对应位置。
                    // 两种取法都只用来定位「这是哪一行」，真正的落点统一给行尾。
                    let pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                    if (pos === null) pos = view.posAtDOM(hrEl, 0);
                    const lineEnd = view.state.doc.lineAt(pos).to;
                    event.preventDefault();
                    event.stopPropagation();
                    // 编辑器可能还没拿到焦点（preventDefault 会挡掉默认的焦点转移），
                    // 先主动聚焦，再把光标放到行尾
                    view.focus();
                    view.dispatch({ selection: { anchor: lineEnd } });
                    return true;
                }

                const linkEl = targetElement.closest('.cm-md-link');
                if (!linkEl) return false;
                const href = linkEl.getAttribute('data-href');
                if (!href) return false;

                // 内链（#标题）：普通点击跳转到目标标题并短暂高亮该行。
                // 匹配规则「精确优先 + slug 回退」与导图侧共用（shared/internalLink）
                if (href.startsWith('#')) {
                    event.preventDefault();
                    event.stopPropagation();
                    const targetPos = findHeadingPos(
                        view.state,
                        syntaxTree(view.state),
                        href.slice(1)
                    );
                    if (targetPos >= 0) {
                        view.dispatch({
                            selection: { anchor: targetPos },
                            effects: [
                                EditorView.scrollIntoView(targetPos, {
                                    y: 'start',
                                    yMargin: 20,
                                }),
                                anchorFlashEffect.of(targetPos),
                            ],
                        });
                        // 1 秒后撤掉高亮（视图已销毁时静默跳过）
                        setTimeout(() => {
                            try {
                                if (view.dom.isConnected) {
                                    view.dispatch({ effects: anchorFlashClearEffect.of(null) });
                                }
                            } catch {
                                /* 视图已销毁：忽略 */
                            }
                        }, 1000);
                    }
                    return true;
                }

                // Relative file link — plain click to open in VS Code
                if (!href.startsWith('http://') && !href.startsWith('https://')) {
                    event.preventDefault();
                    event.stopPropagation();
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const vscodeApi = (window as any).__vscodeApi;
                    if (vscodeApi) {
                        vscodeApi.postMessage({ type: 'openFile', path: href });
                    }
                    return true;
                }

                // External URL — Ctrl+click to open in VS Code
                if (!(event.ctrlKey || event.metaKey)) return false;
                event.preventDefault();
                event.stopPropagation();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const vscodeApi = (window as any).__vscodeApi;
                if (vscodeApi) {
                    vscodeApi.postMessage({ type: 'openUrl', url: href });
                }
                return true;
            },
            /**
             * 处理普通文本中的文件路径 Ctrl/Cmd+点击跳转。
             *
             * 该分支只在未命中现有 Markdown 链接时执行，避免改变既有链接行为。
             *
             * @param event - 浏览器鼠标事件
             * @param view - 当前 CodeMirror 视图
             * @returns 命中文件路径并已拦截默认行为时返回 true
             */
            click(event: MouseEvent, view: EditorView) {
                const target = event.target;
                const targetElement =
                    target instanceof HTMLElement
                        ? target
                        : target instanceof Node
                          ? target.parentElement
                          : null;
                if (!targetElement) {
                    return false;
                }

                if (targetElement.closest('.cm-md-link')) {
                    return false;
                }

                if (!(event.ctrlKey || event.metaKey)) {
                    return false;
                }

                const clickPos = view.posAtCoords({
                    x: event.clientX,
                    y: event.clientY,
                });
                if (clickPos === null) {
                    return false;
                }

                const line = view.state.doc.lineAt(clickPos);
                const fileLinkMatch = findFileLinkAtText(line.text, clickPos - line.from);
                if (!fileLinkMatch) {
                    return false;
                }

                event.preventDefault();
                event.stopPropagation();

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const vscodeApi = (window as any).__vscodeApi;
                if (vscodeApi) {
                    vscodeApi.postMessage({
                        type: 'openFile',
                        path: fileLinkMatch.rawText,
                    });
                }

                return true;
            },
        }),
        createBaseThemeStyles(),
    ];
}

/**
 * 只读显示态的 live 扩展包（导图节点显示 CM 专用）。
 *
 * 与完整包**渲染完全一致**（block 装饰 / 窗口装饰 / 样式 / 高亮全保留），
 * 但摘掉全部编辑交互插件 —— 它们各自带 window 监听器或测量钩子，
 * 几十个节点实例同屏时是初始化成本与交互卡顿（每次 mousemove 要跑
 * 几百个监听）的重要来源。链接/hr 点击跳转也不带（导图里链接不吃点击）。
 */
export function createLivePreviewDisplayExtension(): Extension[] {
    ensureTokenColorCss();
    return [
        // 实例状态字段（装饰管线依赖，见 createLivePreviewExtension）
        livePreviewInstanceField,
        // 只读显示实例标记：mini-CM 是节点级小文档，内链断链判定等
        // 需要全文档上下文的功能据此关闭（见 state.ts）
        livePreviewDisplayOnly.of(true),
        // block 装饰必须由 StateField 提供（CodeMirror 的硬限制）
        livePreviewBlockDecorations,
        // 挂载后补一次表格重建（首次构建时视图还没进 DOM，量不到可用宽度）
        tableWidthBootstrap,
        // 滚动容器宽度变化时主动重建：定宽列自己不会感知 scroller 变窄
        tableResizePlugin,
        // 表格边缘「+」：悬停右边框/下边框加列/加行（导图只读显示态，
        // 命令经 tableEditBridge 临时放开可编辑性执行）
        tableHoverControls,
        livePreviewPlugin,
        syntaxHighlighting(liveWriteMdTokenHighlight),
        createBaseThemeStyles(),
    ];
}

/**
 * 编辑态追加的交互插件（导图节点「翻转」成编辑态时经 Compartment 注入）。
 *
 * 这些插件只跟「正在编辑」有关：拖选锚点补偿 / 双击钉住 / 表格框选 /
 * 管道转义 / 组合态列宽 / 括号配对 / 双击表格切源码 —— 只读显示不需要。
 */
export function livePreviewEditAddons(): Extension[] {
    return [
        lineForcePlugin,
        nativeAnchoredMouseSelection(),
        tableCellSelection(),
        tablePipeEscaper(),
        tableCompositionHandler(),
        autoPairBrackets(),
        tableSourceModeHandler(),
    ];
}
