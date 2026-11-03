/**
 * 编辑器/导图应用状态与模式切换（从 main.ts 拆出）。
 *
 * 模块级共享状态全部落在 webviewContext.ctx 上，这里是操作这些状态的
 * 一组自由函数：导图模式进出、导图编辑回写隐藏 CM、大纲联动等。
 *
 * @module webview/host/appState
 */

import { undo, redo } from '@codemirror/commands';
import { codeLanguages } from '../codemirror/editor.js';
import { tableRemeasureEffect } from '../codemirror/extensions/livePreview/state.js';
import { MESSAGE_TYPES } from '../../shared/messageTypes.js';
// 只取类型：真正的实现改为进入对应模式时才动态 import（见下方 enter 函数）。
// 静态 import 会把导图 / 幻灯片整套代码塞进入口 bundle，每个 md 文件首屏
// 都要为「还没进入的模式」付编译成本。
import type { MindMapApp } from '../mindmap/mindmapApp.js';
import type { MindMapRuntimeSettings } from '../mindmap/types.js';
import type { SlidesApp } from '../slides/slidesApp.js';
import { settingsState } from '../settings/settingsState.js';
import type { EditorMode } from '../editing/editorContextMenu.js';
import { ctx } from './webviewContext.js';
import { sendLog } from './logForward.js';

/**
 * 获取或创建编辑器宿主容器。
 *
 * @returns 编辑器宿主 DOM 节点。
 */
export function getOrCreateEditorHost(): HTMLElement {
    let container = document.getElementById('editor');
    if (!container) {
        container = document.createElement('div');
        container.id = 'editor';
        document.body.appendChild(container);
    }
    return container;
}

/**
 * 获取导图挂载容器（HTML 壳子里已预置 #mindmap）。
     */
export function getMindmapHost(): HTMLElement {
    return document.getElementById('mindmap') as HTMLElement;
}

/**
 * 获取幻灯片挂载容器（HTML 壳子里已预置 #slides）。
 */
export function getSlidesHost(): HTMLElement {
    return document.getElementById('slides') as HTMLElement;
}

/**
 * 从文档 URI 推导文件名（不含扩展名），作为导图虚拟根文本。
 *
 * @param uri 文档 URI
 * @returns 去扩展名后的文件名
 */
export function fileNameFromUri(uri: string): string {
    try {
        const withoutQuery = decodeURIComponent(uri.split('?')[0] ?? uri);
        const base = withoutQuery.split(/[\\/]/).pop() ?? '';
        return base.replace(/\.(md|markdown)$/i, '');
    } catch {
        const fallback = uri.split(/[\\/]/).pop() ?? '';
        return fallback.replace(/\.(md|markdown)$/i, '');
    }
}

/**
 * 从 settingsState 读取导图运行时设置。
     */
export function readMindmapSettings(): MindMapRuntimeSettings {
    return {
        mindmapTheme: settingsState.getString('mindmapTheme') || 'auto',
        mindmapDefaultExpandLevel: settingsState.getNumber('mindmapDefaultExpandLevel'),
        // 节点尺寸上限：getNumber 缺省/异常时回退 0，这里兜底成默认值
        mindmapNodeMaxWidth: settingsState.getNumber('mindmapNodeMaxWidth') || 20,
        mindmapNodeMaxLines: settingsState.getNumber('mindmapNodeMaxLines') || 3,
        // 代码块宽度：40–100 列，0 / 缺失时回退 schema 默认值 60
        mindmapCodeWidth: settingsState.getNumber('mindmapCodeWidth') || 60,
        // 手势期清晰度优先：默认关闭（关闭 = 手势期提升合成层，帧率优先）
        mindmapGestureCrisp: settingsState.getBoolean('mindmapGestureCrisp'),
        // 内链箭头层：默认开启（schema 默认值即 true）
        mindmapInternalLinks: settingsState.getBoolean('mindmapInternalLinks'),
        // 快速卡片：开关 + 宽高（0 视为没读到，回退 schema 默认值）
        quickCardEnabled: settingsState.getBoolean('quickCardEnabled'),
        quickCardWidth: settingsState.getNumber('quickCardWidth') || 280,
    };
}

