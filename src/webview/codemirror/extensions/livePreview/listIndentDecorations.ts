/**
 * Live Preview 装饰管线（从 plugin.ts 拆出）：列表缩进装饰：彩虹缩进引导线 + 悬挂缩进。
 *
 * @module webview/codemirror/extensions/livePreview/listIndentDecorations
 */

import { settingsState } from '../../../settings/settingsState.js';
import { createListIndentStyle, detectIndentUnit, measureIndentUnitPx, measureWhitespacePx, parseListMarkerLine } from './measure/listIndent.js';
import type { IndentGuide, ListMarkerInfo } from './measure/listIndent.js';
import { measureTextIn } from './measure/textMeasure.js';
import type { MeasureEnv } from './measure/textMeasure.js';
import { getSourceRange, windowLines } from './ranges.js';
import type { ILineRange } from './types.js';
import { BulletWidget } from './widgets/simpleWidgets.js';
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { Decoration, ViewPlugin } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';


/**
 * 收集列表缩进的装饰：悬挂缩进 + 层级引导线。
 *
 * 两件事一起做：
 *
 * 1. **悬挂缩进**——行装饰给 `padding-left: 正文左内边距(lineGutterGap) + 缩进真实宽 + marker 区宽`、
 *    `text-indent` 取负值。首行被 text-indent 拉回原位、外观不变；
 *    一旦内容跨行，续行全部从该行正文内容列开始，
 *    不会退到行头，也不会压到更左边的色带。
 * 2. **层级色带**——行内背景按深度 0..当前层级逐级铺颜色块
 *    （见 styles.ts 的 `.cm-md-indent`），每条色带都**满行高**：
 *    它们是这一行真实占用的缩进背景，无论该层级后面是否还有兄弟 / 子级。
 *    （旧实现给「收尾层级」画半高 tail，深层行中间出现一排半高断层，已废弃。）
 *
 * ## 层级口径：有序 / 无序 / 任务项完全统一
 *
 * 层级**只由行首空白**（列数落到缩进单位网格）决定，与 marker 类型无关：
 * - Lezer 对有序列表要求「缩进 ≥ marker 宽度（`1. ` = 3 列）」才建立嵌套，
 *   2 空格的有序子项会被压平成兄弟、第三级起甚至变成上一行的 lazy 续行；
 *   无序列表 2 空格即可嵌套——旧实现走语法树，于是有序只剩一条色带。
 * - 现在按缩进栈逐级出色带；marker 类型只需提供**自己的 marker 区宽度**
 *   （圆点 widget / `1.` 实测宽 / 任务复选框固定宽）。
 *
 * 背景统一用 border-box 定位，不受本行悬挂 padding 影响。
 *
 * 之所以不跟主遍历里的 ListItem 一起处理：主遍历会把**聚焦块整块跳过**，
 * 那样点进某一行时缩进会突然变样。这里按行扫全文，两种状态下结果完全一致。
 *
 * @param state - 当前编辑器状态
 * @param decos - 待写入的装饰数组
 * @returns void，结果直接 push 进 decos
 */
/**
 * 任务项 marker 区宽度（px）：复选框 16 + 右侧 gap 4。
 * 必须与 styles.ts 里 `.cm-md-checkbox` 的 width / marginRight 同源，
 * 改一处要同步另一处。
 */
export const TASK_MARK_PX = 20;


/**
 * 判断一行（非列表行）是否开启了新的块级结构。
 *
 * 列表项可以跨多个源码行（CommonMark 的 lazy continuation）：
 *
 * ```
 * - 第一行
 *   第二行（这行没有 marker）
 * ```
 *
 * 第二行在解析时仍属于同一个 ListItem 的段落，视觉上应该继续带缩进色带。
 * 但标题、围栏代码块、引用、分隔线、表格、HTML 块会打断段落 —— 遇到它们
 * 必须结束「续行继承」，否则后面的正文会被误判成上一项的续行、凭空多出
 * 一条色带。
 *
 * @param lineText - 整行原文
 * @returns 是否是新块的第一行
 */
