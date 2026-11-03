/**
 * 幻灯片模型：Markdown → 块序列 → 逻辑页。
 *
 * 这一层是纯函数，不碰 DOM、不创建 CodeMirror，方便单独测试和复用：
 * - 用与正文一致的 Lezer + GFM 解析（代码块里的假标题天然被排除）；
 * - 每个顶层节点是一个块，块携带 0-based 行区间，回写时按行替换；
 * - 按标题切成逻辑页；`---` 只作强制分页，不进入正文；
 * - front matter 当封面元数据，不参与分页。
 *
 * @module webview/slides/slidesModel
 */

import { GFM } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';
import { tunedMarkdownLanguage } from '../codemirror/extensions/markdownParser.js';
import { maskQuickCardLines } from '../mindmap/edit/staging.js';

export type BlockKind =
    | 'heading'
    | 'para'
    | 'list'
    | 'quote'
    | 'code'
    | 'table'
    | 'math'
    | 'mermaid'
    | 'image'
    | 'html'
    | 'hr';

export type LayoutKind =
    | 'cover'
    | 'section'
    | 'content'
    | 'two-column'
    | 'media'
    | 'quote'
    | 'code'
    /** 金句页：一句话居中大字号。 */
    | 'statement'
    /** 大数字页：整段放大，不拆数字与说明。 */
    | 'fact'
    /** 半幅图：一列图片满幅、一列文字。 */
    | 'image-split'
    /** 列表分栏：一个长列表按顶层条目对半拆成左右两列。 */
    | 'list-columns'
    /** 结束页。 */
    | 'end';

/** 可被 `<!-- layout: xxx -->` 指定的版式集合。 */
const LAYOUT_KINDS: ReadonlySet<LayoutKind> = new Set<LayoutKind>([
    'cover',
    'section',
    'content',
    'two-column',
    'media',
    'quote',
    'code',
    'statement',
    'fact',
    'image-split',
    'list-columns',
    'end',
]);

export interface DeckMeta {
    title?: string;
    subtitle?: string;
    author?: string;
    date?: string;
    theme?: string;
}

export interface SlideBlock {
    /** 稳定标识：kind + 起始行 + 源码哈希。重新解析后按行号重定位。 */
    id: string;
    kind: BlockKind;
    /** 标题级别（1-6），非标题为 undefined。 */
    level?: number;
    /** 0-based 起始行（含）。 */
    fromLine: number;
    /** 0-based 结束行（含）。 */
    toLine: number;
    /** 块源码（不含末尾空行）。 */
    source: string;
    /**
     * 渲染片段所在的树深度（1 = 顶层列表项）。普通顶层块为 0。
     *
     * 列表项被单独拆出来渲染时，源码会去掉缩进；深度只用来补回视觉层级
     * （左侧内边距），不参与 Markdown 语义。
     */
    depth?: number;
    /** 片段源码被去掉的公共缩进；回写时逐行补回。 */
    indent?: string;
    /**
     * 分页时从超长块里拆出来的片段。
     *
     * 片段只用于渲染与分页，不能回写（回写半块会把原文结构打散），
     * 所以渲染层会跳过它的点击编辑。
     */
    synthetic?: boolean;
}

/**
 * 分页单元：普通块，或列表树里的一个节点（连同它的子树）。
 *
 * 与导图一致的层级口径：
 * - 顶层块 depth = 0；
 * - 列表的顶层条目 depth = 1，嵌套条目依次 +1；
 * - 列表项里的后续段落 / 媒体 / 引用是它的子节点，depth = 父节点 + 1。
 *
 * 「同级」= parentId 与 depth 都相同。分页只在同级兄弟之间下刀，
 * 所以左右两列永远从同一层级开始（见 slidesPaginate.tryColumns）。
 */
