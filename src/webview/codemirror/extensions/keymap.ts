/**
 * Markdown 行内格式切换快捷键
 *
 * - Ctrl/Cmd+B：加粗 `**text**`（或 `__text__`）切换
 * - Ctrl/Cmd+I：斜体 `*text*`（或 `_text_`）切换
 * - Ctrl/Cmd+G：行内代码 `` `text` `` 切换
 *
 * ## 交互语义（需求）
 *
 * - 场景 A：存在文本选区 → 对选中文本切换格式，有则移除、无则添加；
 * - 场景 B：无选区、只有一个光标 → **向外探测**光标所属的同类型格式元素，
 *   命中则移除该格式；未命中则插入一对空标记并把光标放在中间，
 *   随后输入的文字直接带上格式（与 Typora / Obsidian 的空选区行为一致）。
 *
 * ## 为什么用语法树而不是数星号
 *
 * 「光标外侧是不是一对 `**`」这种纯文本判断处理不了这些情况：
 * - `a * b 与 *斜体*`（孤立星号）；
 * - `**粗 *斜* 粗**`（嵌套，星号互相挨着）；
 * - `` `code 里的 ** 不是加粗` ``；
 * - `` ``双反引号代码里含 ` 单反引号`` ``。
 *
 * Markdown 语言包已经把文档解析成 Lezer 语法树，直接查
 * `StrongEmphasis / Emphasis / InlineCode` 节点及其首尾
 * `EmphasisMark / CodeMark` 子节点即可，删的就是「真正成对的那两个标记」。
 * 纯文本兜底只保留给「标记写了但语法没解析出来」的边界情况
 * （例如 `** 空格开头` 这种 CommonMark 不认的写法）。
 *
 * @module webview/codemirror/extensions/keymap
 */

import {
    ChangeSet,
    EditorSelection,
    Transaction,
    type ChangeSpec,
    type Extension,
} from '@codemirror/state';
import { EditorView, keymap, type KeyBinding } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import type { SyntaxNode } from '@lezer/common';

/**
 * 一种可切换行内格式的定义。
 */
interface InlineFormatDef {
    /** Lezer 语法树上包裹内容的节点名。 */
    nodeName: 'StrongEmphasis' | 'Emphasis' | 'InlineCode';
    /** 首尾标记在语法树上的子节点名。 */
    markName: 'EmphasisMark' | 'CodeMark';
    /** 添加格式时使用的标记字符串。 */
    addMarker: '**' | '*' | '`';
    /** 纯文本兜底时，按长度从大到小尝试的标记写法。 */
    rawMarkers: readonly string[];
}

/** 加粗定义：语法树同时认 `**` 与 `__`。 */
const BOLD_DEF: InlineFormatDef = {
    nodeName: 'StrongEmphasis',
    markName: 'EmphasisMark',
    addMarker: '**',
    rawMarkers: ['**', '__'],
};

/** 斜体定义：语法树同时认 `*` 与 `_`。 */
const ITALIC_DEF: InlineFormatDef = {
    nodeName: 'Emphasis',
    markName: 'EmphasisMark',
    addMarker: '*',
    rawMarkers: ['*', '_'],
};

/** 行内代码定义：单反引号与双反引号都可能出现。 */
const CODE_DEF: InlineFormatDef = {
    nodeName: 'InlineCode',
    markName: 'CodeMark',
    addMarker: '`',
    rawMarkers: ['``', '`'],
};

/**
 * 一次切换操作产生的计划：文档改动 + 操作后选区（用**旧文档坐标**描述，
 * 稍后统一交给 ChangeSet 映射，多光标时逐个累计位移容易算错）。
 *
 * 选区端点给的是旧坐标 + 映射偏置（assoc）：端点恰好落在删除/插入边界时，
 * -1 表示贴边界左侧（改动之前），1 表示贴右侧（改动之后）。
 */
interface TogglePlan {
    /** 本光标/选区要做的文档改动（坐标基于操作前的原文档）。 */
    changes: ChangeSpec[];
    /** 操作后选区的锚点旧坐标。 */
    anchor: number;
    /** 锚点的映射偏置。 */
    anchorAssoc: -1 | 1;
    /** 操作后选区活动端旧坐标。 */
    head: number;
    /** 活动端的映射偏置。 */
    headAssoc: -1 | 1;
    /**
     * 非 0 时表示「空选区插入空标记对」：值为单个标记长度，
     * 光标最终落在插入点之后的第 N 个位置（两对标记正中间）。
     * mapPos 无法把光标映射到插入文本内部，必须单独算。
     */
    cursorInsideInsert: number;
}

