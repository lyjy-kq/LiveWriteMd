/**
 * MindMapApp 协作模块（从 mindmapApp.ts 拆出）：浮动工具条：单节点工具条 / 多选操作条 / 添加-拆分-删除三级菜单 / 定位。
 *
 * 全部是原 MindMapApp 方法，this 换成第一参数 app；跨模块调用走 app 上的薄包装方法。
 *
 * @module webview/mindmap/app/appToolbar
 */

import type { MindMapApp } from '../mindmapApp.js';
import { addNode } from '.././edit/add.js';
import type { NewNodeSpec } from '.././edit/add.js';
import { isMediaKind } from '.././edit/rename.js';
import { countSubtreeNodes } from '.././edit/shared.js';


/**
 * 创建浮动工具条（＋子节点 / ＋兄弟 / 删除）。
 *
 * 添加类按钮的行为分两层：
 * - 普通点击：添加一个普通文本节点（列表里则是同级列表项）；
 * - 悬浮：展开二级菜单，可选标题（三级菜单 H1-H4）/ 表格（三级菜单
 *   4×4 方格，点哪个位置就插多大的表）/ 代码块 / 公式 / mermaid / 列表项。
 */
export function createToolbar(app: MindMapApp) : void {
    if (app.toolbarEl) return;
    const bar = document.createElement('div');
    bar.className = 'lwm-toolbar';
    bar.style.display = 'none';

    bar.appendChild(app.createAddMenu('child', '＋子节点'));
    bar.appendChild(app.createAddMenu('sibling', '＋兄弟'));
    // 「粘贴」：剪贴板文本解析成子节点挂到当前节点下（Ctrl+V）。
    // meta / 媒体节点没有子节点的概念，showToolbar 里会禁用它
    const pasteButton = document.createElement('button');
    pasteButton.type = 'button';
    pasteButton.dataset.act = 'paste';
    pasteButton.textContent = '粘贴';
    pasteButton.title = '把剪贴板内容解析成节点，挂到当前节点下面（Ctrl+V）';
    bar.appendChild(pasteButton);
    bar.appendChild(app.createDeleteMenu());
    // 「拆分」：只在编辑态选中了文字时出现（见 refreshSplitButton）。
    // 主按钮 = 拆到子节点；悬停二级菜单可选拆到兄弟节点。
    bar.appendChild(app.createSplitMenu());
    // 工具条上的按下事件不要漏给画布（避免触发平移/选中）。
    // 还要 preventDefault 挡住默认的焦点转移：点按钮时编辑中的节点
    // 不该失焦（失焦会立刻 blur 提交会话，「拆分到子节点」这类
    // 依赖选区的操作就会被打断；按钮在 mousedown 时被 hide 还会
    // 连 click 都发不出来）。
    bar.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        event.preventDefault();
    });
    bar.addEventListener('mousedown', (event) => event.preventDefault());
    bar.addEventListener('click', (event) => {
        event.stopPropagation();
        const target = event.target as HTMLElement;
        // 先认菜单项（data-add）：它们不在顶层面板按钮里面，
        // closest 不会误认成「点击了顶层按钮」
        const addItem = target.closest<HTMLElement>('[data-add]');
        if (addItem) {
            const menu = addItem.closest<HTMLElement>('.lwm-tool-menu');
            const placement =
                menu?.dataset.menu === 'sibling' ? 'sibling' : 'child';
            app.addFromMenu(placement, addItem);
            return;
        }
        // 删除的二级菜单项（只删自己 / 只删子节点 / 连同子树）
        const delItem = target.closest<HTMLElement>('[data-del]');
        if (delItem) {
            // class 禁用的项（self：含非标题子节点的标题）：点了不执行
            if (delItem.classList.contains('lwm-item-disabled')) return;
            app.deleteFromMenu(delItem);
            return;
        }
        // 拆分的二级菜单项（拆到子节点 / 拆到兄弟节点）
        const splitItem = target.closest<HTMLElement>('[data-split]');
        if (splitItem) {
            if (app.splitCapture) {
                app.splitSelection(
                    app.splitCapture,
                    splitItem.dataset.split === 'sibling' ? 'sibling' : 'child'
                );
            }
            return;
        }
        const button = target.closest<HTMLButtonElement>('button[data-act]');
        if (!button) return;
        if (button.dataset.act === 'split') {
            // 拆分不依赖 selectedUid（编辑会话可能已被失焦提交掉），
            // 全靠选区变化时备好的快照；主按钮 = 拆到子节点
            if (app.splitCapture) {
                app.splitSelection(app.splitCapture, 'child');
            }
            return;
        }
        if (button.dataset.act === 'paste') {
            // 粘贴是异步的（要读系统剪贴板），且不依赖编辑会话
            void app.pasteFromClipboard();
            return;
        }
        if (!app.selectedUid) return;
        switch (button.dataset.act) {
            case 'child':
                // 普通点击 = 普通文本节点
                app.addQuick('child');
                break;
            case 'sibling':
                app.addQuick('sibling');
                break;
            case 'delete':
                app.deleteSelected();
                break;
            default:
                break;
        }
    });
    // 表格方格：悬停多少行多少列就高亮到哪（点击插入对应尺寸）
    bar.addEventListener('mouseover', (event) => {
        const cell = (event.target as HTMLElement).closest<HTMLElement>(
            '.lwm-table-grid button'
        );
        if (!cell) return;
        const rows = Number(cell.dataset.rows) || 1;
        const cols = Number(cell.dataset.cols) || 1;
        cell.parentElement
            ?.querySelectorAll<HTMLElement>('button[data-rows]')
            .forEach((item) => {
                const r = Number(item.dataset.rows) || 0;
                const c = Number(item.dataset.cols) || 0;
                item.classList.toggle('lwm-table-hit', r <= rows && c <= cols);
            });
        const hint = cell.parentElement?.parentElement?.querySelector(
            '.lwm-table-hint'
        );
        if (hint) hint.textContent = `${rows} 行 × ${cols} 列`;
    });
    app.container.appendChild(bar);
    app.toolbarEl = bar;
}


