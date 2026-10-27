/**
 * Live Preview 装饰管线（从 plugin.ts 拆出）：链接收集器：标题锚点（含闪烁 StateField）+ 文档内链 / 带空格链接 / 文件路径链接。
 *
 * @module webview/codemirror/extensions/livePreview/collectLinks
 */

import { findFileLinkMatches } from '../../../../shared/link/fileLink.js';
import { matchHeadingIndex } from '../../../../shared/link/internalLink.js';
import { hideDeco } from './decor/decorations.js';
import { windowLines } from './ranges.js';
import { livePreviewDisplayOnly } from './state.js';
import type { ILineRange } from './types.js';
import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';


// =============================================================================
// 文档内链接（内链）
//
// 内链 = 指向本文档某个标题的链接：`[[#标题]]`（wiki 风格）与
// `[文字](#标题)`（标准 Markdown）两种写法等价。匹配规则「精确优先 +
// slug 回退、同名取第一个」在 shared/internalLink.ts 里，导图侧共用。
// =============================================================================

/** 一个标题锚点：标题文字（去掉 `#` 标记）+ 文档位置。 */
export interface HeadingAnchor {
    text: string;
    from: number;
}


/**
 * 标题锚点缓存：语法树对象不变则标题列表不变。
 *
 * 文档编辑后 Lezer 会产出新树，缓存自然失效；增量解析中途拿到的旧树
 * 最多让断链判定晚一拍，装饰重建时会跟着新树纠正。
 */
export const headingAnchorsCache = new WeakMap<Tree, HeadingAnchor[]>();


/** 收集全文标题锚点（ATX / Setext，文档顺序）。 */
export function headingAnchorsOf(state: EditorState, tree: Tree): HeadingAnchor[] {
    const cached = headingAnchorsCache.get(tree);
    if (cached) return cached;
    const anchors: HeadingAnchor[] = [];
    tree.iterate({
        enter(node) {
            const name = node.name;
            if (name.startsWith('ATXHeading') || name.startsWith('SetextHeading')) {
                const text = state.doc
                    .sliceString(node.from, node.to)
                    .replace(/^#{1,6}\s+/, '') // 去 ATX 标记
                    .replace(/\n[=-]+\s*$/, '') // 去 Setext 下划线行
                    .trim();
                anchors.push({ text, from: node.from });
            }
            return true;
        },
    });
    headingAnchorsCache.set(tree, anchors);
    return anchors;
}


/**
 * 找内链目标标题的文档位置（精确匹配优先 + slug 回退，同名取第一个）。
 *
 * @param target - 内链目标（`#` 之后的原始文字）
 * @returns 标题节点的 from；不存在返回 -1
 */
export function findHeadingPos(state: EditorState, tree: Tree, target: string): number {
    const anchors = headingAnchorsOf(state, tree);
    const index = matchHeadingIndex(
        anchors.map((a) => a.text),
        target
    );
    return index >= 0 ? anchors[index].from : -1;
}


/**
 * 内链点击跳转后的目标行短暂高亮（1 秒）。
 *
 * 用 StateField + effect 而不是直接摸 DOM：文档编辑 / 撤销时装饰能跟着
 * tr.changes 映射，不会出现「高亮粘在错误行上」。
 */
export const anchorFlashEffect = StateEffect.define<number>();

export const anchorFlashClearEffect = StateEffect.define<null>();

export const anchorFlashLineDeco = Decoration.line({ class: 'cm-md-anchor-flash' });

export const anchorFlashField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
        for (const effect of tr.effects) {
            if (effect.is(anchorFlashEffect)) {
                const pos = Math.min(effect.value, tr.state.doc.length);
                const line = tr.state.doc.lineAt(pos);
                return Decoration.set([anchorFlashLineDeco.range(line.from)]);
            }
            if (effect.is(anchorFlashClearEffect)) return Decoration.none;
        }
        return tr.docChanged ? value.map(tr.changes) : value;
    },
    provide: (field) => EditorView.decorations.from(field),
});


