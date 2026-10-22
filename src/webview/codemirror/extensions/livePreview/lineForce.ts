/**
 * 行级强制源码态的交互入口（mousedown 待选 / 双击钉住）。
 *
 * ## 要解决的问题（2026-09-22 反馈）
 *
 * 拖选从 mousedown 开始，而 CodeMirror 在 mousedown 那一刻就按**当时的渲染态 DOM**
 * 把鼠标坐标换算成了文档位置。行内公式是 widget 替换（渲染宽度和源码宽度完全不同）、
 * 加粗 / 行内代码的标记又被压成 0 宽 —— 等拖出选区、这些修饰符全部展开，
 * 整行长度一变，按下时算好的落点就和实际字符对不上了。
 *
 * 而且旧的展开粒度是「光标只在哪个元素里就只展开哪个元素」：从元素**后面的
 * 普通文字**开始拖时，光标不在元素里，元素一直保持渲染态，错位尤其明显。
 *
 * ## 本插件的状态机（2026-09-22 第二次纠正）
 *
 * 关键认识：**mousedown 时绝不能先把整行展开再算坐标**，否则 CodeMirror 记下的
 * 拖拽锚点是「文本态坐标」下的字符，而不是用户在渲染态下看到、按下的那个字符 ——
 * 从公式后面起拖时起点就错了。
 *
 * 1. **mousedown（缓冲态）**：本插件**不展开任何东西**。
 *    CodeMirror 按渲染态 DOM 把鼠标坐标换算成拖拽锚点（= 看到的字符），
 *    光标落下后已有的常态逻辑只把点击位置所在的那一个元素展开成源码；
 *    点在普通文字上就什么都不展开。纯单击的整个过程里，别的元素永不展开。
 * 2. **鼠标真的拖动（移动超过 DRAG_THRESHOLD_PX）**：这时才把整行全部展开，
 *    拖拽锚点保持 mousedown 时按渲染态记下的字符不变，之后的位置换算在
 *    展开后的 DOM 上进行。
 * 3. **双击**：整行全部展开并钉住，直到选区不再与该行相交（失去焦点）、
 *    或者再次双击同一行。
 *
 * 表格、代码块、图片 / Mermaid 等有各自的点击 / 双击语义，不在本插件接管范围内，
 * 见 WIDGET_OWN_EVENT_TARGETS 与各处的提前返回。
 *
 * @module webview/codemirror/extensions/livePreview/lineForce
 */

import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, type Line } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { Tree } from '@lezer/common';
import { isInlineFormatNode } from './openScale.js';
import { isInCodeBlock } from './ranges.js';
import { settingsState } from '../../../settingsState.js';
import {
    getPendingForceRange,
    getPinnedForceRange,
    lineForceEffect,
} from './state.js';
import { tableBlockAt } from './tableRender.js';

/**
 * 「有自己的点击语义、整行待选不能打扰」的 widget 元素选择器。
 *
 * - 图片 / Mermaid：单击只把光标放进源码、外观保持渲染，双击才进源码模式，
 *   待选展开会让它们一点就散架；
 * - frontmatter / details：整块交互 widget，同上；
 * - 复选框 / 折叠箭头 / 复制按钮 / 脚注引用：mousedown 各自触发动作
 *   （勾选、折叠、复制、跳转），绝不能被展开重建打断。
 *
 * 行内 / 块级**公式**故意不在里面：点公式同样需要整行先展开，
 * 由本插件统一接管，公式自己的 placeMathCaret 仍会照常定位光标。
 */
const WIDGET_OWN_EVENT_TARGETS = [
    '.cm-md-image-wrapper',
    '.cm-md-mermaid-wrapper',
    '.cm-md-frontmatter',
    '.cm-md-details',
    '.cm-md-checkbox',
    '.cm-md-fold-arrow',
    '.cm-md-codeblock-copy',
    '.cm-md-footnote-ref',
].join(',');

/**
 * 从事件目标往上找，判断落点是不是在一个「自带点击语义」的 widget 里。
 *
 * @param target - 鼠标事件的 target
 * @returns 落在 WIDGET_OWN_EVENT_TARGETS 任一元素内部时返回 true
 */
