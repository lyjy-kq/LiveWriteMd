/**
 * 导图 Markdown 回写（从 markdownEdit.ts 拆出）：§6.4 拖拽移动：moveNode + 各类型变换辅助。
 *
 * 全部是纯函数：输入 markdown 全文与节点信息，返回编辑结果。
 *
 * @module webview/mindmap/edit/move
 */

import { isMediaKind } from './rename.js';
import { EditResult, findNodeByUid, rangeOf } from './shared.js';
import { normalizeNestedListIndent } from '../treeBuilder.js';
import type { MindMapTreeNode } from '../types.js';


/**
 * §6.4 拖拽移动（类型不变、各走各的链）。
 *
 * @param dragUid 被拖节点 uid
 * @param newParentUid 新父 uid（root / heading / list）
 * @param anchorUid 新位置的前一个兄弟 uid（优先）；没有时用 after=false + nextUid
 * @param nextUid 新位置的后一个兄弟 uid（anchorUid 为空时使用）
 */
export function moveNode(options: {
    markdown: string;
    tree: MindMapTreeNode;
    dragUid: string;
    newParentUid: string;
    anchorUid: string | null;
    nextUid: string | null;
}): EditResult {
    const { markdown, tree, dragUid, newParentUid, anchorUid, nextUid } = options;
    const dragFound = findNodeByUid(tree, dragUid);
    const parentFound = findNodeByUid(tree, newParentUid);
    if (!dragFound || !parentFound || !dragFound.parent) return { text: markdown };
    const dragNode = dragFound.node;
    const parentNode = parentFound.node;
    if (
        dragNode.data._kind === 'para' ||
        dragNode.data._kind === 'quote' ||
        dragNode.data._kind === 'root'
    ) {
        return { text: markdown };
    }
    // 媒体节点（code/table/image）：原样搬运整段行区间，块级内容与上下空行分隔
    const mediaDrag = isMediaKind(dragNode.data._kind);

    let lines = markdown.split('\n');
    // 缩进参照用归一化文本（行数不变）：拖动落点与增删节点必须按同一套
    // 列表层级计算，否则缩进不足的嵌套列表会把媒体块甩出父项。
    const normalizedLines = normalizeNestedListIndent(markdown).split('\n');
    const range = rangeOf(dragNode);

    // —— 跨链类型转换判定（迭代 N2：列表项 ↔ 标题互转）——
    // 落点语境决定类型：标题落到列表链上（列表节点上 / 纯列表间隙）→ 转成
    // 列表项；列表项落到纯标题间隙 → 转成同级标题。混合锚点（一边标题一边
    // 列表）不转换，保持原类型。
    const anchorNode = anchorUid ? findNodeByUid(tree, anchorUid)?.node : null;
    const gapNextNode = nextUid ? findNodeByUid(tree, nextUid)?.node : null;
    const anchorKind = anchorNode?.data._kind ?? null;
    const gapNextKind = gapNextNode?.data._kind ?? null;
    const dragKind = dragNode.data._kind;
    let convertTo: 'heading' | 'list' | null = null;
    if (dragKind === 'heading') {
        if (parentNode.data._kind === 'list') {
            convertTo = 'list';
        } else if (
            (anchorKind === 'list' || gapNextKind === 'list') &&
            anchorKind !== 'heading' &&
            gapNextKind !== 'heading'
        ) {
            convertTo = 'list';
        }
    } else if (dragKind === 'list') {
        if (
            (anchorKind === 'heading' || gapNextKind === 'heading') &&
            anchorKind !== 'list' &&
            gapNextKind !== 'list'
        ) {
            convertTo = 'heading';
        }
    }
    // 空行分隔按「转换后的类型」算（转成标题 = 块级空行分隔；转成列表项 = 随列表链）
    const effectiveKind = convertTo ?? dragKind;

    // 按类型生成「相对新父节点正确形态」的块
    let blockLines: string[];
    if (mediaDrag) {
        blockLines = lines.slice(range.fromLine, range.toLine + 1);
        // 落到列表节点下：整段缩进到列表内容列，否则 CommonMark 会认为它已脱出列表
        if (parentNode.data._kind === 'list') {
            const indent = listContentColumn(
                normalizedLines[rangeOf(parentNode).fromLine] ?? '-'
            );
            blockLines = reindentLines(blockLines, indent);
        }
    } else if (convertTo === 'list') {
        // 标题块 → 列表块：首行剥 # 改成列表项行（缩进/标记随落点），
        // 章节内容整体缩进到列表内容列（保持子树仍挂在新列表项下）
        const { indent, marker } = listMarkerForDrop(
            normalizedLines,
            anchorNode,
            gapNextNode,
            parentNode
        );
        blockLines = transformHeadingBlockToList(
            lines.slice(range.fromLine, range.toLine + 1),
            indent,
            marker
        );
    } else if (convertTo === 'heading') {
        // 列表块 → 标题块：首行剥列表标记改成标题行（层级随标题兄弟），
        // 其余行 dedent 到顶格（作为标题章节下的顶层内容）
        const siblingLevel =
            (anchorKind === 'heading'
                ? anchorNode?.data._headingLevel
                : gapNextNode?.data._headingLevel) ?? 1;
        blockLines = transformListBlockToHeading(
            lines.slice(range.fromLine, range.toLine + 1),
            siblingLevel
        );
    } else if (dragNode.data._kind === 'heading') {
        const newLevel =
            parentNode.data._kind === 'root'
                ? 1
                : (parentNode.data._headingLevel ?? 1) + 1;
        const oldLevel = dragNode.data._headingLevel ?? 1;
        blockLines = transformHeadingBlock(
            lines.slice(range.fromLine, range.toLine + 1),
            oldLevel,
            newLevel
        );
    } else {
        const sourceFirst = lines[range.fromLine] ?? '-';
        const oldIndent = listIndentOf(sourceFirst);
        const newIndent =
            parentNode.data._kind === 'list'
                ? listContentColumn(
                      normalizedLines[rangeOf(parentNode).fromLine] ?? '-'
                  )
                : 0;
        blockLines = reindentLines(
            lines.slice(range.fromLine, range.toLine + 1),
            newIndent - oldIndent
        );
    }

    // 先在「旧文档坐标」里算出插入行，然后剪切块，再修正插入点
    let insertAt: number;
    let blankSeparated: boolean;
    if (anchorUid) {
        const anchor = findNodeByUid(tree, anchorUid);
        if (!anchor) return { text: markdown };
        insertAt = rangeOf(anchor.node).toLine + 1;
        blankSeparated =
            mediaDrag ||
            effectiveKind === 'heading' ||
            anchor.node.data._kind === 'heading';
    } else if (nextUid) {
        const next = findNodeByUid(tree, nextUid);
        if (!next) return { text: markdown };
        insertAt = rangeOf(next.node).fromLine;
        blankSeparated =
            mediaDrag ||
            effectiveKind === 'heading' ||
            next.node.data._kind === 'heading';
    } else {
        // 落到父节点中央（MOVE_NODE_TO 语义=追加为最后一个子节点）：
        // 父节点已有其它子节点时，锚到最后一个非拖拽子节点的子树末尾。
        const otherChildren = parentNode.children.filter(
            (child) => child.data.uid !== dragNode.data.uid
        );
        const lastChild = otherChildren[otherChildren.length - 1];
        if (lastChild && lastChild.data._lineRange) {
            insertAt = lastChild.data._lineRange.toLine + 1;
            blankSeparated =
                mediaDrag ||
                effectiveKind === 'heading' ||
                lastChild.data._kind === 'heading';
        } else if (parentNode.data._kind === 'root') {
            insertAt = lines.length;
            blankSeparated = mediaDrag || effectiveKind === 'heading';
        } else if (parentNode.data._kind === 'heading') {
            insertAt = rangeOf(parentNode).fromLine + 1;
            blankSeparated = true;
        } else {
            insertAt = rangeOf(parentNode).fromLine + 1;
            // 列表父节点下的媒体块是列表项内容：与上文紧挨，不强制空行
            blankSeparated = mediaDrag;
        }
    }

    // 剪切
    lines.splice(range.fromLine, range.toLine - range.fromLine + 1);
    if (insertAt > range.fromLine) {
        insertAt -= range.toLine - range.fromLine + 1;
    }
    insertAt = Math.max(0, Math.min(insertAt, lines.length));

    // 列表节点落到 heading/root 下时按顶层列表形态处理空行
    lines = insertBlockLines(lines, insertAt, blockLines, blankSeparated, markdown);
    // 剪切/插入边界可能叠出多个空行，最多保留一个
    const joined = lines.join('\n').replace(/\n{3,}/g, '\n\n');
    return { text: joined };
}


