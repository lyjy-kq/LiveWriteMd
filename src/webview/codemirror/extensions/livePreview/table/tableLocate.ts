/**
 * 表格（从 tableRender.ts 拆出）：表格定位与输入 handler：isInTableCell / findTableAt / 源码模式 / 管道符转义 / 输入法。
 *
 * @module webview/codemirror/extensions/livePreview/tableLocate
 */

import { columnWidthsFor } from './tableColumns.js';
import { sourceModeEffect, tableRemeasureEffect } from '../state.js';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';

// =============================================================================
// 定位表格 / 改文档
// =============================================================================

/**
 * 判断某个位置是不是落在表格单元格里。
 *
 * 给别的装饰用：单元格的「格子」是 mark 包出来的盒子，里面如果整段都是
 * `Decoration.replace`（比如一张图片），CodeMirror 会连盒子一起丢掉，
 * 所以这类内容在单元格里要跳过渲染，保持源码原样。
 *
 * @param tree - 语法树
 * @param pos - 文档位置
 * @returns 在某个 TableCell 里时返回 true
 */
export function isInTableCell(tree: Tree, pos: number): boolean {
    let node: SyntaxNode | null = tree.resolveInner(pos, 0);
    while (node) {
        if (node.name === 'TableCell') return true;
        if (node.name === 'Document' || node.name === 'Table') return false;
        node = node.parent;
    }
    return false;
}

/**
 * 从某个位置往上找，看它在哪张表里。
 *
 * @param state - 编辑器状态
 * @param pos - 文档位置
 * @returns Table 语法节点；不在表格里时返回 null
 */
export function findTableAt(state: EditorState, pos: number): SyntaxNode | null {
    // side = -1：双击的位置可能正好落在 Table 节点和后面内容的交界上，
    // 默认的 side=0 会往「后面那个节点」上靠，一上去就不是表格了
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    while (node) {
        if (node.name === 'Table') return node;
        if (node.name === 'Document') return null;
        node = node.parent;
    }
    return null;
}

/**
 * 双击表格 → 整张表切成源码模式（管道线、分隔行的对齐说明都露出来）。
 *
 * 表格本身是「半渲染」的（管道线藏起来、但源码就在文档里），要动结构（手写管道线、
 * 改对齐）时看源码更直接，所以留了这一手，行为和以前那个 widget 版本一样：
 * 光标点到表格外面就自动退出（见 state.ts 的 exitSourceModeIfOutside）。
 *
 * 增删行列走右键菜单（tableCommands.ts），不再靠双击。
 *
 * @returns CodeMirror 的 domEventHandlers 扩展（接进 createLivePreviewExtension）
 */
export function tableSourceModeHandler() {
    return EditorView.domEventHandlers({
        dblclick(event: MouseEvent, view: EditorView) {
            if (!view.state.facet(EditorView.editable)) return false;
            if (event.ctrlKey || event.metaKey || event.altKey) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            const table = findTableAt(view.state, pos);
            if (!table) return false;
            // 光标要在表格里，否则下面那句「光标离开就退出」会立刻把它收回去
            const selection = view.state.selection.main;
            const caretInside = selection.from >= table.from && selection.to <= table.to;
            view.dispatch({
                ...(caretInside ? {} : { selection: { anchor: table.from } }),
                effects: sourceModeEffect.of({ from: table.from, to: table.to }),
            });
            return true;
        },
    });
}

/**
 * 表格单元格里输入 `|` 时自动转义成 `\|`。
 *
 * 管道线是表格的分隔符，在单元格里直接敲一个会把这一行切成两格、整张表跟着变形。
 * 原来的 widget 方案是在写回文档时转义，现在没有写回了，就在输入这一层拦一下。
 *
 * @returns CodeMirror 的 inputHandler 扩展（接进 createLivePreviewExtension）
 */
export function tablePipeEscaper() {
    return EditorView.inputHandler.of((view, from, to, text) => {
        // 只处理单个 `|`；粘贴整段文本不拦（那是用户自己的选择）
        if (text !== '|') return false;
        let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(from, 0);
        while (node && node.name !== 'TableCell') {
            if (node.name === 'Document') return false;
            node = node.parent;
        }
        view.dispatch({
            changes: { from, to, insert: '\\|' },
            selection: { anchor: from + 2 },
        });
        return true;
    });
}

/**
 * 输入法组合结束后，给表格列宽**补一次重估**。
 *
 * 组合（敲中文拼音）期间列宽是冻结的（见 columnWidthsFor），拼音只是临时内容。
 * 选字完成后文档里才是最终中文，需要按最终内容重新算一次列宽 —— 窄了就涨回来。
 *
 * 用 `setTimeout(0)` 延后派发而不在事件里直接派发：各浏览器「最后一次 input
 * 事务」与 `compositionend` 的先后不一致，延后可以保证重估发生在**最终内容
 * 已经落盘**之后。
 *
 * @returns CodeMirror 的 domEventHandlers 扩展（接进 createLivePreviewExtension）
 */
export function tableCompositionHandler() {
    return EditorView.domEventHandlers({
        compositionend(_event: CompositionEvent, view: EditorView) {
            // 只在组合结束于表格内时补算：正文别处的中文组合不需要动表格。
            // findTableAt 只查语法树，代价很小
            if (!findTableAt(view.state, view.state.selection.main.head)) return false;
            setTimeout(() => {
                // 等待期间视图可能已销毁，dispatch 前确认还挂在 DOM 上
                if (view.dom.isConnected) {
                    view.dispatch({ effects: tableRemeasureEffect.of(null) });
                }
            }, 0);
            return false; // 不拦截事件，其他 compositionend 监听照常工作
        },
    });
}