export interface SlideItem {
    id: string;
    kind: BlockKind;
    /** 来源顶层块的 id：同一个列表拆出来的节点共享它。 */
    blockId: string;
    /** 标题级别（1-6），非标题为 undefined。 */
    level?: number;
    /** 树深度；见接口注释。 */
    depth: number;
    /** 同一父节点下的节点共享 parentId。 */
    parentId: string;
    /** 自身内容起始行（0-based，含）。 */
    fromLine: number;
    /** 自身内容结束行（0-based，含，不含子节点）。 */
    toLine: number;
    /** 含子节点的结束行。 */
    subtreeToLine: number;
    /** 自身内容源码（保留原缩进）。 */
    source: string;
    /** 自身源码的公共缩进：渲染时去掉、回写时补回。 */
    indent: string;
    /** 是否媒体节点（图片 / 代码 / 表格 / Mermaid / 公式 / HTML）。 */
    media: boolean;
    /** 列表项是否来自有序列表。 */
    ordered?: boolean;
    /** 子节点（嵌套列表项、列表项内的段落 / 媒体 / 引用）。 */
    children: SlideItem[];
    /** 超长块按行拆出来的片段：只渲染、不回写。 */
    synthetic?: boolean;
}

export interface LogicalSlide {
    index: number;
    /** 逻辑页的标题块；无标题的正文流为 undefined。 */
    heading?: SlideBlock;
    /** 展示用的正文块（不含标题）。 */
    blocks: SlideBlock[];
    /** 按硬分页切出来的段；每段至少一页。 */
    segments: SlideBlock[][];
    /** 正文节点树（列表已展开到条目）；分页与双栏判定用它。 */
    items: SlideItem[];
    /** 与 segments 一一对应的节点段。 */
    itemSegments: SlideItem[][];
    /** 显式 `<!-- layout: xxx -->` 覆盖；优先级高于自动判定。 */
    layoutOverride?: LayoutKind;
}

export interface SlidePage {
    /** 逻辑页序号；封面为 -1。 */
    logicalIndex: number;
    segmentIndex: number;
    layout: LayoutKind;
    blocks: SlideBlock[];
    /**
     * 双栏页的左右两列（每项是已经合并好的渲染片段）。
     * 有值时 renderContent 直接按列摆放，不再自行做 media/文字分类。
     */
    columns?: [SlideBlock[], SlideBlock[]];
    /** 首页才带标题块；续页只显示淡色小标题。 */
    titleBlock?: SlideBlock;
    titleFont: number;
    continued: boolean;
    /** 单块超高时按块 id 记录缩放比例。 */
    fitScales: Map<string, number>;
    overflow: boolean;
}

export interface Deck {
    fullText: string;
    /**
     * 解析用副本：快速卡片行被清空后的全文（行数与 fullText 完全一致）。
     *
     * 卡片是右侧栏的旁注，不应该变成幻灯片。逐行清空卡片区（见
     * maskQuickCardLines）既能把卡片从语法树里抹掉，又保持所有块的行号
     * 不变，所以 fromLine/toLine、回写区间、大纲页码全部照旧。
     * 需要原文的地方（commitBlock 回写、保存、卡片解析）仍用 fullText。
     */
    parseText: string;
    blocks: SlideBlock[];
    /** 所有正文节点（顶层；列表项带 children）。 */
    items: SlideItem[];
    logical: LogicalSlide[];
    slideLevel: number;
    meta: DeckMeta;
}

/** 标题分页级别的用户设置：自动，或固定 H1/H2/H3。 */
export type HeadingLevelSetting = 'auto' | 1 | 2 | 3;

/** 与导图 treeBuilder 同源的解析器（tuned + GFM）。 */
const mdParser = tunedMarkdownLanguage.parser.configure([GFM]);

