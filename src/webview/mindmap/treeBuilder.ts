/**
 * Markdown -> 导图树构建器（设计文档 §4）。
 *
 * 规则：
 * - 虚拟根 = 文件名；H1-H6 为骨（含 setext 标题），跳级挂到最近的更浅标题；
 * - 列表项为叶（嵌套列表 -> 子节点），有序/无序保留在 _listOrdered；
 * - 段落作为标题/列表项的 para 子节点，超过 50 字符截断显示、全文入 note；
 * - 代码块 / 图片独占段 / 表格进导图（媒体节点）；front matter 作为根节点
 *   固定首位的 meta 子节点进导图（任务 14）；引用块 / 数学块 / HTML 块 /
 *   分隔线不进导图；行内公式、行内代码等保留在节点文本里；
 * - 子节点顺序 = 源文档行号顺序；uid 为路径式（"0/2/1"）。
 *
 * 解析与编辑器同源：复用 tunedMarkdownLanguage（setext 最小长度修正）并追加
 * GFM 扩展（表格 / 任务列表 / 删除线），保证代码块里的假标题假列表被天然排除。
 */

import { GFM } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';
import { tunedMarkdownLanguage } from '../codemirror/extensions/markdownParser.js';
import type {
    MindMapNodeKind,
    MindMapTreeNode,
    NodeLineRange,
} from './types.js';

/** 段落截断阈值（字符数，按 code point 计）。 */
const PARA_TRUNCATE_LENGTH = 50;

/**
 * 导图用 markdown 解析器：编辑器同款 tuned parser + GFM（表格识别后才能跳过表格）。
 */
const mindmapParser = tunedMarkdownLanguage.parser.configure([GFM]);

/** 构建期内部节点（额外携带自身行区间，finalize 时折算进 _lineRange）。 */
interface BuildNode {
    kind: MindMapNodeKind;
    text: string;
    note?: string;
    headingLevel?: number;
    listOrdered?: boolean;
    /** 代码块节点的语言标识。 */
    language?: string;
    /** 图片节点地址 / 替代文本。 */
    imageUrl?: string;
    imageAlt?: string;
    /** 自身内容起始行（0-based）。 */
    ownFromLine: number;
    /** 自身内容结束行（0-based，含）。 */
    ownToLine: number;
    children: BuildNode[];
}

/**
 * 由 Markdown 全文构建导图树。
 *
 * @param markdown 源文档全文
 * @param fileName 文件名（不含扩展名），用作虚拟根文本
 * @returns simple-mind-map 树数据
 */
