/**
 * 导图内搜索条（todo.md 任务 15）。
 *
 * **视觉与交互复用 live 模式的搜索面板**：
 * - DOM 结构、类名与 CodeMirror 自带的搜索面板保持一致
 *   （`input[name="search"]`、`.cm-button`、Aa / ab| / .* 三枚 chip、
 *   替换行、右上角关闭按钮），因此可以直接吃同一套样式；
 * - 样式文本由 `searchPanelCss()` 生成 —— 和 live 的 `searchPanelTheme`
 *   来自同一份 `searchPanelStyleSpec`，改一处两边同步；
 * - 匹配语义直接复用 `@codemirror/search` 的 `SearchQuery`：区分大小写、
 *   正则、全词匹配、`$1` / `$&` 替换展开都与 live 完全一致，不再手写
 *   大小写不敏感的子串扫描。
 *
 * 与 live 的差异（导图没有文本光标，只有节点）：
 * - 「全选匹配」在导图里没有意义，面板里不出现这颗按钮；
 * - 导航序列是「落在导图节点里的匹配」：选中节点并把画布居中；
 *   不进导图的内容（引用块、HTML 等）仍计入文档总数；
 * - 替换是文档级的，一次回写 = 一步撤销。
 *
 * @module webview/mindmap/searchBar
 */

import { SearchQuery } from '@codemirror/search';
import { Text } from '@codemirror/state';
import {
    REPLACE_MODE_CLASS,
    searchPanelCss,
} from '../codemirror/extensions/searchPanel.js';

/** 搜索条与宿主的接线。 */
export interface MindmapSearchBarOptions {
    /** 读当前文档全文。 */
    getMarkdown: () => string;
    /** 文档级替换回写（新全文交给宿主，一步撤销 + 导图重建）。 */
    onEdit: (newFullText: string) => void;
    /** 匹配节点的 uid 序列（按文档顺序）变化时回调（高亮用）。 */
    onHighlight: (uids: string[], currentUid: string | null) => void;
    /** 跳转到某节点（宿主负责选中 + 画布居中）。 */
    onGotoUid: (uid: string) => void;
    /** 行号 → 导图节点 uid（0-based 行号；没有对应节点返回 null）。 */
    findUidAtLine: (line0: number) => string | null;
    /** 关闭时回调（清高亮等）。 */
    onClose: () => void;
}

/** 一处文档级匹配。 */
interface DocMatch {
    /** 匹配起点（文档偏移）。 */
    from: number;
    /** 匹配终点。 */
    to: number;
    /** 所在行（0-based）。 */
    line: number;
    /** 落在导图里的节点 uid；不进导图的部分为 null。 */
    uid: string | null;
}

/** SearchQuery 游标产出的一处匹配（正则模式下额外带 match 数组）。 */
interface SearchMatch {
    from: number;
    to: number;
    match?: readonly string[];
}

/** 共享样式只注入一次（多个导图实例 / 反复开关都不重复插 <style>）。 */
let searchCssInjected = false;

/** 把 live 搜索面板的样式注入 document（导图侧复用）。 */
function ensureSearchCss(): void {
    if (searchCssInjected) return;
    const style = document.createElement('style');
    style.id = 'lwm-map-search-css';
    style.textContent = searchPanelCss();
    document.head.appendChild(style);
    searchCssInjected = true;
}

export class MindmapSearchBar {
    private readonly container: HTMLElement;
    private readonly options: MindmapSearchBarOptions;
    /**
     * 外层定位带。
     *
     * 卡片本体必须放在一个「通栏、绝对定位、透明」的容器里，理由和 live
     * 面板一样：卡片的 `width: fit-content` 要按整条可用宽度算。若把
     * absolute 直接挂在卡片上，收缩宽度只能拿到 containing block 的一半
     * （left:50% 把可用宽度切掉了），控件会被莫名其妙地挤成两三行。
     */
    private hostEl: HTMLDivElement | null = null;
    private barEl: HTMLDivElement | null = null;
    private inputEl: HTMLInputElement | null = null;
    private replaceInputEl: HTMLInputElement | null = null;
    private countEl: HTMLSpanElement | null = null;