/**
 * 多选操作条（顶部居中，独立于单节点工具条）。
 *
 * 只放一个按钮：删除 N 项。第一次点击变红并改成「确认删除 N 项」，
 * 4 秒内再点一次才真正删除 —— 和多选常常一次十几个节点，误删代价
 * 比单节点大得多，和单节点删除保持同一套两段式确认。
 */
export function createMultiToolbar(app: MindMapApp) : void {
    if (app.multiBarEl) return;
    const bar = document.createElement('div');
    bar.className = 'lwm-toolbar lwm-multi-toolbar';
    bar.style.display = 'none';
    // 复制 / 剪切 / 粘贴 + 删除。剪贴板三件套作用在整个多选集合上；
    // 粘贴的落点是最早选中的那个节点（pasteFromClipboard 的口径）
    const addButton = (act: string, label: string, title: string): void => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.act = act;
        button.textContent = label;
        button.title = title;
        bar.appendChild(button);
    };
    addButton('multi-copy', '复制', '把选中子树以 Markdown 源码复制到剪贴板（Ctrl+C）');
    addButton('multi-cut', '剪切', '复制选中子树并删除（Ctrl+X）');
    addButton('multi-paste', '粘贴', '把剪贴板内容解析成节点，挂到最早选中的节点下面（Ctrl+V）');
    addButton('multi-delete', '删除 0 项', '删除选中的所有节点（再次点击确认）');
    // 操作条自己的事件不能漏给画布（否则点击会被当成空白点击 → 清空多选）
    bar.addEventListener('pointerdown', (event) => event.stopPropagation());
    bar.addEventListener('click', (event) => {
        event.stopPropagation();
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
        if (!button) return;
        switch (button.dataset.act) {
            case 'multi-copy':
                void app.copySelection();
                break;
            case 'multi-cut':
                void app.cutSelection();
                break;
            case 'multi-paste':
                void app.pasteFromClipboard();
                break;
            default:
                app.deleteSelected();
                break;
        }
    });
    app.container.appendChild(bar);
    app.multiBarEl = bar;
}