function isWidgetOwnedTarget(target: EventTarget | null): boolean {
    // Text 节点没有 closest，先归到父元素上
    const element =
        target instanceof Element
            ? target
            : target instanceof Node
              ? target.parentElement
              : null;
    return !!element?.closest(WIDGET_OWN_EVENT_TARGETS);
}

/**
 * 这一行里有没有「展开后会露面」的行内元素（行内公式 / 加粗 / 斜体 /
 * 删除线 / 行内代码 / 链接）。
 *
 * 没有就不必设待选：展开前后外观一致，设了只是白重建一次。
 * 判据刻意「宁滥勿缺」：误判只是一次多余重建，漏判会让原始的位置错位复现。
 *
 * @param state - 编辑器状态
 * @param tree - 语法树
 * @param line - 待检查的行
 * @returns 行内含行内元素时返回 true
 */
function lineHasInlineMarkup(state: EditorState, tree: Tree, line: Line): boolean {
    // 行内公式（含 $$）是 mathCollect 用正则识别的，语法树里没有对应节点，
    // 先按字符粗判 —— $ 也可能在行内代码里（反引号中的公式照样需要整行展开）
    if (line.text.includes('$')) return true;

    // 其余行内元素走语法树；命中最外层即可，嵌套的跟着外层一起展开
    let found = false;
    tree.iterate({
        from: line.from,
        to: line.to,
        enter: (nodeRef): boolean | void => {
            if (isInlineFormatNode(nodeRef.name)) {
                found = true;
                return false; // 命中即停，不再下探
            }
        },
    });
    return found;
}

/**
 * 默认拖拽判定距离（px），可被设置项 `dragThreshold` 覆盖。
 *
 * 没超过阈值时保持缓冲态（只展开点击的单元素）；一旦超过，立即整行展开。
 * 与 tableRender 的默认手感取同一档。
 */
const DEFAULT_DRAG_THRESHOLD_PX = 4;

/**
 * 一次左键拖拽的起点信息（mousedown 时记录、mouseup 时清除）。
 */
interface DragStart {
    /** 按下时的屏幕坐标，用来和后续 mousemove 比距离 */
    x: number;
    y: number;
    /** 按下位置所在行（整行展开时的区间） */
    lineFrom: number;
    lineTo: number;
}

/**
 * 行级强制源码态的控制器 ViewPlugin：负责挂上 / 摘掉 DOM 监听器。
 *
 * mousedown 挂 contentDOM 捕获阶段只用来记录起点（不展开）；
 * mousemove 挂 window 捕获阶段 —— 必须赶在 CodeMirror 同一次 mousemove
 * 的选区计算之前完成整行展开；mouseup / blur 也挂 window。
 */
class LineForceController {
    /** 当前拖拽的起点；没有按下 / 按下位置不接管时为 null。 */
    private dragStart: DragStart | null = null;

    /**
     * @param view - 当前编辑器视图
     */
    constructor(private view: EditorView) {
        this.view.contentDOM.addEventListener('mousedown', this.onMouseDown, true);
        this.view.contentDOM.addEventListener('dblclick', this.onDblClick);
        window.addEventListener('mousemove', this.onMouseMove, true);
        window.addEventListener('mouseup', this.onMouseUp);
        window.addEventListener('blur', this.onBlur);
    }

    /** 视图销毁时摘掉全部监听器，避免泄漏和对已销毁视图 dispatch。 */
    destroy(): void {
        this.view.contentDOM.removeEventListener('mousedown', this.onMouseDown, true);
        this.view.contentDOM.removeEventListener('dblclick', this.onDblClick);
        window.removeEventListener('mousemove', this.onMouseMove, true);
        window.removeEventListener('mouseup', this.onMouseUp);
        window.removeEventListener('blur', this.onBlur);
    }