/** 插入标题块，按需补空行分隔。 */
export function insertHeadingAtEnd(lines: string[], level: number, text: string): void {
    insertHeadingAt(lines, lines.length, level, text);
}


/** 在指定行位置插入标题，保证与上下内容之间有空行。 */
export function insertHeadingAt(
    lines: string[],
    at: number,
    level: number,
    text: string
): void {
    const block = ['#'.repeat(level) + ' ' + text];
    const result = insertBlockLines(lines, at, block, true, lines.join('\n'));
    lines.length = 0;
    lines.push(...result);
}


/** 插入列表项；insideList=true 时与上层列表紧挨，不强制空行。 */
export function insertListItem(
    lines: string[],
    at: number,
    indent: number,
    ordered: boolean,
    text: string,
    blankBefore: boolean
): void {
    const marker = ordered ? '1. ' : '- ';
    const block = [' '.repeat(indent) + marker + text];
    const result = insertBlockLines(lines, at, block, blankBefore, lines.join('\n'));
    lines.length = 0;
    lines.push(...result);
}


/**
 * 把整块行插入指定位置，按需在块前后补空行，避免标题 / 列表与正文粘连。
 */
export function insertBlockLines(
    lines: string[],
    at: number,
    block: string[],
    blankSeparated: boolean,
    _original: string
): string[] {
    const next = [...lines];
    const insert: string[] = [];
    if (blankSeparated && at > 0 && (next[at - 1] ?? '').trim() !== '') {
        insert.push('');
    }
    insert.push(...block);
    if (blankSeparated && at < next.length && (next[at] ?? '').trim() !== '') {
        insert.push('');
    }
    next.splice(at, 0, ...insert);
    return next;
}