/**
 * 导图编辑回写：把导图算出的新全文同步进隐藏的 CodeMirror 实例。
 *
 * 走 CM dispatch 而不是直发 CONTENT_CHANGE，是为了让导图操作进入 CM 撤销栈
 * （Ctrl+Z / 切回文本 undo 都能撤销，一次导图操作 = 一步 undo），
 * 随后由现有 contentChange 监听防抖上报给扩展（设计文档 §3.3）。
 *
 * dispatch 的变更范围是「新旧全文的公共前后缀之间的最小差异」，
 * 不是整篇替换：全量替换会让 CM 重建整篇语法树与块装饰，大文档拖动
 * 松手时会明显卡顿；最小差异的开销只和改动块的大小相关。
 *
 * @param newFullText 导图操作算出的新全文
 */
export function applyDocumentEdit(
    newFullText: string,
    source: 'mindmap' | 'slides' = 'mindmap'
): void {
    const view = ctx.editor?.getView();
    if (!view) {
        // CM 还没就绪 / 正在 INIT 重建：不能把改动丢掉，直接把全文发扩展侧。
        // INIT 重建时应用 destroy() 会先把未提交的编辑写回这里，
        // 这条兜底保证「刚打开文件就编辑」的那一下也送得出去。
        sendLog(
            'WARN',
            `${source} edit: CodeMirror view is not ready, sending content directly`
        );
        ctx.debouncedSendContentChange(newFullText);
        ctx.debouncedSendContentChange.flush();
        return;
    }
    const oldText = view.state.doc.toString();
    if (oldText === newFullText) return;
    // 不再全量替换：拖动一次通常只动一小块，算出公共前后缀后只替换中间。
    // 全量 dispatch 会让隐藏的 CM 重建整篇语法树/块装饰，文档大时拖动
    // 松手会明显卡一下；最小变更把这块成本压到与改动块同量级。
    let start = 0;
    const minLength = Math.min(oldText.length, newFullText.length);
    while (
        start < minLength &&
        oldText.charCodeAt(start) === newFullText.charCodeAt(start)
    ) {
        start += 1;
    }
    let oldEnd = oldText.length;
    let newEnd = newFullText.length;
    while (
        oldEnd > start &&
        newEnd > start &&
        oldText.charCodeAt(oldEnd - 1) === newFullText.charCodeAt(newEnd - 1)
    ) {
        oldEnd -= 1;
        newEnd -= 1;
    }
    view.dispatch({
        changes: {
            from: start,
            to: oldEnd,
            insert: newFullText.slice(start, newEnd),
        },
    });
    // 导图编辑是离散操作（提交一次 = 一步），不必等 300ms 防抖：
    // 立即把全文发给扩展侧。否则「提交完马上切走/关面板」时改动会
    // 卡在防抖定时器里，表现为「失焦后没写回」。
    ctx.debouncedSendContentChange.flush();
}

/** 导图编辑回写（兼容旧调用点）。 */
export function applyMindmapEdit(newFullText: string): void {
    applyDocumentEdit(newFullText, 'mindmap');
}

/**
 * 导图模式的撤销 / 重做（todo.md 任务 7）。
 *
 * 导图编辑本来就通过 applyMindmapEdit 走「隐藏 CM 的最小差异 dispatch」进
 * CM 撤销栈，所以导图里的 Ctrl+Z/Y 等价于对隐藏 CM 执行 undo/redo；
 * 完成后立即把新文档喂回导图重建（UPDATE 防抖回环太慢，等不起）。
 */
export function applyMindmapUndoRedo(kind: 'undo' | 'redo'): void {
    const view = ctx.editor?.getView();
    if (!view) return;
    const applied = kind === 'undo' ? undo(view) : redo(view);
    if (applied) {
        ctx.mindmapApp?.setDocument(view.state.doc.toString(), ctx.mindmapFileName);
    }
}

