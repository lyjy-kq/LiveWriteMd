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
 * 格式约束（刻意保持极简）：
 * - 开始 / 结束行必须是行首列 0 的独立行（行尾可以有空白）；
 * - 卡片内容里单独一行的 `>>>` 写入时转义成 `\>>>`，读回时还原，
 *   保证内容往返一致（CommonMark 里 `\>>>` 渲染出来仍是 `>>>`）；
 * - 卡外扫描时跳过围栏代码块内部，代码块里的 `<<<` / `>>>` 不算卡片；
 * - 卡片内部不处理围栏，行首 `>>>` 无条件结束卡片；
 * - 写回时沿用原文的换行符，CRLF 文档不会混进 LF。
 *
 * 本文件全部是纯函数，行号口径与 treeBuilder 一致：0-based、含两端。
 *
 * @module webview/mindmap/edit/staging
 */

/** 卡片开始标记行。 */
const CARD_OPEN = '<<<';
/** 卡片结束标记行。 */
const CARD_CLOSE = '>>>';
/** 卡片正文里整行 `>>>` 的转义形式（读回时还原）。 */
const ESCAPED_CARD_CLOSE = '\\>>>';

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

/** 原文用的换行符：出现过 CRLF 就按 CRLF 写回，否则用 LF。 */
function detectEol(markdown: string): string {
    return markdown.includes('\r\n') ? '\r\n' : '\n';
}

/** 原文是否以换行结尾（CRLF 同样以 `\n` 结尾）。 */
function hasTrailingNewline(markdown: string): boolean {
    return markdown.endsWith('\n');
}

/** 内部统一转成 LF 处理，避免每行都带着 `\r` 参与匹配。 */
function toLf(markdown: string): string {
    return markdown.replace(/\r\n/g, '\n');
}

/**
 * 行是否为空行（只含空白）。
 * 正文行尾的空格 / 制表符不算空行，后面清理时不会被吃掉。
 */
function isBlankLine(line: string): boolean {
    return line.trim() === '';
}

/**
 * 把内部（LF）行数组按原文 EOL 写回。
 *
 * 写回前只去掉尾部空行：原文本来以换行结尾就补回一个，否则不补，
 * 保持文件末尾换行状态不变（也不会动正文行尾的空格 / 制表符）。
 */
function joinLinesForWrite(
    lines: string[],
    eol: string,
    trailingNewline: boolean
): string {
    while (lines.length > 0 && isBlankLine(lines[lines.length - 1] ?? '')) {
        lines.pop();
    }
    const body = lines.join('\n');
    const text = trailingNewline ? `${body}\n` : body;
    return eol === '\n' ? text : text.split('\n').join(eol);
}

/** 围栏代码块的字符与长度。 */
interface Fence {
    char: string;
    length: number;
}

/**
 * 起始围栏：行首最多 3 个空格 + 至少 3 个 ``` 或 ~~~，后面可带 info string。
 * 反引号围栏的 info 里不允许再出现反引号，否则这一行根本不是围栏开头。
 */
function openingFenceMatch(line: string): Fence | null {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) return null;
    const marker = match[1] ?? '';
    const info = match[2] ?? '';
    // 反引号起始行的 info 里不能再有反引号（CommonMark 规则）
    if (marker.startsWith('`') && info.includes('`')) return null;
    return { char: marker.charAt(0), length: marker.length };
}

/**
 * 收尾围栏：行首最多 3 个空格 + 与起始同字符、长度不短于起始，
 * 且行尾只允许空白。` ```js ` 这种带 info 的只能当起始，不能当收尾。
 */
function closingFenceMatch(line: string): Fence | null {
    const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (!match) return null;
    const marker = match[1] ?? '';
    return { char: marker.charAt(0), length: marker.length };
}

/** 一次全文扫描的结果。 */
interface ScanResult {
    /** 文档里的卡片（按出现顺序）。 */
    cards: QuickCard[];
    /** 扫到文末仍未闭合的围栏（null = 不在围栏里）。 */
    openFence: Fence | null;
    /** 扫到文末仍未闭合的卡片起始行（-1 = 没有）。 */
    openCardLine: number;
}

/**
 * 扫描全文。parseQuickCards 和「文末是否停在未闭合围栏」共用同一套口径：
 * - 卡外按围栏跳过代码块里的标记；
 * - 进入卡片后不再处理围栏，行首 `>>>` 无条件结束卡片（否则卡片正文里
 *   一个没闭合的 ``` 会让它和后面所有卡片都识别不到）；
 * - 开 / 关卡片时都重置围栏状态，卡片里的围栏不会泄漏到卡片外。
 */
