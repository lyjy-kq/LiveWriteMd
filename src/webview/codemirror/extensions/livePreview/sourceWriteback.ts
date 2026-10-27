/**
 * Live Preview 装饰管线（从 plugin.ts 拆出）：源码回写助手：把 widget 上的编辑（图片宽度/标题、Mermaid 宽度/标题）写回 Markdown 源码。
 *
 * @module webview/codemirror/extensions/livePreview/sourceWriteback
 */

import { formatMediaWidthAttribute, splitTrailingWidthAttribute } from './mediaWidth.js';
import { EditorView } from '@codemirror/view';


/**
 * 使用源文本中的范围替换指定区间内容。
 *
 * 这个 helper 统一封装 WorkspaceEdit 风格的文本替换操作，避免在各个 widget
 * 回写入口里重复拼接 dispatch 细节。
 *
 * @param view - 当前 CodeMirror 视图
 * @param from - 需要替换的起始位置
 * @param to - 需要替换的结束位置
 * @param insert - 需要写回的新文本
 * @returns void
 */
export function replaceSourceRange(view: EditorView, from: number, to: number, insert: string): void {
    if (from >= to) {
        return;
    }

    if (view.state.sliceDoc(from, to) === insert) {
        return;
    }

    view.dispatch({
        changes: { from, to, insert },
    });
}


/**
 * 回写 Markdown 图片语法中的 alt 文本。
 *
 * 该函数兼容 wiki 图片和标准 Markdown 图片两种写法：
 * - wiki 图片：`![[target|alias]]`
 * - Markdown 图片：`![alt](url)`
 *
 * @param view - 当前 CodeMirror 视图
 * @param from - 图片语法起始位置
 * @param to - 图片语法结束位置
 * @param rawImageText - 图片块的原始文本
 * @param nextTitle - 用户提交的新标题
 * @returns void
 */
export function updateImageTitleInSource(
    view: EditorView,
    from: number,
    to: number,
    rawImageText: string,
    nextTitle: string
): void {
    // 先把宽度属性剥出来，改完标题再原样接回去，避免编辑标题时把宽度丢掉。
    const { base, attribute } = splitTrailingWidthAttribute(rawImageText);

    const wikiMatch = base.match(/^!\[\[([^\]\n]+?)\]\]$/);
    if (wikiMatch) {
        const [rawTarget] = wikiMatch[1].split('|', 2);
        const title = nextTitle.trim();
        const nextValue = title ? `![[${rawTarget.trim()}|${title}]]` : `![[${rawTarget.trim()}]]`;
        replaceSourceRange(view, from, to, `${nextValue}${attribute}`);
        return;
    }

    const markdownMatch = base.match(/^!\[([^\]]*?)\]\(([^)\n]+)\)$/);
    if (markdownMatch) {
        const destination = markdownMatch[2];
        const title = nextTitle.trim();
        const nextValue = `![${title}](${destination})`;
        replaceSourceRange(view, from, to, `${nextValue}${attribute}`);
    }
}


/**
 * 回写图片的宽度属性。
 *
 * `from`/`to` 已经覆盖了原有的宽度属性（decoration 范围特意往后多圈了一段），
 * 所以这里在去掉属性后的基础语法上重新追加，不会出现属性叠加。
 *
 * @param view - 当前 CodeMirror 视图
 * @param from - 图片语法起始位置（含尾随属性）
 * @param to - 图片语法结束位置（含尾随属性）
 * @param rawImageText - 整段原始文本
 * @param nextPercent - 新的宽度百分比
 * @returns void
 */
export function updateImageWidthInSource(
    view: EditorView,
    from: number,
    to: number,
    rawImageText: string,
    nextPercent: number
): void {
    const { base } = splitTrailingWidthAttribute(rawImageText);
    replaceSourceRange(view, from, to, `${base}${formatMediaWidthAttribute(nextPercent)}`);
}


/**
 * 回写 Mermaid 代码块 info 行里的宽度属性。
 *
 * info 行同时承载标题（`mermaid 标题`）和宽度（`{width=50%}`），
 * 重写时先把宽度剥掉，再把新属性接到标题后面。
 *
 * @param view - 当前 CodeMirror 视图
 * @param codeInfoFrom - CodeInfo 节点起始位置
 * @param lineTo - fenced code opener 行尾部位置
 * @param nextPercent - 新的宽度百分比
 * @returns void
 */
export function updateMermaidWidthInSource(
    view: EditorView,
    codeInfoFrom: number,
    lineTo: number,
    nextPercent: number
): void {
    const rawInfo = view.state.sliceDoc(codeInfoFrom, lineTo);
    const baseInfo = splitTrailingWidthAttribute(rawInfo).base.trimEnd();
    const attribute = formatMediaWidthAttribute(nextPercent);
    replaceSourceRange(view, codeInfoFrom, lineTo, attribute ? `${baseInfo} ${attribute}` : baseInfo);
}


/**
 * 回写 Mermaid 代码块的标题文本。
 *
 * 这里采用 fenced code block info 行的扩展写法：
 * `mermaid` 后面允许追加一个标题词组，便于在预览标题中编辑后同步保存。
 *
 * @param view - 当前 CodeMirror 视图
 * @param codeInfoFrom - CodeInfo 节点起始位置
 * @param lineTo - 当前 fenced code opener 行尾部位置
 * @param nextTitle - 用户提交的新标题
 * @returns void
 */
export function updateMermaidTitleInSource(
    view: EditorView,
    codeInfoFrom: number,
    lineTo: number,
    nextTitle: string
): void {
    const title = nextTitle.trim();
    const nextValue = title ? `mermaid ${title}` : 'mermaid';
    // 同图片：标题写在 info 行前面，宽度属性原样保留在后面。
    const attribute = splitTrailingWidthAttribute(view.state.sliceDoc(codeInfoFrom, lineTo)).attribute;
    replaceSourceRange(view, codeInfoFrom, lineTo, `${nextValue}${attribute}`);
}