/**
 * 进入导图模式：隐藏文本容器（CM 实例保留），惰性创建/复用导图应用。
 */
export async function enterMindmapMode(): Promise<void> {
    const host = getMindmapHost();
    const editorHost = getOrCreateEditorHost();
    // 必须在隐藏编辑器之前量：容器 hidden 之后 clientHeight = 0，
    // lineBlockAtHeight 拿不到当前屏
    const middleLine = ctx.editor?.getViewportMiddleLine() ?? null;
    editorHost.hidden = true;
    host.hidden = false;

    if (!ctx.mindmapApp) {
        // 首次进导图才加载实现模块：画布引擎 / 样式模板 / 快速卡片栏加起来
        // 约 200KB，和文本编辑器首屏无关，没必要让每次打开文件都等它。
        const { MindMapApp } = await import('../mindmap/mindmapApp.js');
        ctx.mindmapApp = new MindMapApp(host, {
            onEdit: applyMindmapEdit,
            // Ctrl+S：强制写回并保存。
            // 先把最新全文同步进隐藏 CM（进撤销栈，也和后续 UPDATE 对齐），
            // 再让扩展侧直接落盘 —— 不走 CONTENT_CHANGE 的跳过分支，
            // 这样 webview 里「还没提交/被防抖压着」的改动也不会丢。
            onSave: (fullText: string) => {
                applyMindmapEdit(fullText);
                ctx.vscode.postMessage({
                    type: MESSAGE_TYPES.SAVE_DOCUMENT,
                    content: fullText,
                });
            },
            onUndo: () => applyMindmapUndoRedo('undo'),
            onRedo: () => applyMindmapUndoRedo('redo'),
            // mini-CM 的代码块嵌套高亮语言表（主编辑器同款）
            codeLanguages,
            // 任务 16：导图选中节点 → 大纲高亮对应行
            onSelectLine: (line: number) => ctx.outlinePanel?.setActiveLine(line),
            // 迭代 N3：导图导出 → extension 存盘
            onExport: (payload) => {
                ctx.vscode.postMessage({ type: 'saveMindmapExport', ...payload });
            },
            // 画布上改的设置（拖动快速卡片左边界 = quickCardWidth）：
            // 先写本地 settingsState（下次 readMindmapSettings 拿得到），
            // 再走设置面板同一条 UPDATE_SETTING 通道落盘
            onPersistSetting: (key, value) => {
                settingsState.set(key, value);
                ctx.vscode.postMessage({ type: MESSAGE_TYPES.UPDATE_SETTING, key, value });
            },
        });
        ctx.mindmapApp.setTheme(ctx.currentTheme);
        ctx.mindmapApp.setSettings(readMindmapSettings());
    }
    if (ctx.editor && ctx.editor.isReady()) {
        ctx.mindmapApp.setDocument(ctx.editor.getContent(), ctx.mindmapFileName);
    }
    await ctx.mindmapApp.whenReady();
    ctx.mindmapApp.setActive(true);
    // 从文本模式「当前看到的这一屏中间」开始，并固定 100% 缩放。
    // setActive 内部的 fit() 会按整棵树自动缩放，focusLineFromEditor 覆盖它。
    if (middleLine !== null) ctx.mindmapApp.focusLineFromEditor(middleLine - 1);
    sendLog('INFO', 'Mindmap mode activated');
}

/**
 * 退出导图模式：隐藏导图容器、恢复文本容器；CM 状态（撤销栈/光标/滚动）原样保留。
 */
export function leaveMindmapMode(): void {
    // 必须在 setActive(false) 之前取：它会 clearSelection()，之后就只剩
    // 「视口中心」这一条线索了。优先级：选中/编辑节点 → 视口中心节点。
    const focusLine = ctx.mindmapApp?.getFocusLine0() ?? null;
    getMindmapHost().hidden = true;
    getOrCreateEditorHost().hidden = false;
    ctx.mindmapApp?.setActive(false);
    // 容器从 display:none 恢复后让 CM 重新测量
    requestAnimationFrame(() => {
        const view = ctx.editor?.getView();
        view?.requestMeasure();
        // 回到导图里最后看的那一项（行号是 0-based，scrollToLine 要 1-based）
        if (focusLine !== null) ctx.editor?.scrollToLine(focusLine + 1);
    });
}

