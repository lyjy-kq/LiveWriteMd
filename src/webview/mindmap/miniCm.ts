/**
 * 导图节点的迷你 CodeMirror 编辑会话（todo.md 任务 10）。
 *
 * 进入编辑 = 节点原位换成一个 mini-CM（高度自适应内容、宽度与节点一致）：
 * - 挂与文本模式**同款**的 live preview 扩展（任务 4 实例化之后多实例安全）；
 * - 一次会话 = 源文档一步撤销（提交走 renameNode → commit → CM 全量替换）；
 * - 会话内 Ctrl+Z/Y 由 mini-CM 自己的 history 自管（mindmapApp 的快捷键
 *   在编辑态不拦截）；
 * - CM 的鼠标/键盘事件全部 stopPropagation，拖选文字不会拖动画布背景
 *   （库的节点拖拽从 group mousedown 起步，冒泡到这里被截断）；
 * - 失焦 / Esc 提交；文本节点（heading / list / para）里：
 *     Enter       = 在**同一个单元格里**换行（内容变高时上层把盒子撑高，
 *                   见 contentHeight），提交后仍属于同一个 md 块（标题 /
 *                   列表项的续行由 renameNode 负责写回去）；
 *     Shift+Enter = 提交当前项，并在后面新起一个同级节点（上层接管）；
 *   图片节点 Enter = 提交；代码 / 表格 / 公式 / mermaid / YAML 节点
 *   Enter 照常换行（编辑的就是源码，不拆节点）；
 * - 会话容器是**持久元素**：库每次渲染重建节点 DOM 时，createNodeContent
 *   重新返回同一个容器（含同一个 EditorView），编辑不被打断
 *   （mindmapApp 同时锁住外部重建，双保险）。
 *
 * @module webview/mindmap/miniCm
 */