    /**
     * mousedown（捕获阶段）：只记录拖拽起点，**不展开任何内容**。
     *
     * 这样 CodeMirror 随后按渲染态 DOM 算出的拖拽锚点，就是用户看到、
     * 按下的那个字符；光标落下后单元素的展开由常态逻辑负责。
     *
     * @param event - 鼠标按下事件
     */
    private onMouseDown = (event: MouseEvent): void => {
        // 每次新按下都重新开始，旧起点（若有）作废
        this.dragStart = null;

        // 只接管左键拖拽；Shift 是「从现有选区扩展」、Alt 是矩形选择，都保持原生行为
        if (event.button !== 0 || event.shiftKey || event.altKey) return;

        const view = this.view;
        if (!view.state.facet(EditorView.editable)) return;

        // 点在自带点击语义的 widget（图片 / 复选框 / …）上：不记录、不打扰
        if (isWidgetOwnedTarget(event.target)) return;

        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return;

        // 表格有自己的 mouseSelectionStyle（格子框选），双击也有整张表源码模式；
        // 代码块聚焦时本来就是「整块源码 + 围栏」，展开前后没有差别 —— 都跳过
        if (tableBlockAt(view.state, pos)) return;
        if (isInCodeBlock(view.state, pos)) return;

        const line = view.state.doc.lineAt(pos);

        // 行里没有会露面的行内元素：拖不拖都不需要展开，不记录起点
        if (!lineHasInlineMarkup(view.state, syntaxTree(view.state), line)) return;

        // 只记下起点；整行展开与否，交给后续 mousemove 的距离判定
        this.dragStart = {
            x: event.clientX,
            y: event.clientY,
            lineFrom: line.from,
            lineTo: line.to,
        };
    };

    /**
     * mousemove（window 捕获阶段）：移动超过阈值 → 整行全部展开。
     *
     * 挂捕获阶段是为了赶在 CodeMirror 同一次 mousemove 的选区换算之前展开，
     * CM 冒泡阶段处理时 posAtCoords 拿到的就是展开后的 DOM。
     *
     * @param event - 鼠标移动事件
     */
    private onMouseMove = (event: MouseEvent): void => {
        const start = this.dragStart;
        if (!start) return;

        // 左键不知何时已松开（mouseup 没收到）：作废起点
        if (!(event.buttons & 1)) {
            this.dragStart = null;
            return;
        }

        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        // 还在阈值内：保持缓冲态（只展开点击的单元素）。
        // 阈值走设置项 dragThreshold。
        const threshold = settingsState.getNumber('dragThreshold') || DEFAULT_DRAG_THRESHOLD_PX;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return;

        const view = this.view;
        // CodeMirror 自己的选区已经非空时，getSourceRange 的拖选分支会把整行
        // 按源码显示（鼠标已滑进相邻字符盒）—— 不再设 pending，避免重复重建
        if (!view.state.selection.main.empty) return;

        // 同一行已经展开过（继续拖动）：不重复 dispatch
        const prev = getPendingForceRange(view.state);
        if (prev && prev.from === start.lineFrom && prev.to === start.lineTo) return;

        this.view.dispatch({
            effects: lineForceEffect.of({
                pending: { from: start.lineFrom, to: start.lineTo },
            }),
        });
    };

    /**
     * mouseup：清除起点和拖拽展开态。
     *
     * 真的拖出了选区时，pending 清掉后由 getSourceRange 的拖选分支继续给整行
     * 源码，外观不变；没拖动（单击）则回到「只展开光标所在元素」的常态。
     *
     * @param event - 鼠标松开事件
     */
    private onMouseUp = (event: MouseEvent): void => {
        if (event.button !== 0) return;
        this.dragStart = null;

        const view = this.view;
        // 视图已脱离 DOM（编辑器被销毁）：不能再 dispatch
        if (!view.dom.isConnected) return;
        if (!getPendingForceRange(view.state)) return;
        view.dispatch({ effects: lineForceEffect.of({ pending: null }) });
    };

    /**
     * 窗口失焦（Alt+Tab 切走等）：清除起点并立即取消拖拽展开态。
     */
    private onBlur = (): void => {
        this.dragStart = null;
        const view = this.view;
        if (!view.dom.isConnected) return;
        if (!getPendingForceRange(view.state)) return;
        view.dispatch({ effects: lineForceEffect.of({ pending: null }) });
    };