/** 极简哈希：只用来区分同一起始行上的不同源码，不追求抗碰撞。 */
export function hashSource(text: string): string {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

/** 行首偏移表；行号换算用。 */
function buildLineStarts(doc: string): number[] {
    const starts = [0];
    for (let i = 0; i < doc.length; i += 1) {
        if (doc.charCodeAt(i) === 10) starts.push(i + 1);
    }
    return starts;
}

function lineIndexOf(starts: number[], pos: number): number {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= pos) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

/**
 * 识别 front matter。
 *
 * GFM 没有 front matter 概念，会把开头那对 `---` 解析成 HorizontalRule +
 * SetextHeading。这里先按行扫出结束位置，解析时跳过起始行号落在其中的节点。
 */
function parseFrontMatter(doc: string): { endLine: number; meta: DeckMeta } {
    const lines = doc.split('\n');
    if (lines[0]?.trim() !== '---') return { endLine: -1, meta: {} };
    for (let i = 1; i < lines.length; i += 1) {
        const text = lines[i].trim();
        if (text === '---' || text === '...') {
            const meta: DeckMeta = {};
            for (let j = 1; j < i; j += 1) {
                const match = lines[j].match(/^([A-Za-z][\w-]*):\s*(.*)$/);
                if (!match) continue;
                const key = match[1].toLowerCase();
                const value = match[2].replace(/^["']|["']$/g, '').trim();
                if (key === 'title') meta.title = value;
                else if (key === 'subtitle') meta.subtitle = value;
                else if (key === 'author') meta.author = value;
                else if (key === 'date') meta.date = value;
                else if (key === 'theme') meta.theme = value;
            }
            return { endLine: i, meta };
        }
    }
    return { endLine: -1, meta: {} };
}

/**
 * 顶层节点 → 幻灯片块。
 *
 * 数学块和图片在 Lezer 里都是 Paragraph，只能靠源码形态区分；
 * 这与 live 预览的识别口径一致（`$$` / 单图片段落都是内容特征）。
 */
function classify(
    node: SyntaxNode,
    source: string
): { kind: BlockKind; level?: number } | null {
    const name = node.name;

    if (name.startsWith('ATXHeading') || name.startsWith('SetextHeading')) {
        return { kind: 'heading', level: Number(name.slice(-1)) };
    }
    if (name === 'Paragraph') {
        const text = source.trim();
        // 防御分支：独立成段的 HTML 注释正常是 CommentBlock（见下面），
        // 但换了解析配置后也可能落进 Paragraph。漏掉时注释会被当成正文渲染。
        if (
            /^<!--[\s\S]*-->$/.test(text) &&
            /^<!--\s*(layout|notes)\s*:/i.test(text)
        ) {
            return null;
        }
        if (text.startsWith('$$') && text.endsWith('$$') && text.length > 4) {
            return { kind: 'math' };
        }
        if (/^!\[[^\]]*\]\([^)]+\)$/.test(text)) {
            return { kind: 'image' };
        }
        return { kind: 'para' };
    }
    if (name === 'BulletList' || name === 'OrderedList') return { kind: 'list' };
    if (name === 'Blockquote') return { kind: 'quote' };
    if (name === 'FencedCode') {
        const info = source.match(/^(`{3,}|~{3,})\s*([^\s`]*)/)?.[2] ?? '';
        return { kind: info.toLowerCase() === 'mermaid' ? 'mermaid' : 'code' };
    }
    if (name === 'CodeBlock') return { kind: 'code' };
    if (name === 'Table') return { kind: 'table' };
    if (name === 'HorizontalRule') return { kind: 'hr' };
    if (name === 'CommentBlock' || name === 'HTMLBlock') {
        // `<!-- layout: ... -->` / `<!-- notes: ... -->` 是单页覆盖/备注，
        // 不进正文，也不占测量高度；其他 HTML 注释在幻灯片里同样不可见，
        // 一并丢掉（它们只是给渲染器/作者看的元信息）。
        if (name === 'CommentBlock') return null;
        if (/^<!--\s*(layout|notes)\s*:/i.test(source.trim())) return null;
        return { kind: 'html' };
    }
    return { kind: 'para' };
}

// =====================================================================
// 节点树：块 → 分页单元
// =====================================================================

/** 媒体节点：分页时单独成段、有同页规则的块类型。 */
const MEDIA_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>([
    'code',
    'table',
    'math',
    'mermaid',
    'image',
    'html',
]);

/** 行首空白（空格 / Tab）。 */
function leadingIndent(text: string): string {
    return /^[ \t]*/.exec(text)?.[0] ?? '';
}