    // —— 三枚选项 chip 的状态（和 CM 面板的复选框一一对应）——
    private caseSensitive = false;
    private regexp = false;
    private wholeWord = false;
    /** 当前查询是否合法（空查询 / 非法正则都算不合法）。 */
    private queryValid = false;

    /** 当前文档级匹配序列。 */
    private matches: DocMatch[] = [];
    /** 落在导图节点里的匹配下标（matches 的下标，按文档顺序）。 */
    private nodeMatchIdxs: number[] = [];
    /** 当前导航位置（nodeMatchIdxs 的下标；-1 = 未开始）。 */
    private currentNav = -1;
    /** 替换游标（「替换」按钮从该偏移起找下一处）。 */
    private replaceCursor = 0;

    /**
     * 文档文本缓存。
     *
     * `SearchQuery.getCursor` 要一个 `Text`；每次输入都把全文 split 一遍
     * 太浪费，按 markdown 字符串身份缓存（文档变了才重建）。
     */
    private cachedMarkdown: string | null = null;
    private cachedText: Text | null = null;
    /** 每行起始偏移（行号换算用）。 */
    private cachedLineStarts: number[] = [];

    constructor(container: HTMLElement, options: MindmapSearchBarOptions) {
        this.container = container;
        this.options = options;
    }

    /** 搜索条是否开着（显隐由外层定位带控制，卡片本身始终是 flex）。 */
    get isOpen(): boolean {
        return this.hostEl !== null && this.hostEl.style.display !== 'none';
    }

    /**
     * 打开搜索条（已开则聚焦并全选输入）。
     *
     * @param withReplace - 是否同时展开替换行（Ctrl+H）
     */
    open(withReplace: boolean): void {
        ensureSearchCss();
        if (!this.barEl) this.buildBar();
        const bar = this.barEl!;
        // 查找 / 替换形态的切换完全靠这个类（与 live 面板同一套 CSS）
        bar.classList.toggle(REPLACE_MODE_CLASS, withReplace);
        this.hostEl!.style.display = 'block';
        const target = withReplace ? this.replaceInputEl : this.inputEl;
        target?.focus();
        target?.select();
        // 关闭期间文档可能变过：重开时按最新文档重算（保留替换游标）
        if (this.inputEl?.value) this.runSearch(true);
    }

    /** 关闭搜索条并清掉节点高亮。 */
    close(): void {
        if (this.hostEl) this.hostEl.style.display = 'none';
        this.barEl?.classList.remove(REPLACE_MODE_CLASS);
        this.matches = [];
        this.nodeMatchIdxs = [];
        this.currentNav = -1;
        this.queryValid = false;
        this.options.onClose();
    }

    /** 文档变化后（重建完成）刷新匹配与高亮；替换游标保留。 */
    refreshAfterDocumentChange(): void {
        if (!this.isOpen || !this.inputEl?.value) return;
        this.runSearch(true);
    }

    // ==================================================================
    // DOM：与 CodeMirror 搜索面板同构
    // ==================================================================