/** 选区落点描述的便捷类型。 */
type SelectionTarget = Pick<
    TogglePlan,
    'anchor' | 'head' | 'anchorAssoc' | 'headAssoc' | 'cursorInsideInsert'
>;

/** 构造一个选区落点描述。 */
function target(
    anchor: number,
    head: number,
    anchorAssoc: -1 | 1,
    headAssoc: -1 | 1,
    cursorInsideInsert = 0
): SelectionTarget {
    return { anchor, head, anchorAssoc, headAssoc, cursorInsideInsert };
}

// =============================================================================
// 语法树工具
// =============================================================================

/**
 * 从某个语法节点向上找第一个指定名称的祖先节点。
 *
 * @param start - 起点节点（含自身）
 * @param name - 目标节点名
 * @returns 命中的祖先；一路找到根都没有则返回 null
 */
function climbToNode(start: SyntaxNode | null, name: string): SyntaxNode | null {
    for (let node: SyntaxNode | null = start; node !== null; node = node.parent) {
        if (node.name === name) return node;
    }
    return null;
}

/**
 * 取出格式节点的首尾标记子节点。
 *
 * Lezer 的行内元素结构大致是：
 * - `StrongEmphasis` → [EmphasisMark, 内容/嵌套元素, EmphasisMark]
 * - `InlineCode` → [CodeMark, CodeMark]（内容是节点间的文本间隙）
 *
 * 首尾标记按「第一个 / 最后一个同名子节点」取，兼容嵌套
 * （`***x***` 外层节点的首尾仍是最外面的那两个 mark）。
 *
 * @param node - 格式包裹节点
 * @param markName - 标记子节点名
 * @returns 开标记与闭标记；结构异常时返回 null
 */
function extractMarkPair(
    node: SyntaxNode,
    markName: string
): { open: SyntaxNode; close: SyntaxNode } | null {
    let open: SyntaxNode | null = node.firstChild;
    while (open && open.name !== markName) {
        open = open.nextSibling;
    }
    let close: SyntaxNode | null = node.lastChild;
    while (close && close.name !== markName) {
        close = close.prevSibling;
    }
    if (!open || !close || open === close || open.from >= close.from) {
        return null;
    }
    return { open, close };
}

/**
 * 确保光标所在逻辑行已经完成语法解析。
 *
 * 行内格式不会跨行（Lezer 的 markdown 行内解析按行进行），
 * 所以只需要保证解析到该行行尾，不必强制解析整篇文档。
 *
 * @param view - 当前编辑器视图
 * @param pos - 文档位置
 * @returns 可用的语法树；极端情况下解析不出来时返回 null
 */
function ensureTreeAround(view: EditorView, pos: number) {
    const line = view.state.doc.lineAt(pos);
    return ensureSyntaxTree(view.state, line.to, 100000);
}

/**
 * 场景 B：从光标位置向外找它所属的指定类型格式元素。
 *
 * 会分别按「中立 / 偏右 / 偏左」三个 side 解析光标位置——光标恰好贴在
 * 标记边界时，不同 side 可能落在标记节点或内容节点上，多试一次才不会漏。
 * 多个候选里取区间最短（最内层）的那个。
 *
 * @param view - 当前编辑器视图
 * @param pos - 光标位置
 * @param def - 要找的格式定义
 * @returns 包裹节点与首尾标记；光标不在该类格式内时返回 null
 */