/** 去掉每行行首的公共缩进；空行原样保留。 */
export function dedentText(text: string, indent: string): string {
    if (!indent) return text;
    return text
        .split('\n')
        .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
        .join('\n');
}

/** 预序展开节点树：父节点在前，子树紧随其后。 */
export function flattenItems(items: SlideItem[]): SlideItem[] {
    const out: SlideItem[] = [];
    const walk = (nodes: SlideItem[]): void => {
        for (const node of nodes) {
            out.push(node);
            walk(node.children);
        }
    };
    walk(items);
    return out;
}

/** 普通顶层块 → 节点。 */
function blockToItem(block: SlideBlock): SlideItem {
    return {
        id: block.id,
        kind: block.kind,
        blockId: block.id,
        level: block.level,
        depth: 0,
        parentId: 'body',
        fromLine: block.fromLine,
        toLine: block.toLine,
        subtreeToLine: block.toLine,
        source: block.source,
        indent: '',
        media: MEDIA_KINDS.has(block.kind),
        children: [],
    };
}

/** 列表项里可以成为独立子节点的块级节点；ListMark 等标记节点不算。 */
const CHILD_BLOCK_NAMES: ReadonlySet<string> = new Set([
    'Paragraph',
    'Task',
    'FencedCode',
    'CodeBlock',
    'Table',
    'HTMLBlock',
    'Blockquote',
]);

/** 解析一个列表块；行号都相对该块源码，最后加上 block.fromLine。 */
function buildListItems(
    block: SlideBlock,
    listNode: SyntaxNode,
    parentId: string,
    depth: number,
    relLine: (pos: number) => number,
    lines: string[],
    ordered: boolean
): SlideItem[] {
    const items: SlideItem[] = [];
    for (let node = listNode.firstChild; node; node = node.nextSibling) {
        if (node.name === 'ListItem') {
            items.push(
                buildListItem(block, node, parentId, depth, relLine, lines, ordered)
            );
        }
    }
    return items;
}

/** 一个 ListItem → 节点（首段为自身内容，嵌套列表 / 后续段 / 媒体进 children）。 */
function buildListItem(
    block: SlideBlock,
    itemNode: SyntaxNode,
    parentId: string,
    depth: number,
    relLine: (pos: number) => number,
    lines: string[],
    ordered: boolean
): SlideItem {
    const startRel = relLine(itemNode.from);
    /** 自身内容的结束行：首个 Paragraph / Task 的结束；没有就只占标记行。 */
    let selfEndRel = startRel;
    const children: SlideItem[] = [];
    let firstContent = false;

    for (let child = itemNode.firstChild; child; child = child.nextSibling) {
        const childStart = relLine(child.from);
        const childEnd = relLine(Math.max(child.from, child.to - 1));
        if (child.name === 'BulletList' || child.name === 'OrderedList') {
            children.push(
                ...buildListItems(
                    block,
                    child,
                    // 父节点 id 先占位，下面统一替换成真正的 item id
                    parentId,
                    depth + 1,
                    relLine,
                    lines,
                    child.name === 'OrderedList'
                )
            );
            continue;
        }
        if (!firstContent && (child.name === 'Paragraph' || child.name === 'Task')) {
            // 列表项的首段属于「自身」：标记行 + 续行一起渲染，
            // 这样点一下就能编辑整条，圆点 / 缩进也保持原样。
            firstContent = true;
            selfEndRel = childEnd;
            continue;
        }
        // 只认真正的块级子节点；ListMark 之类的标记节点直接跳过，
        // 否则每个列表项都会凭空多出一个子节点，片段永远合并不起来。
        if (!CHILD_BLOCK_NAMES.has(child.name)) continue;
        const raw = lines.slice(childStart, childEnd + 1).join('\n');
        const cls = classify(child, raw);
        if (!cls) continue;
        children.push({
            id: `${block.id}#${childStart}:${hashSource(raw)}`,
            kind: cls.kind,
            blockId: block.id,
            level: cls.level,
            depth: depth + 1,
            parentId: '', // 下面统一指向父 item
            fromLine: block.fromLine + childStart,
            toLine: block.fromLine + childEnd,
            subtreeToLine: block.fromLine + childEnd,
            source: raw,
            indent: leadingIndent(raw),
            media: MEDIA_KINDS.has(cls.kind),
            children: [],
        });
    }

    const selfSource = lines.slice(startRel, selfEndRel + 1).join('\n');
    const item: SlideItem = {
        id: `${block.id}#${startRel}:${hashSource(selfSource)}`,
        kind: 'list',
        blockId: block.id,
        depth,
        parentId,
        fromLine: block.fromLine + startRel,
        toLine: block.fromLine + selfEndRel,
        subtreeToLine: block.fromLine + relLine(Math.max(itemNode.from, itemNode.to - 1)),
        source: selfSource,
        indent: leadingIndent(selfSource),
        media: false,
        ordered,
        children,
    };
    // 子节点的 parentId 需要引用父节点 id，先建完父节点再回填。
    for (const child of item.children) child.parentId = item.id;
    return item;
}

