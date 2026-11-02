/**
 * 导图 Markdown 回写（从 markdownEdit.ts 拆出）：§6.5/6.6 剪贴板：子树提取与粘贴重定级。
 *
 * 全部是纯函数：输入 markdown 全文与节点信息，返回编辑结果。
 *
 * @module webview/mindmap/edit/clipboard
 */

import { addChildNode, addNode } from './add.js';
import {
    insertBlockLines,
    listContentColumn,
    listIndentOf,
    promoteParagraphToList,
    reindentLines,
    transformHeadingBlock,
    transformHeadingBlockToList,
    transformListBlockToHeading,
} from './move.js';
import { isMediaKind } from './rename.js';
import { EditResult, findNodeByUid, rangeOf } from './shared.js';
import { buildMindMapTree, normalizeNestedListIndent } from '../treeBuilder.js';
import type { MindMapTreeNode, NodeLineRange } from '../types.js';


/**
 * 拼接多块行：块之间按需插入**恰好一个**空行。
 *
 * 直接 flat 拼块会丢掉块间空行：段落粘成一段、表格紧贴上一段就认不出；
 * 而块自身的区间可能带着手写的首尾空行，直接拼又会叠出 3 行以上空行。
 * 所以先裁掉每块的首尾空行，再统一补一个分隔空行。
 *
 * 只处理「块与块」：列表项和它的子块在树里本来就是同一块的行区间，
 * 不会走到这里，因此不会把列表拆开。
 *
 * @param blocks 各块的行数组（按目标顺序）
 * @param blankSeparated 块之间是否补空行（列表项之间不能补）
 */
function joinBlocks(blocks: string[][], blankSeparated: boolean): string[] {
    const out: string[] = [];
    for (const block of blocks) {
        // 裁掉块首尾的空行：块间空行统一由本函数负责，避免叠加
        let from = 0;
        let to = block.length;
        while (from < to && block[from].trim() === '') from += 1;
        while (to > from && block[to - 1].trim() === '') to -= 1;
        // 整块都是空行：直接跳过，别凭空留下孤立的空行
        if (from >= to) continue;
        if (out.length > 0 && blankSeparated) out.push('');
        out.push(...block.slice(from, to));
    }
    return out;
}


/**
 * 把插入点两侧紧挨着的连续空行各收成一个，返回修正后的插入点。
 *
 * `insertBlockLines` 只在相邻行**非空**时补空行：插入点周围本来就有的
 * 多个空行会原样保留，插完就变成「两个空行」（3 个以上换行）。
 * 这里只动紧挨插入点的空行，远处文档的排版不受影响。
 *
 * @param lines 可变的全文行数组
 * @param at 计划插入的行位置
 * @returns 删除多余空行后的插入位置
 */
function limitAdjacentBlankLines(lines: string[], at: number): number {
    let pos = at;
    // 前侧：保留紧挨插入点的 1 个空行，多余的删掉
    let before = pos;
    while (before > 0 && (lines[before - 1] ?? '').trim() === '') before -= 1;
    if (pos - before > 1) {
        lines.splice(before + 1, pos - before - 1);
        pos = before + 1;
    }
    // 后侧：同理（后侧为空 / 非空时不处理）
    let after = pos;
    while (after < lines.length && (lines[after] ?? '').trim() === '') after += 1;
    if (after - pos > 1) {
        lines.splice(pos + 1, after - pos - 1);
    }
    return pos;
}


/**
 * 取标题节点自身区间里「标题标记之后」的续行。
 *
 * 树节点不单独保存标题续行：treeBuilder 把紧挨标题的段落并进了
 * `_selfLineRange`，而 `data.text` 只有标题文字本身。粘贴到列表时
 * 必须把续行找回来，否则标题格子里按 Enter 写的正文会丢。
 *
 * setext 标题占两行（文字行 + `===`/`---` 下划线），两行都要跳过。
 */
function headingContinuationLines(selfLines: string[]): string[] {
    if (selfLines.length === 0) return [];
    const first = selfLines[0] ?? '';
    let markupLines = 1;
    // 非 ATX 才可能是 setext：第二行是纯下划线
    if (
        !/^\s*#{1,6}(?:\s|$)/.test(first) &&
        selfLines.length > 1 &&
        /^\s*(?:=+|-+)\s*$/.test(selfLines[1])
    ) {
        markupLines = 2;
    }
    return selfLines.slice(markupLines);
}