    /** 构建搜索条 DOM（查找行 + 替换行，结构与 CM 的 SearchPanel 一致）。 */
    private buildBar(): void {
        // 定位带：通栏、绝对定位、不吃鼠标事件（见 hostEl 字段注释）。
        // 挂 .cm-panels 类是为了原样吃到 live 面板外层的透明底色 / 8px 内边距，
        // 卡片到窗口上沿的距离和 live 里完全一致。
        const host = document.createElement('div');
        host.className = 'cm-panels cm-panels-top lwm-searchbar-host';
        host.style.display = 'none';

        // 外层同时挂 .cm-panel .cm-search：共享样式只认这两个类
        const bar = document.createElement('div');
        bar.className = 'cm-panel cm-search lwm-searchbar';
        bar.setAttribute('role', 'search');

        // —— 查找框 ——
        const input = document.createElement('input');
        input.className = 'cm-textfield';
        input.name = 'search';
        input.type = 'text';
        input.placeholder = '查找';
        input.setAttribute('aria-label', '查找');

        // —— 匹配计数（放在查找框后面，和 live 的 searchMatchCount 一致）——
        const count = document.createElement('span');
        count.className = 'cm-search-match-count';

        // —— 图标按钮：下一个 / 上一个（文字由 CSS 替换成 ↓ / ↑）——
        const nextBtn = mkButton('next', '下一个匹配', '下一个匹配');
        const prevBtn = mkButton('prev', '上一个匹配', '上一个匹配');

        // —— 三枚选项 chip：Aa / ab| / .* ——
        // 原生 checkbox 透明铺满 label，点击与键盘行为全部沿用原生；
        // label 里的文字被 CSS 的 font-size: 0 隐藏，但仍是无障碍名称。
        const caseField = mkCheckbox('case', this.caseSensitive);
        const caseLabel = mkChip(caseField, '区分大小写');
        const reField = mkCheckbox('re', this.regexp);
        const reLabel = mkChip(reField, '正则表达式');
        const wordField = mkCheckbox('word', this.wholeWord);
        const wordLabel = mkChip(wordField, '全词匹配');

        // —— 替换行（<br> 在替换形态下充当 100% 宽的换行占位）——
        const breakEl = document.createElement('br');
        const replaceInput = document.createElement('input');
        replaceInput.className = 'cm-textfield';
        replaceInput.name = 'replace';
        replaceInput.type = 'text';
        replaceInput.placeholder = '替换';
        replaceInput.setAttribute('aria-label', '替换');
        const replaceBtn = mkButton('replace', '替换当前匹配（文档级）', '替换');
        const replaceAllBtn = mkButton(
            'replaceAll',
            '全部替换（文档级，一步撤销）',
            '全部替换'
        );

        // —— 关闭按钮 ——
        const closeBtn = mkButton('close', '关闭', '×');
        closeBtn.setAttribute('aria-label', '关闭');

        bar.append(
            input,
            count,
            nextBtn,
            prevBtn,
            caseLabel,
            reLabel,
            wordLabel,
            breakEl,
            replaceInput,
            replaceBtn,
            replaceAllBtn,
            closeBtn
        );

        // —— 事件：输入即搜 ——
        input.addEventListener('input', () => this.runSearch(false));
        caseField.addEventListener('change', () => {
            this.caseSensitive = caseField.checked;
            this.runSearch(false);
        });
        reField.addEventListener('change', () => {
            this.regexp = reField.checked;
            this.runSearch(false);
        });
        wordField.addEventListener('change', () => {
            this.wholeWord = wordField.checked;
            this.runSearch(false);
        });

        // 查找框：Enter 跳转、Esc 关闭；面板内也要能切换查找 / 替换形态
        input.addEventListener('keydown', (event) => {
            this.handlePanelKey(event, () => this.navigate(event.shiftKey ? -1 : 1));
        });
        replaceInput.addEventListener('keydown', (event) => {
            this.handlePanelKey(event, () => this.replaceCurrent());
        });

        nextBtn.addEventListener('click', () => this.navigate(1));
        prevBtn.addEventListener('click', () => this.navigate(-1));
        closeBtn.addEventListener('click', () => this.close());
        replaceBtn.addEventListener('click', () => this.replaceCurrent());
        replaceAllBtn.addEventListener('click', () => this.replaceAll());

        // 按钮按下别让画布抢焦点（否则输入框失焦、Enter 行为丢失）
        bar.addEventListener('pointerdown', (event) => {
            if ((event.target as HTMLElement).tagName === 'BUTTON') event.preventDefault();
        });

        host.appendChild(bar);
        this.container.appendChild(host);
        this.hostEl = host;
        this.barEl = bar;
        this.inputEl = input;
        this.replaceInputEl = replaceInput;
        this.countEl = count;
    }

