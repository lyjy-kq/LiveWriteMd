/**
 * 快速卡片（暂存想法）的存储格式与纯编辑函数。
 *
 * 卡片**不是导图节点**，是直接写在 Markdown 里的普通文本块，用 Markdown
 * 里不会出现的独立行包起来：
 *
 * ```
 * <<<
 * 随手记的想法
 * 第二行
 * >>>
 * ```
 *
 * 这样 live 模式不需要任何特殊渲染 —— 卡片就是三段普通文字，
 * 切回文本模式也能直接改；导图模式只是把这些行跳过，不生成节点。
 *
 * 格式约束（刻意保持极简，不做转义）：
 * - 开始 / 结束行必须是行首列 0 的独立行（行尾可以有空白）；
 * - 卡片内容里单独一行的 `>>>` 会提前结束卡片，这是格式本身的限制；
 * - 围栏代码块里的 `<<<` / `>>>` 不算卡片（扫描时跳过 fence 内部）。
 *
 * 本文件全部是纯函数，行号口径与 treeBuilder 一致：0-based、含两端。
 *
 * @module webview/mindmap/edit/staging
 */

/** 卡片开始标记行。 */
const CARD_OPEN = '<<<';
/** 卡片结束标记行。 */
const CARD_CLOSE = '>>>';

/** 解析出来的一张卡片。 */
export interface QuickCard {
    /** 开始标记所在行（0-based）。 */
    fromLine: number;
    /** 结束标记所在行（0-based）。 */
    toLine: number;
    /** 卡片内容（已去掉首尾空行；行间内容原样保留）。 */
    text: string;
}