/**
 * §6.5 提取选中子树的纯 Markdown 文本（复制 / 剪切的剪贴板内容）。
 *
 * 规则：
 * - 按文档顺序排列（不是点击顺序），读起来才是原来的行文；
 * - 父与子同时被选中时丢弃子的区间（祖先的 `_lineRange` 本来就包含它）；
 * - 每块按自身最小缩进去到顶格：复制出来的是「独立的子树」，
 *   粘到文本框不该带着原来的层级缩进；
 * - 块与块之间空行分隔（防止两个段落粘成一段）。
 *
 * 设计上剪贴板里就是纯 Markdown：粘到文本框是纯文本，粘回导图时
 * 由 insertSubtreeFromText 重新解析成节点，不需要自定义剪贴板格式。
 *
 * @returns 剪贴板文本；没有有效节点时返回空串
 */
export function extractSubtreeText(
    markdown: string,
    tree: MindMapTreeNode,
    uids: readonly string[]
): string {
    const lines = markdown.split('\n');
    const ranges: Array<{ from: number; to: number }> = [];
    for (const uid of uids) {
        const found = findNodeByUid(tree, uid);
        const node = found?.node;
        if (!node || node.data._kind === 'root') continue;
        const range = node.data._lineRange;
        if (!range) continue;
        ranges.push({ from: range.fromLine, to: range.toLine });
    }
    if (ranges.length === 0) return '';
    ranges.sort((a, b) => a.from - b.from);
    const kept: Array<{ from: number; to: number }> = [];
    for (const range of ranges) {
        const last = kept[kept.length - 1];
        if (last && range.from >= last.from && range.to <= last.to) continue;
        kept.push(range);
    }
    const blocks = kept.map((range) => {
        const block = lines.slice(range.from, range.to + 1);
        const nonEmpty = block.filter((line) => line.trim() !== '');
        // 整块都是空行（理论上不会有，保险）：直接当空块丢掉，
        // 否则 Math.min() 得到 Infinity，reindentLines 会做无意义的去缩进
        if (nonEmpty.length === 0) return [];
        const indent = Math.min(...nonEmpty.map((line) => listIndentOf(line)));
        return indent > 0 ? reindentLines(block, -indent) : block;
    });
    return blocks
        .map((block) => block.join('\n').replace(/\n{3,}/g, '\n\n').trim())
        .filter((block) => block !== '')
        .join('\n\n');
}


/**
 * §6.6 粘贴：把一段 Markdown（通常来自 extractSubtreeText）解析后
 * 作为目标节点的**子节点**插入（XMind 惯例：选谁就粘到谁下面）。
 *
 * 各目标类型的换算：
 * - root：标题追加到文末；非标题块插到第一个标题之前（同 addNode 的
 *   rootBlockChild 规则，否则会被解析成最后一个标题的子节点）；
 * - 标题（级别 L）：剪贴板里的标题子树整体平移，最浅的标题落到 L+1；
 *   非标题块锚定在「第一个子标题之前」（同 addNode 的标题锚定）；
 * - 列表：标题/段落降级成列表项（`- 文字`，CommonMark 里列表项塞不进
 *   标题），列表整块搬入重缩进，媒体块缩进到内容列；
 * - 段落：先原地升级成列表项（同 addChildNode），再按列表处理。
 *
 * 不返回 newNodeUid：粘贴后不进编辑态，由调用方自己决定选谁。
 *
 * @returns 新全文；剪贴板为空 / 目标是 meta / 媒体时原样返回
 */
