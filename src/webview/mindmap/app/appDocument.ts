/**
 * MindMapApp 协作模块（从 mindmapApp.ts 拆出）：文档装载。
 *
 * setMarkdown 入口 + 展开状态烘烤 + computeNodeDoc（给画布算每个节点的
 * 显示文档，处理续行 / sentinel / dedent）。
 *
 * @module webview/mindmap/app/appDocument
 */

import type { MindMapApp } from '../mindmapApp.js';
import type { ThemeType } from '../../../shared/types.js';
import { extractSubtreeText, insertSubtreeFromText } from '.././edit/clipboard.js';
import { renameNode } from '.././edit/rename.js';
import type { MapNode } from '.././engine/model.js';
import type { MindMapTreeNode, NodeLineRange } from '.././types.js';

/** 更新 markdown 并同步按行缓存。 */
export function setMarkdown(app: MindMapApp, text: string): void {
    app.markdown = text;
    app.markdownLines = text.split('\n');
}

/** 按主题设置解析实际明暗。 */
export function resolveTheme(app: MindMapApp): ThemeType {
    if (app.settings.mindmapTheme === 'dark') return 'dark';
    if (app.settings.mindmapTheme === 'default') return 'light';
    return app.theme;
}

/**
 * 重建前把展开状态烤进树：新 uid 按默认展开层级初始化，旧 uid 跟随用户操作。
 */
export function bakeExpandState(app: MindMapApp, tree: MindMapTreeNode): MindMapTreeNode {
    const level = app.settings.mindmapDefaultExpandLevel;
    const walk = (node: MindMapTreeNode, depth: number): void => {
        const uid = node.data.uid;
        if (!app.knownUids.has(uid)) {
            app.knownUids.add(uid);
            if (depth >= level && node.children.length > 0) {
                app.collapsedUids.add(uid);
            }
        }
        node.data.expand = !app.collapsedUids.has(uid);
        node.children.forEach((child) => walk(child, depth + 1));
    };
    walk(tree, 0);
    return tree;
}

/** 渲染节点显示文档（computeDoc 回调）。 */
export function computeNodeDoc(app: MindMapApp, node: MapNode): { doc: string; sentinel: boolean } {
    const range = node.data._lineRange as NodeLineRange | undefined;
    // 自身区间（不含子节点）：列表项的父节点不能把嵌套列表再渲染一遍
    const selfRange =
        (node.data._selfLineRange as NodeLineRange | undefined) ?? range;
    const sliceRange = (r: NodeLineRange | undefined): string =>
        r ? app.markdownLines.slice(r.fromLine, r.toLine + 1).join('\n') : '';
    switch (node.kind) {
        case 'root':
            return { doc: `# ${node.text}`, sentinel: true };
        case 'heading': {
            // 标题节点允许在格子里按 Enter 换行（commit 后 md 是「# 标题」+
            // 紧跟的续行，treeBuilder 把它并回同一个节点）。首行统一显示成
            // 规范的 ATX 前缀，续行原样保留：
            // - ATX：源首行以 # 开头，续行从第 2 行起；
            // - setext：源首行是文字、第 2 行是 ===/--- 下划线（不显示），
            //   续行从第 3 行起。
            const level = Number(node.data._headingLevel ?? 1);
            const prefix = '#'.repeat(Math.min(6, Math.max(1, level)));
            const lines = selfRange ? sliceRange(selfRange).split('\n') : [];
            const first = (lines[0] ?? '').trimStart();
            const isAtx = /^#{1,6}(\s|$)/.test(first);
            const isSetext =
                !isAtx &&
                lines.length > 1 &&
                /^\s*(?:=+|-+)\s*$/.test(lines[1] ?? '');
            const continuation = lines
                .slice(isAtx ? 1 : isSetext ? 2 : 1)
                .join('\n');
            return {
                doc: continuation
                    ? `${prefix} ${node.text}\n${continuation}`
                    : `${prefix} ${node.text}`,
                sentinel: true,
            };
        }
        case 'para':
            return { doc: sliceRange(range).trim(), sentinel: true };
        case 'quote':
            // 引用块：整段源码（含 > 标记）喂给 mini-CM，渲染与 live 一致；
            // 列表项里的引用行带父级缩进，与媒体节点一样先去掉
            return {
                doc: selfRange ? dedentNodeSource(sliceRange(selfRange)) : node.text,
                sentinel: true,
            };
        case 'list':
            // 只渲染列表项自身（含首段续行），子列表是独立节点。
            // 必须先去掉父级缩进：嵌套项在源文档里带 2 空格 / 1 个 Tab，
            // 单元格是独立节点，直接把缩进画进去会在格子左边多出一截空白。
            return {
                doc: selfRange
                    ? dedentNodeSource(sliceRange(selfRange))
                    : node.text,
                sentinel: true,
            };
        default:
            // code / table / math / mermaid / image / meta：叶子，整段源码。
            // 与列表节点一样去掉公共行首缩进：列表项里的围栏在源文档中
            // 为了挂进列表会缩进到内容列（有序列表嵌套时能到 7 格）。
            // 节点是独立的 mini-CM，缩进 ≥4 格的围栏会被 CommonMark 判成
            // 「缩进代码块」而不是 FencedCode —— mermaid 的块级 widget
            // 根本不会生成，表现就是「mermaid 不渲染」。提交时
            // renameNode 会把缩进按原样补回去。
            return {
                doc: range ? dedentNodeSource(sliceRange(range)) : node.text,
                sentinel: true,
            };
    }
}





































// ==================================================================
// 剪贴板（复制 / 剪切 / 粘贴）
//
// 设计要点：剪贴板里只放**纯 Markdown 源码**（extractSubtreeText），
// 粘到文本框是普通文本，粘回导图由 insertSubtreeFromText 解析成
// 子节点挂到目标下面 —— 一种格式同时满足两个世界。
// ==================================================================

/**
 * 去掉节点源码的公共行首缩进（导图单元格渲染用）。
 *
 * 列表项及列表项里的媒体块在源文档里带父级缩进（空格或 Tab），但单元格
 * 本身已经是独立的节点，缩进再画进去就会在格子左侧多出一截空白
 * （有序 / 无序 / 代码块 / 表格 / mermaid 同此）。
 *
 * 对媒体块还有一层语义影响：围栏缩进 ≥4 格时，独立的 mini-CM 会把它
 * 解析成「缩进代码块」，mermaid 的块级 widget 不会生成。去掉缩进后
 * 才是普通 FencedCode（提交时 renameNode 会补回去）。
 *
 * 以首行为基准整体左移，续行保留相对缩进：
 * ```
 *   - foo          ->  - foo
 *     bar          ->    bar
 * ```
 * 首行没有缩进（顶层列表项）时原样返回，避免无谓的字符串复制。
 *
 * @param source 节点自身的源码行（`_selfLineRange` / `_lineRange` 切片）
 * @returns 去掉公共缩进后的源码
 */
export function dedentNodeSource(source: string): string {
    const lines = source.split('\n');
    const indent = /^[ \t]*/.exec(lines[0] ?? '')?.[0] ?? '';
    if (!indent) return source;
    return lines
        .map((line) =>
            line.startsWith(indent)
                ? line.slice(indent.length)
                : // 懒续行可能比首行缩进更浅：兜底去掉自己的行首空白
                  line.replace(/^[ \t]+/, '')
        )
        .join('\n');
}