function scanDocument(lines: string[]): ScanResult {
    const cards: QuickCard[] = [];
    /** 当前所在的围栏（null = 不在围栏里）。 */
    let fence: Fence | null = null;
    /** 当前打开中的卡片起始行（-1 = 没有）。 */
    let openLine = -1;

    for (let i = 0; i < lines.length; i += 1) {
        const line = trimCr(lines[i] ?? '');

        // 卡片内部：不处理围栏，行首 `>>>`（trimEnd 后整行相等）无条件结束卡片
        if (openLine >= 0) {
            if (line.trimEnd() === CARD_CLOSE && line.startsWith(CARD_CLOSE)) {
                cards.push({
                    fromLine: openLine,
                    toLine: i,
                    text: collectCardText(lines, openLine, i),
                });
                openLine = -1;
                fence = null; // 关卡片时重置，卡片里的围栏状态不会泄漏出去
            }
            continue;
        }

        // 卡外且围栏内部：不识别卡片标记，只找合法的收尾围栏
        if (fence) {
            const close = closingFenceMatch(line);
            if (
                close &&
                close.char === fence.char &&
                close.length >= fence.length
            ) {
                fence = null;
            }
            continue;
        }

        // 卡外：起始围栏（可带 info）开始跳过代码块
        const open = openingFenceMatch(line);
        if (open) {
            fence = open;
            continue;
        }

        if (line.trimEnd() === CARD_OPEN && line.startsWith(CARD_OPEN)) {
            openLine = i;
            fence = null; // 开卡片时也重置
        }
    }

    return { cards, openFence: fence, openCardLine: openLine };
}

/**
 * parseQuickCards 的单条缓存：源串完全相同时直接复用上次结果。
 * 约定调用方不修改返回的数组（内部只读）。
 */
let parseCache: { source: string; cards: QuickCard[] } | null = null;

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
    if (parseCache && parseCache.source === markdown) return parseCache.cards;
    const result = scanDocument(markdown.split('\n'));
    parseCache = { source: markdown, cards: result.cards };
    return result.cards;
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
 * @returns 卡片行被清空后的全文（统一为 LF，行数不变）
 */