/** 同步多选操作条的可见性 / 数量 / 待确认态。 */
export function updateMultiBar(app: MindMapApp) : void {
    const bar = app.multiBarEl;
    if (!bar) return;
    const count = app.multiSelected.size;
    if (count === 0) {
        bar.style.display = 'none';
        app.pendingDeleteMulti = false;
        return;
    }
    const button = bar.querySelector<HTMLButtonElement>('button[data-act="multi-delete"]');
    if (button) {
        button.textContent = app.pendingDeleteMulti
            ? `确认删除 ${count} 项`
            : `删除 ${count} 项`;
        button.classList.toggle('lwm-danger', app.pendingDeleteMulti);
    }
    bar.style.display = 'flex';
    app.positionMultiBar();
}


/**
 * 多选操作条定位到「最下面的选中节点」的下方。
 *
 * 多选经常跨越好几层（框选一列 / Ctrl 点散点），固定在顶部会离
 * 操作对象很远；贴到最下面那个节点的下缘，和单节点工具条
 * 「跟着节点走」的体感一致。
 */
export function positionMultiBar(app: MindMapApp) : void {
    const bar = app.multiBarEl;
    if (!bar || bar.style.display === 'none' || app.multiSelected.size === 0) {
        return;
    }
    let bottom = -Infinity;
    let left = 0;
    for (const uid of app.multiSelected) {
        const rect = app.canvas.getNodeRect(uid);
        if (!rect) continue;
        if (rect.bottom > bottom) {
            bottom = rect.bottom;
            left = rect.left;
        }
    }
    if (bottom === -Infinity) return;
    bar.style.left = `${left}px`;
    bar.style.top = `${bottom + 6}px`;
}


/** 造一个「添加类」按钮 + 悬浮二级菜单。 */
export function createAddMenu(app: MindMapApp, act: 'child' | 'sibling', label: string) : HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'lwm-tool-menu';
    wrap.dataset.menu = act;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.act = act;
    button.textContent = label;
    button.title = '点击添加普通文本节点；悬停选择其它类型';
    wrap.appendChild(button);

    const popup = document.createElement('div');
    popup.className = 'lwm-tool-popup';
    const addItem = (text: string, dataset: Record<string, string>): void => {
        const item = document.createElement('button');
        item.type = 'button';
        item.textContent = text;
        item.dataset.add = dataset.add;
        for (const [key, value] of Object.entries(dataset)) {
            if (key !== 'add') item.dataset[key] = value;
        }
        popup.appendChild(item);
    };
    addItem('普通文本', { add: 'text' });

    // —— 标题 ▸ H1-H4（三级菜单）——
    const headingItem = document.createElement('div');
    headingItem.className = 'lwm-tool-item';
    const headingLabel = document.createElement('div');
    headingLabel.className = 'lwm-tool-label';
    headingLabel.textContent = '标题';
    headingItem.appendChild(headingLabel);
    const headingPopup = document.createElement('div');
    headingPopup.className = 'lwm-tool-popup lwm-tool-popup-right';
    for (const level of [1, 2, 3, 4]) {
        const item = document.createElement('button');
        item.type = 'button';
        item.textContent = `${'#'.repeat(level)} ${level} 级标题`;
        item.dataset.add = 'heading';
        item.dataset.level = String(level);
        headingPopup.appendChild(item);
    }
    headingItem.appendChild(headingPopup);
    popup.appendChild(headingItem);

    // —— 表格 ▸ 4×4 方格（三级菜单）——
    const tableItem = document.createElement('div');
    tableItem.className = 'lwm-tool-item';
    const tableLabel = document.createElement('div');
    tableLabel.className = 'lwm-tool-label';
    tableLabel.textContent = '表格';
    tableItem.appendChild(tableLabel);
    const tablePopup = document.createElement('div');
    tablePopup.className = 'lwm-tool-popup lwm-tool-popup-right';
    const grid = document.createElement('div');
    grid.className = 'lwm-table-grid';
    for (let rows = 1; rows <= 4; rows += 1) {
        for (let cols = 1; cols <= 4; cols += 1) {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.dataset.add = 'table';
            cell.dataset.rows = String(rows);
            cell.dataset.cols = String(cols);
            cell.title = `${rows} 行 × ${cols} 列`;
            grid.appendChild(cell);
        }
    }
    tablePopup.appendChild(grid);
    const tableHint = document.createElement('div');
    tableHint.className = 'lwm-table-hint';
    tableHint.textContent = '1 行 × 1 列';
    tablePopup.appendChild(tableHint);
    tableItem.appendChild(tablePopup);
    popup.appendChild(tableItem);

    addItem('代码块', { add: 'code' });
    addItem('公式', { add: 'math' });
    addItem('mermaid 图', { add: 'mermaid' });
    addItem('列表项', { add: 'list' });
    wrap.appendChild(popup);
    return wrap;
}