/**
 * 进入幻灯片模式：隐藏文本容器（CM 实例保留），惰性创建 / 复用幻灯片应用。
 *
 * 顺序很重要：先把文档喂给应用（非激活状态只记录），再 setActive 一次性
 * 解析 / 测量 / 渲染，避免先跑一轮空文档。
 */
export async function enterSlidesMode(): Promise<void> {
    const host = getSlidesHost();
    const editorHost = getOrCreateEditorHost();
    // 容器隐藏后拿不到光标行，进入前先取（1-based → 0-based）
    const currentLine =
        ctx.editor && ctx.editor.isReady()
            ? Math.max(0, ctx.editor.getCurrentLine() - 1)
            : null;
    editorHost.hidden = true;
    host.hidden = false;

    if (!ctx.slidesApp) {
        // 幻灯片同理：解析 / 分页 / 样式的整套代码只在第一次进幻灯片时加载。
        const { SlidesApp } = await import('../slides/slidesApp.js');
        ctx.slidesApp = new SlidesApp(host, {
            onEdit: (fullText) => applyDocumentEdit(fullText, 'slides'),
            // Ctrl+S：强制写回并落盘，和导图同一条路径
            onSave: (fullText) => {
                applyDocumentEdit(fullText, 'slides');
                ctx.vscode.postMessage({
                    type: MESSAGE_TYPES.SAVE_DOCUMENT,
                    content: fullText,
                });
            },
            onPersistSetting: (key, value) => {
                settingsState.set(key, value);
                ctx.vscode.postMessage({
                    type: MESSAGE_TYPES.UPDATE_SETTING,
                    key,
                    value,
                });
            },
            // mini-CM 的代码块嵌套高亮语言表（主编辑器同款）
            codeLanguages,
            // PPT 模式复用右侧大纲：分页一变就重渲染页码标注
            onPagesChange: () => ctx.outlinePanel?.refresh(),
            // 大纲高亮跟着当前页走（PPT 页面里没有正文光标）
            onActiveLineChange: (line0) => {
                if (line0 !== null) {
                    ctx.outlinePanel?.setActiveLine(line0 + 1);
                }
            },
            // 物理屏幕全屏：webview 是沙箱 iframe，requestFullscreen 被拒时
            // 让扩展宿主执行 F11 同款的窗口全屏命令
            onWindowFullscreen: (on) => {
                ctx.vscode.postMessage({
                    type: MESSAGE_TYPES.SLIDES_FULLSCREEN,
                    on,
                });
            },
        });
        ctx.slidesApp.setEditorTheme(ctx.currentTheme);
        ctx.slidesApp.applySettings();
    }

    // 大纲右侧的「行号」换成页码（P8 / P8,9）。分页还没算完时返回空串，
    // 大纲会自动回退显示行号。
    ctx.outlinePanel?.setMetaProvider(
        (line) => ctx.slidesApp?.getOutlinePageLabel(line) ?? ''
    );

    ctx.slidesApp.setDocument(
        ctx.editor?.getContent() ?? '',
        ctx.mindmapFileName
    );
    ctx.slidesApp.setActive(true, currentLine);
    await ctx.slidesApp.whenReady();
    sendLog('INFO', 'Slides mode activated');
}

/**
 * 退出幻灯片模式：提交未完成的编辑、隐藏容器、恢复文本容器。
 *
 * 切回文本时尽量回到当前页第一行，保持和导图一致的「位置连续」体验。
 */