function findEnclosingAtCursor(
    view: EditorView,
    pos: number,
    def: InlineFormatDef
): { node: SyntaxNode; open: SyntaxNode; close: SyntaxNode } | null {
    const tree = ensureTreeAround(view, pos);
    if (!tree) {
        return null;
    }

    let best: { node: SyntaxNode; open: SyntaxNode; close: SyntaxNode } | null = null;

    // resolveInner 的 side：-1 偏左、1 偏右、0 中立（与 live preview 的
    // findActiveInlineNode 保持一致，保证两个功能的「命中感」相同）
    for (const side of [-1, 0, 1] as const) {
        const inner = tree.resolveInner(pos, side);
        const node = climbToNode(inner, def.nodeName);
        if (!node) {
            continue;
        }
        const marks = extractMarkPair(node, def.markName);
        if (!marks) {
            continue;
        }
        // 光标必须真的在内容区里（含边界）：开标记结束之后、闭标记开始之前。
        // 落在 `**` 两个星号中间这种位置不算在格式内。
        if (pos < marks.open.to || pos > marks.close.from) {
            continue;
        }
        if (!best || node.to - node.from < best.node.to - best.node.from) {
            best = { node, open: marks.open, close: marks.close };
        }
    }

    return best;
}

/**
 * 场景 A：判断选区是否正好被某个指定类型的格式元素包住。
 *
 * 只接受两种「整段命中」：
 * 1. 选区恰好等于格式内容（不含标记）——最常见，双击选中加粗里的词；
 * 2. 选区恰好等于整个格式节点（含首尾标记）——手动把 `**x**` 全选了。
 *
 * 只选中内容的一部分时不做整体移除，走「给选区加格式」的分支，
 * 避免误删用户选区外面的标记。
 *
 * @param view - 当前编辑器视图
 * @param from - 选区起点
 * @param to - 选区终点
 * @param def - 格式定义
 * @returns 命中时返回包裹节点、首尾标记与命中模式
 */
function findEnclosingForSelection(
    view: EditorView,
    from: number,
    to: number,
    def: InlineFormatDef
):
    | {
          node: SyntaxNode;
          open: SyntaxNode;
          close: SyntaxNode;
          mode: 'content' | 'full';
      }
    | null {
    const tree = ensureTreeAround(view, from);
    if (!tree) {
        return null;
    }

    // 起点偏右、终点偏左地解析，保证选区两端贴边界时仍落在内容侧
    const startNode = climbToNode(tree.resolveInner(from, 1), def.nodeName);
    const endNode = climbToNode(tree.resolveInner(to, -1), def.nodeName);
    if (!startNode || !endNode || startNode !== endNode) {
        return null;
    }

    const marks = extractMarkPair(startNode, def.markName);
    if (!marks) {
        return null;
    }

    // 整段（含标记）被选中
    if (from === startNode.from && to === startNode.to) {
        return { node: startNode, open: marks.open, close: marks.close, mode: 'full' };
    }

    // 恰好选中内容
    if (from === marks.open.to && to === marks.close.from) {
        return { node: startNode, open: marks.open, close: marks.close, mode: 'content' };
    }

    return null;
}

// =============================================================================
// 纯文本兜底
// =============================================================================

/**
 * 不依赖语法树，直接看选区两侧 / 选区首尾是不是一对同型标记。
 *
 * 仅用于语法树没解析出来的写法（不合法的 Markdown 或解析尚未更新）。
 *
 * @param state - 编辑器状态
 * @param from - 选区起点
 * @param to - 选区终点
 * @param def - 格式定义
 * @returns 命中时给出两个删除区间与命中模式
 */
function findRawMarkPair(
    state: EditorView,
    from: number,
    to: number,
    def: InlineFormatDef
):
    | {
          openFrom: number;
          openTo: number;
          closeFrom: number;
          closeTo: number;
          mode: 'outside' | 'inside';
      }
    | null {
    const docLength = state.doc.length;

    for (const marker of def.rawMarkers) {
        const len = marker.length;

        // 仅单字符斜体标记（`*` / `_`）需要守护：它可能只是 `**` / `__`
        // 加粗标记的一半，那种情况下不能按斜体处理。
        const isSingleItalicMarker = def.nodeName === 'Emphasis' && len === 1;

        // 情况一：标记紧贴选区外侧（旧实现的行为）。
        // 此时若它属于加粗标记，另一个同字符在更外侧：开标记查 from-len-1，
        // 闭标记查 to+len。
        const outsideLooksLikeBold =
            isSingleItalicMarker &&
            (state.sliceDoc(from - len - 1, from - len) === marker ||
                state.sliceDoc(to + len, to + len + 1) === marker);

        if (
            !outsideLooksLikeBold &&
            from >= len &&
            to + len <= docLength &&
            state.sliceDoc(from - len, from) === marker &&
            state.sliceDoc(to, to + len) === marker
        ) {
            return {
                openFrom: from - len,
                openTo: from,
                closeFrom: to,
                closeTo: to + len,
                mode: 'outside',
            };
        }

        // 情况二：选区本身就把一对标记包在里面。
        // 此时另一个同字符在标记的内侧：开标记查 from+len，闭标记查 to-len-1。
        const insideLooksLikeBold =
            isSingleItalicMarker &&
            (state.sliceDoc(from + len, from + len + 1) === marker ||
                state.sliceDoc(to - len - 1, to - len) === marker);

        if (
            !insideLooksLikeBold &&
            to - from >= len * 2 &&
            state.sliceDoc(from, from + len) === marker &&
            state.sliceDoc(to - len, to) === marker
        ) {
            return {
                openFrom: from,
                openTo: from + len,
                closeFrom: to - len,
                closeTo: to,
                mode: 'inside',
            };
        }
    }

    return null;
}

