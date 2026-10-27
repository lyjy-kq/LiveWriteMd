/**
 * 导图 Markdown 回写（从 markdownEdit.ts 拆出）：§6.1 改名：heading/list/para 三种写回策略。
 *
 * 全部是纯函数：输入 markdown 全文与节点信息，返回编辑结果。
 *
 * @module webview/mindmap/edit/rename
 */

import { EditResult, findNodeByUid, rangeOf } from './shared.js';
import type { MindMapTreeNode, NodeLineRange } from '../types.js';


/**
 * §6.1 改节点文字。
 *
 * - heading：替换标题行文字，保留 # 前缀（setext 标题整行替换，下划线保留）
 * - list：保留缩进 / 列表标记 / 任务标记，替换文字部分（续行按标记列重新缩进）
 * - para：整段区间替换
 * - root：不允许编辑（原样返回）
 */
export function renameNode(
    markdown: string,
    tree: MindMapTreeNode,
    uid: string,
    newText: string
): EditResult {
    const found = findNodeByUid(tree, uid);
    if (!found || found.node.data._kind === 'root') return { text: markdown };
    const lines = markdown.split('\n');
    const node = found.node;
    const { fromLine, toLine } = rangeOf(node);
    const trimmed = newText.trim();

    if (node.data._kind === 'heading') {
        // 标题节点允许在格子里按 Enter 换行：提交的文本可能是多行。写回规则：
        //   首行 → 标题行（保留原有 ATX 前缀 / setext 文字行）
        //   其余行 → 紧跟在标题块后面的续行（treeBuilder 会把它并回同一节点）
        // setext 的第 2 行是 ===/--- 下划线，续行必须插在下划线之后。
        // 注意用 _selfLineRange：不能碰子节点的行。
        const self = (node.data._selfLineRange as NodeLineRange | undefined) ?? {
            fromLine,
            toLine,
        };
        const firstLine = lines[self.fromLine] ?? '';
        const contentLines = trimmed.split('\n');
        // 显示态首行被规范成了 ATX（"# 标题"），setext 节点也一样，所以
        // 提交文本的首行要先剥掉 ATX 前缀（和收尾的 # 串）再套回原行前缀。
        const stripPrefix = (line: string): string =>
            line
                .replace(/^[ \t]*#{1,6}[ \t]+/, '')
                .replace(/[ \t]+#+[ \t]*$/, '');
        const firstContent = stripPrefix(contentLines[0] ?? '');
        const continuation = contentLines.slice(1);
        const atxMatch = /^([ \t]*#{1,6}[ \t]+)(.*)$/.exec(firstLine);
        if (atxMatch) {
            lines[self.fromLine] = atxMatch[1] + firstContent;
            // 替换掉旧的续行（自身边界到标题行之后）
            lines.splice(
                self.fromLine + 1,
                self.toLine - self.fromLine,
                ...continuation
            );
        } else {
            // setext：第 1 行文字、第 2 行下划线，续行插在下划线之后
            lines[self.fromLine] = firstContent;
            lines.splice(
                self.fromLine + 2,
                Math.max(0, self.toLine - self.fromLine - 1),
                ...continuation
            );
        }
        return { text: lines.join('\n') };
    }

    if (node.data._kind === 'list') {
        const firstLine = lines[fromLine] ?? '';
        // 拆出：行首缩进 / 列表标记（含其后空白）/ 任务标记 / 内容
        const match = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/.exec(
            firstLine
        );
        if (!match) return { text: markdown };
        const indent = match[1];
        const marker = match[2] + match[3];
        const task = match[4] ?? '';
        const prefix = indent + marker + task;
        // 续行对齐到 marker 之后：保留原 Tab 缩进层级，只用空格补标记宽度
        const markerWidth = marker.length + task.length;
        const continuationIndent = indent + ' '.repeat(markerWidth);
        // 显示态文档已经去掉父级缩进，但首行仍带自己的列表 marker、
        // 续行仍带 marker 宽度的缩进（见 mindmapApp.dedentListSource）。
        // 提交时先剥掉这一层再套回原文前缀，否则会写成「- - 新文本」，
        // 续行的相对缩进也会一层层累加。
        const textLines = trimmed.split('\n').map((textLine, index) => {
            if (index === 0) {
                return textLine.replace(
                    /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/,
                    ''
                );
            }
            // 最多剥掉 marker 宽度的空白：用户额外敲的缩进要保留
            let cut = 0;
            while (
                cut < markerWidth &&
                (textLine[cut] === ' ' || textLine[cut] === '\t')
            ) {
                cut += 1;
            }
            return textLine.slice(cut);
        });
        const replacement = textLines.map((textLine, index) =>
            index === 0 ? prefix + textLine : continuationIndent + textLine
        );
        // 只替换列表项自身占用的行！_lineRange 含整棵子树，
        // 用它做 splice 会把嵌套子列表/代码块一起删掉。
        const self = (node.data._selfLineRange as NodeLineRange | undefined) ?? {
            fromLine,
            toLine,
        };
        lines.splice(self.fromLine, self.toLine - self.fromLine + 1, ...replacement);
        return { text: lines.join('\n') };
    }

    // para / 媒体 / 元数据节点（code/table/image/math/mermaid/meta）：
    // 整段行区间替换。编辑的就是其完整 md 源码（围栏、表格线、图片语法、
    // front matter 的 --- 全部由用户输入负责 —— 统一显示态后编辑态含完整结构）。
    //
    // 显示态给节点喂的是**去掉公共行首缩进**的源码（列表项里的围栏如果
    // 保留 4+ 空格，独立 mini-CM 会把它当成缩进代码块，mermaid 就不渲染）。
    // 提交时要按原首行缩进补回去，否则列表项里的代码块/表格会掉出列表。
    const originalIndent = /^[ \t]*/.exec(lines[fromLine] ?? '')?.[0] ?? '';
    const replacement = trimmed.split('\n').map((line) =>
        line.trim() === '' ? '' : originalIndent + line
    );
    lines.splice(fromLine, toLine - fromLine + 1, ...replacement);
    return { text: lines.join('\n') };
}


/** 是否媒体节点（code / table / image / math / mermaid / html）：叶位置、可删可拖可编辑源码。 */
export function isMediaKind(kind: string): boolean {
    return (
        kind === 'code' ||
        kind === 'table' ||
        kind === 'image' ||
        kind === 'math' ||
        kind === 'mermaid' ||
        kind === 'html'
    );
}