/** 取列表行的前导缩进空格数。 */
export function listIndentOf(line: string): number {
    const match = /^(\s*)/.exec(line);
    return match ? match[1].replace(/\t/g, '    ').length : 0;
}


/**
 * 列表行内容列的位置（前导缩进 + marker + marker 后空白）。
 *
 * 子列表必须缩进到这一列才能被 CommonMark 识别为嵌套：
 * 无序列表 marker 宽 2（`- `），有序列表宽 3+（`1. `），
 * 统一按「缩进 +2」会让有序列表的子项退化成同级列表。
 */
export function listContentColumn(line: string): number {
    const match = /^(\s*(?:[-*+]|\d+[.)])\s+)/.exec(line);
    return match ? match[1].replace(/\t/g, '    ').length : listIndentOf(line) + 2;
}


/**
 * 把段落节点原地升级成列表项（段落要加子节点时用）。
 *
 * Markdown 里段落没有「子节点」这种结构：想让一段普通文字成为分支，
 * 只能把它变成列表项。转换保持文字内容与位置不变，只补 `- ` 前缀，
 * 续行缩进到 marker 之后（内容列），这样多行段落仍属于同一个列表项。
 *
 * @param lines - 可变的全文行数组（原地替换该段落的行）
 * @param range - 段落自身行区间（`_selfLineRange`，不含子节点）
 * @returns 新列表项的内容列缩进（子节点按这个缩进插入）
 */
export function promoteParagraphToList(
    lines: string[],
    range: { fromLine: number; toLine: number }
): number {
    const raw = lines.slice(range.fromLine, range.toLine + 1);
    if (raw.length === 0) return 0;
    // 段落可能缩进在列表项内部（续段），保留原缩进，只补 marker
    const indent = listIndentOf(raw[0]);
    const pad = ' '.repeat(indent);
    const converted = raw.map((line, index) => {
        const text = line.trim();
        if (text === '') return '';
        // 首行加 marker；续行缩到内容列（marker 宽 2）
        return index === 0 ? `${pad}- ${text}` : `${pad}  ${text}`;
    });
    lines.splice(range.fromLine, raw.length, ...converted);
    return indent + 2;
}


/** 整块统一增减缩进（delta 为负时逐行去缩进）。 */
export function reindentLines(block: string[], delta: number): string[] {
    return block.map((line) => {
        if (line.trim() === '') return line;
        if (delta >= 0) return ' '.repeat(delta) + line;
        const remove = Math.min(-delta, listIndentOf(line));
        return line.slice(remove);
    });
}


// ==================================================================
// 跨链类型转换（迭代 N2：列表项 ↔ 标题互转）
// ==================================================================

