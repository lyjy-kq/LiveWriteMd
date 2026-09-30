/**
 * Live Preview Decorations
 *
 * Pre-built Decoration instances and HighlightStyle definitions.
 *
 * @module webview/codemirror/extensions/livePreview/decorations
 */

import { Decoration } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// =============================================================================
// Pre-built Decorations
// =============================================================================

/** Hides content by replacing it with nothing */
export const hideDeco = Decoration.replace({});

/**
 * 被 widget 顶替掉的源码：压 0 宽**盖住**，但不从文档里换掉。
 *
 * 行内公式、单元格里的复选框都走这个：KaTeX 排版和复选框都是 widget，
 * 源码本身没用了，可要是不留在文档里、直接 `replace` 掉，会连带两件事一起坏：
 * 一是表格单元格的「格子」是个 mark 包出来的盒子，格子里整段都是 replace 时
 * CodeMirror 会把那个 mark 一起丢掉，格子就塌了；二是光标再也走不进这段源码
 * （点公式要能把光标放进去改，见 widgets.ts 的 placeMathCaret）。
 */
export const hiddenSourceDeco = Decoration.mark({ class: 'cm-md-src-hidden' });

/**
 * **块级**标记符（`# `、`> `、代码块围栏）平时压成 0 宽。
 *
 * 行内元素的标记不在这里处理——它们由 focusMarks.ts 做「就地展开 + 整体缩放」，
 * 标记是正常显示的。会用到这个 0 宽处理的只剩行首这些块级标记：
 * 它们一旦原样显示，整行（连同缩进）都会跟着挪，而它们平时又不常改，
 * 所以平时压 0 宽，等光标真的落到标记字符上（见 srcMarkActiveDeco）再露出来。
 */
export const srcMarkDeco = Decoration.mark({ class: 'cm-md-src-mark' });

/**
 * **行内**元素展开时的标记符（`**`、`` ` ``、`[`、`](地址)`）。
 *
 * 这些标记要正常占宽度、正常可见可点，只是颜色压灰一点，
 * 好和正文内容区分开；整体宽度由外层 `cm-md-src-open` 的缩放补回来。
 */
export const srcDelimDeco = Decoration.mark({ class: 'cm-md-src-delim' });

/**
 * 标记符的展开态：光标或选区碰到它时用正常字号显示。
 *
 * 标记符平时 0 宽看不见，要改 `**` 这类标记就得先让它露面，
 * 具体触发规则见 focusMarks.ts 里的说明。
 */
export const srcMarkActiveDeco = Decoration.mark({ class: 'cm-md-src-mark-active' });

/** Marks bold content */
export const boldMarkDeco = Decoration.mark({ class: 'cm-md-bold' });

/** Marks italic content */
export const italicMarkDeco = Decoration.mark({ class: 'cm-md-italic' });

/** Marks inline code content */
export const codeMarkDeco = Decoration.mark({ class: 'cm-md-code' });

/** Marks strikethrough content */
export const strikethroughMarkDeco = Decoration.mark({ class: 'cm-md-strikethrough' });

/** Marks link content */
export const linkMarkDeco = Decoration.mark({ class: 'cm-md-link' });

/** Heading line decorations per level (1-6) */
export const headingLineDecos: Record<number, Decoration> = {};
for (let level = 1; level <= 6; level++) {
    headingLineDecos[level] = Decoration.line({ class: `cm-md-heading cm-md-heading-${level}` });
}

/** Blockquote line decorations per nesting level (1-5) */
export const blockquoteLevelDecos: Decoration[] = [];
for (let level = 1; level <= 5; level++) {
    blockquoteLevelDecos.push(
        Decoration.line({ class: `cm-md-blockquote cm-md-blockquote-${level}` })
    );
}

/** Footnote definition line decoration */
export const footnoteDefLineDeco = Decoration.line({ class: 'cm-md-footnote-def' });

/** Code block line decoration */
export const codeBlockLineDeco = Decoration.line({ class: 'cm-md-codeblock' });

/** Hidden line decoration (for block widget multi-line collapse) */
export const hiddenLineDeco = Decoration.line({ class: 'cm-md-hidden-line' });

/**
 * 图片独占一行的行级装饰（让图片在正文列里居中）。
 *
 * 不能用 CSS 的 `.cm-line:has(> .cm-md-image-wrapper:only-child)` 来判断：
 * CM6 会在行内 widget 前后插一个 `<img class="cm-widgetBuffer">` 占位元素，
 * 于是 `:only-child` 永远不成立（实测确认）。改成由插件按源码判断
 * 「这一行除了图片没有别的文字」，再挂这个 class 走 text-align: center。
 */
export const imageLineDeco = Decoration.line({ class: 'cm-md-image-line' });