import { EditorState, Prec, Compartment, StateField } from '@codemirror/state';
import {
    EditorView,
    keymap,
    drawSelection,
    Decoration,
    type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { markdownKeymap } from '../codemirror/extensions/keymap.js';
import {
    LanguageDescription,
    syntaxHighlighting,
    type LanguageSupport,
} from '@codemirror/language';
import { tunedMarkdownLanguage } from '../codemirror/extensions/markdownParser.js';
import { lightTheme, darkTheme } from '../codemirror/extensions/theme.js';
import {
    createLivePreviewDisplayExtension,
    livePreviewEditAddons,
} from '../codemirror/extensions/livePreview/plugin.js';
import {
    ensureTokenColorCss,
    liveWriteMdTokenHighlight,
} from '../codemirror/extensions/livePreview/tokenColors.js';
import type { ThemeType } from '../../shared/types.js';

/**
 * 文本节点：Enter = 单元格内换行，Shift+Enter = 提交并新起同级节点。
 * 这三类的多行内容都能写回同一个 md 块：
 * - 标题：首行是标题，续行紧跟在下一行（treeBuilder 会把「标题后紧挨着
 *   的段落」并回标题节点，见 treeBuilder 的 heading continuation）；
 * - 列表项：续行按 marker 宽度缩进（renameNode 已支持）；
 * - 段落：多行本来就是一个段落。
 */
const TEXT_KINDS = new Set(['heading', 'list', 'para']);

/** 单行节点类型：Enter = 提交（图片在 md 里只占一行，多一行会变成图文段落）。 */
const SINGLE_LINE_KINDS = new Set(['image']);

// ==================================================================
// 节点显示态（显示/编辑统一，新需求 1）：只读 mini-CM
// ==================================================================

/** 节点显示构造参数。 */
export interface NodeDisplayOptions {
    /** 显示文档（完整 md 源码：文本节点是行内容，媒体节点含围栏）。 */
    doc: string;
    /**
     * 是否在末尾加隐藏哨兵空行。
     *
     * 解决的问题：整篇文档就是「一个块」（代码块/表格/数学块/mermaid）时，
     * 光标无论停哪都在块内 → live 的「聚焦块 = 源码态」规则让块装饰
     * （边框/底色/rainbow indent/表格 widget/公式 widget）永远不生效。
     * 加一行隐藏空行并把选区停在那里，块永远处于「非聚焦」渲染态。
     */
    sentinel?: boolean;
    /** 当前明暗主题。 */
    theme: ThemeType;
    /** 代码块嵌套高亮语言表。 */
    codeLanguages?: readonly LanguageDescription[];
    /**
     * 轻量渲染（画布缩放到「降级渲染」阈值以下时由 MapCanvas 传 true）：
     * 不挂 live preview 显示扩展 —— 行内标记、代码块边框、表格 widget、
     * 公式 / mermaid / 图片全部不构建，只留 Markdown 源码本身的排版。
     * 缩放后这些细节本来也看不清，省掉的是每节点几十个装饰与测量。
     */
    lite?: boolean;
}

/** 节点显示会话。 */
export interface NodeDisplay {
    /** 容器（含只读 mini-CM）。 */
    readonly container: HTMLDivElement;
    /** 只读编辑器实例。 */
    readonly view: EditorView;
    /** 原始显示文档（不含哨兵换行）：缓存键与提交比对用。 */
    readonly sourceDoc: string;
    /** 是否带哨兵行。 */
    readonly sentinel: boolean;
    /** 当前是否处于编辑态（翻转中）。 */
    readonly editing: boolean;
    /** 选区复位（P1 失焦恢复：被点开的行内元素收回渲染态）。 */
    resetSelection: () => void;
    /** 销毁（节点被永久移除/替换后清理）。 */
    destroy: () => void;
    /**
     * 原地翻转成编辑态（不重渲染、不换 DOM）：
     * Compartment 重配（可编辑 + history + 会话键位）+ 事件截断 + blur 提交。
     */
    enterEdit: (opts: {
        kind: string;
        onCommit: (text: string) => void;
        /**
         * Shift+Enter 接管（文本节点用）：提交当前项并新起一个同级节点。
         * 不传时文本节点只保留 Enter 换行，Shift+Enter 不绑定。
         */
        onShiftEnter?: () => void;
        /** 文档变化（回车/自动折行）时通知上层，用于把节点盒子撑高。 */
        onDocChanged?: () => void;
    }) => void;
    /** 翻转回显示态（提交/放弃之后调用；提交逻辑由调用方完成）。 */
    exitEdit: () => void;
    /**
     * 在「可编辑」状态下执行一段命令，结束后自动恢复只读。
     *
     * 用途：显示态是只读的（`EditorView.editable = false`），但表格增删行列
     * 之类的命令内部会检查 editable 才肯改文档（见 runTableCommand）。
     * 不进入完整编辑会话（不挂 blur 提交、不显示会话键位），只临时放开
     * 可编辑性，执行完立刻收回 —— 右键菜单点一下就改表格，不该整个节点
     * 翻成编辑态。
     *
     * @param fn - 拿到同一个 EditorView 执行命令
     * @returns fn 的返回值
     */
    withEditable: <T>(fn: (view: EditorView) => T) => T;
    /** 当前文本（哨兵文档剥掉末尾那一个换行）。 */
    getText: () => string;
    /** 当前内容完整高度（含 .cm-content 上下 padding），撑高节点盒子用。 */
    contentHeight: () => number;
    /** 聚焦并把光标放到视口坐标处；无坐标则放文末。 */
    focusAt: (x?: number, y?: number) => void;
}

/**
 * 创建节点显示态的只读 mini-CM（新需求 1：显示态 = live 本尊）。
 *
 * 挂与文本模式同款的完整 live preview 扩展 —— 行内元素的点击展开/
 * 失焦恢复/位置补偿、代码块的边框与 rainbow indent、表格 widget、
 * 数学/mermaid/图片 widget 全部原生生效，与正文像素级一致。
 *
 * 不截断鼠标事件：点击/拖拽同时属于 CM（选区/展开）与节点（选中/拖拽），
 * 冒泡到导图库的 group 处理器照常工作。
 */
export function createNodeDisplay(options: NodeDisplayOptions): NodeDisplay {
    ensureTokenColorCss();

    const sentinel = options.sentinel === true;
    const rawDoc = sentinel ? options.doc + '\n' : options.doc;

    const container = document.createElement('div');
    container.className = 'lwm-node-display';

    // 可编辑性三件套用 Compartment：显示（只读）⇄ 编辑（可编辑）原地翻转，
    // 不重建 EditorView —— 进编辑零重渲染（编辑入口卡顿修复的核心）
    const editableComp = new Compartment();
    const readOnlyComp = new Compartment();
    const editExtComp = new Compartment();

    const extensions = [
        // 只读显示：不可编辑（选区仍然可用，行内展开靠的就是选区）
        editableComp.of(EditorView.editable.of(false)),
        readOnlyComp.of(EditorState.readOnly.of(true)),
        EditorView.lineWrapping,
        markdown({
            base: tunedMarkdownLanguage,
            codeLanguages: options.codeLanguages ?? [],
        }),
        options.theme === 'light' ? lightTheme : darkTheme,
        // 高度随内容（截断交给节点 CSS）
        Prec.high(
            EditorView.theme({
                '&': { height: 'auto' },
                '.cm-scroller': { overflow: 'visible' },
                '.cm-content': { padding: '2px 0' },
            })
        ),
        // 与文本模式渲染一致的**显示态** live 扩展包（无编辑交互插件：
        // 几十实例同屏时的监听器/测量钩子大头都在这里省掉）。
        // 轻量档（画布缩得很小）连这层也省掉，只显示源码排版。
        ...(options.lite ? [] : [createLivePreviewDisplayExtension()]),
        // 编辑态扩展槽（history + 会话键位 + 交互插件，翻转时注入）
        editExtComp.of([]),
    ];
    // 初始选区一律停文末：
    // - 哨兵文档（代码/表格/数学/mermaid）：选区在哨兵行 = 块外，块永远非聚焦；
    // - 单行文本节点：选区在行首会把光标压在块级标记上（`-`/`#` 按
    //   live 的「光标落在标记字符上才露出」规则一直显示），停行尾则
    //   标记按 live 常态渲染成圆点/隐藏，与正文外观一致
    const selectionAnchor = rawDoc.length;
    if (sentinel) {
        /**
         * 哨兵空行的行装饰（高度压 0、不可见）。
         *
         * 绝对不能用静态 `EditorView.decorations.of(...)`：静态集合的位置
         * 不跟随文档变化。编辑时删掉几个字符后，旧「文末」位置就超出了
         * 新文档长度，CM 在下一个事务里映射装饰区间（DocView 更新、
         * HeightMap、鼠标按下时的 select/start）时直接抛
         * `RangeError: Position N is out of range for changeset of length M`。
         *
         * 改成 StateField：docChanged 时按**当前**末行重算一遍。只有末行
         * 为空（文档确实以 '\n' 结尾、末尾那一行就是哨兵行）时才挂，
         * 避免把最后一行正文错误地压成 0 高。
         */
        const buildSentinelLine = (state: EditorState): DecorationSet => {
            const lastLine = state.doc.line(state.doc.lines);
            if (lastLine.length !== 0) return Decoration.none;
            return Decoration.set([
                Decoration.line({ class: 'lwm-sentinel-line' }).range(lastLine.from),
            ]);
        };
        const sentinelLineField = StateField.define<DecorationSet>({
            create: buildSentinelLine,
            // 位置只在文档变化时才会失效；选区/焦点事务沿用旧值
            update: (value, tr) => (tr.docChanged ? buildSentinelLine(tr.state) : value),
            provide: (field) => EditorView.decorations.from(field),
        });
        extensions.push(sentinelLineField);
    }

    const view = new EditorView({
        parent: container,
        state: EditorState.create({
            doc: rawDoc,
            selection: { anchor: selectionAnchor },
            extensions,
        }),
    });

    // —— 翻转状态 ——
    let editing = false;
    let blurHandler: (() => void) | null = null;

    /** 事件截断（编辑态专用，防拖选文字触发节点/画布拖拽）。 */
    const stopProp = (event: Event): void => event.stopPropagation();

    const display: NodeDisplay = {
        container,
        view,
        sourceDoc: options.doc,
        sentinel,
        get editing(): boolean {
            return editing;
        },
        resetSelection: (): void => {
            try {
                // 与初始选区一致：一律复位到文末（理由见 createNodeDisplay 注释）
                view.dispatch({ selection: { anchor: view.state.doc.length } });
            } catch {
                /* 视图已销毁：忽略 */
            }
        },
        destroy: () => view.destroy(),
        contentHeight: (): number => {
            // contentDOM 的 rect 含 .cm-content 的上下 padding（2px 0），
            // 正好等于节点盒子里需要留给内容的高度
            return view.contentDOM.getBoundingClientRect().height;
        },
        enterEdit: ({ kind, onCommit, onShiftEnter, onDocChanged }): void => {
            if (editing) return;
            editing = true;
            container.classList.add('lwm-node-editing');
            container.closest('.lwm-node')?.classList.add('lwm-node-editing');
            // 编辑态只截 mousedown：节点/画布拖拽从 group mousedown 起步，
            // 截住它即可；mousemove/mouseup 必须放行 —— CM 的拖选文字
            // 靠 document 级监听，全截会让编辑态无法滑动选中（bug 2）
            container.addEventListener('mousedown', stopProp);
            // 会话键位：Esc 提交；回车按节点类型决定：
            //   文本节点（heading / list / para）：Enter = 纯换行。这里不能
            //     交给默认键位 —— @codemirror/lang-markdown 的列表续行会在
            //     列表行里自己插一个 "- "，虽然提交后也能被 renameNode 收成
            //     续行，但编辑态看着像新起了一项。原生插入一个 '\n' 最干净。
            //   image：Enter = 提交（单行节点）；
            //   其余（code / table / math / mermaid / meta）：不绑定，走默认
            //     换行（编辑源代码）。
            //   Shift-Enter：文本节点交给上层「提交 + 新起同级节点」。
            const textKind = TEXT_KINDS.has(kind);
            const singleLine = SINGLE_LINE_KINDS.has(kind);
            const enterBinding = textKind
                ? {
                      key: 'Enter',
                      run: (view: EditorView): boolean => {
                          // 哨兵空行不属于正文（高度压 0、看不见）。光标若停在
                          // 文末哨兵行上，直接回车会在正文和哨兵之间插入一个
                          // 「真的空行」—— 提交后一段被拆成两段。先把光标拉回
                          // 正文末尾，再插入换行。
                          const sel = view.state.selection.main;
                          const docLength = view.state.doc.length;
                          if (sentinel && sel.empty && sel.from >= docLength) {
                              view.dispatch({
                                  selection: { anchor: Math.max(0, docLength - 1) },
                              });
                          }
                          view.dispatch(view.state.replaceSelection('\n'));
                          return true;
                      },
                  }
                : singleLine
                  ? {
                        key: 'Enter',
                        run: (): boolean => {
                            onCommit(display.getText());
                            return true;
                        },
                    }
                  : null;
            const shiftEnterBinding =
                textKind && onShiftEnter
                    ? {
                          key: 'Shift-Enter',
                          run: (): boolean => {
                              onShiftEnter();
                              return true;
                          },
                      }
                    : null;
            view.dispatch({
                effects: [
                    editableComp.reconfigure(EditorView.editable.of(true)),
                    readOnlyComp.reconfigure(EditorState.readOnly.of(false)),
                    editExtComp.reconfigure([
                        history(),
                        // 会话键位必须用 Prec.highest：@codemirror/lang-markdown
                        // 自带的列表续行键位（Enter）也用 high 优先级，而且它在
                        // 基础扩展里排在前面。列表项里光标只要不在行首，前者就会
                        // 先返回 true 把 Enter 吞掉 —— 表现为「有时回车没反应/
                        // 只多出一行、有时才新起一项」。highest 保证会话规则
                        // （Esc 提交、列表回车新建、单行节点回车提交）永远先跑。
                        Prec.highest(
                            keymap.of([
                                {
                                    key: 'Escape',
                                    run: (): boolean => {
                                        onCommit(display.getText());
                                        return true;
                                    },
                                },
                                ...(enterBinding ? [enterBinding] : []),
                                ...(shiftEnterBinding ? [shiftEnterBinding] : []),
                            ])
                        ),
                        // 文档变化通知：普通段落回车新增一行、长行自动折行后，
                        // 上层据此把节点盒子撑高，否则新行会被编辑态裁掉
                        EditorView.updateListener.of((update) => {
                            if (update.docChanged) onDocChanged?.();
                        }),
                        // 与 live 模式同款的行内格式快捷键（Ctrl/Cmd+B/I/G）。
                        // 放在 history/defaultKeymap 前面，保证 Mod-g 不会被
                        // 默认键位里的「转到行」之类抢走（我们的 defaultKeymap
                        // 来自 @codemirror/commands，没有 gotoLine，但顺序习惯
                        // 与主编辑器保持一致，便于以后维护）。
                        keymap.of([...markdownKeymap, ...historyKeymap, ...defaultKeymap]),
                        // 编辑期补回交互插件（拖选锚点/括号配对/表格框选等）
                        ...livePreviewEditAddons(),
                    ]),
                ],
            });
            blurHandler = () => onCommit(display.getText());
            view.contentDOM.addEventListener('blur', blurHandler);
        },
        withEditable: <T>(fn: (view: EditorView) => T): T => {
            // 已经在编辑会话里就是可编辑的，不重复重配（重配会多跑一轮
            // Compartment 更新，还会把会话键位顺序打乱）
            const wasEditable = view.state.facet(EditorView.editable);
            if (!wasEditable) {
                view.dispatch({
                    effects: [
                        editableComp.reconfigure(EditorView.editable.of(true)),
                        readOnlyComp.reconfigure(EditorState.readOnly.of(false)),
                    ],
                });
            }
            try {
                return fn(view);
            } finally {
                // 命令抛异常也要收回只读，否则显示态会莫名变成可编辑
                if (!wasEditable) {
                    view.dispatch({
                        effects: [
                            editableComp.reconfigure(EditorView.editable.of(false)),
                            readOnlyComp.reconfigure(EditorState.readOnly.of(true)),
                        ],
                    });
                }
            }
        },
        exitEdit: (): void => {
            if (!editing) return;
            editing = false;
            container.classList.remove('lwm-node-editing');
            container.closest('.lwm-node')?.classList.remove('lwm-node-editing');
            container.removeEventListener('mousedown', stopProp);
            if (blurHandler) {
                view.contentDOM.removeEventListener('blur', blurHandler);
                blurHandler = null;
            }
            try {
                view.dispatch({
                    effects: [
                        editableComp.reconfigure(EditorView.editable.of(false)),
                        readOnlyComp.reconfigure(EditorState.readOnly.of(true)),
                        editExtComp.reconfigure([]),
                    ],
                });
            } catch {
                /* 视图已销毁：忽略 */
            }
        },
        getText: (): string => {
            const text = view.state.doc.toString();
            // 哨兵文档末尾的那一个换行是显示态加的结构，提交时剥掉
            return sentinel && text.endsWith('\n') ? text.slice(0, -1) : text;
        },
        focusAt: (x?: number, y?: number): void => {
            if (!editing) return;
            view.focus();
            let pos: number | null = null;
            if (x !== undefined && y !== undefined) {
                pos = view.posAtCoords({ x, y });
            }
            // 无坐标（F2 / 工具条入口）→ 光标放文末；不全选
            view.dispatch({
                selection: { anchor: pos ?? view.state.doc.length },
            });
        },
    };
    return display;
}
