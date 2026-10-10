/**
 * LiveWriteMD 右侧大纲面板。
 *
 * 这个模块负责在 Webview 中创建右侧大纲、可拖拽分隔线、
 * 标题树渲染、折叠状态持久化以及标题点击跳转。
 */

/**
 * 解析后的标题节点信息。
 */
interface ParsedOutlineNode {
    /** 标题文本。 */
    text: string;
    /** 标题级别，范围为 1 到 6。 */
    level: number;
    /** 标题所在的源文档行号，从 1 开始。 */
    line: number;
    /** 用于折叠状态持久化的稳定键。 */
    key: string;
    /** 子标题节点。 */
    children: ParsedOutlineNode[];
    /** 当前节点是否处于折叠状态。 */
    collapsed: boolean;
    /** 当前节点是否拥有子标题。 */
    hasChildren: boolean;
}

/**
 * 大纲持久化状态。
 */
interface OutlinePersistedState {
    /** 右侧大纲栏宽度，单位为像素。 */
    width: number;
    /** 当前处于折叠状态的标题键集合。 */
    collapsedKeys: string[];
}

/**
 * 大纲管理器的构造参数。
 */
export interface OutlineManagerOptions {
    /** 现有的编辑器容器节点。 */
    editorHost: HTMLElement;
    /** 点击大纲标题时执行的跳转回调。 */
    jumpToLine: (line: number) => void;
    /** 读取 Webview 持久化状态的回调。 */
    getState: () => unknown;
    /** 写入 Webview 持久化状态的回调。 */
    setState: (state: unknown) => void;
}

/**
 * 默认的大纲栏宽度。
 */
const DEFAULT_OUTLINE_WIDTH = 300;

/**
 * 大纲栏最小宽度。
 */
const MIN_OUTLINE_WIDTH = 220;

/**
 * 大纲栏最大宽度。
 */
const MAX_OUTLINE_WIDTH = 520;

/**
 * 大纲栏分隔条的可拖拽宽度。
 */
const OUTLINE_DIVIDER_WIDTH = 8;

/**
 * 右侧面板样式注入标识。
 */
const OUTLINE_STYLE_ID = 'livewritemd-outline-style';

/**
 * 根布局容器标识。
 */
const OUTLINE_ROOT_ID = 'livewritemd-app-root';

/**
 * 编辑器外壳容器标识。
 */
const OUTLINE_EDITOR_SHELL_ID = 'livewritemd-editor-shell';

/**
 * 大纲面板容器标识。
 */
const OUTLINE_PANEL_ID = 'livewritemd-outline-pane';

/**
 * 大纲树根容器标识。
 */
const OUTLINE_TREE_ID = 'livewritemd-outline-tree';

/**
 * 大纲空状态容器标识。
 */
const OUTLINE_EMPTY_ID = 'livewritemd-outline-empty';

/**
 * 大纲分隔条标识。
 */
const OUTLINE_DIVIDER_ID = 'livewritemd-outline-divider';

/**
 * 安全读取对象类型值。
 *
 * @param value - 待检查的值。
 * @returns 如果值是普通对象则返回 true，否则返回 false。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 规范化标题文本，去掉尾部标记、内联 HTML 标签和多余空白。
 *
 * @param text - 原始标题文本。
 * @returns 清洗后的标题文本。
 */