/**
 * 一个块 → 分页节点。
 *
 * 非列表块原样成一个节点；列表块按 ListItem 展开成树，每个条目连同
 * 子树成为一个节点。这样列表可以按条目分页 / 双栏，而不再整块不可拆。
 */
export function buildBlockItems(block: SlideBlock): SlideItem[] {
    if (block.kind !== 'list') return [blockToItem(block)];

    const source = block.source;
    const tree = mdParser.parse(source);
    const starts = buildLineStarts(source);
    const relLine = (pos: number): number => lineIndexOf(starts, pos);
    const lines = source.split('\n');
    const items: SlideItem[] = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        if (node.name === 'BulletList' || node.name === 'OrderedList') {
            items.push(
                ...buildListItems(
                    block,
                    node,
                    block.id,
                    1,
                    relLine,
                    lines,
                    node.name === 'OrderedList'
                )
            );
        }
    }
    // 解析失败时退回整块，保证内容不会凭空消失。
    return items.length > 0 ? items : [blockToItem(block)];
}

/** Markdown 全文 → 块序列 + 逻辑页。 */
export function parseDeck(
    text: string,
    headingLevel: HeadingLevelSetting = 'auto'
): Deck {
    // CRLF 归一：Lezer 的表格识别对行尾 \r 敏感；后面所有行号/切片都按
    // 归一后的文本算。网页端保存时仍按原换行回写（行号不变）。
    const fullText = text.replace(/\r\n?/g, '\n');
    // 快速卡片（<<< / >>> 块）是右侧栏的旁注，不是幻灯片正文：
    // 解析用一份卡片行被清空的副本。maskQuickCardLines 行数不变，
    // 所以块的 fromLine/toLine、回写区间与大纲页码口径全部不受影响。
    const parseText = maskQuickCardLines(fullText);
    const { endLine, meta } = parseFrontMatter(parseText);
    const tree = mdParser.parse(parseText);
    const starts = buildLineStarts(parseText);
    const blocks: SlideBlock[] = [];

    let node: SyntaxNode | null = tree.topNode.firstChild;
    while (node) {
        const fromLine = lineIndexOf(starts, node.from);
        const toLine = lineIndexOf(starts, Math.max(node.from, node.to - 1));
        if (endLine >= 0 && fromLine <= endLine) {
            node = node.nextSibling;
            continue;
        }
        const raw = parseText.slice(node.from, node.to).replace(/\n+$/, '');
        if (!raw.trim()) {
            node = node.nextSibling;
            continue;
        }
        const cls = classify(node, raw);
        if (cls) {
            blocks.push({
                id: `${cls.kind}:${fromLine}:${hashSource(raw)}`,
                kind: cls.kind,
                level: cls.level,
                fromLine,
                toLine,
                source: raw,
            });
        }
        node = node.nextSibling;
    }

    // 版式覆盖注释在 classify() 里被丢出正文，这里单独按行扫回来。
    // 它同时充当硬分页：作者写 <!-- layout: fact --> 是想「这一页」，
    // 而不是把上一段也一起变成大数字页。
    //
    // 按行扫描会把代码块里的同形文本也扫进来，用块行区间过滤掉：
    // 真正的顶层指令不属于任何块。
    // 必须扫解析副本：卡片里写的伪指令不能替幻灯片强制断页。
    const overrides = collectLayoutOverrides(parseText).filter(
        (override) =>
            !blocks.some(
                (block) =>
                    override.line >= block.fromLine &&
                    override.line <= block.toLine
            )
    );
    const { logical, slideLevel } = buildLogicalSlides(
        blocks,
        headingLevel,
        overrides.map((override) => override.line)
    );
    applyLayoutOverrides(logical, overrides);

    // 块 → 节点树。每个块只解析一次，逻辑页与硬分页段共享同一份节点，
    // 避免同一段源码被解析两遍（大文档上列表解析并不便宜）。
    const itemCache = new Map<string, SlideItem[]>();
    const itemsOf = (block: SlideBlock): SlideItem[] => {
        let items = itemCache.get(block.id);
        if (!items) {
            items = buildBlockItems(block);
            itemCache.set(block.id, items);
        }
        return items;
    };
    for (const slide of logical) {
        slide.items = slide.blocks.flatMap(itemsOf);
        // 分页流必须是预序展开的：父节点后面紧跟它的整棵子树。
        // 否则嵌套条目不会参与装页，渲染时也会漏掉子节点。
        slide.itemSegments = slide.segments.map((segment) =>
            flattenItems(segment.flatMap(itemsOf))
        );
    }

    return {
        fullText,
        parseText,
        blocks,
        items: logical.flatMap((slide) => slide.items),
        logical,
        slideLevel,
        meta,
    };
}

