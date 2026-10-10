/**
 * 定制 Markdown 解析器：修正「单个 `-` / `=` 紧跟文字被当成 Setext 标题」。
 *
 * ## 背景
 *
 * CommonMark 规定 Setext 标题的下划线**最少只需一个** `-`（二级）或 `=`（一级）。
 * 于是这样的内容：
 *
 * ```markdown
 * 大脑制定了流程之后，需要执行框架实施：
 * -
 * ```
 *
 * 会被解析成 `SetextHeading2`，即第一行文字被渲染成二级标题 —— 但用户分明写的
 * 是两行。这里把 Setext 下划线的最小长度提高到 **2**：单个 `-`/`=` 保持普通
 * 段落（两行）；`--`、`---`（以及 `==`）等仍按标题解析；真正的列表项
 * （`- 内容`）本就由列表 parser 处理，不受影响。
 *
 * 通过替换 @lezer/markdown 内置的 `SetextHeading` leaf block parser 实现。
 *
 * @module webview/codemirror/extensions/markdownParser
 */

import { Language } from '@codemirror/language';
import { markdownLanguage } from '@codemirror/lang-markdown';
import type {
    BlockContext,
    LeafBlock,
    LeafBlockParser,
    Line,
    MarkdownConfig,
} from '@lezer/markdown';

/** Setext 下划线允许的最小字符数（少于它就不构成标题）。 */
const MIN_SETEXT_MARKERS = 2;

/**
 * 判定一行是不是合法 Setext 下划线，返回下划线结束位置；不合法返回 -1。
 *
 * 规则与 @lezer/markdown 内部的 `isSetextUnderline` 一致：
 *
 * - 标记字符必须全是 `-` 或全是 `=`（`line.next` 给出第一个标记字符）；
 * - 该行缩进不能 ≥4（缩进 4 是代码块）；
 * - 下划线之后只允许空格 / Tab。
 *
 * @param line - 当前行
 * @returns 下划线结束位置（不含 trailing 空白）；不合法为 -1
 */
function setextEnd(line: Line): number {
    const marker = line.next;
    if (marker !== 45 && marker !== 61) return -1; // '-' / '='
    if (line.indent >= line.baseIndent + 4) return -1;

    let pos = line.pos + 1;
    while (pos < line.text.length && line.text.charCodeAt(pos) === marker) pos++;
    const end = pos;

    // 下划线之后只能有空格(32)/Tab(9)
    while (pos < line.text.length) {
        const code = line.text.charCodeAt(pos);
        if (code !== 32 && code !== 9) return -1;
        pos++;
    }
    return end;
}

/**
 * 严格版 Setext leaf parser：下划线至少 {@link MIN_SETEXT_MARKERS} 个才升级为标题，
 * 否则按普通段落处理（`nextLine` 返回 false）。
 */
class StrictSetextParser implements LeafBlockParser {
    /**
     * 处理段落后续行。
     *
     * @param cx - 块解析上下文
     * @param line - 当前（下划线）行
     * @param leaf - 正在累积的段落块
     * @returns true 表示已消费该行并完成块；false 表示不是 Setext，交回默认段落解析
     */
    nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
        const end = setextEnd(line);
        // 不合法，或下划线字符不足（单个 - / =）→ 不做标题
        if (end < 0 || end - line.pos < MIN_SETEXT_MARKERS) return false;

        const heading = line.next === 61 ? 'SetextHeading1' : 'SetextHeading2';
        const mark = cx.elt('HeaderMark', cx.lineStart + line.pos, cx.lineStart + end);
        cx.nextLine();
        cx.addLeafElement(
            leaf,
            cx.elt(heading, leaf.start, cx.prevLineEnd(), [
                ...cx.parser.parseInline(leaf.content, leaf.start),
                mark,
            ])
        );
        return true;
    }

    /**
     * 块被外部结束（空行等）时不干预，按普通段落处理。
     *
     * @returns 恒 false
     */
    finish(): boolean {
        return false;
    }
}

/**
 * Setext parser 替换配置。
 */
const config: MarkdownConfig = {
    parseBlock: [
        {
            name: 'SetextHeading',
            leaf(): LeafBlockParser {
                return new StrictSetextParser();
            },
        },
    ],
};

/**
 * parser 替换后的 MarkdownParser。
 */
const tunedParser = markdownLanguage.parser.configure(config);

/**
 * 以 tuned parser 构造的 Markdown **语言**：复用原 markdownLanguage 的
 * languageData facet（代码块、括号、注释等配置原样保留），只替换 parser。
 *
 * 作为 `markdown({ base })` 的基础 —— markdown 期望 base 是带 `.parser` 的
 * Language（并用 `parser instanceof MarkdownParser` 校验），而不是裸 parser。
 * 此版本 @codemirror/language 的 markdownLanguage 是基类 `Language`（没有
 * LRLanguage.configure），故用 public 的 `new Language(data, parser, …, name)`。
 */
export const tunedMarkdownLanguage = new Language(
    markdownLanguage.data,
    tunedParser,
    undefined,
    markdownLanguage.name
);