// =============================================================================
// 切换计划
// =============================================================================

/**
 * 为单个选区/光标计算切换计划。
 *
 * @param view - 编辑器视图
 * @param anchor - 选区锚点
 * @param head - 选区活动端
 * @param def - 格式定义
 * @returns 切换计划
 */
function planToggle(
    view: EditorView,
    anchor: number,
    head: number,
    def: InlineFormatDef
): TogglePlan {
    const state = view.state;
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);

    // ---- 场景 B：空选区（只有光标） ----
    if (from === to) {
        // 先向外探测：命中就删掉那一对标记，光标停到内容起点
        const enclosing = findEnclosingAtCursor(view, from, def);
        if (enclosing) {
            return {
                changes: [
                    { from: enclosing.open.from, to: enclosing.open.to },
                    { from: enclosing.close.from, to: enclosing.close.to },
                ],
                // 光标放在开标记起点（删除区间起点），向右映射即落在内容首字符前
                ...target(enclosing.open.from, enclosing.open.from, 1, 1),
            };
        }

        // 未命中：插入一对空标记，光标落在两对标记正中间
        const marker = def.addMarker;
        return {
            changes: [{ from, insert: marker + marker }],
            ...target(from, from, 1, 1, marker.length),
        };
    }

    // ---- 场景 A：有选区 ----
    // 先走语法树：精确识别「整段内容 / 整段含标记」两种移除情形
    const enclosing = findEnclosingForSelection(view, from, to, def);
    if (enclosing) {
        // content：选区两端正好贴着标记内侧 ——
        //   锚点在开标记删除区间右端（贴左），活动端在闭标记删除区间左端（贴右）；
        // full：选区包含整对标记 ——
        //   锚点从开标记起点向右映射、活动端从闭标记终点向左映射，都落到内容上。
        const sel =
            enclosing.mode === 'content'
                ? target(from, to, -1, 1)
                : target(enclosing.node.from, enclosing.node.to, 1, -1);
        return {
            changes: [
                { from: enclosing.open.from, to: enclosing.open.to },
                { from: enclosing.close.from, to: enclosing.close.to },
            ],
            ...sel,
        };
    }

    // 语法树没认出来：用纯文本两侧匹配兜底（含选区自带标记的情况）
    const raw = findRawMarkPair(state, from, to, def);
    if (raw) {
        // outside：删除区间紧贴选区外侧 —— 锚点贴左、活动端贴右；
        // inside：删除区间在选区两端内侧 —— 内容起点是开删除的右端（贴左），
        //         内容终点是闭删除的左端（贴右）。
        const sel =
            raw.mode === 'outside'
                ? target(from, to, -1, 1)
                : target(raw.openTo, raw.closeFrom, -1, 1);
        return {
            changes: [
                { from: raw.openFrom, to: raw.openTo },
                { from: raw.closeFrom, to: raw.closeTo },
            ],
            ...sel,
        };
    }

    // 都没命中：在选区两侧添加标记，选区覆盖文本本身（不含新标记）。
    // 锚点从选区起点向右映射（越过新开标记），活动端从选区终点向左映射
    // （停在新闭标记之前）。
    const marker = def.addMarker;
    return {
        changes: [
            { from, insert: marker },
            { from: to, insert: marker },
        ],
        ...target(from, to, 1, -1),
    };
}