export function buildMindMapTree(markdown: string, fileName: string): MindMapTreeNode {
    const doc = markdown.length > 0 ? markdown : '';
    const tree = mindmapParser.parse(doc);
    const lines = collectLineStarts(doc);
    const lineOf = (pos: number): number => positionToLine(lines, pos);

    const root: BuildNode = {
        kind: 'root',
        text: fileName || '未命名',
        ownFromLine: 0,
        ownToLine: Math.max(0, lines.length - 1),
        children: [],
    };

    // 标题栈：栈顶是当前块内容归属的最近标题
    const headingStack: Array<{ level: number; node: BuildNode }> = [];

    const frontMatterEndLine = detectFrontMatterEndLine(doc);

    /** 当前块级内容的挂载点：有标题挂标题，否则挂虚拟根。 */
    const currentParent = (): BuildNode =>
        headingStack.length > 0 ? headingStack[headingStack.length - 1].node : root;

    const documentNode = tree.topNode;
    const topBlocks: SyntaxNode[] = [];
    for (let b = documentNode.firstChild; b; b = b.nextSibling) {
        topBlocks.push(b);
    }
    /** tuned parser 把 3+ 短横线的 setext 下划线误判成「段落 + 分隔线」，
     *  这里记录哪些 Paragraph 应提升为二级标题、哪些 HorizontalRule 要跳过。 */
    const promotedParagraphs = new Set<SyntaxNode>();
    const underlineHrNodes = new Set<SyntaxNode>();
    for (let i = 0; i + 1 < topBlocks.length; i++) {
        const para = topBlocks[i];
        const hr = topBlocks[i + 1];
        if (
            para.name === 'Paragraph' &&
            hr.name === 'HorizontalRule' &&
            // setext：文字行与下划线行之间没有空行，只隔一个换行
            hr.from - para.to === 1
        ) {
            const underlineText = doc.slice(hr.from, hr.to);
            const dashes = Array.from(underlineText).filter((ch) => ch === '-').length;
            // 与项目 StrictSetextParser 的最小长度一致（2 个字符）
            if (dashes >= 2) {
                promotedParagraphs.add(para);
                underlineHrNodes.add(hr);
            }
        }
    }

    /**
     * 标题续行：标题块（ATX / setext / 被提升的 setext 段落）**下一行紧挨着**
     * 的普通段落，并回标题节点。
     *
     * 这样导图里一个标题节点可以按 Enter 在格子里换行（提交后 md 是
     * `## 标题` + 紧跟的正文行），重建时仍是同一个节点，而不是冒出一个
     * 独立的 para 子节点。注意只认「中间没有空行」的段落 —— 空行是用户
     * 明确分隔段落的信号，这时仍然是两个节点。
     */
    const headingContinuationParagraphs = new Set<SyntaxNode>();
    const headingExtraEndLine = new Map<SyntaxNode, number>();
    /** 标题块自身的结束行与「下一候选块」下标。 */
    const headingBlockInfo = (
        index: number
    ): { endLine: number; nextIndex: number } | null => {
        const block = topBlocks[index];
        if (!block) return null;
        if (
            block.name.startsWith('ATXHeading') ||
            block.name === 'SetextHeading1' ||
            block.name === 'SetextHeading2'
        ) {
            return { endLine: lineOf(block.to - 1), nextIndex: index + 1 };
        }
        if (block.name === 'Paragraph' && promotedParagraphs.has(block)) {
            // 提升的 setext：标题块 = 文字行 + 下划线行（下划线是下一个块）
            const hr = topBlocks[index + 1];
            if (!hr || !underlineHrNodes.has(hr)) return null;
            return { endLine: lineOf(hr.to - 1), nextIndex: index + 2 };
        }
        return null;
    };
    topBlocks.forEach((block, index) => {
        const info = headingBlockInfo(index);
        if (!info) return;
        const next = topBlocks[info.nextIndex];
        if (!next || next.name !== 'Paragraph') return;
        if (promotedParagraphs.has(next) || underlineHrNodes.has(next)) return;
        // 有空行就不合并（段落起点必须正好在标题块结束的下一行）
        if (lineOf(next.from) !== info.endLine + 1) return;
        headingContinuationParagraphs.add(next);
        headingExtraEndLine.set(block, lineOf(next.to - 1));
    });

    topBlocks.forEach((node) => visitTopLevelBlock(node));

    // front matter → 根节点固定首位的 meta 子节点（任务 14）：
    // 无 front matter（detectFrontMatterEndLine 返回 -1）时不产生该节点。
    // 注意它会占据 uid 0/0，其余根子节点的路径式 uid 顺次后移
    if (frontMatterEndLine >= 0) {
        root.children.unshift({
            kind: 'meta',
            text: '元数据',
            ownFromLine: 0,
            ownToLine: frontMatterEndLine,
            children: [],
        });
    }

    /** 处理文档顶层块。 */
    function visitTopLevelBlock(node: SyntaxNode): void {
        // 被提升为 setext 二级标题的下划线行跳过
        if (underlineHrNodes.has(node)) return;
        // front matter 范围内的 hr/paragraph 全部跳过
        if (lineOf(node.from) <= frontMatterEndLine) return;

        if (node.name === 'ATXHeading1' ||
            node.name === 'ATXHeading2' ||
            node.name === 'ATXHeading3' ||
            node.name === 'ATXHeading4' ||
            node.name === 'ATXHeading5' ||
            node.name === 'ATXHeading6') {
            pushHeading(node, Number(node.name.slice(-1)));
            return;
        }
        if (node.name === 'SetextHeading1' || node.name === 'SetextHeading2') {
            // setext 节点跨两行（文字行 + 下划线行），文字取第一行
            pushHeading(node, node.name === 'SetextHeading1' ? 1 : 2);
            return;
        }
        // 标题后面紧挨着的续行段落：已经并进标题节点的自身区间，跳过
        if (node.name === 'Paragraph' && headingContinuationParagraphs.has(node)) {
            return;
        }
        // tuned parser 漏判的 3+ 短横线 setext 二级标题（见上面的提升逻辑）
        if (node.name === 'Paragraph' && promotedParagraphs.has(node)) {
            pushHeadingFromText(
                doc.slice(node.from, node.to).trim(),
                lineOf(node.from),
                headingExtraEndLine.get(node) ?? lineOf(node.to),
                2
            );
            return;
        }
        if (node.name === 'BulletList' || node.name === 'OrderedList') {
            appendListItems(node, currentParent(), node.name === 'OrderedList');
            return;
        }
        // 媒体节点：代码块 / mermaid / 表格进导图（设计文档 §6 + 迭代 N1）
        if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
            // mermaid 围栏单独成一类（显示态渲染图，而不是代码文本）
            const info = node.getChildren('CodeInfo')[0];
            const lang = info ? doc.slice(info.from, info.to).trim().toLowerCase() : '';
            appendMediaBlock(node, currentParent(), lang === 'mermaid' ? 'mermaid' : 'code');
            return;
        }
        if (node.name === 'Table') {
            appendMediaBlock(node, currentParent(), 'table');
            return;
        }
        if (node.name === 'Paragraph') {
            // 整段都是 $$ 数学块：作为 math 媒体节点进导图（迭代 N1）
            if (isDisplayMathParagraph(doc, node)) {
                appendMediaBlock(node, currentParent(), 'math');
                return;
            }
            appendParagraphIfUseful(node, currentParent());
            return;
        }
        // Blockquote / HTMLBlock / HorizontalRule 等非树内容：直接跳过
    }

    /**
     * 代码块 / 表格 / 数学块 / mermaid → 媒体节点
     * （摘要文本 + 行区间，渲染时按行区间从源文档取内容）。
     */
    function appendMediaBlock(
        node: SyntaxNode,
        parent: BuildNode,
        kind: 'code' | 'table' | 'math' | 'mermaid'
    ): void {
        const fromLine = lineOf(node.from);
        const toLine = lineOf(node.to - 1);
        const src = doc.slice(node.from, node.to);
        let language: string | undefined;
        let text: string;
        if (kind === 'code' || kind === 'mermaid') {
            // fenced 代码块的语言在 CodeInfo 子节点上；缩进代码块没有语言
            const info = node.getChildren('CodeInfo')[0];
            language = info ? doc.slice(info.from, info.to).trim() || undefined : undefined;
            const contentLines =
                node.name === 'FencedCode'
                    ? Math.max(0, toLine - fromLine - 1)
                    : toLine - fromLine + 1;
            text =
                kind === 'mermaid'
                    ? `mermaid 图 · ${contentLines} 行`
                    : `${language || '代码'} · ${contentLines} 行`;
        } else if (kind === 'math') {
            text = `数学 · ${toLine - fromLine + 1} 行`;
        } else {
            // 表格：表头 + 分隔行 + 数据行；摘要给「行 × 列」
            const tableLines = src.split('\n').filter((line) => line.trim() !== '');
            const dataRows = Math.max(0, tableLines.length - 2);
            const cols = (tableLines[0] ?? '')
                .split('|')
                .filter((cell) => cell.trim() !== '').length;
            text = `表格 ${dataRows} 行 × ${cols} 列`;
        }
        parent.children.push({
            kind,
            text,
            language,
            // note 放源码全文（悬浮提示）；编辑初值另按 _lineRange 从源文档取
            note: src,
            ownFromLine: fromLine,
            ownToLine: toLine,
            children: [],
        });
    }

    /** 压入一个标题节点，按层级维护标题栈。 */
    function pushHeading(node: SyntaxNode, level: number): void {
        // 标题节点自身的结束行要带上「紧挨着的续行段落」（headingExtraEndLine）：
        // 用户在导图里按 Enter 在标题格子里换行后，md 是「# 标题」+ 下一行正文，
        // 重建时必须仍是同一个标题节点，续行也属于它的 _selfLineRange。
        pushHeadingFromText(
            extractHeadingText(doc, node),
            lineOf(node.from),
            headingExtraEndLine.get(node) ?? lineOf(node.to - 1),
            level
        );
    }

    /** 以显式文本与行区间压入标题节点。 */
    function pushHeadingFromText(
        text: string,
        fromLine: number,
        toLine: number,
        level: number
    ): void {
        while (
            headingStack.length > 0 &&
            headingStack[headingStack.length - 1].level >= level
        ) {
            headingStack.pop();
        }
        const parent = currentParent();
        const heading: BuildNode = {
            kind: 'heading',
            text,
            headingLevel: level,
            ownFromLine: fromLine,
            ownToLine: toLine,
            children: [],
        };
        parent.children.push(heading);
        headingStack.push({ level, node: heading });
    }

    /** 递归把一个 List 下的 ListItem 转成列表节点，挂到 parent。 */
    function appendListItems(
        listNode: SyntaxNode,
        parent: BuildNode,
        ordered: boolean
    ): void {
        let item = listNode.firstChild;
        while (item) {
            if (item.name === 'ListItem') {
                parent.children.push(buildListItem(item, ordered));
            }
            item = item.nextSibling;
        }
    }

    /** 单个 ListItem -> 列表节点（首段为自身文字，嵌套列表/后续段落为子节点）。 */
    function buildListItem(itemNode: SyntaxNode, ordered: boolean): BuildNode {
        const node: BuildNode = {
            kind: 'list',
            text: '',
            listOrdered: ordered,
            ownFromLine: lineOf(itemNode.from),
            ownToLine: lineOf(itemNode.from),
            children: [],
        };
        let firstContent: SyntaxNode | null = null;
        let child = itemNode.firstChild;
        while (child) {
            // 任务列表项的行内内容包在 Task 节点里（不一定有 Paragraph）
            if (child.name === 'Paragraph' || child.name === 'Task') {
                if (!firstContent) {
                    firstContent = child;
                    node.text = extractListItemText(doc, child);
                    node.ownToLine = lineOf(child.to - 1);
                } else {
                    // 列表项里的后续段落 -> para 子节点（保持源顺序）
                    appendParagraphIfUseful(child, node);
                }
            } else if (child.name === 'BulletList' || child.name === 'OrderedList') {
                appendListItems(child, node, child.name === 'OrderedList');
            } else if (child.name === 'FencedCode' || child.name === 'CodeBlock') {
                // 列表项内的代码块 → 该列表节点的 code 子节点（mermaid 单独成类）
                const info = child.getChildren('CodeInfo')[0];
                const lang = info ? doc.slice(info.from, info.to).trim().toLowerCase() : '';
                appendMediaBlock(child, node, lang === 'mermaid' ? 'mermaid' : 'code');
            } else if (child.name === 'Table') {
                appendMediaBlock(child, node, 'table');
            }
            // 列表项内的引用 / HTML 块等仍跳过
            child = child.nextSibling;
        }
        // 兜底：极端情况下没有 Paragraph 子节点
        if (!firstContent) {
            node.text = '';
        }
        return node;
    }

    /** 段落有可用文字时作为 para 节点挂到 parent。 */
    function appendParagraphIfUseful(paraNode: SyntaxNode, parent: BuildNode): void {
        const raw = doc.slice(paraNode.from, paraNode.to);
        const text = raw.replace(/\s+$/, '');
        if (!text.trim()) return;
        // $$ 数学块（含跨行的裸段落写法）不进导图
        if (text.trimStart().startsWith('$$')) return;
        // 纯图片段落 → image 媒体节点（取第一张图；多图段落其余图不进导图）
        if (stripInlineImages(text).trim().length === 0) {
            const imageMatch = /!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/.exec(text);
            if (!imageMatch) return;
            parent.children.push({
                kind: 'image',
                text: imageMatch[1] || '图片',
                imageUrl: imageMatch[2],
                imageAlt: imageMatch[1],
                note: text.trim(),
                ownFromLine: lineOf(paraNode.from),
                ownToLine: lineOf(paraNode.to - 1),
                children: [],
            });
            return;
        }

        const fullText = text.trim();
        const chars = Array.from(fullText);

        // 节点不再按字数截断：显示侧由「节点尺寸上限」（max-width + line-clamp）
        // 统一截断并加省略号，note 保留全文用于悬浮提示与编辑初值。
        parent.children.push({
            kind: 'para',
            text: fullText,
            note: chars.length > PARA_TRUNCATE_LENGTH ? fullText : undefined,
            ownFromLine: lineOf(paraNode.from),
            ownToLine: lineOf(paraNode.to - 1),
            children: [],
        });
    }

    return finalize(root);
}