interface LayoutOverride {
    /** 0-based 行号。 */
    line: number;
    layout: LayoutKind;
}

/** 收集文档里的 `<!-- layout: xxx -->` 行；不认识的值直接忽略。 */
function collectLayoutOverrides(text: string): LayoutOverride[] {
    const out: LayoutOverride[] = [];
    const re = /^\s*<!--\s*layout\s*:\s*([a-z-]+)\s*-->\s*$/i;
    text.split('\n').forEach((line, index) => {
        const kind = line.match(re)?.[1]?.toLowerCase() as
            | LayoutKind
            | undefined;
        if (kind && LAYOUT_KINDS.has(kind)) {
            out.push({ line: index, layout: kind });
        }
    });
    return out;
}

/** 逻辑页覆盖的源码行范围；空页（只有标题）也算一行。 */
function slideLineRange(
    slide: LogicalSlide
): { first: number; last: number } | null {
    const first = slide.heading ?? slide.blocks[0];
    const last = slide.blocks[slide.blocks.length - 1] ?? slide.heading;
    if (!first || !last) return null;
    return {
        first: Math.min(first.fromLine, last.fromLine),
        last: Math.max(first.toLine, last.toLine),
    };
}

/**
 * 把覆盖注释挂到逻辑页：
 * 1. 注释落在某页的块范围内 → 覆盖这一页；
 * 2. 注释写在标题之前（上一页结束之后）→ 归到下一张逻辑页。
 */
function applyLayoutOverrides(
    logical: LogicalSlide[],
    overrides: LayoutOverride[]
): void {
    for (const override of overrides) {
        const inside = logical.find((slide) => {
            const range = slideLineRange(slide);
            return (
                !!range &&
                override.line >= range.first &&
                override.line <= range.last
            );
        });
        const target =
            inside ??
            logical.find((slide) => {
                const range = slideLineRange(slide);
                return !!range && range.first > override.line;
            });
        // 同一页写了多条时以第一条为准，避免解析顺序带来的意外
        if (target && !target.layoutOverride) {
            target.layoutOverride = override.layout;
        }
    }
}

/** 结束页的标题关键词；只认最后一页且没有正文的情况。 */
const END_RE = /^(谢谢|感谢|thanks|thank\s*you|q\s*&\s*a|问答)[!！。.\s]*$/i;