/**
 * 造「删除」按钮 + 悬浮二级菜单。
 *
 * 普通点击保留原来的默认行为（删整棵子树，有子项时先变红要二次确认），
 * 悬停展开的二级菜单提供导图里另外两种常见删法：
 * - 只删除自己：子节点整体上移一级，接替当前节点的位置；
 * - 只删除子节点：保留当前节点，清空它下面的分支。
 *
 * 实现方式与「＋子节点 / ＋兄弟」完全一致（`.lwm-tool-menu`），
 * 显示/隐藏交给 CSS 的 :hover，不额外维护开关状态。
 */
/**
 * 「拆分」按钮 + 悬浮二级菜单（拆到子节点 / 拆到兄弟节点）。
 *
 * 主按钮点击 = 拆到子节点（最常用）。整个菜单只在编辑态有文字
 * 选区时可见（refreshSplitButton 控制），因为拆分作用的对象是
 * 选区而不是节点本身。
 */
export function createSplitMenu(app: MindMapApp) : HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'lwm-tool-menu';
    wrap.dataset.menu = 'split';
    wrap.style.display = 'none';
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.act = 'split';
    button.textContent = '拆分';
    button.title = '把选中的文字剪到一个新的子节点里；悬停可选拆到兄弟节点';
    wrap.appendChild(button);

    const popup = document.createElement('div');
    popup.className = 'lwm-tool-popup';
    const addItem = (act: 'child' | 'sibling', text: string, title: string): void => {
        const item = document.createElement('button');
        item.type = 'button';
        item.dataset.split = act;
        item.textContent = text;
        item.title = title;
        popup.appendChild(item);
    };
    addItem('child', '拆分到子节点', '选中文字剪成一个新子节点');
    addItem('sibling', '拆分到兄弟节点', '选中文字剪成当前节点后面的同级节点');
    wrap.appendChild(popup);
    return wrap;
}


export function createDeleteMenu(app: MindMapApp) : HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'lwm-tool-menu';
    wrap.dataset.menu = 'delete';
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.act = 'delete';
    button.textContent = '删除';
    button.title = '点击删除节点及子节点；悬停选择其它删除方式';
    wrap.appendChild(button);

    const popup = document.createElement('div');
    popup.className = 'lwm-tool-popup';
    const addItem = (
        act: 'subtree' | 'self' | 'children',
        text: string,
        title: string
    ): void => {
        const item = document.createElement('button');
        item.type = 'button';
        item.dataset.del = act;
        item.textContent = text;
        item.title = title;
        popup.appendChild(item);
    };
    // 文案里的数量由 showToolbar 动态补（「（共 N 项）」）
    addItem('subtree', '删除节点及子节点', '连同整棵子树一起删除（与点击「删除」相同）');
    addItem(
        'self',
        '只删除自己',
        '保留子节点，让它们接替当前节点的位置'
    );
    addItem('children', '只删除子节点', '保留当前节点，删掉它下面的所有分支');
    wrap.appendChild(popup);
    return wrap;
}