    /**
     * 双击：钉住 / 取消钉住整行源码态。
     *
     * @param event - 双击事件
     */
    private onDblClick = (event: MouseEvent): void => {
        // 设置里关闭「双击钉住源码态」：不接管，保持 CodeMirror 默认双击选词。
        if (!settingsState.getBoolean('doubleClickPin')) return;
        // 带修饰键的双击可能另有用途（如多光标），保持原生行为
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

        // 双击发生时拖拽起点作废（两次点击间的微小移动不该留下 pending）
        this.dragStart = null;

        const view = this.view;
        if (!view.state.facet(EditorView.editable)) return;

        // 双击自带语义的 widget（图片 / Mermaid 双击进源码、复选框…）：不接管
        if (isWidgetOwnedTarget(event.target)) return;

        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return;

        // 表格双击 = 整张表源码模式（tableSourceModeHandler），不接管
        if (tableBlockAt(view.state, pos)) return;
        // 代码块里双击没有额外意义（聚焦时围栏已展开），不接管
        if (isInCodeBlock(view.state, pos)) return;

        const line = view.state.doc.lineAt(pos);
        const prevPinned = getPinnedForceRange(view.state);
        // 再次双击同一行 → 取消钉住；双击别的行 → 钉住新行（旧行自然失焦退出，
        // 这里直接替换，规则与「选区离开即退出」一致）
        const sameLine =
            !!prevPinned && prevPinned.from === line.from && prevPinned.to === line.to;
        view.dispatch({
            effects: lineForceEffect.of({
                pinned: sameLine ? null : { from: line.from, to: line.to },
                // 待选态在 mouseup 时已取消；这里再带一次 null，以防事件顺序差异
                pending: null,
            }),
        });
    };
}

/** 行级强制源码态交互插件，接进 createLivePreviewExtension。 */
export const lineForcePlugin = ViewPlugin.fromClass(LineForceController);

// =============================================================================
// 原生 caret 锚定的鼠标选区（修「从公式后面起拖、锚点算到文本态」的抖动）
// =============================================================================

/**
 * 用浏览器**原生 caret hit-test** 求坐标对应的文档位置。
 *
 * 为什么必须自己取：CodeMirror 的 posAtCoords 在含行内公式的行上会走 bidi 随机
 * 扫描 —— 公式源码里的拉丁字母（`\mu`、`pi_k`）是强 LTR 字符，在中文行里
 * 形成 bidi 分段，随机扫描可能漏掉进视线的字符，返回前一个 widget 的起点。
 * 而 `caretPositionFromPoint` / `caretRangeFromPoint` 直接对**实际渲染的 DOM**
 * 做命中判定，看到哪个字就是哪个字，与用户视觉一致。
 *
 * @param view - 编辑器视图
 * @param clientX - 视口坐标 X
 * @param clientY - 视口坐标 Y
 * @returns 文档位置；取不到（老浏览器 / 节点在编辑器外）时返回 null
 */
function nativeCaretPos(
    view: EditorView,
    clientX: number,
    clientY: number
): number | null {
    const doc = view.contentDOM.ownerDocument;

    // Chrome/WebKit 系用 caretPositionFromPoint，Firefox 用 caretRangeFromPoint
    let node: Node | null = null;
    let offset = 0;
    const caretPosition = doc.caretPositionFromPoint?.(clientX, clientY);
    if (caretPosition) {
        node = caretPosition.offsetNode;
        offset = caretPosition.offset;
    } else {
        const range = doc.caretRangeFromPoint?.(clientX, clientY);
        if (!range) return null;
        node = range.startContainer;
        offset = range.startOffset;
    }

    // 命中编辑器外（理论上不会，保险）
    if (!node || !view.contentDOM.contains(node)) return null;

    // 把（DOM 节点 + 节点内偏移）换算成文档位置；
    // 节点在替换 widget 内时，posAtDOM 自然给出 widget 的文档起点（点公式即锚公式）
    try {
        return view.posAtDOM(node, offset);
    } catch {
        return null;
    }
}