/**
 * 后处理：路径式 uid、展开标志、子树行区间，转成对外树类型。
 */
function finalize(root: BuildNode): MindMapTreeNode {
    const convert = (node: BuildNode, uid: string): MindMapTreeNode => {
        let toLine = node.ownToLine;
        const children = node.children.map((child, index) => {
            const converted = convert(child, `${uid}/${index}`);
            if (converted.data._lineRange) {
                toLine = Math.max(toLine, converted.data._lineRange.toLine);
            }
            return converted;
        });

        const payload: MindMapTreeNode['data'] = {
            text: node.text,
            expand: true,
            uid,
            _kind: node.kind,
        };
        if (node.note !== undefined) payload.note = node.note;
        if (node.headingLevel !== undefined) payload._headingLevel = node.headingLevel;
        if (node.listOrdered !== undefined) payload._listOrdered = node.listOrdered;
        if (node.language !== undefined) payload._language = node.language;
        if (node.imageUrl !== undefined) payload._imageUrl = node.imageUrl;
        if (node.imageAlt !== undefined) payload._imageAlt = node.imageAlt;
        if (node.kind !== 'root') {
            const range: NodeLineRange = { fromLine: node.ownFromLine, toLine };
            payload._lineRange = range;
            // 自身内容区间：不吸收子节点。列表项渲染/改名只认这个，
            // 否则父节点会把嵌套子列表的源码一起画进自己的格子里。
            payload._selfLineRange = {
                fromLine: node.ownFromLine,
                toLine: node.ownToLine,
            };
        }
        return { data: payload, children };
    };
    return convert(root, '0');
}