export function leaveSlidesMode(): void {
    const host = getSlidesHost();
    const line = ctx.slidesApp?.getCurrentLine0() ?? null;
    ctx.slidesApp?.setActive(false);
    // 大纲恢复成普通行号显示
    ctx.outlinePanel?.setMetaProvider(null);
    host.hidden = true;
    getOrCreateEditorHost().hidden = false;
    requestAnimationFrame(() => {
        const view = ctx.editor?.getView();
        view?.requestMeasure();
        // 幻灯片期间表格列宽可能是按块编辑器的字体口径量的（测量根被
        // setMeasureRootOverride 临时切走过），回到正文后强制重排一次表格
        if (view) view.dispatch({ effects: tableRemeasureEffect.of(null) });
        // 回到幻灯片里最后看的那一页第一行（行号是 0-based，scrollToLine 要 1-based）
        if (line !== null) ctx.editor?.scrollToLine(line + 1);
    });
}

/**
 * 应用扩展侧下发的模式切换（live / viewer / source / mindmap / slides）。
 *
 * @param mode 目标模式
 */
export async function applyEditorMode(mode: EditorMode): Promise<void> {
    const previousMode = ctx.currentEditorMode;
    ctx.currentEditorMode = mode;
    if (mode === 'mindmap') {
        leaveSlidesMode();
        await enterMindmapMode();
        return;
    }
    if (mode === 'slides') {
        leaveMindmapMode();
        await enterSlidesMode();
        return;
    }
    leaveSlidesMode();
    leaveMindmapMode();
    if (ctx.editor && ctx.editor.isReady()) {
        ctx.editor.setMode(mode);
        // 三个文本模式互切：永远回到最近一次光标 / 鼠标位置。
        // 切出 / 切入导图、幻灯片时不插手 —— 它们有自己的位置恢复逻辑。
        // setMode 重配了装饰，行高与折行都会变，等一帧重新测量后再滚，
        // 否则滚到的是旧布局的行位置。
        const isTextMode = (value: EditorMode | null | undefined): boolean =>
            value === 'live' || value === 'viewer' || value === 'source';
        if (
            previousMode !== mode &&
            isTextMode(previousMode) &&
            isTextMode(mode)
        ) {
            const line = ctx.editor.getCurrentLine();
            requestAnimationFrame(() => {
                const view = ctx.editor?.getView();
                view?.requestMeasure();
                ctx.editor?.revealLine(line);
            });
        }
    }
}

/**
 * 获取右侧大纲面板的初始宽度。
 *
 * 优先读取 HTML 注入的 CSS 变量，这样页面首次渲染时就能直接使用
 * 扩展端保存的宽度；如果读取失败，则回退到默认值。
 *
 * @returns 右侧大纲面板初始宽度，单位像素
 */
export function getInitialOutlineWidth(): number {
    const rawWidth = getComputedStyle(document.documentElement).getPropertyValue(
        '--livewritemd-outline-width'
    );
    const parsedWidth = Number.parseFloat(rawWidth);
    if (!Number.isFinite(parsedWidth) || parsedWidth <= 0) {
        return 280;
    }
    return Math.round(parsedWidth);
}

/**
 * 同步当前编辑器光标所在行到右侧大纲。
 *
 * 这样大纲高亮会跟随正文光标移动，而不是长期停留在第一条标题上。
 *
 * @returns void
 */
export function syncOutlineActiveLine(): void {
    if (!ctx.editor || !ctx.editor.isReady()) {
        return;
    }

    try {
        ctx.outlinePanel?.setActiveLine(ctx.editor.getCurrentLine());
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        sendLog('ERROR', `Sync outline active line skipped: ${errorMessage}`);
    }
}

/**
 * 判断事件目标是否属于需要自行保留焦点的交互控件。
 *
 * @param target - 待检查的事件目标或当前激活元素。
 * @returns 如果目标属于搜索面板、表单控件或可编辑元素则返回 true。
 */
export function isInteractiveFocusTarget(target: EventTarget | Element | null): boolean {
    if (!(target instanceof Element)) {
        return false;
    }

    // 搜索面板和原生表单控件需要保留自身焦点，避免被正文编辑器抢走。
    return Boolean(
        target.closest(
            '.cm-search, input, textarea, select, button, [contenteditable="true"], [role="textbox"]'
        )
    );
}