/** 普通点击「＋子节点 / ＋兄弟」：插入普通文本节点。 */
export function addQuick(app: MindMapApp, placement: 'child' | 'sibling') : void {
    app.insertNodeSpec(placement, { type: 'text' });
}


/** 悬浮菜单项：把 data-* 解析成 NewNodeSpec 后插入。 */
export function addFromMenu(app: MindMapApp, placement: 'child' | 'sibling', item: HTMLElement) : void {
    const add = item.dataset.add;
    let spec: NewNodeSpec | null = null;
    switch (add) {
        case 'text':
            spec = { type: 'text' };
            break;
        case 'heading':
            spec = { type: 'heading', level: Number(item.dataset.level) || 1 };
            break;
        case 'list':
            spec = { type: 'list' };
            break;
        case 'code':
            spec = { type: 'code' };
            break;
        case 'math':
            spec = { type: 'math' };
            break;
        case 'mermaid':
            spec = { type: 'mermaid' };
            break;
        case 'table':
            spec = {
                type: 'table',
                rows: Number(item.dataset.rows) || 1,
                cols: Number(item.dataset.cols) || 1,
            };
            break;
        default:
            return;
    }
    app.insertNodeSpec(placement, spec);
}


/** 统一插入入口：结束编辑 → addNode → commit（新节点自动进入编辑）。 */
export function insertNodeSpec(app: MindMapApp, placement: 'child' | 'sibling', spec: NewNodeSpec) : void {
    if (!app.selectedUid || !app.currentTree) return;
    app.endEditBeforeStructuralOp();
    app.commit(
        addNode(
            app.markdown,
            app.currentTree,
            app.selectedUid,
            placement,
            spec
        )
    );
}