/**
 * 对当前所有选区（支持多光标）执行一次格式切换，合并为同一个事务，
 * 这样一次撤销就能完整回退。
 *
 * @param view - CodeMirror 编辑器视图
 * @param def - 要切换的格式
 * @returns 是否消费了这次快捷键
 */
function toggleInlineFormat(view: EditorView, def: InlineFormatDef): boolean {
    // 只读模式（Viewer）不允许改文档；输入法组词期间也不插手，避免破坏中文输入
    if (!view.state.facet(EditorView.editable) || view.composing) {
        return false;
    }

    const selection = view.state.selection;
    const ranges = selection.ranges;

    // 逐个选区计算计划。各选区互不重叠，改动坐标都基于原文档，
    // 可以安全合并到同一个 ChangeSet。
    const plans = ranges.map((range) =>
        planToggle(view, range.anchor, range.head, def)
    );

    const allChanges: ChangeSpec[] = [];
    for (const plan of plans) {
        allChanges.push(...plan.changes);
    }

    // 用合并后的 ChangeSet 把旧坐标统一映射成新坐标，
    // 避免手动累加每个删除/插入的位移量（多光标时极易算错）。
    const changeSet = ChangeSet.of(allChanges, view.state.doc.length);
    const newRanges = plans.map((plan) => {
        let anchor: number;
        let head: number;
        if (plan.cursorInsideInsert > 0) {
            // 空标记对：mapPos 无法落到插入文本内部，
            // 先映射到插入区间右端再往回退一个标记长度，正好落在两对标记中间
            const len = plan.cursorInsideInsert;
            anchor = changeSet.mapPos(plan.anchor, 1) - len;
            head = changeSet.mapPos(plan.head, 1) - len;
        } else {
            anchor = changeSet.mapPos(plan.anchor, plan.anchorAssoc);
            head = changeSet.mapPos(plan.head, plan.headAssoc);
        }
        return EditorSelection.range(anchor, head);
    });

    view.dispatch({
        changes: allChanges,
        selection: EditorSelection.create(newRanges, selection.mainIndex),
        annotations: Transaction.userEvent.of('input.format'),
        scrollIntoView: true,
    });

    return true;
}

// =============================================================================
// 对外命令
// =============================================================================

/**
 * 切换加粗（Ctrl/Cmd+B）。
 *
 * 导出给导图模式复用：导图节点选中后按同一组快捷键，走的是完全相同的
 * 语法树判断与选区处理（见 mindmapApp 的 applyInlineFormat）。
 */
export function toggleBold(view: EditorView): boolean {
    return toggleInlineFormat(view, BOLD_DEF);
}

/** 切换斜体（Ctrl/Cmd+I）。 */
export function toggleItalic(view: EditorView): boolean {
    return toggleInlineFormat(view, ITALIC_DEF);
}

/** 切换行内代码（Ctrl/Cmd+G）。 */
export function toggleInlineCode(view: EditorView): boolean {
    return toggleInlineFormat(view, CODE_DEF);
}

/**
 * Markdown 行内格式快捷键。
 *
 * 注意：searchKeymap 也占用了 Mod-g（查找下一个），但它带
 * 'editor search-panel' 作用域，且本 keymap 在 editor.ts 中排在前面，
 * 所以正文编辑时 Mod-g 走行内代码切换、焦点在搜索面板里时仍是「下一个」。
 *
 * 'Mod' 在 macOS 上解析为 Cmd，其它平台为 Ctrl。
 */
export const markdownKeymap: readonly KeyBinding[] = [
    {
        key: 'Mod-b',
        run: toggleBold,
        preventDefault: true,
    },
    {
        key: 'Mod-i',
        run: toggleItalic,
        preventDefault: true,
    },
    {
        key: 'Mod-g',
        run: toggleInlineCode,
        preventDefault: true,
    },
];

/**
 * 创建包含历史与全部快捷键的扩展集合。
 *
 * 编辑器实际使用的快捷键在 editor.ts 中直接拼装；此函数保留给测试与
 * 其它需要独立创建编辑器的场景使用。
 *
 * @returns CodeMirror 扩展数组
 */
export function createLiveWriteMdKeymap(): Extension[] {
    return [
        history(),
        // Markdown 格式快捷键排在最前，优先于默认按键与搜索按键
        keymap.of([...markdownKeymap, ...historyKeymap, ...defaultKeymap]),
    ];
}
