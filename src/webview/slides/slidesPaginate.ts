/**
 * 幻灯片分页：逻辑页的节点树 + 实测高度 → 物理页。
 *
 * 纯函数，不碰 DOM。测量在上层（slidesApp）完成，这里只负责排版：
 *
 * 1. **分页单位 = 节点**（列表项、段落、媒体各是一个节点），不是整个列表块；
 *    这样长列表可以按条目续页，双栏也能从同一层级开始。
 * 2. **渲染单位 = 连续的同级节点段**：一页里能连着的兄弟节点会合并成
 *    一个片段再交给 mini-CM，编辑体验和「整块渲染」一致。
 * 3. **双栏判定**：左右两列都必须从同一父节点下、同一层级的节点开始，
 *    且两列都能各自装下至少一个节点；不满足就退回单列。
 * 4. **媒体同页**：媒体节点上下是段落 / 引用、它所属的列表项、或同父同层
 *    的列表兄弟时，拉进同一页；单独占页只是放不下时的兜底。
 * 5. **孤行保护**：标题不和正文拆开，父节点不和第一个子节点拆开。
 *
 * @module webview/slides/slidesPaginate
 */

import type {
    Deck,
    LayoutKind,
    LogicalSlide,
    SlideBlock,
    SlideItem,
    SlidePage,
} from './slidesModel.js';
import {
    dedentText,
    flattenItems,
    isEndSlide,
    layoutOf,
    titleFontSize,
} from './slidesModel.js';

/** 页面内容区可用高度（720 - 56 上下内边距）。 */
export const CONTENT_H = 720 - 56 * 2;
/** 页面内容区可用宽度（1280 - 72 左右内边距）。 */
export const CONTENT_W = 1280 - 72 * 2;
/** 双栏之间的水平间距（与 slidesStyles 的 .slide-two-col gap 一致）。 */
export const COLUMN_GAP = 32;
/** 双栏时每列的可用宽度。 */
export const COLUMN_W = (CONTENT_W - COLUMN_GAP) / 2;
/** 正文节点之间的垂直间距。 */
export const BLOCK_GAP = 16;
/** 单块溢出时允许缩到的最小比例。 */
export const FIT_MIN = 0.55;
/** 表格最小缩放：再小就提示作者精简，而不是缩成一团。 */
export const TABLE_MIN_SCALE = 0.7;
/** 合并媒体 + 文字后整页允许的等比缩放下限。 */
export const MEDIA_MERGE_MIN_SCALE = 0.45;

export interface MeasureResult {
    /** 单栏（整页宽）高度：key = item.id。 */
    body: Map<string, number>;
    /** 双栏（半页宽）高度：key = item.id；没测过就退回单列。 */
    bodyColumn: Map<string, number>;
    /** 标题块在标题字号下的高度：key = block.id。 */
    titles: Map<string, number>;
    /** 本轮实际创建的测量实例数（诊断用）。 */
    cmCount: number;
    /** 测量耗时（毫秒，诊断用）。 */
    ms: number;
}

/** 一页的排版结果（内部用节点表示，最后才折算成渲染片段）。 */
interface PackedPage {
    items: SlideItem[];
    /** 双栏页的左右两列；单列页为 undefined。 */
    columns?: [SlideItem[], SlideItem[]];
    /** 超高单节点的缩放比例：key = item.id（片段化后也写入片段 id）。 */
    fitByItem: Map<string, number>;
    overflow: boolean;
}

/** 可安全按源码行拆分的块；列表项、表格、图片、Mermaid 拆了没法回写。 */
const SPLITTABLE = new Set(['code', 'para', 'quote']);

/** 媒体节点：单独成页时可以和相邻解释文字 / 同级列表合并。 */
const MEDIA_KINDS = new Set(['table', 'image', 'mermaid', 'code']);

/** 能作为「解释文字」被媒体带进同一页的节点（标题不算）。 */
const TEXT_KINDS = new Set(['para', 'quote']);

/**
 * 两个相邻节点之间要不要留页面级间距。
 *
 * 同一个源码块内部的节点（列表的父子 / 兄弟）最终会落进同一个渲染
 * 片段（或至少在同一个列表结构里），条目之间只有行高、没有 16px 块
 * 间距；不同块之间才按页面级间距算。
 */
function gapBetween(prev: SlideItem, next: SlideItem): number {
    return prev.blockId === next.blockId ? 0 : BLOCK_GAP;
}