function normalizeHeadingText(text: string): string {
    return text
        .replace(/<\/?[a-zA-Z][^>]*>/g, '')
        .replace(/\s+#+\s*$/, '')
        .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
        .replace(/[`*_~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 生成标题的简易键值片段。
 *
 * @param text - 标题文本。
 * @returns 用于路径拼接的稳定片段。
 */
function slugifyHeadingText(text: string): string {
    const normalized = normalizeHeadingText(text)
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized || 'heading';
}

/**
 * 将像素宽度限制在允许范围内。
 *
 * @param width - 待限制的宽度值。
 * @returns 限制后的宽度值。
 */
function clampOutlineWidth(width: number): number {
    const upperBound = Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, window.innerWidth - 280));
    return Math.min(upperBound, Math.max(MIN_OUTLINE_WIDTH, Math.round(width)));
}

/**
 * 读取持久化状态中的大纲配置。
 *
 * @param rawState - Webview 原始状态对象。
 * @returns 解析后的持久化状态。
 */
function readOutlineState(rawState: unknown): OutlinePersistedState | null {
    if (!isRecord(rawState)) {
        return null;
    }

    const outlineState = rawState.livewritemdOutline;
    if (!isRecord(outlineState)) {
        return null;
    }

    const width = outlineState.width;
    const collapsedKeys = outlineState.collapsedKeys;

    const safeWidth = typeof width === 'number' && Number.isFinite(width) ? clampOutlineWidth(width) : DEFAULT_OUTLINE_WIDTH;
    const safeCollapsedKeys = Array.isArray(collapsedKeys)
        ? collapsedKeys.filter((item): item is string => typeof item === 'string')
        : [];

    return {
        width: safeWidth,
        collapsedKeys: safeCollapsedKeys,
    };
}

/**
 * 将大纲状态写回 Webview 持久化存储。
 *
 * @param setState - Webview 状态写入回调。
 * @param rawState - 现有状态对象。
 * @param state - 需要写入的大纲状态。
 * @returns void
 */
function persistOutlineState(
    setState: (state: unknown) => void,
    rawState: unknown,
    state: OutlinePersistedState
): void {
    const nextState: Record<string, unknown> = isRecord(rawState) ? { ...rawState } : {};
    nextState.livewritemdOutline = state;
    setState(nextState);
}

/**
 * 解析 Markdown 文档中的标题节点。
 *
 * @param content - Markdown 原文内容。
 * @returns 按顺序排列的标题树。
 */
function parseMarkdownOutline(content: string): ParsedOutlineNode[] {
    const lines = content.split(/\r?\n/);
    const flatNodes: Array<{ text: string; level: number; line: number }> = [];
    let inFence = false;
    let fenceMarker = '';
    let fenceLength = 0;

    for (let index = 0; index < lines.length; index += 1) {
        const currentLine = lines[index];
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
            const text = normalizeHeadingText(atxMatch[2]);
            if (text) {
                flatNodes.push({
                    text,
                    level: atxMatch[1].length,
                    line: index + 1,
                });
            }
            continue;
        }

        const nextLine = lines[index + 1];
        const setextLevel =
            nextLine && !inFence && /^\s*=+\s*$/.test(nextLine)
                ? 1
                : nextLine && !inFence && /^\s*-+\s*$/.test(nextLine)
                  ? 2
                  : 0;

        if (setextLevel > 0) {
            const text = normalizeHeadingText(currentLine);
            if (text) {
                flatNodes.push({
                    text,
                    level: setextLevel,
                    line: index + 1,
                });
            }
            index += 1;
        }
    }

    return buildOutlineTree(flatNodes);
}

/**
 * 将扁平标题列表构造成树状结构。
 *
 * @param nodes - 扁平标题节点列表。
 * @returns 树状标题节点列表。
 */
function buildOutlineTree(
    nodes: Array<{ text: string; level: number; line: number }>
): ParsedOutlineNode[] {
    const roots: ParsedOutlineNode[] = [];
    const stack: ParsedOutlineNode[] = [];
    const siblingCounters = new Map<string, number>();

    for (const node of nodes) {
        while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
            stack.pop();
        }

        const parent = stack[stack.length - 1];
        const parentPath = parent ? parent.key : '';
        const slug = slugifyHeadingText(node.text);
        const baseKey = parentPath ? `${parentPath}>${slug}` : slug;
        const nextIndex = (siblingCounters.get(baseKey) ?? 0) + 1;
        siblingCounters.set(baseKey, nextIndex);
        const key = `${baseKey}#${nextIndex}`;

        const outlineNode: ParsedOutlineNode = {
            text: node.text,
            level: node.level,
            line: node.line,
            key,
            children: [],
            collapsed: false,
            hasChildren: false,
        };

        if (parent) {
            parent.children.push(outlineNode);
        } else {
            roots.push(outlineNode);
        }

        stack.push(outlineNode);
    }

    const markChildren = (list: ParsedOutlineNode[]): void => {
        for (const item of list) {
            item.hasChildren = item.children.length > 0;
            markChildren(item.children);
        }
    };
    markChildren(roots);

    return roots;
}

/**
 * LiveWriteMD 右侧大纲面板管理器。
 */
export class OutlineManager {
    /** 编辑器宿主容器。 */
    private readonly editorHost: HTMLElement;

    /** 点击标题时使用的跳转回调。 */
    private readonly jumpToLine: (line: number) => void;

    /** 读取 Webview 持久化状态的回调。 */
    private readonly getState: () => unknown;

    /** 写入 Webview 持久化状态的回调。 */
    private readonly setState: (state: unknown) => void;

    /** 根布局容器。 */
    private readonly root: HTMLDivElement;

    /** 编辑器外壳容器。 */
    private readonly editorShell: HTMLDivElement;

    /** 大纲栏容器。 */
    private readonly outlinePane: HTMLAsideElement;

    /** 大纲树根容器。 */
    private readonly outlineTree: HTMLDivElement;

    /** 大纲标题栏容器。 */
    private readonly outlineHeader: HTMLDivElement;

    /** 大纲空状态容器。 */
    private readonly emptyState: HTMLDivElement;

    /** 分隔条容器。 */
    private readonly divider: HTMLDivElement;

    /** 当前文档内容。 */
    private content = '';

    /** 当前大纲树数据。 */
    private outlineNodes: ParsedOutlineNode[] = [];

    /** 当前折叠状态集合。 */
    private collapsedKeys = new Set<string>();

    /** 当前大纲宽度。 */
    private width = DEFAULT_OUTLINE_WIDTH;

    /** 计划中的渲染帧编号。 */
    private renderFrame: number | null = null;

    /** 分隔条是否处于拖拽状态。 */
    private isDragging = false;

    /** 拖拽起始 X 坐标。 */
    private dragStartX = 0;

    /** 拖拽起始宽度。 */
    private dragStartWidth = DEFAULT_OUTLINE_WIDTH;

    /**
     * 创建新的大纲管理器并初始化布局。
     *
     * @param options - 大纲管理器所需的外部依赖。
     * @returns void
     */
    constructor(options: OutlineManagerOptions) {
        this.editorHost = options.editorHost;
        this.jumpToLine = options.jumpToLine;
        this.getState = options.getState;
        this.setState = options.setState;

        this.root = document.createElement('div');
        this.root.id = OUTLINE_ROOT_ID;

        this.editorShell = document.createElement('div');
        this.editorShell.id = OUTLINE_EDITOR_SHELL_ID;

        this.outlinePane = document.createElement('aside');
        this.outlinePane.id = OUTLINE_PANEL_ID;
        this.outlinePane.setAttribute('aria-label', 'Outline');

        this.divider = document.createElement('div');
        this.divider.id = OUTLINE_DIVIDER_ID;
        this.divider.setAttribute('role', 'separator');
        this.divider.setAttribute('aria-orientation', 'vertical');
        this.divider.setAttribute('aria-label', 'Resize outline panel');

        this.outlineTree = document.createElement('div');
        this.outlineTree.id = OUTLINE_TREE_ID;
        this.outlineTree.setAttribute('role', 'tree');

        this.outlineHeader = document.createElement('div');
        this.outlineHeader.className = 'livewritemd-outline-header';
        const headerTitle = document.createElement('strong');
        headerTitle.textContent = 'Outline';
        const headerHint = document.createElement('span');
        headerHint.textContent = 'Click to jump';
        this.outlineHeader.appendChild(headerTitle);
        this.outlineHeader.appendChild(headerHint);

        this.emptyState = document.createElement('div');
        this.emptyState.id = OUTLINE_EMPTY_ID;
        this.emptyState.textContent = 'No headings found';

        this.ensureStyles();
        this.mountLayout();
        this.restorePersistedState();
        this.installDividerDragging();
        this.applyWidth(this.width, false);
        this.scheduleRender();
    }

    /**
     * 设置最新的 Markdown 内容，并触发大纲刷新。
     *
     * @param content - 当前 Markdown 文本。
     * @returns void
     */
    public setContent(content: string): void {
        if (this.content === content) {
            return;
        }

        this.content = content;
        this.scheduleRender();
    }

    /**
     * 释放大纲管理器占用的资源。
     *
     * @returns void
     */
    public destroy(): void {
        if (this.renderFrame !== null) {
            window.cancelAnimationFrame(this.renderFrame);
            this.renderFrame = null;
        }
    }

    /**
     * 挂载布局容器并把编辑器宿主节点移动到新的布局中。
     *
     * @returns void
     */
    private mountLayout(): void {
        const existingRoot = document.getElementById(OUTLINE_ROOT_ID);
        if (existingRoot) {
            existingRoot.remove();
        }

        this.editorShell.appendChild(this.editorHost);
        this.root.appendChild(this.editorShell);
        this.root.appendChild(this.divider);
        this.root.appendChild(this.outlinePane);

        this.outlinePane.appendChild(this.outlineHeader);
        this.outlinePane.appendChild(this.outlineTree);
        this.outlinePane.appendChild(this.emptyState);

        document.body.insertBefore(this.root, document.body.firstChild);
    }

    /**
     * 注入右侧大纲所需的样式。
     *
     * @returns void
     */
    private ensureStyles(): void {
        if (document.getElementById(OUTLINE_STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = OUTLINE_STYLE_ID;
        style.textContent = `
body {
    display: flex;
    width: 100vw;
    height: 100vh;
}

#${OUTLINE_ROOT_ID} {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    overflow: hidden;
}

#${OUTLINE_EDITOR_SHELL_ID} {
    position: relative;
    flex: 1 1 auto;
    min-width: 260px;
    height: 100%;
    overflow: hidden;
}

#editor {
    width: 100%;
    height: 100%;
}

#${OUTLINE_DIVIDER_ID} {
    flex: 0 0 ${OUTLINE_DIVIDER_WIDTH}px;
    width: ${OUTLINE_DIVIDER_WIDTH}px;
    cursor: col-resize;
    position: relative;
    background: transparent;
}

#${OUTLINE_DIVIDER_ID}::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 2px;
    transform: translateX(-1px);
    border-radius: 999px;
    background: var(--vscode-panel-border, rgba(127, 127, 127, 0.45));
    opacity: 0.8;
}

#${OUTLINE_PANEL_ID} {
    flex: 0 0 var(--livewritemd-outline-width, ${DEFAULT_OUTLINE_WIDTH}px);
    width: var(--livewritemd-outline-width, ${DEFAULT_OUTLINE_WIDTH}px);
    min-width: ${MIN_OUTLINE_WIDTH}px;
    max-width: min(${MAX_OUTLINE_WIDTH}px, 45vw);
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e));
    color: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground, #d4d4d4));
    border-left: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.25));
    box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.02);
}

#${OUTLINE_PANEL_ID} .livewritemd-outline-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 14px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.2));
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground, var(--vscode-editor-foreground, #d4d4d4));
}

#${OUTLINE_PANEL_ID} .livewritemd-outline-header strong {
    font-size: 12px;
    letter-spacing: 0.08em;
}

#${OUTLINE_TREE_ID} {
    flex: 1 1 auto;
    overflow: auto;
    padding: 10px 8px 14px;
}

#${OUTLINE_EMPTY_ID} {
    display: none;
    flex: 1 1 auto;
    align-items: center;
    justify-content: center;
    padding: 20px 12px;
    color: var(--vscode-descriptionForeground, rgba(127, 127, 127, 0.8));
    text-align: center;
    font-size: 12px;
    line-height: 1.6;
}

#${OUTLINE_PANEL_ID}.is-empty #${OUTLINE_TREE_ID} {
    display: none;
}

#${OUTLINE_PANEL_ID}.is-empty #${OUTLINE_EMPTY_ID} {
    display: flex;
}

.livewritemd-outline-node {
    position: relative;
    margin: 0;
    padding: 0;
}

.livewritemd-outline-row {
    position: relative;
    z-index: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 28px;
    padding: 2px 8px;
    border-radius: 6px;
    color: inherit;
    background: transparent;
    transition: background-color 120ms ease, color 120ms ease;
}

.livewritemd-outline-node + .livewritemd-outline-node > .livewritemd-outline-row,
.livewritemd-outline-children > .livewritemd-outline-node + .livewritemd-outline-node > .livewritemd-outline-row {
    overflow: visible;
}

.livewritemd-outline-node + .livewritemd-outline-node::before,
.livewritemd-outline-children > .livewritemd-outline-node + .livewritemd-outline-node::before {
    content: '';
    position: absolute;
    top: 0;
    left: 8px;
    right: 8px;
    height: 1px;
    background: rgba(255, 255, 255, 0.09);
    pointer-events: none;
    z-index: 1;
}

.livewritemd-outline-row:hover {
    background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.12));
}

.livewritemd-outline-toggle {
    flex: 0 0 18px;
    width: 18px;
    height: 18px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 11px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0.85;
}

.livewritemd-outline-toggle:hover {
    background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.12));
}

.livewritemd-outline-toggle.is-spacer {
    visibility: hidden;
}

.livewritemd-outline-title {
    flex: 1 1 auto;
    min-width: 0;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0;
    font: inherit;
}

.livewritemd-outline-title:hover {
    color: var(--vscode-textLink-foreground, var(--vscode-focusBorder, #007acc));
}

.livewritemd-outline-node[data-level='1'] .livewritemd-outline-title {
    font-weight: 700;
}

.livewritemd-outline-node[data-level='2'] .livewritemd-outline-title {
    font-weight: 600;
}

.livewritemd-outline-node[data-level='3'] .livewritemd-outline-title {
    opacity: 0.94;
}

.livewritemd-outline-node[data-level='4'] .livewritemd-outline-title,
.livewritemd-outline-node[data-level='5'] .livewritemd-outline-title,
.livewritemd-outline-node[data-level='6'] .livewritemd-outline-title {
    opacity: 0.82;
}

.livewritemd-outline-children {
    margin: 0;
    padding: 0;
}

.livewritemd-outline-node.is-collapsed > .livewritemd-outline-children {
    display: none;
}

body.livewritemd-outline-resizing {
    cursor: col-resize;
    user-select: none;
}
        `;
        document.head.appendChild(style);
    }

    /**
     * 从持久化状态中恢复大纲宽度和折叠状态。
     *
     * @returns void
     */
    private restorePersistedState(): void {
        const persisted = readOutlineState(this.getState());
        if (!persisted) {
            return;
        }

        this.width = persisted.width;
        this.collapsedKeys = new Set(persisted.collapsedKeys);
    }

    /**
     * 安装分隔条拖拽逻辑。
     *
     * @returns void
     */
    private installDividerDragging(): void {
        this.divider.addEventListener('pointerdown', (event: PointerEvent) => {
            if (event.button !== 0) {
                return;
            }

            event.preventDefault();
            this.isDragging = true;
            this.dragStartX = event.clientX;
            this.dragStartWidth = this.width;
            document.body.classList.add('livewritemd-outline-resizing');

            const handleMove = (moveEvent: PointerEvent): void => {
                if (!this.isDragging) {
                    return;
                }

                const delta = this.dragStartX - moveEvent.clientX;
                const nextWidth = clampOutlineWidth(this.dragStartWidth + delta);
                this.applyWidth(nextWidth, true);
            };

            const handleUp = (): void => {
                if (!this.isDragging) {
                    return;
                }

                this.isDragging = false;
                document.body.classList.remove('livewritemd-outline-resizing');
                window.removeEventListener('pointermove', handleMove);
                window.removeEventListener('pointerup', handleUp);
                window.removeEventListener('pointercancel', handleUp);
                this.persistState();
            };

            window.addEventListener('pointermove', handleMove);
            window.addEventListener('pointerup', handleUp);
            window.addEventListener('pointercancel', handleUp);
        });
    }

    /**
     * 触发布局宽度更新，并可选择立即持久化。
     *
     * @param width - 新的大纲宽度。
     * @param shouldPersist - 是否同步保存到 Webview 状态。
     * @returns void
     */
    private applyWidth(width: number, shouldPersist: boolean): void {
        this.width = clampOutlineWidth(width);
        this.outlinePane.style.setProperty('--livewritemd-outline-width', `${this.width}px`);
        this.outlinePane.style.flexBasis = `${this.width}px`;
        this.outlinePane.style.width = `${this.width}px`;

        if (shouldPersist) {
            this.persistState();
        }
    }

    /**
     * 计划一次大纲重渲染，避免频繁重复计算。
     *
     * @returns void
     */
    private scheduleRender(): void {
        if (this.renderFrame !== null) {
            window.cancelAnimationFrame(this.renderFrame);
        }

        this.renderFrame = window.requestAnimationFrame(() => {
            this.renderFrame = null;
            this.renderOutline();
        });
    }

    /**
     * 根据当前内容渲染大纲树。
     *
     * @returns void
     */
    private renderOutline(): void {
        this.outlineNodes = parseMarkdownOutline(this.content);
        const scrollTop = this.outlineTree.scrollTop;

        const presentKeys = new Set<string>();
        const collectKeys = (nodes: ParsedOutlineNode[]): void => {
            for (const node of nodes) {
                presentKeys.add(node.key);
                collectKeys(node.children);
            }
        };
        collectKeys(this.outlineNodes);

        const nextCollapsedKeys = new Set<string>();
        for (const key of this.collapsedKeys) {
            if (presentKeys.has(key)) {
                nextCollapsedKeys.add(key);
            }
        }
        this.collapsedKeys = nextCollapsedKeys;

        this.outlineTree.innerHTML = '';
        if (this.outlineNodes.length === 0) {
            this.outlinePane.classList.add('is-empty');
            this.persistState();
            return;
        }

        this.outlinePane.classList.remove('is-empty');
        const fragment = document.createDocumentFragment();
        for (const node of this.outlineNodes) {
            fragment.appendChild(this.renderNode(node, 0));
        }
        this.outlineTree.appendChild(fragment);
        this.outlineTree.scrollTop = scrollTop;
        this.persistState();
    }

    /**
     * 渲染单个标题节点及其子树。
     *
     * @param node - 当前标题节点。
     * @param depth - 当前节点所在的树深度。
     * @returns 渲染后的 DOM 节点。
     */
    private renderNode(node: ParsedOutlineNode, depth: number): HTMLDivElement {
        const container = document.createElement('div');
        container.className = 'livewritemd-outline-node';
        container.dataset.level = String(node.level);
        container.style.paddingLeft = `${depth * 12}px`;

        if (this.collapsedKeys.has(node.key)) {
            container.classList.add('is-collapsed');
            node.collapsed = true;
        } else {
            node.collapsed = false;
        }

        const row = document.createElement('div');
        row.className = 'livewritemd-outline-row';

        const toggleButton = document.createElement('button');
        toggleButton.type = 'button';
        toggleButton.className = 'livewritemd-outline-toggle';
        toggleButton.textContent = node.hasChildren ? (node.collapsed ? '+' : '-') : '';
        toggleButton.setAttribute('aria-label', node.hasChildren ? 'Toggle section' : 'Section');
        toggleButton.setAttribute('aria-expanded', String(!node.collapsed));
        if (!node.hasChildren) {
            toggleButton.classList.add('is-spacer');
            toggleButton.disabled = true;
        }
        toggleButton.addEventListener('click', (event: MouseEvent) => {
            event.stopPropagation();
            if (!node.hasChildren) {
                return;
            }

            if (this.collapsedKeys.has(node.key)) {
                this.collapsedKeys.delete(node.key);
            } else {
                this.collapsedKeys.add(node.key);
            }
            this.scheduleRender();
        });

        const titleButton = document.createElement('button');
        titleButton.type = 'button';
        titleButton.className = 'livewritemd-outline-title';
        titleButton.textContent = node.text;
        titleButton.title = `Jump to line ${node.line}`;
        titleButton.addEventListener('click', () => {
            this.jumpToLine(node.line);
        });

        row.appendChild(toggleButton);
        row.appendChild(titleButton);
        container.appendChild(row);

        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'livewritemd-outline-children';
        if (node.collapsed) {
            childrenContainer.style.display = 'none';
        }

        for (const child of node.children) {
            childrenContainer.appendChild(this.renderNode(child, depth + 1));
        }

        container.appendChild(childrenContainer);
        return container;
    }

    /**
     * 将当前大纲状态写入 Webview 持久化存储。
     *
     * @returns void
     */
    private persistState(): void {
        persistOutlineState(this.setState, this.getState(), {
            width: this.width,
            collapsedKeys: [...this.collapsedKeys],
        });
    }
}