/** 最后一页、没有正文、标题像结束语 → 自动用结束版式。 */
export function isEndSlide(slide: LogicalSlide, isLast: boolean): boolean {
    if (!isLast) return false;
    if (slide.blocks.length > 0) return false;
    return END_RE.test(plainHeading(slide.heading));
}

/**
 * 标题分页规则：
 * - 自动：有 H2 时 H2 是内容页起点、H1 是章节页；只有一种标题级别时那一级
 *   就是内容页起点；没有标题时整篇一个逻辑页，按内容流分页；
 * - 固定级别：那一级及更浅的标题都开启新页；
 * - 恰好是 `---` 的分隔线是强制换页，不进入正文；
 * - 第一个标题之前的内容单独成一个无标题逻辑页。
 */
export function buildLogicalSlides(
    blocks: SlideBlock[],
    headingLevel: HeadingLevelSetting = 'auto',
    /**
     * 额外硬分页行（版式覆盖注释所在行）。注释本身不是块，只能在走到
     * 下一个块时补一次「断页」——并且只有当当前页已有正文时才断，
     * 避免 `## 标题` 紧跟注释时多出一张空页。
     */
    breakLines: number[] = []
): { logical: LogicalSlide[]; slideLevel: number } {
    const levels = blocks
        .filter((block) => block.kind === 'heading')
        .map((block) => block.level ?? 0);
    const slideLevel =
        headingLevel !== 'auto'
            ? headingLevel
            : levels.includes(2)
              ? 2
              : levels.includes(1)
                ? 1
                : 0;

    const logical: LogicalSlide[] = [];
    let current: LogicalSlide | null = null;
    let segment: SlideBlock[] = [];
    // breakLines 升序；指针只前进，整体仍是线性扫描
    const breaks = [...breakLines].sort((a, b) => a - b);
    let breakIndex = 0;

    const finishSegment = (): void => {
        if (current && segment.length > 0) {
            current.segments.push(segment);
            segment = [];
        }
    };
    const finishSlide = (): void => {
        finishSegment();
        if (current) {
            logical.push(current);
            current = null;
        }
    };

    for (const block of blocks) {
        // 版式注释 = 硬分页。只有当前页已有正文时才真正断开；
        // `## 标题` 紧跟注释时（注释在标题之后）应属于这一页，
        // 否则会多出一张只有标题的空页。
        while (breakIndex < breaks.length && breaks[breakIndex] < block.fromLine) {
            if (current && current.blocks.length > 0) finishSlide();
            breakIndex += 1;
        }
        if (block.kind === 'hr' && block.source.trim() === '---') {
            finishSegment();
            continue;
        }
        if (block.kind === 'heading' && (block.level ?? 7) <= slideLevel) {
            finishSlide();
            current = {
                index: logical.length,
                heading: block,
                blocks: [],
                segments: [],
                items: [],
                itemSegments: [],
            };
            continue;
        }
        if (!current) {
            current = {
                index: logical.length,
                heading: undefined,
                blocks: [],
                segments: [],
                items: [],
                itemSegments: [],
            };
        }
        segment.push(block);
        current.blocks.push(block);
    }
    finishSlide();
    return { logical, slideLevel };
}