/** wiki 内链 `[[#标题]]` 的逐行匹配式（`![[...]]` 图片与 `|` 别名不支持）。 */
export const WIKI_INTERNAL_LINK_RE = /\[\[#([^\]\n|]+?)\]\]/g;


/**
 * 这些语法节点内部不识别 wiki 内链。
 *
 * 注意 **Link 不能进这个集合**：`[[#x]]` 的内层 `[#x]` 会被 Lezer 标成
 * 快捷引用式 Link 节点（只有 2 个 LinkMark），按祖先一刀切会把所有
 * wiki 内链都误杀；完整的内联链接（4 个 LinkMark）在收集器里单独判断。
 */
export const WIKI_LINK_SKIP_NODES = new Set([
    'InlineCode',
    'CodeText',
    'FencedCode',
    'CodeBlock',
    'HTMLTag',
    'HTMLBlock',
    'Comment',
    'CommentBlock',
    'Image',
    // 表格单元格是另一条渲染管线（列宽按源文计量、内容经 inlineEngine 拼
    // HTML）：藏括号会让显示宽度与列宽口径对不上，v1 在表格内不识别
    'Table',
]);


/**
 * 收集 wiki 内链 `[[#标题]]` 的装饰。
 *
 * Lezer 的 Markdown 语法不认识这种写法（全文里它是纯文本 + 一个内层
 * 快捷 Link 节点），所以和文件路径一样走逐行正则。渲染方式与内联链接
 * 对齐：藏掉 `[[#` 与 `]]`，标题文字部分加链接样式；断链换灰皮、
 * 不给 data-href（点击退回普通文本行为，方便用户原地修）。
 *
 * 遵守「A 套（openScale/openWrap）不许识别 Link」：这里只产出
 * hide / mark 装饰，不进点击展开与宽度补偿体系。
 *
 * @param state - 当前编辑器状态
 * @param decos - 待写入的装饰数组
 * @param range - 渲染窗口
 * @param focusedRange - 当前源码区间（聚焦行保持源码）
 * @param tree - 当前语法树
 */
export function collectWikiInternalLinkDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    focusedRange: ILineRange,
    tree: Tree
): void {
    const win = windowLines(state, range);
    // 导图节点的 mini-CM 是节点级小文档，没有全文标题可比对，
    // 断链判定只对主编辑器做（见 state.ts 的 livePreviewDisplayOnly）
    const displayOnly = state.facet(livePreviewDisplayOnly);
    for (let ln = win.first; ln <= win.last; ln++) {
        const line = state.doc.line(ln);
        // 快速跳过：没有 `[[` 的行不可能有 wiki 内链
        if (!line.text.includes('[[')) continue;
        WIKI_INTERNAL_LINK_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = WIKI_INTERNAL_LINK_RE.exec(line.text))) {
            const from = line.from + match.index;
            const to = from + match[0].length;
            // `![[...]]` 是 wiki 图片，不是内链
            if (match.index > 0 && line.text[match.index - 1] === '!') continue;
            // 聚焦区间（光标 / 选区所在块）保持源码形态
            if (from < focusedRange.to && to > focusedRange.from) continue;
            // 代码 / 图片 / 完整内联链接内部不识别
            let skip = false;
            let node: SyntaxNode | null = tree.resolveInner(from + 1, 1);
            while (node) {
                if (WIKI_LINK_SKIP_NODES.has(node.name)) {
                    skip = true;
                    break;
                }
                // 完整内联链接 `[a](b)` 里的 `[[#x]]` 不识别；
                // 内层快捷 Link（2 个 LinkMark）就是 wiki 内链自己，放行
                if (node.name === 'Link' && node.getChildren('LinkMark').length >= 4) {
                    skip = true;
                    break;
                }
                node = node.parent;
            }
            if (skip) continue;
            const target = match[1].trim();
            if (!target) continue;
            const broken = !displayOnly && findHeadingPos(state, tree, target) < 0;

            // 藏 `[[#` 前缀与 `]]` 后缀，只留标题文字可见
            decos.push(hideDeco.range(from, from + 3));
            decos.push(hideDeco.range(to - 2, to));
            const attrs: Record<string, string> = {};
            let cls = 'cm-md-link cm-md-link-internal';
            if (broken) {
                cls += ' cm-md-link-broken';
                attrs['title'] = `未找到标题：${target}`;
            } else {
                attrs['data-href'] = `#${target}`;
                attrs['title'] = `${target}（点击跳转）`;
            }
            if (from + 3 < to - 2) {
                decos.push(
                    Decoration.mark({ class: cls, attributes: attrs }).range(from + 3, to - 2)
                );
            }
        }
    }
}


/**
 * 带空格 / 括号的文件链接兜底：`[PDF](../A Lightweight Gateway.pdf)`。
 *
 * CommonMark 不允许链接目标带空格（除非 `<>` 包裹或 %20 编码），Lezer 只把
 * 它解析成 `[PDF]` 快捷引用 + 普通文本。这里按行正则兜底，只识别**文件路径**
 * 形态的目标（`./` `../` `/` `~` / 盘符开头，或含 `/` `\` 且最后一段带扩展名），
 * 避免把 `[a](b c)` 这类普通文字误判成链接。
 */
export const SPACED_FILE_LINK_RE = /\[([^\]\n]+)\]\(((?:[^()\n]|\([^()\n]*\))*)\)/g;