// =============================================================================
// Syntax Highlight Styles
// =============================================================================
        // { tag: tags.keyword, color: '#c586c0' },
        // { tag: tags.controlKeyword, color: '#c586c0' },
        // { tag: tags.operatorKeyword, color: '#c586c0' },
        // { tag: tags.definitionKeyword, color: '#c586c0' },
        // { tag: tags.moduleKeyword, color: '#c586c0' },
        // { tag: tags.operator, color: '#d4d4d4' },
        // { tag: tags.punctuation, color: '#d4d4d4' },
        // { tag: tags.bracket, color: '#ffd700' },
        // { tag: tags.string, color: '#ce9178' },
        // { tag: tags.number, color: '#b5cea8' },
        // { tag: tags.bool, color: '#569cd6' },
        // { tag: tags.null, color: '#569cd6' },
        // { tag: tags.comment, color: '#c9d1d9' },
        // { tag: tags.lineComment, color: '#c9d1d9' },
        // { tag: tags.blockComment, color: '#c9d1d9' },
        // { tag: tags.docComment, color: '#c9d1d9' },
        // { tag: tags.variableName, color: '#9cdcfe' },
        // { tag: tags.definition(tags.variableName), color: '#4fc1ff' },
        // { tag: tags.function(tags.variableName), color: '#dcdcaa' },
        // { tag: tags.typeName, color: '#4ec9b0' },
        // { tag: tags.className, color: '#4ec9b0' },
        // { tag: tags.propertyName, color: '#9cdcfe' },
        // { tag: tags.function(tags.propertyName), color: '#dcdcaa' },
        // { tag: tags.attributeName, color: '#9cdcfe' },
        // { tag: tags.tagName, color: '#569cd6' },
        // { tag: tags.angleBracket, color: '#808080' },
        // { tag: tags.regexp, color: '#d16969' },
        // { tag: tags.self, color: '#569cd6' },
        // { tag: tags.meta, color: '#d4d4d4' },
/**
 * Dark theme highlight style for code syntax within Markdown fenced blocks.
 */
export const flowMdDarkHighlight = HighlightStyle.define(
    [
        { tag: tags.keyword, color: '#af00db' },
        { tag: tags.controlKeyword, color: '#af00db' },
        { tag: tags.operatorKeyword, color: '#af00db' },
        { tag: tags.definitionKeyword, color: '#af00db' },
        { tag: tags.moduleKeyword, color: '#af00db' },
        { tag: tags.operator, color: '#000000' },
        { tag: tags.punctuation, color: '#000000' },
        { tag: tags.bracket, color: '#0431fa' },
        { tag: tags.string, color: '#a31515' },
        { tag: tags.number, color: '#098658' },
        { tag: tags.bool, color: '#0000ff' },
        { tag: tags.null, color: '#0000ff' },
        { tag: tags.comment, color: '#5f6a79' },
        { tag: tags.lineComment, color: '#5f6a79' },
        { tag: tags.blockComment, color: '#5f6a79' },
        { tag: tags.docComment, color: '#5f6a79' },
        { tag: tags.variableName, color: '#001080' },
        { tag: tags.definition(tags.variableName), color: '#0070c1' },
        { tag: tags.function(tags.variableName), color: '#795e26' },
        { tag: tags.typeName, color: '#267f99' },
        { tag: tags.className, color: '#267f99' },
        { tag: tags.propertyName, color: '#001080' },
        { tag: tags.function(tags.propertyName), color: '#795e26' },
        { tag: tags.attributeName, color: '#e50000' },
        { tag: tags.tagName, color: '#800000' },
        { tag: tags.angleBracket, color: '#800000' },
        { tag: tags.regexp, color: '#811f3f' },
        { tag: tags.self, color: '#0000ff' },
        { tag: tags.meta, color: '#000000' },
    ],
    { themeType: 'dark' }
);

/**
 * Light theme highlight style for code syntax within Markdown fenced blocks.
 */
export const flowMdLightHighlight = HighlightStyle.define(
    [
        { tag: tags.keyword, color: '#af00db' },
        { tag: tags.controlKeyword, color: '#af00db' },
        { tag: tags.operatorKeyword, color: '#af00db' },
        { tag: tags.definitionKeyword, color: '#af00db' },
        { tag: tags.moduleKeyword, color: '#af00db' },
        { tag: tags.operator, color: '#000000' },
        { tag: tags.punctuation, color: '#000000' },
        { tag: tags.bracket, color: '#0431fa' },
        { tag: tags.string, color: '#a31515' },
        { tag: tags.number, color: '#098658' },
        { tag: tags.bool, color: '#0000ff' },
        { tag: tags.null, color: '#0000ff' },
        { tag: tags.comment, color: '#5f6a79' },
        { tag: tags.lineComment, color: '#5f6a79' },
        { tag: tags.blockComment, color: '#5f6a79' },
        { tag: tags.docComment, color: '#5f6a79' },
        { tag: tags.variableName, color: '#001080' },
        { tag: tags.definition(tags.variableName), color: '#0070c1' },
        { tag: tags.function(tags.variableName), color: '#795e26' },
        { tag: tags.typeName, color: '#267f99' },
        { tag: tags.className, color: '#267f99' },
        { tag: tags.propertyName, color: '#001080' },
        { tag: tags.function(tags.propertyName), color: '#795e26' },
        { tag: tags.attributeName, color: '#e50000' },
        { tag: tags.tagName, color: '#800000' },
        { tag: tags.angleBracket, color: '#800000' },
        { tag: tags.regexp, color: '#811f3f' },
        { tag: tags.self, color: '#0000ff' },
        { tag: tags.meta, color: '#000000' },
    ],
    { themeType: 'light' }
);