/** 根据块构成选版式。 */
export function layoutOf(
    slide: LogicalSlide,
    slideLevel: number
): LayoutKind {
    // 显式覆盖优先级最高：statement / fact / image-split 等没有可靠的
    // 自动判定口径，交给作者用注释指定。
    if (slide.layoutOverride) return slide.layoutOverride;
    const heading = slide.heading;
    if (!heading) return 'content';
    if ((heading.level ?? 7) < slideLevel && slide.blocks.length === 0) {
        return 'section';
    }
    if (slide.blocks.length === 0) return 'section';

    const blocks = slide.blocks;
    if (blocks.length === 1) {
        const one = blocks[0];
        // 列表分栏不再在这里判定：分页层会按「同级节点 + 列宽实测高度」
        // 尝试双栏，成功才用 list-columns（见 slidesPaginate）。
        if (one.kind === 'quote') return 'quote';
        if (one.kind === 'code') return 'code';
        if (
            one.kind === 'image' ||
            one.kind === 'mermaid' ||
            one.kind === 'table'
        ) {
            return 'media';
        }
    }
    const hasMedia = blocks.some(
        (block) => block.kind === 'image' || block.kind === 'mermaid'
    );
    const hasText = blocks.some(
        (block) =>
            block.kind === 'para' ||
            block.kind === 'list' ||
            block.kind === 'quote'
    );
    // 图文页统一走双栏：图片放右列，图片上方 / 下方的文字都收进左列，
    // 不再因为段落多就退回上下堆叠（图片会被挤到页面底部）。
    // 块数上限只是防止一整段长文硬塞进半栏，真放不下时渲染层还会等比缩放。
    if (hasMedia && hasText && blocks.length <= 4) return 'two-column';
    return 'content';
}

/**
 * 标题字号。
 *
 * 尺度参照 Marp 官方主题（同样是 1280×720），但整体比正文收一档：
 * 投影时标题过大会吃掉正文空间，一页反而装不下几条要点。
 */
export function titleFontSize(level: number, slideLevel: number): number {
    // 章节页 42；只有一级标题时 34；内容页标题 30
    if (level === 1) return slideLevel === 2 ? 42 : 34;
    return 30;
}

/**
 * 正文块的基准字号。
 *
 * 正文整体比标题更接近「投影也要看得清」的尺度：标题收小、正文放大，
 * 一页的阅读重心落到内容上。放不下时交给渲染层的等比缩放兜底。
 */
export function bodyFontSize(block: { kind: BlockKind; level?: number }): number {
    switch (block.kind) {
        case 'heading':
            // 页内小标题分两档：H3 34，H4 及以下 28
            return (block.level ?? 3) <= 3 ? 34 : 28;
        case 'code':
            // 正文 0.68 倍：与 Marp uncover 的代码比例接近
            return 20;
        case 'table':
            // 表格与正文同口径
            return 28;
        case 'quote':
            // 引用略大于正文，强调它是「一句被引用的话」
            return 32;
        default:
            return 30;
    }
}

/** 标题纯文本：去掉 Markdown 标记，给续页 / 缩略图 / 页脚用。 */
export function plainHeading(block: SlideBlock | undefined): string {
    if (!block) return '';
    return block.source
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/\n[-=]+\s*$/, '')
        .trim();
}

/** 当前行（0-based）所在的逻辑页；找不到时返回 null。 */
export function findLogicalSlideByLine(
    deck: Deck,
    line: number
): number | null {
    for (const slide of deck.logical) {
        if (slide.heading) {
            const from = slide.heading.fromLine;
            const lastBlock = slide.blocks[slide.blocks.length - 1];
            const to = lastBlock
                ? Math.max(slide.heading.toLine, lastBlock.toLine)
                : slide.heading.toLine;
            if (line >= from && line <= to) return slide.index;
        } else {
            const first = slide.blocks[0];
            const last = slide.blocks[slide.blocks.length - 1];
            if (first && last && line >= first.fromLine && line <= last.toLine) {
                return slide.index;
            }
        }
    }
    return null;
}

/**
 * 最近的前一个逻辑页（0-based 行号）。
 *
 * 光标停在不属于任何块的行上时（典型：快速卡片区——卡片已被掩码出
 * 幻灯片），`findLogicalSlideByLine` 会返回 null。这时应该落到「上方
 * 最近的一页」，而不是回到第 0 页。行号在所有页之前时返回第一页。
 */
export function findNearestLogicalSlideByLine(
    deck: Deck,
    line: number
): number | null {
    let before: number | null = null;
    for (const slide of deck.logical) {
        const range = slideLineRange(slide);
        if (!range) continue;
        if (range.first <= line) before = slide.index;
        // logical 按行序生成，后面的页只会更靠后，可以提前结束
        else break;
    }
    if (before !== null) return before;
    return deck.logical[0]?.index ?? null;
}