/** 显示工具条并按节点种类禁用不适用的按钮。 */
export function showToolbar(app: MindMapApp, uid: string) : void {
    if (!app.toolbarEl) return;
    const node = app.canvas.getNode(uid);
    if (!node) {
        app.toolbarEl.style.display = 'none';
        return;
    }
    const kind = node.kind;
    const media = isMediaKind(kind);
    const setDisabled = (act: string, disabled: boolean): void => {
        const button = app.toolbarEl?.querySelector<HTMLButtonElement>(
            `button[data-act="${act}"]`
        );
        if (button) button.disabled = disabled;
    };
    // 禁用时整个悬浮菜单一起藏起来（按钮 disabled 但 hover 菜单还能弹会误导）
    const setMenuDisabled = (act: string, disabled: boolean): void => {
        const menu = app.toolbarEl?.querySelector<HTMLElement>(
            `.lwm-tool-menu[data-menu="${act}"]`
        );
        if (menu) menu.classList.toggle('lwm-menu-disabled', disabled);
    };
    // 段落（文本叶子）也能加子节点：addNode 会先把它升级成列表项。
    // 媒体 / meta 仍是真叶子（代码块、表格里塞不进子节点）。
    const childDisabled = kind === 'meta' || media;
    // 段落 / 媒体现在支持加兄弟（普通文本节点），root 与元数据仍不行
    const siblingDisabled = kind === 'root' || kind === 'meta';
    setDisabled('child', childDisabled);
    setDisabled('sibling', siblingDisabled);
    // 粘贴 = 加子节点的一种，禁用口径与「＋子节点」一致（root 除外：
    // root 可以往文末/第一个标题前粘，而 addChild 走的是同一条 root 分支）
    setDisabled('paste', kind === 'meta' || media);
    setDisabled('delete', kind === 'root');
    setMenuDisabled('child', childDisabled);
    setMenuDisabled('sibling', siblingDisabled);
    // 根节点不能删：整个删除菜单（含悬停展开）一起禁用
    setMenuDisabled('delete', kind === 'root');

    // 删除二级菜单：文案带子项数量，「只删除子节点」在没有分支时禁用
    const treeNode =
        app.currentTree && app.selectedUid
            ? findTreeNodeByUid(app.currentTree, app.selectedUid)
            : null;
    const childCount = treeNode ? countSubtreeNodes(treeNode.node) : 0;
    const deleteMenu = app.toolbarEl.querySelector<HTMLElement>(
        '.lwm-tool-menu[data-menu="delete"]'
    );
    const subtreeItem = deleteMenu?.querySelector<HTMLButtonElement>(
        '[data-del="subtree"]'
    );
    if (subtreeItem) {
        subtreeItem.textContent =
            childCount > 0 ? `删除节点及子节点` : '删除节点';
    }
    const childrenItem = deleteMenu?.querySelector<HTMLButtonElement>(
        '[data-del="children"]'
    );
    if (childrenItem) {
        childrenItem.disabled = childCount === 0;
        childrenItem.title =
            childCount === 0
                ? '当前节点没有子节点'
                : '保留当前节点，删掉它下面的所有分支';
    }
    // 「只删除自己」的前提是子节点能整体上移一级。标题的子标题可以
    //（## 升 #，天然还是根的子节点），但**非标题**子节点不行：
    // Markdown 没有「节结束」标记，文档中部的顶层段落/列表/表格必然
    // 归入前一个标题的章节 —— 提升出去就挂到了上一个兄弟标题下面
    //（看着像「删了 B，内容全跑进 A」）。这种标题禁用该项并说明原因。
    // 注意用 class 而不是 disabled 属性：禁用按钮不派发鼠标事件，
    // title 里的原因提示会永远看不到。
    const selfItem = deleteMenu?.querySelector<HTMLButtonElement>(
        '[data-del="self"]'
    );
    if (selfItem) {
        const hasNonHeadingChild =
            treeNode?.node.data._kind === 'heading' &&
            treeNode.node.children.some(
                (child) => child.data._kind !== 'heading'
            );
        selfItem.classList.toggle('lwm-item-disabled', !!hasNonHeadingChild);
        selfItem.title = hasNonHeadingChild
            ? '子节点含段落 / 表格 / 代码等非标题内容：Markdown 里它们无法提升到顶层（会归入上一个标题的章节），请改用其它删除方式'
            : '保留子节点，让它们接替当前节点的位置';
    }
    app.toolbarEl.style.display = 'flex';
    app.positionToolbar();
    if (app.toolbarTimer) clearInterval(app.toolbarTimer);
    // 画布平移/缩放时跟随（onViewChange 已经即时定位，这里是兜底）
    app.toolbarTimer = setInterval(() => app.positionToolbar(), 120);
}


/** 工具条定位到选中节点右下方；菜单会按容器边界翻转方向。 */
export function positionToolbar(app: MindMapApp) : void {
    // 多选操作条也要跟帧（它独立显隐，不受单节点工具条状态影响）
    app.positionMultiBar();
    if (!app.toolbarEl || !app.selectedUid || app.toolbarEl.style.display === 'none') {
        return;
    }
    const rect = app.canvas.getNodeRect(app.selectedUid);
    if (!rect) return;
    const bar = app.toolbarEl;
    const below = rect.bottom + 6;
    bar.style.left = `${rect.left}px`;
    bar.style.top = `${below}px`;
    // 容器尺寸用缓存的：positionToolbar 在平移时每帧都会被调用，
    // clientWidth/clientHeight 会强制同步布局（上一轮刚挂载/卸载过
    // 节点），大文档下每帧白烧一次整树排版。ResizeObserver 已经维护
    // 了这两个值，这里直接读。
    const viewWidth = app.lastContainerWidth || app.container.clientWidth;
    const viewHeight = app.lastContainerHeight || app.container.clientHeight;
    // 二级菜单向下展开约 260px：底部放不下就向上翻
    bar.classList.toggle('lwm-toolbar-up', below + 260 > viewHeight);
    // 节点靠近右边缘时，菜单向左展开，避免被画布裁掉
    bar.classList.toggle('lwm-toolbar-flip-x', rect.left + 200 > viewWidth);
}