/** 去掉行尾的 `\r`（CRLF 文档按行切分后每行会带一个）。 */
function trimCr(line: string): string {
    return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** 这一行是不是围栏代码块的开始 / 结束（只做最基础的 ``` / ~~~ 判定）。 */
function fenceMatch(line: string): { char: string; length: number } | null {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!match) return null;
    return { char: match[1][0], length: match[1].length };
}

/**
 * 扫描全文，按出现顺序返回所有卡片。
 *
 * 未闭合的 `<<<` 不产生卡片（那一行照常当普通文本 / 段落处理），
 * 这样用户写到一半也不会让后半篇文档从导图里消失。
 *
 * @param markdown 源文档全文（CRLF / LF 均可）
 * @returns 卡片列表（文档顺序）
 */
export function parseQuickCards(markdown: string): QuickCard[] {
    const lines = markdown.split('\n');
    const cards: QuickCard[] = [];
    /** 当前所在的围栏（null = 不在围栏里）。 */
    let fence: { char: string; length: number } | null = null;
    /** 当前打开中的卡片起始行（-1 = 没有）。 */
    let openLine = -1;

    for (let i = 0; i < lines.length; i += 1) {
        const line = trimCr(lines[i] ?? '');

        // 围栏代码块内部：不识别卡片标记，只找同字符、不短于开头的收尾围栏
        const fenceMark = fenceMatch(line);
        if (fence) {
            if (
                fenceMark &&
                fenceMark.char === fence.char &&
                fenceMark.length >= fence.length
            ) {
                fence = null;
            }
            continue;
        }
        if (fenceMark) {
            fence = fenceMark;
            continue;
        }

        if (openLine < 0) {
            if (line.trimEnd() === CARD_OPEN && line.startsWith(CARD_OPEN)) {
                openLine = i;
            }
            continue;
        }
        if (line.trimEnd() === CARD_CLOSE && line.startsWith(CARD_CLOSE)) {
            cards.push({
                fromLine: openLine,
                toLine: i,
                text: collectCardText(lines, openLine, i),
            });
            openLine = -1;
        }
    }
    return cards;
}

/**
 * 把卡片占用的行整行替换成空行（行数不变），供 treeBuilder 解析前使用。
 *
 * 为什么不直接在「块起始行落在卡片里」时跳过块：CommonMark 里卡片标记
 * 只是普通文字，`<<<` 后面紧跟着的正文（或者紧挨着的上一段）会跟卡片
 * 并成**同一个段落**。只跳过「起始行落在卡片里的块」会把卡片后面那段
 * 正文一起吞掉。先把卡片行清空，卡片就从语法树里彻底消失，同时行号
 * 完全不变，下游所有按行回写的逻辑不需要任何换算。
 *
 * @param markdown 源全文
 * @returns 卡片行被清空后的全文（CRLF 会变成 LF，行数不变）
 */
export function maskQuickCardLines(markdown: string): string {
    const cards = parseQuickCards(markdown);
    if (cards.length === 0) return markdown;
    const lines = markdown.split('\n');
    for (const card of cards) {
        for (let line = card.fromLine; line <= card.toLine; line += 1) {
            lines[line] = '';
        }
    }
    return lines.join('\n');
}

/**
 * 取卡片内容：去掉开始 / 结束行，再去掉内容首尾的空行，
 * 中间的空行与缩进原样保留。
 */
function collectCardText(lines: string[], openLine: number, closeLine: number): string {
    let content = lines
        .slice(openLine + 1, closeLine)
        .map((line) => trimCr(line));
    while (content.length > 0 && (content[0] ?? '').trim() === '') content.shift();
    while (
        content.length > 0 &&
        (content[content.length - 1] ?? '').trim() === ''
    ) {
        content.pop();
    }
    return content.join('\n');
}

/** 规范化待写入的卡片内容：去掉首尾空行（空内容返回空串）。 */
function normalizeCardText(text: string): string {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    while (lines.length > 0 && (lines[0] ?? '').trim() === '') lines.shift();
    while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') {
        lines.pop();
    }
    return lines.join('\n');
}

/** 一张卡片的完整源码块（行数组）。 */
function cardBlockLines(text: string): string[] {
    return [CARD_OPEN, ...text.split('\n'), CARD_CLOSE];
}

/**
 * 在文档末尾追加一张卡片。
 *
 * 卡片统一追加在文末：暂存卡片是「随手丢进来的想法」，不参与正文的
 * 章节结构；放在末尾也避免把一张卡片插进某个标题的章节里，破坏导图层级。
 *
 * @param markdown 源全文
 * @param text 卡片内容（首尾空行会被去掉；全空则原样返回）
 * @returns 新全文
 */
export function appendQuickCard(markdown: string, text: string): string {
    const content = normalizeCardText(text);
    if (!content) return markdown;
    // 文末已有空行就不重复加；空文档直接写卡片块
    const base = markdown.replace(/\s+$/, '');
    const block = cardBlockLines(content).join('\n');
    return base ? `${base}\n\n${block}` : block;
}

/**
 * 在第 index 张卡片之前插入一张卡片。
 *
 * index 超出范围时插在最后一张卡片之后（不是文末：卡片可能夹在正文
 * 中间，追加到文末会让「拖到侧边最下面」落到文档末尾去）。
 *
 * @param markdown 源全文
 * @param index 插入位置（0 = 第一张卡片之前；cards.length = 最后一张之后）
 * @param text 卡片内容（首尾空行会被去掉；全空则原样返回）
 * @returns 新全文
 */
export function insertQuickCard(
    markdown: string,
    index: number,
    text: string
): string {
    const content = normalizeCardText(text);
    if (!content) return markdown;
    const cards = parseQuickCards(markdown);
    const block = cardBlockLines(content);
    if (cards.length === 0) return appendQuickCard(markdown, content);
    const lines = markdown.split('\n');
    if (index < cards.length) {
        // 插在目标卡片块的第一行之前，后面补一个空行把它和上面的内容隔开
        lines.splice(cards[index]!.fromLine, 0, ...block, '');
    } else {
        // 最后一张之后：紧贴着它的结束标记行插入
        lines.splice(cards[cards.length - 1]!.toLine + 1, 0, '', ...block);
    }
    return collapseBlankLines(lines.join('\n'));
}

/**
 * 把第 from 张卡片移动到 finalIndex（移动完成后的序号）。
 *
 * 实现成「取出内容 → 删掉原块 → 按序号插回去」，空的 / 越界的序号
 * 原样返回。finalIndex 是移动后的目标序号，调用方不需要自己减一。
 *
 * @param markdown 源全文
 * @param from 原序号（0-based）
 * @param finalIndex 移动后的序号（0-based）
 * @returns 新全文
 */
export function moveQuickCard(
    markdown: string,
    from: number,
    finalIndex: number
): string {
    const cards = parseQuickCards(markdown);
    const card = cards[from];
    if (!card) return markdown;
    if (from === finalIndex) return markdown;
    const text = card.text;
    const next = deleteQuickCard(markdown, from);
    const count = parseQuickCards(next).length;
    const target = Math.max(0, Math.min(finalIndex, count));
    return insertQuickCard(next, target, text);
}

/**
 * 更新第 index 张卡片的内容。
 *
 * 内容为空等价于删除。index 以 {@link parseQuickCards} 的顺序为准；
 * 找不到（文档被外部改过）时原样返回。
 *
 * @param markdown 源全文
 * @param index 卡片序号（0-based）
 * @param text 新内容
 * @returns 新全文
 */
export function updateQuickCard(
    markdown: string,
    index: number,
    text: string
): string {
    const content = normalizeCardText(text);
    if (!content) return deleteQuickCard(markdown, index);
    const card = parseQuickCards(markdown)[index];
    if (!card) return markdown;
    const lines = markdown.split('\n');
    lines.splice(
        card.fromLine,
        card.toLine - card.fromLine + 1,
        ...cardBlockLines(content)
    );
    return collapseBlankLines(lines.join('\n'));
}

/**
 * 删除第 index 张卡片（连同它的开始 / 结束标记行）。
 *
 * @param markdown 源全文
 * @param index 卡片序号（0-based）
 * @returns 新全文（找不到时原样返回）
 */
export function deleteQuickCard(markdown: string, index: number): string {
    const card = parseQuickCards(markdown)[index];
    if (!card) return markdown;
    const lines = markdown.split('\n');
    lines.splice(card.fromLine, card.toLine - card.fromLine + 1);
    return collapseBlankLines(lines.join('\n'));
}

/**
 * 收拾删改后留下的多余空行：连续空行最多留一个、文首空行去掉、
 * 文末多余空行去掉。
 */
function collapseBlankLines(text: string): string {
    return text
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '');
}