    /**
     * 面板输入框里的按键：Enter 执行、Esc 关闭、Ctrl+F/H 切换形态。
     *
     * 导图宿主的全局快捷键处理遇到 INPUT 目标会直接放行，所以这里
     * 必须自己兜住 Ctrl+F / Ctrl+H（和 live 面板的 searchPanelKeymap 一致）。
     */
    private handlePanelKey(event: KeyboardEvent, onEnter: () => void): void {
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
            const key = event.key.toLowerCase();
            if (key === 'f') {
                event.preventDefault();
                event.stopPropagation();
                this.open(false);
                return;
            }
            if (key === 'h') {
                event.preventDefault();
                event.stopPropagation();
                this.open(true);
                return;
            }
            // 与 live 的 searchKeyMap 对齐：Ctrl/Cmd+G 下一个，
            // Shift+Ctrl/Cmd+G 上一个（面板里 Ctrl+G 不做行内代码）
            if (key === 'g') {
                event.preventDefault();
                event.stopPropagation();
                this.navigate(event.shiftKey ? -1 : 1);
                return;
            }
        }
        if (event.key === 'F3') {
            // live 里 F3 / Shift+F3 是下一个 / 上一个（在替换框里也一样，
            // 不会触发替换）。所以这里直接导航，不走 onEnter。
            event.preventDefault();
            this.navigate(event.shiftKey ? -1 : 1);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            onEnter();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            this.close();
        }
    }

    // ==================================================================
    // 检索
    // ==================================================================

    /** 取当前文档对应的 Text（按字符串身份缓存）。 */
    private docText(markdown: string): Text {
        if (this.cachedMarkdown === markdown && this.cachedText) return this.cachedText;
        const lines = markdown.split('\n');
        this.cachedText = Text.of(lines);
        this.cachedMarkdown = markdown;
        // 每行起始偏移：行号换算用，和 Text 的分行完全一致（只按 \n 切）
        const starts: number[] = [0];
        for (let i = 0; i < markdown.length; i++) {
            if (markdown.charCodeAt(i) === 10) starts.push(i + 1);
        }
        this.cachedLineStarts = starts;
        return this.cachedText;
    }

    /**
     * 构造与 live 面板语义一致的查询。
     *
     * 空查询或非法正则返回 null（live 面板此时也是「没有结果」）。
     */
    private makeQuery(): SearchQuery | null {
        const search = this.inputEl?.value ?? '';
        if (!search) return null;
        const query = new SearchQuery({
            search,
            caseSensitive: this.caseSensitive,
            regexp: this.regexp,
            wholeWord: this.wholeWord,
            // 替换文本进 query 是为了让 getReplacement 能展开 $1 / $&，
            // 与 live 的 replaceNext / replaceAll 完全一致
            replace: this.replaceInputEl?.value ?? '',
        });
        return query.valid ? query : null;
    }

    /** 输入即搜：全文找匹配，映射到节点，刷新计数与高亮。 */
    private runSearch(keepReplaceCursor: boolean): void {
        const markdown = this.options.getMarkdown();
        const text = this.docText(markdown);
        const query = this.makeQuery();
        this.matches = [];
        this.nodeMatchIdxs = [];
        this.currentNav = -1;
        this.queryValid = query !== null;
        if (!keepReplaceCursor) this.replaceCursor = 0;

        if (query) {
            const cursor = query.getCursor(text);
            // 匹配按文档顺序产出；行号用递增指针换算，整体 O(行数+匹配数)
            let line = 0;
            const starts = this.cachedLineStarts;
            for (let item = cursor.next(); !item.done; item = cursor.next()) {
                const { from, to } = item.value;
                while (line + 1 < starts.length && starts[line + 1] <= from) line++;
                this.matches.push({ from, to, line, uid: null });
            }
            // 匹配 → 导图节点
            this.matches.forEach((match, index) => {
                match.uid = this.options.findUidAtLine(match.line);
                if (match.uid !== null) this.nodeMatchIdxs.push(index);
            });
        }
        this.updateCount();
        this.options.onHighlight(
            this.nodeMatchIdxs.map((i) => this.matches[i].uid as string),
            null
        );
    }

    /** 更新计数显示：「当前/总数」或「N 个结果」/「无结果」。 */
    private updateCount(): void {
        if (!this.countEl) return;
        if (!this.inputEl?.value) {
            this.countEl.textContent = '';
            this.countEl.classList.remove('cm-search-match-count-none');
            return;
        }
        // 非法查询（如写坏的正则）：live 面板此时不显示计数
        if (!this.queryValid) {
            this.countEl.textContent = '';
            this.countEl.classList.remove('cm-search-match-count-none');
            return;
        }
        const total = this.matches.length;
        if (total === 0) {
            this.countEl.textContent = '无结果';
            this.countEl.classList.add('cm-search-match-count-none');
            return;
        }
        this.countEl.classList.remove('cm-search-match-count-none');
        if (this.currentNav >= 0) {
            // 当前导航项在整篇文档匹配序列里的序号（1-based）
            const index = this.nodeMatchIdxs[this.currentNav] + 1;
            this.countEl.textContent = `${index}/${total}`;
        } else {
            this.countEl.textContent = `${total} 个结果`;
        }
    }

    /** 在节点内匹配间跳转：选中 + 画布居中。 */
    private navigate(dir: 1 | -1): void {
        if (this.nodeMatchIdxs.length === 0) return;
        if (this.currentNav < 0) {
            this.currentNav = dir > 0 ? 0 : this.nodeMatchIdxs.length - 1;
        } else {
            this.currentNav =
                (this.currentNav + dir + this.nodeMatchIdxs.length) %
                this.nodeMatchIdxs.length;
        }
        const match = this.matches[this.nodeMatchIdxs[this.currentNav]];
        const uid = match.uid as string;
        this.updateCount();
        this.options.onHighlight(
            this.nodeMatchIdxs.map((i) => this.matches[i].uid as string),
            uid
        );
        this.options.onGotoUid(uid);
    }

    // ==================================================================
    // 替换（文档级）
    // ==================================================================

    /**
     * 展开替换文本：$& / $1 / $$ 的语义直接复用 SearchQuery 内部实现。
     *
     * `getReplacement` 没有出现在 `@codemirror/search` 的公开类型里，
     * 但 CM 自己的 replaceNext / replaceAll 用的就是它；直接调用可以保证
     * 与 live 的替换结果逐字节一致（正则捕获组、$& 等都一样）。
     */
    private replacementFor(query: SearchQuery, match: SearchMatch): string {
        const internal = query as unknown as {
            getReplacement(result: SearchMatch): string;
        };
        if (typeof internal.getReplacement === 'function') {
            return internal.getReplacement(match);
        }
        // 兜底（未来版本移除该方法时）：按字面量替换
        return this.replaceInputEl?.value ?? '';
    }

    /** 替换当前匹配（从替换游标起找下一处，替换后游标推进）。 */
    private replaceCurrent(): void {
        const query = this.makeQuery();
        if (!query) return;
        const markdown = this.options.getMarkdown();
        const text = this.docText(markdown);
        // 从游标往后找；找到文末再绕回开头（与 live 的「查找下一个」一致）
        let item = query
            .getCursor(text, Math.min(this.replaceCursor, markdown.length))
            .next();
        if (item.done && this.replaceCursor > 0) {
            item = query.getCursor(text, 0).next();
        }
        if (item.done) return;
        const match = item.value;
        const replacement = this.replacementFor(query, match);
        // 游标推到替换文本之后：下一次「替换」不会原地重复替换
        this.replaceCursor = match.from + replacement.length;
        this.options.onEdit(
            markdown.slice(0, match.from) + replacement + markdown.slice(match.to)
        );
    }

    /** 全部替换（整个文档一次回写 = 一步撤销）。 */
    private replaceAll(): void {
        const query = this.makeQuery();
        if (!query) return;
        const markdown = this.options.getMarkdown();
        const text = this.docText(markdown);
        const parts: string[] = [];
        let cursorEnd = 0;
        let replaced = 0;
        const cursor = query.getCursor(text);
        for (let item = cursor.next(); !item.done; item = cursor.next()) {
            const match = item.value;
            const replacement = this.replacementFor(query, match);
            const original = markdown.slice(match.from, match.to);
            if (replacement === original) continue;
            parts.push(markdown.slice(cursorEnd, match.from), replacement);
            cursorEnd = match.to;
            replaced += 1;
        }
        if (replaced === 0) return;
        parts.push(markdown.slice(cursorEnd));
        this.options.onEdit(parts.join(''));
    }
}

/** 造一个搜索条按钮（类名与 CM 面板一致，按钮文字由共享 CSS 接管）。 */
function mkButton(name: string, title: string, label: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-button';
    btn.name = name;
    btn.title = title;
    btn.textContent = label;
    return btn;
}

/** 造一枚选项复选框（透明铺满 label，原生行为全部保留）。 */
function mkCheckbox(name: string, checked: boolean): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = name;
    input.checked = checked;
    return input;
}

/** 造一枚 chip：label 包住原生 checkbox + 无障碍文字。 */
function mkChip(input: HTMLInputElement, label: string): HTMLLabelElement {
    const el = document.createElement('label');
    el.appendChild(input);
    el.appendChild(document.createTextNode(label));
    return el;
}