export function startsNewBlock(lineText: string): boolean {
    const text = lineText.replace(/^[ \t]+/, '');
    // ATX 标题
    if (/^#{1,6}(?:[ \t]|$)/.test(text)) return true;
    // 围栏代码块：开、关都算结束（关掉之后也不该继续继承列表段落）
    if (/^(?:```|~~~)/.test(text)) return true;
    // 引用块
    if (/^>/.test(text)) return true;
    // 分隔线（`---` / `***` / `- - -`）
    if (/^(?:[-*_][ \t]*){3,}$/.test(text)) return true;
    // 表格行
    if (/^\|/.test(text)) return true;
    // HTML 块
    if (/^<(?:!--|\/?[a-zA-Z])/.test(text)) return true;
    return false;
}


export function collectListIndentDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    /**
     * 量字用的字体环境。窗口遍由 ViewPlugin 传入当前视图的正文样式；
     * 导图 mini-CM 与主编辑器字体环境互相独立，必须按自己的视图量，
     * 否则圆点/缩进宽度和源码态的真实 `- ` 宽度对不上（文字横跳）。
     */
    env: MeasureEnv | null = null
): void {
    const win = windowLines(state, range);

    // 缩进单位：取样「窗口行 + 前 200 行」，整篇扫在长文档上浪费，
    // 而缩进单位在同一份文档里基本统一
    const sampleTexts: string[] = [];
    for (let ln = win.first; ln <= win.last; ln++) sampleTexts.push(state.doc.line(ln).text);
    for (let ln = 1; ln <= Math.min(200, state.doc.lines); ln++) {
        sampleTexts.push(state.doc.line(ln).text);
    }
    const unit = detectIndentUnit(sampleTexts);
    const unitPx = measureIndentUnitPx(unit);
    // 行内坐标统一起点：正文与行号线距离（theme 给 .cm-line 的左内边距）
    const linePadding = settingsState.getNumber('lineGutterGap');
    // 当前「该显示源码」的区间（光标所在行 / 拖选行 / 钉住行）。
    // 兜底 marker 落在其中时必须撤掉——否则深层 Tab 行点进去圆点不会变回 "-"。
    const focusedRange = getSourceRange(state);

    // —— 行解析（统一口径：有序 / 无序 / 任务项都只认行首空白）——
    // 带缓存：窗口外的补扫（祖先栈预填 / full-tail 判定）会重复取同一行
    const parseCache = new Map<number, ListMarkerInfo | null>();
    const getInfo = (ln: number): ListMarkerInfo | null => {
        if (!parseCache.has(ln)) {
            parseCache.set(ln, parseListMarkerLine(state.doc.line(ln).text));
        }
        return parseCache.get(ln)!;
    };
    // 行首空白落到单位网格得到的「名义层级」（与 getListIndent 同口径）；非列表行 -1
    const rawLevelOf = (info: ListMarkerInfo | null): number => {
        if (!info) return -1;
        if (info.indentCols <= 0) return 0;
        return Math.min(8, Math.max(1, Math.round(info.indentCols / unit)));
    };

    // —— 有效层级判定（规则已升级到对 n 个 Tab 生效）——
    // 连按任意次 Tab（缩进从深度 D 跳到 D+n，中间缺 n-1 级）时，CommonMark 会
    // 把该行判为上一项段落的 lazy 续行；本插件不沿用该判定——只要行首空白
    // 匹配 marker，就按其名义层级渲染，所有缺失层级一律用单位网格上的虚拟
    // 色带补齐（见下方 guide 构建）。早期实现先限 +1、后放宽到 +2，现已
    // 完全放开（仍受深度上限 8 约束）。
    /**
     * 在给定栈上推进一行，返回有效层级。
     * @returns 名义层级（含跳级，0..8）；非列表行返回 -1
     */
    const effectiveLevel = (info: ListMarkerInfo | null): number => rawLevelOf(info);
    /** 按有效层级更新栈：本行占 L 档，清掉更深旧档。 */
    const advanceStack = (ln: number, level: number, stk: number[]): void => {
        stk[level] = ln;
        for (let d = level + 1; d <= 8; d++) stk[d] = -1;
    };

    // —— 祖先栈预填：窗口起点之前各级 marker 所在行（每深度取最近一行）——
    // 反向收集后**正向模拟**：跳过的虚拟层级无法被反向直接识别（要先知道它
    // 前面的栈），正向走一遍 advanceStack 才能建立正确栈态。最多回看 120 行，
    // 正常嵌套区很快就把 9 档填满。
    const stack = new Array<number>(9).fill(-1);
    {
        const collected: Array<{ ln: number; info: ListMarkerInfo }> = [];
        for (let ln = win.first - 1; ln >= 1 && collected.length < 120; ln--) {
            const info = getInfo(ln);
            if (info) collected.push({ ln, info });
        }
        const sim = new Array<number>(9).fill(-1);
        for (let i = collected.length - 1; i >= 0; i--) {
            const { ln, info } = collected[i];
            const lv = effectiveLevel(info);
            if (lv >= 0) {
                advanceStack(ln, lv, sim);
                // 窗口需要的是每档「最近一行」，正向遇到即覆盖
                stack[lv] = ln;
            }
        }
    }

    // —— 窗口行预演：得到每行有效层级（正式产出装饰时复用）——
    const winLevels: number[] = [];
    {
        const sim = [...stack];
        for (let ln = win.first; ln <= win.last; ln++) {
            const lv = effectiveLevel(getInfo(ln));
            winLevels.push(lv);
            if (lv >= 0) advanceStack(ln, lv, sim);
        }
    }

    const tree = syntaxTree(state);

    // 续行色带上下文：最近一个列表行生成的 guides。
    //
    // 列表项可以跨多个源码行（lazy continuation），续行没有 marker，
    // 以前 ownLevel < 0 直接跳过 → 从第二行开始色带整段消失。
    // 这里记住上一项的层级链，给同一段落内的续行补上同样的背景；
    // 只补色带、不套悬挂缩进（续行的文字位置由它自己的行首空白决定，
    // 再叠 padding / text-indent 会把已经对齐好的文字又推走）。
    let continuation: { guides: IndentGuide[] } | null = null;

    for (let i = 0; i < winLevels.length; i++) {
        const ln = win.first + i;
        const ownLevel = winLevels[i];
        const line = state.doc.line(ln);

        // ownLevel < 0：非列表行。
        // 空行 / 新块结束继承；同一段落里的续行沿用上一项的色带。
        if (ownLevel < 0) {
            if (line.text.trim() === '' || startsNewBlock(line.text)) {
                continuation = null;
                continue;
            }
            if (!continuation) continue;
            decos.push(
                Decoration.line({
                    class: 'cm-md-indent',
                    attributes: {
                        style: createListIndentStyle(continuation.guides, 0),
                    },
                }).range(line.from)
            );
            continue;
        }

        const info = getInfo(ln);
        if (!info) continue;

        // 行首空白 → 定宽占位盒（用 mark：光标仍能走进缩进、改缩进）。
        // 宽度按空白**真实像素**（5 空格等非网格缩进也量得准），与色带口径一致。
        if (info.indentText.length > 0 && unitPx > 0) {
            decos.push(
                Decoration.mark({
                    class: 'cm-md-indent-space',
                    attributes: {
                        style: `width:${measureWhitespacePx(info.indentText, env).toFixed(2)}px`,
                    },
                }).range(line.from, line.from + info.indentText.length)
            );
        }

        // marker 区宽度（缩进之后、正文之前）：
        // - 任务项：复选框 16 + 右 gap 4（TASK_MARK_PX，与 styles 同源）；
        // - 其余项：marker 文本 + 分隔空白 的实测宽（`10.` 比 `1.` 宽也量得准）。
        // 续行对齐到「marker 区之后的内容列」——对齐 `-` 左缘会让竖线穿过续行文字。
        const leadWidth = (m: ListMarkerInfo): number =>
            m.type === 'task'
                ? TASK_MARK_PX
                : measureTextIn(env, m.marker, '400') +
                  (m.gap.length > 0 ? measureTextIn(env, m.gap, '400') : 0);
        // hang = 缩进真实宽 + marker 区；padding 边沿即内容列。
        // 用真实空白宽而非「层级×单位」：5 空格等非网格缩进的续行应对齐其真实内容列。
        const hangPx =
            (unitPx > 0 ? measureWhitespacePx(info.indentText, env) : 0) + leadWidth(info);

        // 各级色带：深度 0（根级）→ ownLevel，共 ownLevel + 1 条，全部满行高。
        // 层级链与 marker 类型无关——有序项 2 空格缩进照样逐级出色带，
        // 这是与旧实现（走 Lezer 树、有序被压平只剩一条）的关键区别。
        const guides: IndentGuide[] = [];
        for (let d = 0; d <= ownLevel; d++) {
            const isOwn = d === ownLevel;
            // 该深度 marker 所在行：祖先栈里取；缺档（-1，连按多个 Tab
            // 跳过的虚拟层级，可能连续缺多级）走网格补位。isOwn 时 ln 必然有效。
            const markerLn = isOwn ? ln : stack[d];
            let contentX: number;
            if (markerLn >= 1) {
                // 真实层级（祖先 / 本行）：右缘 = marker 行**真实缩进** +
                // marker 区宽（不写死 d×单位：存在非网格缩进时真实位置才与
                // DOM 文字一致）
                const dInfo = getInfo(markerLn)!;
                contentX =
                    linePadding +
                    measureWhitespacePx(dInfo.indentText, env) +
                    leadWidth(dInfo);
            } else {
                // 虚拟层级（跳过的中间一级）：色带落在单位网格上，
                // 右缘 = d 格 + 借当前行 marker 区宽——保证与前后色带
                // 各差一个单位宽、不重叠不留缝
                contentX = linePadding + d * unitPx + leadWidth(info);
            }
            guides.push({ contentX });
        }

        const lineStyle = createListIndentStyle(guides, hangPx);
        decos.push(
            Decoration.line({
                class: 'cm-md-indent',
                attributes: { style: lineStyle },
            }).range(line.from)
        );
        // 后续没有 marker 的源码行按同一层级链补色带（见上方 continuation）
        continuation = { guides };

        // —— marker 装饰兜底 ——
        // 两种情况在 Lezer 树里没有 ListMark 节点、主遍历不会上 marker 样式：
        //   1. 有序子项只缩 2 空格（< `1. ` 的 3 列），第三级起是上一行 lazy 续行；
        //   2. 连按多个 Tab 跳过层级，CommonMark 同样判为 lazy 段落。
        // 这里按行首空白认出来补上，保证有序 / 无序、任意跳级视觉一致。
        const markFrom = line.from + info.indentText.length;
        const markTo = markFrom + info.marker.length;
        // 树里该位置确有 ListMark（且左缘吻合）→ 主遍历已处理，跳过
        const atMark = tree.resolveInner(markFrom, 1);
        const covered = atMark.name === 'ListMark' && atMark.from === markFrom;
        // marker 落在当前源码区间（光标在本行 / 拖选 / 钉住）→ 不补渲染态
        // marker：让原始 "-" / "1." 直接露出来。正常 ListMark 由主遍历的
        // 焦点跳过处理，兜底路径必须自己复刻这一判定，否则深层 Tab 行
        // 点进去圆点不变文本（用户报的最后一个 bug）。
        const inFocus = markFrom < focusedRange.to && markTo > focusedRange.from;
        if (!covered && !inFocus) {
            if (info.type === 'ordered') {
                decos.push(
                    Decoration.mark({ class: 'cm-md-ordmark' }).range(markFrom, markTo)
                );
            } else if (info.type === 'bullet') {
                // 与主遍历一致：连 marker 后第一个分隔空白字符一起替换
                // （BulletWidget 盒内自带空白）
                const gapEnd = info.gap.length > 0 ? markTo + 1 : markTo;
                decos.push(
                    Decoration.replace({
                        widget: new BulletWidget(info.marker, env),
                    }).range(markFrom, gapEnd)
                );
            }
            // task 的 lazy 行极罕见（任务项出现在 2 空格缩进的有序列表深处），
            // 不补 checkbox，保持源码形态
        }

        // 更新祖先栈：本行占据 ownLevel 档，并清掉更深的旧档
        stack[ownLevel] = ln;
        for (let d = ownLevel + 1; d <= 8; d++) stack[d] = -1;
    }
}