/**
 * 坐标 → 文档位置：优先原生 hit-test，失败再退回 CM 的 posAtCoords。
 */
function robustPosAtCoords(
    view: EditorView,
    clientX: number,
    clientY: number
): number {
    const native = nativeCaretPos(view, clientX, clientY);
    if (native !== null) return native;
    return view.posAtCoords({ x: clientX, y: clientY }) ?? 0;
}

/**
 * 原生锚定的鼠标选区扩展。
 *
 * 只在「**单击 + 含行内元素的普通正文行**」时接管：
 * - mousedown 的锚点用原生 hit-test 求（= 渲染态看到的字符），CM 内部据此
 *   固定拖拽起点，从公式后面向前拖也不会错；
 * - 之后拖动过程中每一刻的位置同样用原生 hit-test。
 *
 * 其它情况一律返回 null、交回 CM 默认（`basicMouseSelection`）：
 * - 双击 / 三击（detail≠1）：选词、选行由默认处理，钉住仍由本文件的 dblclick 负责；
 * - 表格：格子框选由 tableCellSelection 负责；
 * - 代码块、没有行内元素的行：默认行为本来就正确。
 *
 * @returns CodeMirror 的 mouseSelectionStyle 扩展
 */
export function nativeAnchoredMouseSelection() {
    return EditorView.mouseSelectionStyle.of((view, event) => {
        // 只接管左键单击（detail=1）；双击/三击交回默认
        if (event.button !== 0 || event.detail !== 1) return null;
        if (!view.state.facet(EditorView.editable)) return null;

        // 先按原生 hit-test 拿到点击位置
        const startPos = robustPosAtCoords(view, event.clientX, event.clientY);

        // 表格 / 代码块：不接管
        if (tableBlockAt(view.state, startPos)) return null;
        if (isInCodeBlock(view.state, startPos)) return null;

        const line = view.state.doc.lineAt(startPos);
        // 没有行内元素的行：默认算法无歧义，不接管
        if (!lineHasInlineMarkup(view.state, syntaxTree(view.state), line)) return null;

        // 拖拽起点（会随文档编辑映射）与选区快照（Shift 扩展用）
        let anchorPos = startPos;
        let baseSel = view.state.selection;

        return {
            /**
             * 文档变化时把起点和选区快照映射到新坐标，与 basicMouseSelection 对齐。
             *
             * @param update - 当前视图更新
             * @returns 恒 false（不需要 CM 因 update 返回值而延迟重选）
             */
            update(update: ViewUpdate): boolean {
                if (update.docChanged) {
                    anchorPos = update.changes.mapPos(anchorPos);
                    baseSel = baseSel.map(update.changes);
                }
                return false;
            },

            /**
             * 按住 / 松开、扩展或多光标时各自的选区。
             *
             * @param current - 本次鼠标事件
             * @param extend - 是否 Shift（沿用已有选区端点）
             * @param multiple - 是否 Ctrl/Cmd（加一个选区，这里不支持多选，忽略即可）
             * @returns 该瞬间的选区
             */
            get(current: MouseEvent, extend: boolean, multiple: boolean): EditorSelection {
                const curPos = robustPosAtCoords(view, current.clientX, current.clientY);
                // 单击/起点未移动：就是一个落在该字符的光标
                let range = EditorSelection.cursor(curPos);
                // 起点与当前位置不同：选区的 **anchor 固定在拖拽起点、head 跟随**。
                // 必须用 range(anchor, head)，不能 range(min, max) —— 后者会把
                // anchor 归一化到较小位置，反向拖时起点就「跑」到另一头去了。
                if (anchorPos !== curPos && !extend) {
                    range = EditorSelection.range(anchorPos, curPos);
                }
                // Shift：从已有选区的主选区端点向当前位置扩展
                if (extend) {
                    return baseSel.replaceRange(
                        baseSel.main.extend(range.from, range.to)
                    );
                }
                // Ctrl/Cmd 多光标：追加一个选区
                if (multiple) {
                    return baseSel.addRange(range);
                }
                return EditorSelection.create([range]);
            },
        };
    });
}
