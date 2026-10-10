/**
 * 列表项 Enter 行为定制。
 *
 * ## 需求
 *
 * 在**空列表项**（如 `- 一级` 按 Enter 续出的 `- `，再按 Enter；或缩进后的
 * `  - `）按 Enter：
 *
 * - **一级**（`-` / `1.` 顶格）：整行标记删除，回到行头（退出列表）；
 * - **二级及更深**：只删除列表标记、**保留前导缩进**，光标落在原标记 `-` 的
 *   起始列 —— 即下一行与 `-` 开头对齐，而不是像默认命令那样立刻退回上一级
 *   列表项。
 *
 * 其余情况（在有内容的列表项末尾 Enter 续列表、非列表段落等）一律交回标准
 * 命令 `insertNewlineContinueMarkup`。
 *
 * @module webview/codemirror/extensions/listEnter
 */

import { EditorSelection, Prec, type Extension } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';

/**
 * 处理「空列表项按 Enter」。
 *
 * @param view - 编辑器视图
 * @returns true 表示已处理；false 表示不是空列表项，调用方应改用标准命令
 */
function emptyListEnter(view: EditorView): boolean {
    const state = view.state;
    const main = state.selection.main;
    if (!main.empty) return false;

    const pos = main.head;
    const line = state.doc.lineAt(pos);

    // 从光标位置沿语法树向上找所属 ListItem
    let listItem = syntaxTree(state).resolveInner(pos, -1);
    while (listItem && listItem.name !== 'ListItem') {
        listItem = listItem.parent ?? null;
    }
    if (!listItem) return false;

    const listMark = listItem.getChild('ListMark');
    if (!listMark) return false;

    // 空项判据：ListMark 之后到行尾没有任何非空白字符
    const rest = state.sliceDoc(listMark.to, line.to);
    if (/\S/.test(rest)) return false;

    // 标记相对行头的缩进列
    const markCol = listMark.from - line.from;

    if (markCol <= 0) {
        // 一级空项：整行清空，光标回到行头（退出列表）
        view.dispatch({
            changes: { from: line.from, to: line.to },
            selection: EditorSelection.cursor(line.from),
            userEvent: 'input',
        });
    } else {
        // 二级（或更深）空项：先删除「标记 → 行尾」，保留前导缩进
        view.dispatch({
            changes: { from: listMark.from, to: line.to },
            userEvent: 'input',
        });
        // 删除后该行只剩缩进空白。光标放到**缩进结束处**（= 原标记起始列，
        // 与 - 开头对齐）。分两步：同一事务里 selection 会被 changes 映射到
        // 删除点左侧（差一列），无法精确对齐，故删除后再单独放置。
        // assoc=-1 让光标取左侧最后一个缩进空格的矩形，竖线保持可见
        view.dispatch({ selection: EditorSelection.cursor(listMark.from, -1) });
    }
    return true;
}

/**
 * Enter 键扩展：空列表项走对齐逻辑，其余走标准续标记命令。
 *
 * 用 highest（不是 high）：@codemirror/lang-markdown 注入的默认 Enter 也是
 * Prec.high，同优先级下它先注册会先命中；业务定制必须压过语言默认行为。
 */
export const listEnterExtension: Extension = Prec.highest(
    keymap.of([
        {
            key: 'Enter',
            run(view: EditorView): boolean {
                return emptyListEnter(view) || insertNewlineContinueMarkup(view);
            },
        },
    ])
);
