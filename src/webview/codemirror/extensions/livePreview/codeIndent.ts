/**
 * 围栏代码块缩进导引（从 helpers.ts 拆出）。
 *
 * 量缩进列数、生成彩虹缩进色带的 background 样式。
 *
 * @module webview/codemirror/extensions/livePreview/codeIndent
 */

// =============================================================================
// 代码块缩进导引（Rainbow indent）
// =============================================================================

/**
 * 代码块里一个 Tab 占几列。
 *
 * CodeMirror 6 默认 `state.tabSize = 4`，并把 `tab-size: <n>` 逐行写进
 * `.cm-line` 的内联样式（见 @codemirror/view），所以浏览器实际渲染 Tab
 * 用的也是这个宽度——这里必须与它一致，不能用浏览器默认的 8。
 */
const CODE_TAB_COLUMNS = 4;

/**
 * Rainbow indent 最多铺几层色带；最深一层会把剩余列数全包住（见下）。
 *
 * 20+ 层深缩进在真实代码里极罕见，卡 20 只是防止异常文档塞进几十层背景；
 * 注意当缩进单位是 2 空格时，6 层只够覆盖 12 列，所以不能再像旧版那样只给 6。
 */
const CODE_INDENT_MAX_BANDS = 20;

/**
 * 代码行的行首缩进信息。
 */
export interface CodeBlockIndentInfo {
    /** 行首空白占的视觉列数（Tab 按 tab-stop 折算）。 */
    columns: number;
}

/**
 * 计算代码行行首空白占的视觉列数，用于缩进导引渲染。
 *
 * @param lineText - 当前代码行文本
 * @param tabSize - 一个 Tab 的停靠宽度（列），默认 4，与 CM state.tabSize 对齐
 * @returns 缩进信息；未缩进时 columns 为 0
 */
export function getCodeBlockIndentInfo(lineText: string, tabSize = CODE_TAB_COLUMNS): CodeBlockIndentInfo {
    let columns = 0;
    for (const ch of lineText) {
        if (ch === ' ') {
            columns += 1;
            continue;
        }
        if (ch === '\t') {
            // Tab 跳到「当前列之后的第一个 tabSize 整数倍」位置，
            // 不是无脑 +tabSize（Tab 在第 0 列才前进整整 4 列）。
            columns = (Math.floor(columns / tabSize) + 1) * tabSize;
            continue;
        }
        break;
    }
    return { columns };
}

/**
 * 生成代码块缩进导引（rainbow indent）的内联样式。
 *
 * 色带按「缩进层级」铺：每经过一个缩进单位（indentUnit）就换一种颜色——
 * 用户每按一次 Tab（默认插入 2 空格，即一个缩进单位），颜色就轮换一格。
 * **最后一层色带不画满一个单位**，宽度恰好 = 行首空白在本单位内的剩余列数
 * ——于是无论缩进是几列（奇数空格、Tab、空格混 Tab），色带都正好停在
 * 这一行第一个文字/字母开始的位置，不会渲染到文字上。
 *
 * 横向尺寸一律用 **ch 单位**（不用 Canvas 量 px）：`1ch` 就是元素自身字体里
 * `'0'` 的推进宽度，等宽字体下它**按定义等于一列宽**，浏览器会自动跟着行实际
 * 使用的字体/字号走。ch 没有测量环节，首屏即正确。
 *
 * 超过最大层数的深缩进不另加颜色，而是让最深一层自动变宽把剩余列全包住，
 * 任何缩进深度都覆盖得到。
 *
 * @param columns - 行首空白的视觉列数（getCodeBlockIndentInfo 算出）
 * @param unitColumns - 一个缩进单位（indentUnit）占几列；色带按此宽度轮换
 * @returns 可直接写入 line decoration attributes.style 的样式字符串
 */
export function createCodeBlockIndentStyle(columns: number, unitColumns: number): string {
    const backgroundColor = 'var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08))';
    const palette = [
        'rgba(235, 131, 131, 0.18)',
        'rgba(174, 154, 203, 0.18)',
        'rgba(125, 181, 205, 0.18)',
        'rgba(113, 167, 150, 0.18)',
        'rgba(220, 191, 97, 0.18)',
        'rgba(221, 163, 106, 0.18)',
        'rgba(184, 245, 162, 0.18)',
    ];

    // 未缩进：只铺代码块底色，不铺任何色带。
    if (columns <= 0) {
        return `background-color: ${backgroundColor}; background-image: none; background-repeat: no-repeat;`;
    }

    // 兜底：缩进单位异常（0 列）时退回按 4 列一色，避免死循环/除零。
    const safeUnitColumns = unitColumns > 0 ? unitColumns : CODE_TAB_COLUMNS;
    const bandCount = Math.min(
        CODE_INDENT_MAX_BANDS,
        Math.max(1, Math.ceil(columns / safeUnitColumns))
    );

    const layers: string[] = [];
    const positions: string[] = [];
    const sizes: string[] = [];

    for (let i = 0; i < bandCount; i++) {
        const startCols = i * safeUnitColumns;
        // 最后一层：宽度 = 从本层起点到文字起点之间的真实剩余列数。
        //  - 行首空白不是缩进单位的整数倍时，它就只有余数列那么宽，
        //    正好停在文字前；
        //  - 深缩进超过最大层数时，这一层会随之变宽，把最深的空白也盖住。
        // 其余层固定一个缩进单位宽。
        const widthCols = i === bandCount - 1 ? columns - startCols : safeUnitColumns;

        layers.push(`linear-gradient(${palette[i % palette.length]}, ${palette[i % palette.length]})`);
        // ch = 行字体里一列的宽度；小数列（widthCols 恒为整数，保留写法兜底）也准。
        positions.push(`${startCols.toFixed(2)}ch 0`);
        sizes.push(`${widthCols.toFixed(2)}ch 100%`);
    }

    return [
        `background-color: ${backgroundColor}`,
        `background-image: ${layers.join(', ')}`,
        'background-repeat: no-repeat',
        // 原点用 **content-box**：色带坐标要和「第 0 列字符」对齐，
        // 而字符从行的内容区（padding 之后）开始。旧实现用 padding-box，
        // 色带整体左偏一个行内边距（4px），同样停不准。
        // 裁剪仍用 padding-box：底色铺满整行、圆角处不露黑边。
        'background-origin: content-box',
        'background-clip: padding-box',
        `background-position: ${positions.join(', ')}`,
        `background-size: ${sizes.join(', ')}`,
    ].join('; ');
}