/** 判断括号里的内容是不是文件路径形态。 */
export function looksLikeFilePath(dest: string): boolean {
    const t = dest.trim();
    if (!t) return false;
    // 协议 / 锚点 / 邮箱按其它通道处理
    if (t.includes('://') || t.startsWith('#') || t.startsWith('mailto:')) return false;
    const pathLike =
        /^[.~#/\\]/.test(t) || /^[a-zA-Z]:[/\\]/.test(t) || t.includes('/') || t.includes('\\');
    if (!pathLike) return false;
    // 最后一段必须带扩展名（`b c` 这种普通文字没有）
    const lastSeg = t.split(/[/\\?#]/).pop() ?? '';
    return /\.[A-Za-z0-9]{1,10}$/.test(lastSeg);
}


/**
 * 收集「带空格文件链接」的装饰（Lezer 解析失败的兜底通道）。
 *
 * 渲染与内联链接完全一致：藏掉 `[` `]` `(` `)` 与目标文本，链接文字加
 * `.cm-md-link` + data-href（点击走统一的 openFile 通道）。
 *
 * @param state - 当前编辑器状态
 * @param decos - 待写入的装饰数组
 * @param range - 渲染窗口
 * @param focusedRange - 当前源码区间（聚焦行保持源码）
 * @param tree - 当前语法树
 */
export function collectSpacedFileLinkDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    focusedRange: ILineRange,
    tree: Tree
): void {
    const win = windowLines(state, range);
    for (let ln = win.first; ln <= win.last; ln++) {
        const line = state.doc.line(ln);
        // 快速跳过：没有 `](` 的行不可能有这种链接
        if (!line.text.includes('](')) continue;
        SPACED_FILE_LINK_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = SPACED_FILE_LINK_RE.exec(line.text))) {
            const dest = match[2].trim();
            if (!looksLikeFilePath(dest)) continue;
            const from = line.from + match.index;
            const to = from + match[0].length;
            // 图片 `![alt](...)` 不在这条通道（图片走 Image 分支）
            if (match.index > 0 && line.text[match.index - 1] === '!') continue;
            // 聚焦区间保持源码
            if (from < focusedRange.to && to > focusedRange.from) continue;
            // 代码 / 图片 / 表格 / 完整链接内部不识别（与 wiki 内链同一套跳过规则）
            let skip = false;
            let node: SyntaxNode | null = tree.resolveInner(from + 1, 1);
            while (node) {
                if (WIKI_LINK_SKIP_NODES.has(node.name)) {
                    skip = true;
                    break;
                }
                // 已经解析成功的完整内联链接（含 <> / %20 形式）不需要兜底
                if (
                    node.name === 'Link' &&
                    node.from <= from &&
                    node.to >= to &&
                    node.getChildren('LinkMark').length >= 4
                ) {
                    skip = true;
                    break;
                }
                node = node.parent;
            }
            if (skip) continue;

            // 布局：`[text](dest)` —— text 可见，其余全藏
            const textFrom = from + 1;
            const textTo = textFrom + match[1].length;
            const destFrom = textTo + 2; // 跳过 `](`
            const destTo = destFrom + match[2].length;
            decos.push(hideDeco.range(from, textFrom)); // `[`
            decos.push(hideDeco.range(textTo, destFrom)); // `](`
            decos.push(hideDeco.range(destFrom, destTo)); // 目标文本
            decos.push(hideDeco.range(destTo, to)); // `)`
            if (textFrom < textTo) {
                decos.push(
                    Decoration.mark({
                        class: 'cm-md-link',
                        attributes: {
                            'data-href': dest,
                            title: `${dest}（点击打开文件）`,
                        },
                    }).range(textFrom, textTo)
                );
            }
        }
    }
}


/**
 * 收集普通文本中的文件路径装饰，用于提示可 Ctrl/Cmd+点击跳转。
 *
 * @param state - 当前编辑器状态
 * @param decos - 待写入的装饰数组
 * @param focusedRange - 当前正在编辑的聚焦区间
 * @returns void
 */
export function collectFileLinkDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    focusedRange: ILineRange
): void {
    const fileLinkDeco = Decoration.mark({ class: 'cm-md-file-link' });
    const win = windowLines(state, range);

    for (let ln = win.first; ln <= win.last; ln++) {
        const line = state.doc.line(ln);
        if (line.from < focusedRange.to && line.to > focusedRange.from) {
            continue;
        }
        // 快速跳过：路径匹配式的第一段必然含斜杠（盘符 `C:\`、`/`、`a/b` 都算），
        // 中文正文里几乎没有任何一行含斜杠 —— 这一条把整篇的逐行正则省掉了（实测 1.9ms → 0）。
        if (!line.text.includes('/') && !line.text.includes('\\')) continue;

        for (const fileLinkMatch of findFileLinkMatches(line.text)) {
            decos.push(
                fileLinkDeco.range(line.from + fileLinkMatch.start, line.from + fileLinkMatch.end)
            );
        }
    }
}