export function insertSubtreeFromText(
    markdown: string,
    tree: MindMapTreeNode,
    targetUid: string,
    clipText: string
): EditResult {
    // CRLF 归一：剪贴板文本可能来自任何编辑器
    const clip = clipText.replace(/\r\n/g, '\n').trim();
    if (!clip) return { text: markdown };
    const found = findNodeByUid(tree, targetUid);
    if (!found) return { text: markdown };
    const target = found.node;
    const kind = target.data._kind;
    // meta / 媒体节点不能有子节点（与 addChildNode 同一规约）
    if (kind === 'meta' || isMediaKind(kind)) return { text: markdown };

    // 剪贴板文本解析成临时树：根的子节点就是要插的节点。
    // 文件名传「粘贴」只为可读；meta（front matter）不是内容，丢掉
    const clipTree = buildMindMapTree(clip, '粘贴');
    const clipChildren = clipTree.children.filter((c) => c.data._kind !== 'meta');
    if (clipChildren.length === 0) return { text: markdown };

    const lines = markdown.split('\n');
    // 缩进判断用归一化文本（同 addChildNode 的说明）
    const normalizedLines = normalizeNestedListIndent(markdown).split('\n');
    const clipLines = clip.split('\n');

    /** 取 clip 子节点（含子树）的源码行块。 */
    const blockOf = (node: MindMapTreeNode): string[] => {
        const range = node.data._lineRange;
        if (!range) return [];
        return clipLines.slice(range.fromLine, range.toLine + 1);
    };

    /** 取 clip 子节点**自身**的源码行块（不含子节点，标题续行靠它）。 */
    const selfBlockOf = (node: MindMapTreeNode): string[] => {
        const range = node.data._selfLineRange as NodeLineRange | undefined;
        if (!range) return [];
        return clipLines.slice(range.fromLine, range.toLine + 1);
    };

    /** 把一块行插进 lines（走 insertBlockLines 的空行规约）。 */
    const applyInsert = (at: number, block: string[], blankSeparated: boolean): void => {
        // 空块直接跳过：insertBlockLines 仍会在空白分隔模式下补空行，
        // 结果是在插入点凭空多出一行空白，把文档写脏
        if (block.length === 0) return;
        // 空行分隔时，先把插入点两侧原有的多余空行收成一个，
        // 再让 insertBlockLines 补齐缺失的那一个（前后各恰好一行空白）
        const pos = blankSeparated ? limitAdjacentBlankLines(lines, at) : at;
        const next = insertBlockLines(lines, pos, block, blankSeparated, lines.join('\n'));
        lines.length = 0;
        lines.push(...next);
    };

    // —— root ——
    if (kind === 'root') {
        const firstHeading = target.children.find(
            (c) => c.data._kind === 'heading' && !!c.data._lineRange
        );
        // 先标题（文末）后块（标题前）：从后往前插，行号互不影响
        const headBlocks = clipChildren
            .filter((c) => c.data._kind === 'heading')
            .map(blockOf);
        const bodyBlocks = clipChildren
            .filter((c) => c.data._kind !== 'heading')
            .map(blockOf);
        // 块与块之间统一一个空行（段落 / 表格 / 引用 / 列表都是不同块），
        // 否则段落会粘成一段、表格紧贴上一段会失效
        if (headBlocks.length > 0) {
            applyInsert(lines.length, joinBlocks(headBlocks, true), true);
        }
        if (bodyBlocks.length > 0) {
            const at = firstHeading?.data._lineRange?.fromLine ?? lines.length;
            applyInsert(at, joinBlocks(bodyBlocks, true), true);
        }
        return { text: lines.join('\n') };
    }

    // —— 段落：先升级成列表项，再按列表处理 ——
    let listIndent: number | null = null;
    let listInsertAt = 0;
    if (kind === 'para') {
        const self =
            (target.data._selfLineRange as NodeLineRange | undefined) ?? rangeOf(target);
        listIndent = promoteParagraphToList(lines, self);
        listInsertAt = self.toLine + 1;
    } else if (kind === 'list') {
        listIndent = listContentColumn(
            normalizedLines[rangeOf(target).fromLine] ?? '-'
        );
        listInsertAt = rangeOf(target).toLine + 1;
    }

    // —— 列表 / 段落（已升级）：全部转成列表项体系 ——
    if (listIndent !== null) {
        const out: string[] = [];
        /**
         * 把一个 clip 子节点转成列表项行（递归，子项缩进 +2）。
         * 列表与媒体搬原始行块（保围栏/表格结构），标题与段落取文字。
         */
        const emit = (node: MindMapTreeNode, indent: number): void => {
            const pad = ' '.repeat(indent);
            const ck = node.data._kind;
            if (ck === 'heading' || ck === 'para') {
                // 列表项内容列 = marker 缩进 + "- " 宽度；续行必须缩到这里，
                // 只缩第一行会让续行掉出列表项变成顶层段落（拆散列表）
                const contentPad = `${pad}  `;
                const textLines = node.data.text.split('\n');
                // 段落的多行就在 data.text 里；标题的续行不在 text 里
                // （treeBuilder 把紧挨标题的段落并进了 _selfLineRange），
                // 所以标题还要从自身行区间把续行捞出来。
                const continuation =
                    ck === 'heading'
                        ? headingContinuationLines(selfBlockOf(node)).concat(
                              textLines.slice(1)
                          )
                        : textLines.slice(1);
                // 只去行首缩进，行尾的两个空格是硬换行，要原样保留
                const first = (textLines[0] ?? '').replace(/^[ \t]+/, '');
                // 空标题 / 空段落只写一个光杆 marker，别留下尾随空格
                out.push(first.trim() !== '' ? `${pad}- ${first}` : `${pad}-`);
                // 续行逐行重挂到内容列：不能沿用 clip 原文的层级缩进，
                // 否则一层层粘贴会越缩越深；同样保留行尾硬换行空格
                for (const line of continuation) {
                    if (line.trim() === '') continue;
                    out.push(contentPad + line.replace(/^[ \t]+/, ''));
                }
                for (const child of node.children) emit(child, indent + 2);
                return;
            }
            // list / 媒体：原始行块重缩进到目标列（clip 已顶格，直接加 pad）。
            // 这里的 indent 已经是「父列表项的内容列」：媒体块必须落在
            // marker 之后，写到 marker 列会被 CommonMark 当成脱出列表的
            // 顶层块，把列表从中间拆成两段。
            for (const line of blockOf(node)) {
                out.push(line.trim() === '' ? '' : pad + line);
            }
        };
        for (const child of clipChildren) emit(child, listIndent);
        applyInsert(listInsertAt, out, false);
        return { text: lines.join('\n') };
    }

    // —— 标题：标题子树平移到 L+1 起，非标题块锚在第一个子标题之前 ——
    if (kind === 'heading') {
        const level = target.data._headingLevel ?? 1;
        const childLevel = Math.min(6, level + 1);
        const headingChildren = clipChildren.filter((c) => c.data._kind === 'heading');
        const bodyChildren = clipChildren.filter((c) => c.data._kind !== 'heading');
        // 先插标题（章节末尾）：用旧树的区间，后面插内容块不影响它
        if (headingChildren.length > 0) {
            const topLevel = Math.min(
                ...headingChildren.map((c) => c.data._headingLevel ?? 1)
            );
            // shiftHeadingLevel 的语义是「level - delta」：delta 可负（降级）
            const delta = topLevel - childLevel;
            // 每个标题子树是独立的块：块之间要空一行，不能首尾直接粘上
            const block = joinBlocks(
                headingChildren.map((c) => shiftHeadingLevel(blockOf(c), delta)),
                true
            );
            applyInsert(rangeOf(target).toLine + 1, block, true);
        }
        // 再插非标题块：第一个子标题之前（锚定逻辑同 addNode）
        if (bodyChildren.length > 0) {
            const nonHeadingChildren = target.children.filter(
                (c) => c.data._kind !== 'heading'
            );
            const lastNonHeading = nonHeadingChildren[nonHeadingChildren.length - 1];
            const anchor =
                lastNonHeading?.data._lineRange?.toLine ??
                (target.data._selfLineRange as NodeLineRange | undefined)?.toLine ??
                rangeOf(target).fromLine;
            // 正文块之间同样空行分隔（段落 / 表格 / 列表各是独立的块）
            applyInsert(
                anchor + 1,
                joinBlocks(bodyChildren.map(blockOf), true),
                true
            );
        }
        return { text: lines.join('\n') };
    }

    return { text: markdown };
}