/**
 * 落点的列表形态（缩进 + 标记）：标题转列表项时用。
 *
 * - 间隙落点：跟随锚点列表项的缩进与列表类型；有序锚点递增/递减序号；
 * - 节点落点（无锚点，追加为子节点）：缩进到父列表的内容列，
 *   有序父取「现有子节点数 + 1」为序号，无序父用 `-`。
 */
export function listMarkerForDrop(
    lines: string[],
    anchorNode: MindMapTreeNode | null | undefined,
    gapNextNode: MindMapTreeNode | null | undefined,
    parentNode: MindMapTreeNode
): { indent: number; marker: string } {
    /** 解析列表行：缩进 / 标记文本 / 是否有序 / 序号。 */
    const parseListLine = (
        line: string
    ): { indent: number; markerText: string; ordered: boolean; num: number } | null => {
        const m = /^(\s*)([-*+]|(\d+)[.)])(\s+)/.exec(line);
        if (!m) return null;
        return {
            indent: m[1].replace(/\t/g, '    ').length,
            markerText: m[2],
            ordered: m[3] !== undefined,
            num: m[3] !== undefined ? Number(m[3]) : 0,
        };
    };
    // 间隙落点：优先跟前一个兄弟
    for (const sibling of [anchorNode, gapNextNode]) {
        if (!sibling?.data._lineRange) continue;
        const line = lines[sibling.data._lineRange.fromLine] ?? '';
        const parsed = parseListLine(line);
        if (!parsed) continue;
        if (!parsed.ordered) return { indent: parsed.indent, marker: parsed.markerText };
        const num = sibling === anchorNode ? parsed.num + 1 : Math.max(1, parsed.num - 1);
        return { indent: parsed.indent, marker: `${num}.` };
    }
    // 节点落点：追加为列表节点的最后一个子节点
    if (parentNode.data._lineRange) {
        const parentLine = lines[parentNode.data._lineRange.fromLine] ?? '-';
        const indent = listContentColumn(parentLine);
        const ordered = parentNode.data._listOrdered === true;
        return {
            indent,
            marker: ordered ? `${parentNode.children.length + 1}.` : '-',
        };
    }
    return { indent: 0, marker: '-' };
}


/**
 * 标题块 → 列表块（N2）。
 *
 * 首行剥 `#` 改成列表项行；其余行（章节内容）整体缩进到列表内容列，
 * 保证重建后子树仍挂在新列表项下。章节里的子标题留在原地（合法 md，
 * 但列表项内的标题不进导图——已知边界，见进度档案）。
 */
export function transformHeadingBlockToList(
    block: string[],
    indent: number,
    marker: string
): string[] {
    const result = [...block];
    const first = result[0] ?? '';
    const m = /^(\s*)#{1,6}\s+(.*)$/.exec(first);
    const text = m ? m[2] : first.trim();
    result[0] = ' '.repeat(indent) + marker + ' ' + text;
    const contentCol = indent + marker.length + 1;
    for (let i = 1; i < result.length; i++) {
        if (result[i].trim() === '') continue;
        result[i] = ' '.repeat(contentCol) + result[i];
    }
    return result;
}


/**
 * 列表块 → 标题块（N2）。
 *
 * 首行剥列表标记改成标题行（层级随标题兄弟）；其余行 dedent 到顶格，
 * 作为标题章节下的顶层内容（导图重建时子列表/段落仍是该标题的子节点）。
 */
export function transformListBlockToHeading(block: string[], level: number): string[] {
    const result = [...block];
    const first = result[0] ?? '';
    const m = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(first);
    const text = m ? m[2] : first.trim();
    const clamped = Math.min(6, Math.max(1, level));
    result[0] = '#'.repeat(clamped) + ' ' + text;
    const contentCol = m ? listContentColumn(first) : 0;
    for (let i = 1; i < result.length; i++) {
        if (result[i].trim() === '') continue;
        const remove = Math.min(contentCol, listIndentOf(result[i]));
        result[i] = result[i].slice(remove);
    }
    return result;
}


/**
 * 移动标题块：块内所有 ATX 标题整体偏移层级，最深截断为 H6；
 * 非标题行原样返回。
 */
export function transformHeadingBlock(
    block: string[],
    oldLevel: number,
    newLevel: number
): string[] {
    const delta = newLevel - oldLevel;
    return block.map((line) => {
        const match = /^(\s*)(#{1,6})(\s+.*)$/.exec(line);
        if (!match) return line;
        const level = Math.min(6, match[2].length + delta);
        if (level <= 0) return line;
        return match[1] + '#'.repeat(level) + match[3];
    });
}
