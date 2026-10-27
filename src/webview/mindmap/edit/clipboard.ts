/**
 * 导图 Markdown 回写（从 markdownEdit.ts 拆出）：§6.5/6.6 剪贴板：子树提取与粘贴重定级。
 *
 * 全部是纯函数：输入 markdown 全文与节点信息，返回编辑结果。
 *
 * @module webview/mindmap/edit/clipboard
 */

import { addChildNode, addNode } from './add.js';
import { insertBlockLines, listContentColumn, listIndentOf, promoteParagraphToList, reindentLines } from './move.js';
import { isMediaKind } from './rename.js';
import { EditResult, findNodeByUid, rangeOf } from './shared.js';
import { buildMindMapTree, normalizeNestedListIndent } from '../treeBuilder.js';
import type { MindMapTreeNode, NodeLineRange } from '../types.js';


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

    /** 把一块行插进 lines（走 insertBlockLines 的空行规约）。 */
    const applyInsert = (at: number, block: string[], blankSeparated: boolean): void => {
        const next = insertBlockLines(lines, at, block, blankSeparated, lines.join('\n'));
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
        for (const block of headBlocks) {
            applyInsert(lines.length, block, true);
        }
        if (bodyBlocks.length > 0) {
            const at = firstHeading?.data._lineRange?.fromLine ?? lines.length;
            applyInsert(at, bodyBlocks.flat(), true);
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
                out.push(`${pad}- ${node.data.text}`);
                for (const child of node.children) emit(child, indent + 2);
                return;
            }
            // list / 媒体：原始行块重缩进到目标列（clip 已顶格，直接加 pad）
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
            const block = headingChildren.flatMap((c) =>
                shiftHeadingLevel(blockOf(c), delta)
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
            applyInsert(anchor + 1, bodyChildren.flatMap(blockOf), true);
        }
        return { text: lines.join('\n') };
    }

    return { text: markdown };
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