/**
 * §6.7 把一段 Markdown 作为**兄弟节点**插到 anchorUid 的前面 / 后面。
 *
 * 场景：把快速卡片拖到两个节点之间的间隙（而不是压在某个节点上）。
 * 与 insertSubtreeFromText（作为子节点）互补，落点语义照抄拖普通节点：
 * 「落在节点上 = 子节点，落在旁边 = 兄弟」。
 *
 * 兄弟的类型必须跟锚点一致，所以按锚点类型做换算：
 * - 列表锚点：标题 / 段落降级成同缩进、同标记的列表项；列表 / 媒体块
 *   整体平移到锚点的标记缩进；
 * - 标题锚点：标题块平移到同一层级（最浅的那级落到锚点级别），
 *   段落 / 列表升成同级标题；
 * - 段落 / 媒体锚点：原样插入（块之间空行分隔）。
 *
 * 媒体块（代码 / 公式 / 表格）没法当列表项或标题，列表锚点下会退化成
 * 锚点列表项的内容（Markdown 语法本身就不允许别的写法）。
 *
 * @param before - true = 插到锚点前面，false = 插到锚点后面
 * @returns 新全文；剪贴板为空 / 锚点是 root 时原样返回（root 没有兄弟）
 */
export function insertSiblingFromText(
    markdown: string,
    tree: MindMapTreeNode,
    anchorUid: string,
    before: boolean,
    clipText: string
): EditResult {
    // CRLF 归一：文本可能来自任何编辑器
    const clip = clipText.replace(/\r\n/g, '\n').trim();
    if (!clip) return { text: markdown };
    const found = findNodeByUid(tree, anchorUid);
    // root 没有兄弟：退回「作为子节点」，至少不丢内容
    if (!found || !found.parent || found.node.data._kind === 'root') {
        return insertSubtreeFromText(markdown, tree, anchorUid, clip);
    }
    const anchor = found.node;
    const clipLines = clip.split('\n');
    const clipTree = buildMindMapTree(clip, '粘贴');
    const children = clipTree.children.filter((c) => c.data._kind !== 'meta');
    if (children.length === 0) return { text: markdown };

    /** 取 clip 子节点（含子树）的源码行块。 */
    const blockOf = (node: MindMapTreeNode): string[] => {
        const range = node.data._lineRange;
        return range ? clipLines.slice(range.fromLine, range.toLine + 1) : [];
    };
    /** 整块平移到目标缩进列（列表 / 媒体块用）。 */
    const reindentTo = (block: string[], indent: number): string[] => {
        // 以第一个非空行判断源缩进：块首万一带空行也不会把判据打偏
        const first = block.find((line) => line.trim() !== '') ?? '';
        const from = listIndentOf(first);
        return from === indent ? block : reindentLines(block, indent - from);
    };

    const lines = markdown.split('\n');
    const anchorLine = lines[rangeOf(anchor).fromLine] ?? '';
    const kind = anchor.data._kind;
    const blocks: string[][] = [];

    if (kind === 'list') {
        const anchorMatch = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(anchorLine);
        const indent = listIndentOf(anchorLine);
        // 媒体 / 引用等非列表块的对齐列 = 父列表项的**内容列**（marker 之后）。
        // 用 marker 列会把它们写到列表项外面，把列表拆成两段。
        // 锚点行解析不出列表形态时没有可靠的内容列，保持原缩进。
        const contentIndent = anchorMatch ? listContentColumn(anchorLine) : null;
        // 标记沿用锚点（`-` / `*` / `1.` …）；有序列表不重排后续序号，
        // CommonMark 渲染时只看第一个数字，重建树也不依赖序号
        const marker = anchorMatch?.[2] ?? '-';
        for (const child of children) {
            const block = blockOf(child);
            const ck = child.data._kind;
            if (ck === 'heading' || ck === 'para') {
                blocks.push(transformHeadingBlockToList(block, indent, marker));
            } else if (ck === 'list') {
                // 列表块是真正的同级列表项：平移到锚点的 marker 列
                blocks.push(reindentTo(block, indent));
            } else {
                // 媒体 / 引用没有列表形态：退化成锚点列表项的内容
                blocks.push(contentIndent === null ? block : reindentTo(block, contentIndent));
            }
        }
    } else if (kind === 'heading') {
        const level = anchor.data._headingLevel ?? 1;
        for (const child of children) {
            const block = blockOf(child);
            if (child.data._kind === 'heading') {
                blocks.push(transformHeadingBlock(block, child.data._headingLevel ?? 1, level));
            } else if (child.data._kind === 'para' || child.data._kind === 'list') {
                blocks.push(transformListBlockToHeading(block, level));
            } else {
                // 媒体 / 引用没有标题形态：原样插入。以前这里也走
                // transformListBlockToHeading，会把围栏首行写成 `# ``` `，
                // 整个代码块就坏了。
                blocks.push(block);
            }
        }
    } else {
        for (const child of children) blocks.push(blockOf(child));
    }

    const range = rangeOf(anchor);
    const at = before ? range.fromLine : range.toLine + 1;
    // 列表项之间不能塞空行（会被拆成两段列表），其余块用空行隔开
    const blankSeparated = kind !== 'list';
    // 块自身可能带首尾空行，统一裁掉后按需补一个，避免叠出多个空行
    const block = joinBlocks(blocks, blankSeparated);
    // 没有可用块时原样返回：空块 + 空白分隔也会凭空插入空行
    if (block.length === 0) return { text: markdown };
    // 空白分隔时，插入点两侧原有的多余空行先收成一个
    const pos = blankSeparated ? limitAdjacentBlankLines(lines, at) : at;
    return { text: insertBlockLines(lines, pos, block, blankSeparated, markdown).join('\n') };
}


/**
 * 把一段行里的 ATX 标题整体升 `delta` 级（`#` 数量减少）。
 *
 * 只认 ATX；setext 标题（文字行 + `===`/`---` 下划线）没法用「改 `#` 数」
 * 表达层级变化，原样保留 —— 宁可层级不动，也不能把下划线行改坏。
 *
 * @param block 标题子树的行
 * @param delta 要升的级数（> 0）
 * @returns 新的行数组
 */
export function shiftHeadingLevel(block: string[], delta: number): string[] {
    return block.map((line) => {
        const match = /^([ \t]*)(#{1,6})([ \t]+.*)$/.exec(line);
        if (!match) return line;
        const level = Math.min(6, Math.max(1, match[2].length - delta));
        if (level === match[2].length) return line;
        return `${match[1]}${'#'.repeat(level)}${match[3]}`;
    });
}
