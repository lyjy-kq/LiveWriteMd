/**
 * 括号自动配对扩展。
 *
 * 在编辑器中输入左括号字符时自动补出右半括号，并把光标放在成对括号中间；
 * 若输入时存在选中文字，则用这对括号包裹选中内容。
 *
 * 基于 CodeMirror 的 EditorView.inputHandler：它在统一的文本输入路径中触发，
 * 直接键入与输入法（IME）组字上屏都会经过，因此全角括号【《同样有效。
 *
 * @module livePreview/autoPair
 */

import { EditorView } from '@codemirror/view';

/**
 * 左字符 → 右字符 的配对表。
 * key/value 都是单个字符；需要新增配对时在此登记即可。
 */
const PAIRS: Record<string, string> = {
    '[': ']',
    '{': '}',
    '(': ')',
    '【': '】',
    '《': '》',
    '<': '>',
};

/**
 * 括号自动配对的输入处理扩展，注册进 createLivePreviewExtension。
 *
 * @returns EditorView.inputHandler 扩展
 */
export function autoPairBrackets() {
    return EditorView.inputHandler.of((view, from, to, text) => {
        // 只处理「配对表里登记的单个左字符」；粘贴多字符、未登记字符一律放行
        const right = PAIRS[text];
        if (!right) return false;

        if (from < to) {
            // 有选区：用成对括号包裹选中文字，并保持内部文字处于选中态
            const selected = view.state.sliceDoc(from, to);
            view.dispatch({
                changes: { from, to, insert: text + selected + right },
                selection: { anchor: from + 1, head: from + 1 + selected.length },
            });
        } else {
            // 无选区：插入「左 + 右」，光标落在两者中间
            view.dispatch({
                changes: { from, to, insert: text + right },
                selection: { anchor: from + 1 },
            });
        }
        // 返回 true：已自行处理输入，阻止 CodeMirror 再做默认的单字符插入
        return true;
    });
}