/** 一列节点的总高度（含列内片段间距，不含跨列间距）。 */
function sumColumnHeight(
    items: SlideItem[],
    heights: Map<string, number>
): number {
    let total = 0;
    for (let i = 0; i < items.length; i += 1) {
        total += heights.get(items[i].id) ?? 90;
        if (i > 0) total += gapBetween(items[i - 1], items[i]);
    }
    return total;
}

// =====================================================================
// 节点拆分
// =====================================================================

/** 一个拆出来的片段（带按行数估算的高度）。 */
interface SplitPiece {
    item: SlideItem;
    height: number;
}

/**
 * 单节点超过整页 1.2 倍时按源码行拆分，而不是缩成一团糊字。
 *
 * 只拆段落 / 引用 / 代码：列表项的最小单位就是条目本身（再拆会把
 * 标记与子项拆散），表格 / 图片 / Mermaid 拆了没法回写。
 * 拆出来的片段标 synthetic，只渲染、不提供编辑。
 */
function splitOversizedItem(
    item: SlideItem,
    height: number,
    bodyHeight: number
): SplitPiece[] | null {
    if (item.synthetic) return null;
    // 代码块**绝不缩放**：只要超过一页就按行拆（哪怕只多几行）。
    // 代码的字号一旦被等比缩小就很难读，而且页面下半截会空着 ——
    // 用户要的是「保持正常字号、铺满整页、拆成多页继续」。
    // 其它块留 20% 余量：略高一点点缩一点就能放下，拆页反而更碎。
    const splitThreshold = item.kind === 'code' ? bodyHeight : bodyHeight * 1.2;
    if (height <= splitThreshold) return null;

    const text = dedentText(item.source, item.indent);
    const lines = text.split('\n');

    // 表格过高：在数据行之间拆成多页，每页重复表头。
    //
    // 只有「缩到 TABLE_MIN_SCALE（0.7）还放不下」才拆：只是略高一点的
    // 表格缩一点就够，硬拆成两页反而打散阅读。拆出来的片段只读
    // （回写半张表会把源码结构打散），和超高段落的行为一致。
    if (item.kind === 'table') {
        if (height <= bodyHeight / TABLE_MIN_SCALE) return null;
        const sepIndex = lines.findIndex((line) =>
            /^\s*\|?\s*:?-{3,}/.test(line)
        );
        if (sepIndex < 0 || sepIndex + 1 >= lines.length) return null;
        const head = lines.slice(0, sepIndex + 1);
        const rows = lines.slice(sepIndex + 1).filter((line) => line.trim());
        if (rows.length < 2) return null;

        const targetH = bodyHeight * 0.9;
        const perChunk = Math.max(
            1,
            Math.floor((rows.length * targetH) / height)
        );
        const pieces: SplitPiece[] = [];
        for (let start = 0; start < rows.length; start += perChunk) {
            const slice = rows.slice(start, start + perChunk);
            const lineOffset = sepIndex + 1 + start;
            pieces.push({
                item: {
                    ...item,
                    id: `${item.id}#T${pieces.length}`,
                    synthetic: true,
                    fromLine: item.fromLine + lineOffset,
                    toLine: item.fromLine + lineOffset + slice.length - 1,
                    subtreeToLine: item.fromLine + lineOffset + slice.length - 1,
                    source: [...head, ...slice].join('\n'),
                    children: [],
                },
                height: Math.max(
                    40,
                    (height * (head.length + slice.length)) /
                        Math.max(1, lines.length)
                ),
            });
        }
        return pieces.length > 1 ? pieces : null;
    }

    // 列表项自身就是一段很长的段落（常见：一条列表项下面跟了一大段说明 /
    // 一张缩进的表被当成懒续行）时，按源代码行切成只读片段。
    // 否则整条只能缩到 0.4，字小到看不清。子节点仍会留在后面的节点流里。
    if (item.kind === 'list') {
        if (lines.length < 2) return null;
        const targetH = bodyHeight * 0.9;
        const perChunk = Math.max(
            1,
            Math.floor((lines.length * targetH) / height)
        );
        const pieces: SplitPiece[] = [];
        for (let start = 0; start < lines.length; start += perChunk) {
            const slice = lines.slice(start, start + perChunk);
            if (!slice.join('').trim()) continue;
            // 后续片段从续行开始，去掉它们自己的行首缩进，
            // 否则 4 格以上会被渲染成缩进代码块。
            const baseIndent = /^[ \t]*/.exec(slice[0])?.[0] ?? '';
            pieces.push({
                item: {
                    ...item,
                    id: `${item.id}#S${pieces.length}`,
                    // 第一段保留列表标记；后面的片段按普通段落渲染
                    kind: start === 0 ? 'list' : 'para',
                    synthetic: true,
                    fromLine: item.fromLine + start,
                    toLine: item.fromLine + start + slice.length - 1,
                    subtreeToLine: item.fromLine + start + slice.length - 1,
                    source: dedentText(slice.join('\n'), baseIndent),
                    children: [],
                },
                height: Math.max(
                    40,
                    (height * slice.length) / Math.max(1, lines.length)
                ),
            });
        }
        return pieces.length > 1 ? pieces : null;
    }

    // 有子节点的条目不能在这里拆：子节点会跟着片段走，拆开就乱序了。
    if (item.children.length > 0) return null;
    if (!SPLITTABLE.has(item.kind)) return null;
    if (lines.length < 4) return null;

    // 每页目标高度留 10% 余量，避免片段又刚好贴着页底
    const targetH = bodyHeight * 0.9;
    const scaleToH = (lineCount: number): number =>
        Math.max(40, (height * lineCount) / Math.max(1, lines.length));

    const makePiece = (
        index: number,
        lineOffset: number,
        lineCount: number,
        source: string,
        heightEst: number
    ): SplitPiece => ({
        item: {
            ...item,
            id: `${item.id}#S${index}`,
            synthetic: true,
            fromLine: item.fromLine + lineOffset,
            toLine: item.fromLine + lineOffset + lineCount - 1,
            subtreeToLine: item.fromLine + lineOffset + lineCount - 1,
            source,
            children: [],
        },
        height: heightEst,
    });

    if (item.kind === 'code') {
        // 围栏代码保留起止 fence，否则片段会被当成普通文本
        const fence = /^\s*(`{3,}|~{3,})/;
        if (!fence.test(lines[0]) || !fence.test(lines[lines.length - 1])) {
            return null;
        }
        const open = lines[0];
        const close = lines[lines.length - 1];
        const inner = lines.slice(1, -1);
        if (inner.length < 2) return null;
        // 代码片段按整页可用高度切，并且比其它块多留一点：
        // 离屏测量出的块高通常比真实渲染矮约 5%，按 0.9 切会让每页
        // 底部空出一截；0.94 补上这个偏差，渲染后正好铺到页面底部附近，
        // 又不会因为高出一行触发整页缩放（那样字号又变小了）。
        const codeTargetH = bodyHeight * 0.94;
        const perChunk = Math.max(
            1,
            Math.floor((inner.length * codeTargetH) / height)
        );
        const pieces: SplitPiece[] = [];
        for (let start = 0; start < inner.length; start += perChunk) {
            const slice = inner.slice(start, start + perChunk);
            pieces.push(
                makePiece(
                    pieces.length,
                    start + 1,
                    slice.length + 2,
                    [open, ...slice, close].join('\n'),
                    scaleToH(slice.length + 2)
                )
            );
        }
        return pieces.length > 1 ? pieces : null;
    }

    // para / quote：按行比例切
    const perChunk = Math.max(
        1,
        Math.floor((lines.length * targetH) / height)
    );
    const pieces: SplitPiece[] = [];
    for (let start = 0; start < lines.length; start += perChunk) {
        const slice = lines.slice(start, start + perChunk);
        if (!slice.join('').trim()) continue;
        pieces.push(
            makePiece(
                pieces.length,
                start,
                slice.length,
                slice.join('\n'),
                scaleToH(slice.length)
            )
        );
    }
    return pieces.length > 1 ? pieces : null;
}

/** 在分页前把超高节点拆成多个片段；返回新的节点流与高度表副本。 */
function expandOversized(
    items: SlideItem[],
    measured: MeasureResult,
    bodyHeight: number
): { items: SlideItem[]; heights: Map<string, number> } {
    // 高度表是副本：合成片段的高度不能写回 measured.body，否则下一轮
    // 测量没有这些 id，缓存会变脏。
    const heights = new Map(measured.body);
    const out: SlideItem[] = [];
    for (const item of items) {
        const height = heights.get(item.id) ?? 90;
        const pieces = splitOversizedItem(item, height, bodyHeight);
        if (!pieces) {
            out.push(item);
            continue;
        }
        for (const piece of pieces) {
            out.push(piece.item);
            heights.set(piece.item.id, piece.height);
        }
    }
    return { items: out, heights };
}

// =====================================================================
// 双栏
// =====================================================================

/**
 * k 是否是一个「同级边界」：左右两侧的节点同父同层。
 *
 * 这是双栏的唯一合法下刀点，也是「左列一级列表、右列二级列表不合格」
 * 的实现口径 —— 跨层下刀直接不成立。
 */
function isSiblingBoundary(items: SlideItem[], k: number): boolean {
    if (k <= 0 || k >= items.length) return false;
    const left = items[k - 1];
    const right = items[k];
    return left.parentId === right.parentId && left.depth === right.depth;
}

/**
 * 尝试把当前剩余节点排成双栏。
 *
 * 约束（全部满足才返回结果）：
 * - 左右两列从同父、同层的节点开始；
 * - 每列至少一个节点，且各自高度不超过列高；
 * - 两列高度差不超过 40%（避免一列挤满、一列空一半）；
 * - 不在子树中间下刀（边界必须是同级兄弟）。
 *
 * 返回当前页的双栏内容与剩余节点；失败返回 null，调用方退回单列。
 */
function tryColumns(
    items: SlideItem[],
    columnHeights: Map<string, number>,
    bodyHeight: number
): { left: SlideItem[]; right: SlideItem[]; rest: SlideItem[] } | null {
    if (items.length < 2) return null;

    // 列宽下的高度必须全部测过；缺一个就保守退回单列。
    for (const item of items) {
        if (!columnHeights.has(item.id)) return null;
    }

    let best:
        | { k: number; m: number; minH: number }
        | null = null;

    for (let k = 1; k < items.length; k += 1) {
        if (!isSiblingBoundary(items, k)) continue;
        // 左右两列的第一个节点必须同级（同一父节点下同一层级），
        // 且类型类别一致：不能一边是文字、一边是表格 / 图片。
        if (items[0].depth !== items[k].depth) continue;
        if (items[0].parentId !== items[k].parentId) continue;
        if (items[0].media !== items[k].media) continue;

        const leftH = sumColumnHeight(items.slice(0, k), columnHeights);
        if (leftH > bodyHeight * 0.98) continue;

        for (let m = k + 1; m <= items.length; m += 1) {
            // 右列不能在子树中间结束；结束点也得是同级边界
            if (m < items.length && !isSiblingBoundary(items, m)) continue;
            const rightH = sumColumnHeight(
                items.slice(k, m),
                columnHeights
            );
            if (rightH > bodyHeight * 0.98) continue;

            const maxH = Math.max(leftH, rightH);
            const minH = Math.min(leftH, rightH);
            // 平衡：矮的一列至少要占高的一列的 60%
            if (minH < maxH * 0.6) continue;

            // 优先装下更多内容，其次让两列更均衡
            if (
                !best ||
                m > best.m ||
                (m === best.m && minH > best.minH)
            ) {
                best = { k, m, minH };
            }
        }
    }

    if (!best) return null;
    return {
        left: items.slice(0, best.k),
        right: items.slice(best.k, best.m),
        rest: items.slice(best.m),
    };
}

// =====================================================================
// 单列装页
// =====================================================================

/** 一页的装填结果。 */
interface PageSlice {
    page: PackedPage;
    rest: SlideItem[];
}

function makePage(items: SlideItem[]): PackedPage {
    return { items, fitByItem: new Map(), overflow: false };
}

/**
 * 装出当前页（只处理一页），返回剩余节点。
 *
 * 超高节点独占一页并等比缩小；否则按高度贪心。孤行保护：
 * - 页尾标题带到下一页和正文一起；
 * - 父节点不和它的第一个子节点拆开。
 */
function packFirstPage(
    items: SlideItem[],
    heights: Map<string, number>,
    bodyHeight: number
): PageSlice {
    const current: SlideItem[] = [];
    let used = 0;

    for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        const height = heights.get(item.id) ?? 90;

        // 单节点超过整页、又没能拆开（行数太少 / 围栏不完整）：独占一页并等比缩小。
        // 代码块在上一步已经按行拆开，正常走不到这里。
        if (height > bodyHeight) {
            if (current.length > 0) {
                return { page: makePage(current), rest: items.slice(i) };
            }
            // 留 6% 余量：离屏测量和真实渲染偶尔差几个像素。
            const rawScale = (bodyHeight * 0.94) / height;
            const minScale =
                item.kind === 'table' ? TABLE_MIN_SCALE : FIT_MIN;
            const scale = Math.max(minScale, rawScale);
            return {
                page: {
                    items: [item],
                    fitByItem: new Map([[item.id, scale]]),
                    overflow: rawScale < minScale,
                },
                rest: items.slice(i + 1),
            };
        }

        const gap =
            current.length > 0
                ? gapBetween(current[current.length - 1], item)
                : 0;
        if (current.length > 0 && used + gap + height > bodyHeight) {
            const last = current[current.length - 1];

            // 孤行：页尾标题带到下一页，和正文一起
            if (last.kind === 'heading' && current.length > 1) {
                current.pop();
                return {
                    page: makePage(current),
                    rest: items.slice(i - 1),
                };
            }

            // 父节点不和第一个子节点拆开（列表项 + 它的第一条说明）
            if (
                last.children.length > 0 &&
                last.children[0] === item &&
                current.length > 1
            ) {
                current.pop();
                return {
                    page: makePage(current),
                    rest: items.slice(i - 1),
                };
            }

            return { page: makePage(current), rest: items.slice(i) };
        }

        current.push(item);
        used += gap + height;
    }

    return { page: makePage(current), rest: [] };
}

// =====================================================================
// 媒体同页
// =====================================================================

/**
 * 媒体节点单独占页时，把相邻的解释文字 / 同级列表拉过来。
 *
 * 规则（与产品口径一致）：
 * - 相邻节点是普通文本节点（段落 / 列表 / 引用）→ 可以合并；
 * - 相邻节点是同一父节点下的同级列表项、且媒体节点没有下级列表 →
 *   可以合并（媒体是这一组列表的一部分）。
 *
 * 合并后整页允许缩到 0.45；再低就宁可让媒体单独一页。
 */
function coLocateMedia(
    pages: PackedPage[],
    heights: Map<string, number>,
    bodyHeight: number
): PackedPage[] {
    const limit = bodyHeight / MEDIA_MERGE_MIN_SCALE;

    const eligible = (media: SlideItem, neighbor: SlideItem): boolean => {
        if (neighbor.media) return false;
        // 普通解释文字：段落 / 引用
        if (TEXT_KINDS.has(neighbor.kind)) return true;
        // 媒体所属的那条列表项（缩进媒体的上一行）：它就是在解释媒体
        if (neighbor.id === media.parentId) return true;
        // 同级列表兄弟，且媒体自己没有下级列表 —— 媒体属于这一组列表
        return (
            media.children.length === 0 &&
            neighbor.kind === 'list' &&
            neighbor.parentId === media.parentId &&
            neighbor.depth === media.depth
        );
    };

    for (let i = 0; i < pages.length; i += 1) {
        const page = pages[i];
        // 双栏页不处理：列宽不同，合并规则另算
        if (page.columns || page.items.length === 0) continue;
        const media = page.items.find((item) => MEDIA_KINDS.has(item.kind));
        if (!media) continue;
        // 这一页已经有普通文字就说明已经同页了，不再向外拉
        if (page.items.some((item) => !MEDIA_KINDS.has(item.kind))) continue;

        // 代码页不为「多带一段说明文字」而缩小：代码的字号必须保持正常。
        // 代码片段按整页高度切好后基本已经铺满，只有真的还有空位才并；
        // 其它媒体仍允许缩到 MEDIA_MERGE_MIN_SCALE 换同页。
        const mergeLimit = media.kind === 'code' ? bodyHeight : limit;

        const pageHeight = (): number =>
            sumColumnHeight(page.items, heights);

        // 优先并后面那段：阅读顺序里它本来就紧跟在媒体后面
        const next = pages[i + 1];
        const nextFirst = next?.items[0];
        if (
            next &&
            !next.columns &&
            nextFirst &&
            eligible(media, nextFirst)
        ) {
            const textH = heights.get(nextFirst.id) ?? 90;
            const gap = gapBetween(
                page.items[page.items.length - 1],
                nextFirst
            );
            if (pageHeight() + gap + textH <= mergeLimit) {
                page.items.push(nextFirst);
                next.items = next.items.slice(1);
                if (next.items.length === 0) pages.splice(i + 1, 1);
            }
        }

        // 再看前面那段：上下都是解释时两段都带上（装得下才带）
        const prev = pages[i - 1];
        const prevLast = prev?.items[prev.items.length - 1];
        if (
            prev &&
            !prev.columns &&
            prevLast &&
            eligible(media, prevLast)
        ) {
            const textH = heights.get(prevLast.id) ?? 90;
            const gap = gapBetween(prevLast, page.items[0]);
            if (pageHeight() + gap + textH <= mergeLimit) {
                page.items.unshift(prevLast);
                prev.items.pop();
                if (prev.items.length === 0) {
                    pages.splice(i - 1, 1);
                    i -= 1;
                }
            }
        }
    }
    return pages;
}

// =====================================================================
// 节点流 → 页面
// =====================================================================

/** 节点流 → 若干物理页（单列 / 双栏按可行性交替）。 */
function packItemFlow(
    items: SlideItem[],
    measured: MeasureResult,
    bodyHeight: number,
    allowColumns: boolean
): PackedPage[] {
    const expanded = expandOversized(items, measured, bodyHeight);
    let rest = expanded.items;
    const pages: PackedPage[] = [];

    while (rest.length > 0) {
        if (allowColumns) {
            const columns = tryColumns(
                rest,
                measured.bodyColumn,
                bodyHeight
            );
            if (columns) {
                pages.push({
                    items: [...columns.left, ...columns.right],
                    columns: [columns.left, columns.right],
                    fitByItem: new Map(),
                    overflow: false,
                });
                rest = columns.rest;
                continue;
            }
        }
        const slice = packFirstPage(rest, expanded.heights, bodyHeight);
        pages.push(slice.page);
        rest = slice.rest;
    }

    return coLocateMedia(pages, expanded.heights, bodyHeight);
}

// =====================================================================
// 片段化（节点 → 渲染块）
// =====================================================================

/** 预序展开一个节点及其所有后代。 */
function flattenSubtree(item: SlideItem): SlideItem[] {
    const out: SlideItem[] = [];
    const walk = (node: SlideItem): void => {
        out.push(node);
        for (const child of node.children) walk(child);
    };
    walk(item);
    return out;
}

/** 从 start 开始的节点是否恰好是 node 的完整子树；是则返回子树。 */
function completeSubtree(
    items: SlideItem[],
    start: number,
    node: SlideItem
): SlideItem[] | null {
    const subtree = flattenSubtree(node);
    if (start + subtree.length > items.length) return null;
    for (let k = 0; k < subtree.length; k += 1) {
        if (items[start + k].id !== subtree[k].id) return null;
    }
    return subtree;
}

/**
 * 把一页的节点折成渲染片段。
 *
 * 同一源码块里的连续内容合并成一个片段：同级兄弟在子树完整时整棵并进来；
 * 子树被分页 / 分栏切开时，也把「这一页实际包含的那段子孙」继续并进当前
 * 片段，而不是让父节点退化成一行、子节点各成一块。
 *
 * 为什么必须这样：每个片段都是一个独立的 slide-block，自带 .slide-body 的
 * 16px 块间距和 cm-content 的上下 padding。一条嵌套列表链如果被拆成一行
 * 一个片段，视觉上就是「一行一个节点、间距巨大」，还很容易触发页面溢出；
 * 合并后每页最多一个列表块，行距/缩进与 live 的同一份渲染完全一致。
 *
 * 嵌套片段会去掉公共缩进（dedentText），靠 CSS 左内边距补回视觉层级。
 * 切片必须用 deck.parseText（卡片行已清空、行数不变）：松散列表 / HTML
 * block 可以跨过卡片行，用原文切会把卡片内容重新带回幻灯片。跨卡片行的
 * 片段在 SlidesApp.attachEdit 里会被判成只读，避免回写删卡。
 */
function buildFragments(
    items: SlideItem[],
    sourceText: string,
    fitByItem: Map<string, number>
): SlideBlock[] {
    const lines = sourceText.split('\n');
    const out: SlideBlock[] = [];
    let i = 0;

    while (i < items.length) {
        const first = items[i];

        // 合成片段（超长块按行拆出来的）单独成块，用自身源码渲染：
        // 它的行区间可能不覆盖 fence 等渲染必需的行。
        if (first.synthetic) {
            const fragment: SlideBlock = {
                id: first.id,
                kind: first.kind,
                level: first.level,
                fromLine: first.fromLine,
                toLine: first.toLine,
                source: first.source,
                depth: first.depth,
                indent: first.indent,
                synthetic: true,
            };
            const scale = fitByItem.get(first.id);
            if (scale !== undefined) fitByItem.set(fragment.id, scale);
            out.push(fragment);
            i += 1;
            continue;
        }

        // 合并同一源码块里的连续内容（见函数头注释）：
        // - 第一个节点无条件纳入；
        // - 之后要么是它（或刚并入的兄弟）的子孙（按 pre-order 紧接），
        //   要么是它的同级兄弟（同 parentId / depth）；
        // - 兄弟的子树完整时整棵并进来，被切开时先并它自身，子孙在下几轮
        //   按「后裔」继续并进来。
        // allowedToLine = 已纳入根节点的最大子树末行：子孙的 fromLine 落在
        // 这个范围内就属于当前片段；跨过它且不是同级兄弟，片段到此为止。
        let end = i + 1;
        let last = first;
        let allowedToLine = first.subtreeToLine;
        let endLine = first.toLine;
        while (end < items.length) {
            const node = items[end];
            if (node.blockId !== first.blockId || node.synthetic) break;
            const inside = node.fromLine <= allowedToLine;
            const siblingOfFirst =
                node.parentId === first.parentId && node.depth === first.depth;
            if (!inside && !siblingOfFirst) break;
            if (siblingOfFirst) {
                const subtree = completeSubtree(items, end, node);
                if (subtree) {
                    last = subtree[subtree.length - 1];
                    endLine = Math.max(endLine, node.subtreeToLine);
                    end += subtree.length;
                } else {
                    // 兄弟的子树被页/栏切开：先并兄弟自身，后面的子孙
                    // 会在下一轮按后裔继续并入
                    last = node;
                    endLine = Math.max(endLine, node.toLine);
                    end += 1;
                }
                allowedToLine = Math.max(allowedToLine, node.subtreeToLine);
                continue;
            }
            // 子孙节点：只并入自身内容，它的子节点随后按 pre-order 继续
            last = node;
            endLine = Math.max(endLine, node.toLine);
            allowedToLine = Math.max(allowedToLine, node.subtreeToLine);
            end += 1;
        }

        const raw = lines.slice(first.fromLine, endLine + 1).join('\n');

        const fragment: SlideBlock = {
            id:
                end - i === 1
                    ? first.id
                    : `${first.id}..${last.id}`,
            kind: first.kind,
            level: first.level,
            fromLine: first.fromLine,
            toLine: endLine,
            source: dedentText(raw, first.indent),
            depth: first.depth,
            indent: first.indent,
        };
        // 超高单节点才会带缩放；合并片段不缩放（它本来就装得下）
        const scale =
            end - i === 1 ? fitByItem.get(first.id) : undefined;
        if (scale !== undefined) fitByItem.set(fragment.id, scale);
        out.push(fragment);
        // 至少消费了 first 自己；end 是下一个未处理的下标
        i = end;
    }

    return out;
}

// =====================================================================
// 对外：逻辑页 → 物理页
// =====================================================================

/** 逻辑页 → 物理页。封面来自 front matter，单独一页。 */
export function paginateDeck(
    deck: Deck,
    measured: MeasureResult
): SlidePage[] {
    const pages: SlidePage[] = [];

    if (deck.meta.title || deck.meta.subtitle) {
        pages.push({
            logicalIndex: -1,
            segmentIndex: 0,
            layout: 'cover',
            blocks: [],
            titleFont: 0,
            continued: false,
            fitScales: new Map(),
            overflow: false,
        });
    }

    // 单页版式：整页只渲染一次，不做高度分页。
    // - section：只有标题；
    // - statement / fact：一页只表达一件事，缩不缩由作者决定，不续页；
    // - end：结束页。
    const singlePageLayouts = new Set<LayoutKind>([
        'cover',
        'section',
        'statement',
        'fact',
        'end',
    ]);

    const lastIndex = deck.logical.length - 1;
    for (let slideIndex = 0; slideIndex < deck.logical.length; slideIndex += 1) {
        const slide = deck.logical[slideIndex];
        let layout: LayoutKind = layoutOf(slide, deck.slideLevel);
        // 结束页自动判定放在分页层：只有这里知道「是不是最后一页」。
        // 显式覆盖优先，不再被自动判定改写。
        if (!slide.layoutOverride && isEndSlide(slide, slideIndex === lastIndex)) {
            layout = 'end';
        }
        const titleBlock = slide.heading;
        const titleFont = titleBlock
            ? titleFontSize(titleBlock.level ?? 2, deck.slideLevel)
            : 0;
        const titleHeight = titleBlock
            ? (measured.titles.get(titleBlock.id) ?? 90)
            : 0;

        if (singlePageLayouts.has(layout) || slide.segments.length === 0) {
            pages.push({
                logicalIndex: slide.index,
                segmentIndex: 0,
                layout,
                // cover / section / end 不渲染正文；statement / fact 取第一段内容
                blocks:
                    layout === 'cover' ||
                    layout === 'section' ||
                    layout === 'end'
                        ? []
                        : (slide.segments[0] ?? slide.blocks),
                titleBlock,
                titleFont,
                continued: false,
                fitScales: new Map(),
                overflow: false,
            });
            continue;
        }

        // 图文双栏 / 半幅图仍走原来的「整段一起缩放」路径：
        // 这两类是按内容类型分列（文字左、媒体右），不是同级节点配对。
        if (layout === 'two-column' || layout === 'image-split') {
            let firstPage = true;
            for (let si = 0; si < slide.segments.length; si += 1) {
                const segment = slide.segments[si];
                pages.push({
                    logicalIndex: slide.index,
                    segmentIndex: si,
                    layout,
                    blocks: segment.slice(),
                    titleBlock:
                        firstPage && titleBlock ? titleBlock : undefined,
                    titleFont,
                    continued: !firstPage,
                    fitScales: new Map(),
                    overflow: false,
                });
                firstPage = false;
            }
            continue;
        }

        let firstPageOfSlide = true;
        for (let si = 0; si < slide.segments.length; si += 1) {
            const items = slide.itemSegments[si] ?? [];
            // 首页标题区 = 标题块 + 强调短线 + header 下间距；
            // 续页只有淡色小标题，占一行左右。
            const headerHeight =
                firstPageOfSlide && titleBlock
                    ? titleHeight + 34
                    : titleBlock
                      ? 52
                      : 0;
            const bodyHeight = Math.max(160, CONTENT_H - headerHeight);

            // 作者用 <!-- layout: content --> 强制单列；
            // <!-- layout: list-columns --> 强制尝试双栏。
            const allowColumns =
                slide.layoutOverride !== 'content' &&
                (layout === 'content' || layout === 'list-columns');

            const packed = packItemFlow(
                items,
                measured,
                bodyHeight,
                allowColumns
            );

            for (let pi = 0; pi < packed.length; pi += 1) {
                const chunk = packed[pi];
                const leftFrags = chunk.columns
                    ? buildFragments(
                          chunk.columns[0],
                          deck.parseText,
                          chunk.fitByItem
                      )
                    : [];
                const rightFrags = chunk.columns
                    ? buildFragments(
                          chunk.columns[1],
                          deck.parseText,
                          chunk.fitByItem
                      )
                    : [];
                const blocks = chunk.columns
                    ? [...leftFrags, ...rightFrags]
                    : buildFragments(
                          chunk.items,
                          deck.parseText,
                          chunk.fitByItem
                      );
                const isFirst = firstPageOfSlide && pi === 0;

                pages.push({
                    logicalIndex: slide.index,
                    segmentIndex: si,
                    // 双栏统一标 list-columns；单列保留 media / quote /
                    // code 这类版式类名（CSS 会用到），其余归 content。
                    layout: chunk.columns
                        ? 'list-columns'
                        : layout === 'media' ||
                            layout === 'quote' ||
                            layout === 'code'
                          ? layout
                          : 'content',
                    blocks,
                    columns: chunk.columns
                        ? [leftFrags, rightFrags]
                        : undefined,
                    titleBlock:
                        isFirst && titleBlock ? titleBlock : undefined,
                    titleFont,
                    continued: !isFirst,
                    fitScales: chunk.fitByItem,
                    overflow: chunk.overflow,
                });
            }
            firstPageOfSlide = false;
        }
    }
    return pages;
}

/** 一个逻辑页是否已经被测量过（用于增量测量/导航时按需补测）。 */
export function isSlideMeasured(
    slide: LogicalSlide,
    measured: MeasureResult
): boolean {
    for (const item of flattenItems(slide.items)) {
        // 分隔线不测量（slidesApp 的测量循环直接跳过 hr）：这里必须
        // 同样跳过，否则 `***` / `___` 这类留在正文里的分隔线会让
        // 这张逻辑页永远「未测」，后台补测会无限重复。
        if (item.kind === 'hr') continue;
        if (!measured.body.has(item.id)) return false;
    }
    if (slide.heading && !measured.titles.has(slide.heading.id)) return false;
    return true;
}