/**
 * 提取 ATX/setext 标题的行内 md 源码（去掉 # 前导与可选闭合 #）。
 */
function extractHeadingText(doc: string, node: SyntaxNode): string {
    if (node.name === 'SetextHeading1' || node.name === 'SetextHeading2') {
        const firstLineEnd = doc.indexOf('\n', node.from);
        return doc.slice(node.from, firstLineEnd === -1 ? node.to : firstLineEnd).trim();
    }
    // ATX：用 HeaderMark 之后的位置，避免手工数 #
    const mark = node.getChildren('HeaderMark')[0];
    const contentStart = mark ? mark.to : node.from;
    let text = doc.slice(contentStart, node.to).trim();
    // 去掉 ATX 结尾的闭合序列（"文字  ###"）
    text = text.replace(/\s+#+\s*$/, '').trim();
    return text;
}

/**
 * 列表项首段文字：保留任务标记 [ ]/[x]，仅去掉列表 marker 与缩进。
 */
function extractListItemText(doc: string, paragraph: SyntaxNode): string {
    // Paragraph 范围已在 ListMark 之后，直接取源码；跨行段落保留换行
    return doc
        .slice(paragraph.from, paragraph.to)
        .split('\n')
        .map((line) => line.trim())
        .filter((line, index) => !(index > 0 && line === ''))
        .join('\n')
        .trim();
}

/** 去掉行内图片 markdown，用于判断一个段落是否「纯图片」。 */
function stripInlineImages(text: string): string {
    return text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
}

/**
 * 整段是不是 $$ 数学块（迭代 N1）。
 *
 * 判定与 live 的公式收集器一致按文本特征：去掉首尾空白后
 * 以 `$$` 开头并以 `$$` 结尾（单行 `$$x$$` 与跨行 `$$...$$` 都算；
 * 裸的 `$$`（长度不足）不算，避免把未闭合的孤行误判成数学块）。
 */
function isDisplayMathParagraph(doc: string, node: SyntaxNode): boolean {
    const text = doc.slice(node.from, node.to).trim();
    return text.length > 4 && text.startsWith('$$') && text.endsWith('$$');
}

/**
 * 识别 YAML front matter 占据的行数。
 *
 * lezer 把开头的 `---` 解析成分隔线（后接段落、再一条分隔线），
 * 这里按文本特征独立判定：首行是 `---`，其后最近的 `---`/`...` 行为止。
 *
 * @returns front matter 结束行（0-based，含）；没有时返回 -1
 */
function detectFrontMatterEndLine(doc: string): number {
    if (!doc.startsWith('---')) return -1;
    const firstLineEnd = doc.indexOf('\n');
    if (firstLineEnd === -1) return -1;
    const lines = doc.split('\n');
    for (let i = 1; i < Math.min(lines.length, 200); i++) {
        const trimmed = lines[i].trim();
        if (trimmed === '---' || trimmed === '...') {
            return i;
        }
    }
    return -1;
}

/** 预计算每行起始偏移。 */
function collectLineStarts(doc: string): number[] {
    const starts: number[] = [0];
    for (let i = 0; i < doc.length; i++) {
        if (doc[i] === '\n') starts.push(i + 1);
    }
    return starts;
}

/** 二分把偏移换算成 0-based 行号。 */
function positionToLine(lineStarts: number[], pos: number): number {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= pos) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}