export function maskQuickCardLines(markdown: string): string {
    const cards = parseQuickCards(markdown);
    if (cards.length === 0) return markdown;
    const lines = toLf(markdown).split('\n');
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
function collectCardText(
    lines: string[],
    openLine: number,
    closeLine: number
): string {
    const content = lines
        .slice(openLine + 1, closeLine)
        .map((line) => trimCr(line));
    while (content.length > 0 && isBlankLine(content[0] ?? '')) content.shift();
    while (
        content.length > 0 &&
        isBlankLine(content[content.length - 1] ?? '')
    ) {
        content.pop();
    }
    // 写入时转义的 `>>>` 行在这里还原，保证「读 → 写 → 读」内容一致
    return content.map(unescapeCardClose).join('\n');
}

/** 规范化待写入的卡片内容：去掉首尾空行（空内容返回空串）。 */
function normalizeCardText(text: string): string {
    const lines = toLf(text).split('\n');
    while (lines.length > 0 && isBlankLine(lines[0] ?? '')) lines.shift();
    while (lines.length > 0 && isBlankLine(lines[lines.length - 1] ?? '')) {
        lines.pop();
    }
    return lines.join('\n');
}

/**
 * 写入时把会被当成结束标记的行首加 `\`。
 * 结束标记判定只看 trimEnd，所以行尾带空白的 `>>>` 也要转义。
 */
function escapeCardClose(line: string): string {
    return line.trimEnd() === CARD_CLOSE ? `\\${line}` : line;
}

/** 读回时把 `\>>>` 行还原（保留行尾空白）。 */
function unescapeCardClose(line: string): string {
    return line.trimEnd() === ESCAPED_CARD_CLOSE ? line.slice(1) : line;
}

/** 一张卡片的完整源码块（行数组）。 */
function cardBlockLines(text: string): string[] {
    return [CARD_OPEN, ...text.split('\n').map(escapeCardClose), CARD_CLOSE];
}

/**
 * 收拾卡片块前后的空行：块内部一行不动，只把紧挨着块的两段连续空行
 * 调整成「有内容的一侧恰好隔一个空行、贴文首 / 文末的一侧不隔」。
 * 文档其它位置的空行完全不受影响。
 *
 * @param lines 内部 LF 行数组（原地修改）
 * @param start 卡片块首行下标
 * @param end 卡片块末行下标（闭区间）
 */
function tidyAroundBlock(lines: string[], start: number, end: number): void {
    // —— 前侧：把块前面的连续空行调整成最多一个 ——
    let before = start;
    while (before > 0 && isBlankLine(lines[before - 1] ?? '')) before -= 1;
    const wantBefore = before > 0 ? 1 : 0;
    const haveBefore = start - before;
    if (haveBefore > wantBefore) {
        const removed = haveBefore - wantBefore;
        lines.splice(before, removed);
        start -= removed;
        end -= removed;
    } else if (haveBefore < wantBefore) {
        const added = wantBefore - haveBefore;
        lines.splice(before, 0, ...new Array<string>(added).fill(''));
        start += added;
        end += added;
    }

    // —— 后侧：块后面的连续空行同理，块贴文末就不留空行 ——
    let after = end + 1;
    while (after < lines.length && isBlankLine(lines[after] ?? '')) after += 1;
    const wantAfter = after < lines.length ? 1 : 0;
    const haveAfter = after - end - 1;
    if (haveAfter > wantAfter) {
        lines.splice(end + 1, haveAfter - wantAfter);
    } else if (haveAfter < wantAfter) {
        lines.splice(
            end + 1,
            0,
            ...new Array<string>(wantAfter - haveAfter).fill('')
        );
    }
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
    const eol = detectEol(markdown);
    const trailingNewline = hasTrailingNewline(markdown);
    const lines = toLf(markdown).split('\n');

    // 只去掉尾部空行，不碰正文行尾的空格 / 制表符
    while (lines.length > 0 && isBlankLine(lines[lines.length - 1] ?? '')) {
        lines.pop();
    }

    // 文末停在未闭合围栏里：先补一行合法的收尾围栏，否则追加的卡片
    // 会被围栏当成代码，parseQuickCards 根本看不到
    const scan = scanDocument(lines);
    if (scan.openFence) {
        lines.push(scan.openFence.char.repeat(scan.openFence.length));
    }

    const block = cardBlockLines(content);
    // 和正文之间恰好隔一个空行；空文档直接写块
    if (lines.length > 0) lines.push('');
    lines.push(...block);
    return joinLinesForWrite(lines, eol, trailingNewline);
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
    if (cards.length === 0) return appendQuickCard(markdown, content);

    const eol = detectEol(markdown);
    const trailingNewline = hasTrailingNewline(markdown);
    const lines = toLf(markdown).split('\n');
    const block = cardBlockLines(content);

    // 越界（含负数）时插在最后一张卡片之后
    const target = index >= 0 && index < cards.length ? cards[index] : null;
    const start = target
        ? target.fromLine
        : (cards[cards.length - 1]?.toLine ?? 0) + 1;
    lines.splice(start, 0, ...block);

    // 只收拾新卡片前后的空行，文档其它位置不动
    tidyAroundBlock(lines, start, start + block.length - 1);
    return joinLinesForWrite(lines, eol, trailingNewline);
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
    // 删掉一张后卡片数正好减一，不用再解析一遍 next
    const count = cards.length - 1;
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

    const eol = detectEol(markdown);
    const trailingNewline = hasTrailingNewline(markdown);
    const lines = toLf(markdown).split('\n');
    const block = cardBlockLines(content);
    lines.splice(
        card.fromLine,
        card.toLine - card.fromLine + 1,
        ...block
    );

    // 只收拾被替换卡片前后的空行（内容变了，块高度也会变）
    tidyAroundBlock(lines, card.fromLine, card.fromLine + block.length - 1);
    return joinLinesForWrite(lines, eol, trailingNewline);
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
    const eol = detectEol(markdown);
    const trailingNewline = hasTrailingNewline(markdown);
    const lines = toLf(markdown).split('\n');
    lines.splice(card.fromLine, card.toLine - card.fromLine + 1);

    // 删除点两侧的空行会拼在一起，压成一个；贴文首 / 文末就不留空行。
    // 这里只做压缩，不凭空补空行。
    let before = card.fromLine;
    while (before > 0 && isBlankLine(lines[before - 1] ?? '')) before -= 1;
    let after = card.fromLine;
    while (after < lines.length && isBlankLine(lines[after] ?? '')) after += 1;
    const keep = before > 0 && after < lines.length ? 1 : 0;
    if (after - before > keep) {
        lines.splice(before + keep, after - before - keep);
    }

    return joinLinesForWrite(lines, eol, trailingNewline);
}
