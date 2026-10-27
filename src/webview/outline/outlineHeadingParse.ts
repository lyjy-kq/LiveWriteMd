/**
 * 大纲面板：Markdown 标题解析（从 outlinePanel.ts 拆出）。
 *
 * 三个函数互相调用、只依赖入参，是类里唯一的纯逻辑块。
 * OutlineNode 类型留在 outlinePanel.ts（面板与渲染都用），type-only 导入。
 *
 * @module webview/outline/outlineHeadingParse
 */

import type { OutlineNode } from './outlinePanel.js';

/**
 * 瑙ｆ瀽 Markdown 鏍囬骞舵瀯寤烘爲褰㈢粨鏋勩€?     *
 * @param content - Markdown 婧愭枃鏈?     * @returns 鏍戝舰鏍囬鑺傜偣
 */
export function parseHeadings(content: string): OutlineNode[] {
    const lines = content.split(/\r?\n/);
    const rootNodes: OutlineNode[] = [];
    const stack: OutlineNode[] = [];
    const siblingCounts = new Map<string, number>();
    let inFence = false;
    let fenceMarker = '';
    let fenceLength = 0;

    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
        const currentLine = lines[lineNumber];
        const fenceMatch = currentLine.match(/^\s{0,3}(```+|~~~+)/);
        if (fenceMatch) {
            const marker = fenceMatch[1][0];
            const length = fenceMatch[1].length;
            if (!inFence) {
                inFence = true;
                fenceMarker = marker;
                fenceLength = length;
            } else if (marker === fenceMarker && length >= fenceLength) {
                inFence = false;
                fenceMarker = '';
                fenceLength = 0;
            }
            continue;
        }

        if (inFence) {
            continue;
        }

        const atxMatch = currentLine.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (atxMatch) {
            pushHeadingNode(
                rootNodes,
                stack,
                siblingCounts,
                atxMatch[1].length,
                normalizeHeadingText(atxMatch[2]),
                lineNumber + 1
            );
            continue;
        }

        const nextLine = lines[lineNumber + 1];
        const setextLevel =
            nextLine && /^\s*=+\s*$/.test(nextLine)
                ? 1
                : nextLine && /^\s*-+\s*$/.test(nextLine)
                  ? 2
                  : 0;
        if (setextLevel > 0) {
            const text = normalizeHeadingText(currentLine);
            if (text) {
                pushHeadingNode(rootNodes, stack, siblingCounts, setextLevel, text, lineNumber + 1);
            }
            lineNumber += 1;
        }
    }

    return rootNodes;
}

/**
 * 灏嗗崟涓爣棰樿妭鐐瑰姞鍏ユ爲缁撴瀯銆?     *
 * @param rootNodes - 鏍硅妭鐐瑰垪琛?     * @param stack - 褰撳墠瑙ｆ瀽鏍?     * @param siblingCounts - 鍚屽眰绾ц鏁板櫒
 * @param level - 鏍囬灞傜骇
 * @param text - 鏍囬鏂囨湰
 * @param line - 鏍囬鎵€鍦ㄨ鍙?     * @returns void
 */
export function pushHeadingNode(
    rootNodes: OutlineNode[],
    stack: OutlineNode[],
    siblingCounts: Map<string, number>,
    level: number,
    text: string,
    line: number
): void {
    if (!text) {
        return;
    }

    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
    }

    const parentPath = stack.map((node) => node.id).join('/');
    const siblingKey = `${parentPath}|${level}`;
    const siblingIndex = (siblingCounts.get(siblingKey) ?? 0) + 1;
    siblingCounts.set(siblingKey, siblingIndex);

    const node: OutlineNode = {
        id: `${siblingKey}|${siblingIndex}|${line}`,
        level,
        text,
        line,
        children: [],
    };

    if (stack.length === 0) {
        rootNodes.push(node);
    } else {
        stack[stack.length - 1].children.push(node);
    }

    stack.push(node);
}

/**
 * 清理标题文本，去掉尾部标记、内联 HTML 标签和多余空白。
 *
 * @param text - 原始标题文本。
 * @returns 清理后的标题文本。
 */
export function normalizeHeadingText(text: string): string {
    return text
        .replace(/<\/?[a-zA-Z][^>]*>/g, '')
        .replace(/\s+#+\s*$/, '')
        .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
        .replace(/[`*_~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
