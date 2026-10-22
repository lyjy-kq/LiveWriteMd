/**
 * LiveWriteMD 正文右键菜单模块。
 *
 * 这个模块只负责 Webview 中 Markdown 正文区域的自定义右键菜单，
 * 不处理大纲、标题栏或其它辅助 UI 的菜单逻辑。
 */

import type { TableCommand } from './codemirror/extensions/livePreview/tableCommands.js';

// 编辑器模式联合类型集中定义在 shared/types，webview 与扩展共用一份。
import type { EditorMode as SharedEditorMode } from '../shared/types.js';

/**
 * 支持的编辑器模式类型。
 */
export type EditorMode = SharedEditorMode;

/**
 * 菜单里所有可能的动作名（各种命令 + 表格增删行列）。
 *
 * 模式切换和大纲开关已从右键菜单移除，统一收编到 VSCode 编辑器标题栏，
 * 这里的菜单只保留正文编辑相关的动作。
 */
type MenuAction =
    | 'insert-image'
    | 'export-as-html'
    | 'export-as-pdf'
    | 'download-remote-images'
    | TableCommand;

/**
 * 判断一个动作名是不是表格操作。
 *
 * @param action - 菜单动作名
 * @returns 是表格操作时返回 true
 */
function isTableCommand(action: MenuAction): action is TableCommand {
    return TABLE_MENU_ITEMS.some((item) => item.action === action);
}

/**
 * 正文右键菜单需要调用的外部动作。
 */
export interface EditorContextMenuActions {
    /** 触发插入图片操作。 */
    onInsertImage: () => void;
    /** 触发导出 HTML 操作。 */
    onExportAsHtml: () => void;
    /** 触发导出 PDF 操作。 */
    onExportAsPdf: () => void;
    /** 触发下载正文网络图片到本地操作。 */
    onDownloadRemoteImages: () => void;
    /**
     * 右键位置是不是落在表格单元格里。
     *
     * 返回 true 时菜单会多出一组「表格增删行列」。实现方顺便把光标（或整格选区）
     * 放进点了的那一格，后面的命令就作用在它（或框选的那片）上面。
     */
    resolveTableContext?: (event: MouseEvent) => boolean;
    /** 执行一项表格操作（增删行列）。 */
    onTableCommand?: (command: TableCommand) => void;
}

/**
 * 表格那一组菜单项：动作名 → 文案。
 *
 * 导出给导图复用（导图节点里的表格右键菜单与 live 模式保持一致）。
 */
export const TABLE_MENU_ITEMS: Array<{ action: TableCommand; label: string }> = [
    { action: 'row-above', label: '向上插入行' },
    { action: 'row-below', label: '向下插入行' },
    { action: 'col-left', label: '向左插入列' },
    { action: 'col-right', label: '向右插入列' },
    { action: 'delete-row', label: '删除所选行' },
    { action: 'delete-col', label: '删除所选列' },
];

/**
 * LiveWriteMD 正文右键菜单控制器。
 */
export class EditorContextMenu {
    /** 菜单根节点。 */
    private readonly menuEl: HTMLDivElement;

    /** 当前绑定的正文区域容器。 */
    private targetEl: HTMLElement | null = null;

    /** 当前是否显示菜单。 */
    private isOpen = false;

    /** 表格那一组菜单项（单元格上右键才显示）。 */
    private readonly tableGroup: HTMLDivElement;

    /** 菜单项对应的按钮集合。 */
    private readonly buttons = new Map<MenuAction, HTMLButtonElement>();

    /** 菜单样式标识。 */
    private static readonly STYLE_ID = 'livewritemd-editor-context-menu-style';

    /**
     * 创建正文右键菜单控制器。
     *
     * @param actions - 外部动作回调
     * @returns 右键菜单控制器实例
     */
    constructor(private readonly actions: EditorContextMenuActions) {
        this.installStyles();
        this.menuEl = this.createMenuElement();
        this.tableGroup = this.createTableGroup();
        // 表格那组排在最前面：在格子上右键，用户要的就是这几项
        this.menuEl.insertBefore(this.tableGroup, this.menuEl.firstChild);
        this.installGlobalDismissHandlers();
    }

    /**
     * 绑定到指定正文区域。
     *
     * @param targetEl - Markdown 正文区域容器
     * @returns void
     */
    public attach(targetEl: HTMLElement | null): void {
        if (this.targetEl) {
            this.targetEl.removeEventListener('contextmenu', this.handleContextMenu);
        }

        this.targetEl = targetEl;
        if (this.targetEl) {
            this.targetEl.addEventListener('contextmenu', this.handleContextMenu);
        }
    }

    /**
     * 销毁菜单并移除事件绑定。
     *
     * @returns void
     */
    public destroy(): void {
        this.attach(null);
        this.hide();
        this.menuEl.remove();
    }

    /**
     * 创建菜单 DOM。
     *
     * @returns 菜单 DOM 节点
     */
    private createMenuElement(): HTMLDivElement {
        const menu = document.createElement('div');
        menu.className = 'livewritemd-editor-context-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-hidden', 'true');

        // 菜单只保留正文编辑相关动作；模式切换与大纲开关在编辑器标题栏。
        const insertButton = this.createMenuButton('insert-image', '插入图片');
        const downloadButton = this.createMenuButton(
            'download-remote-images',
            '下载网络图片到本地'
        );
        const exportButton = this.createMenuButton('export-as-html', 'Export as HTML');
        const exportPdfButton = this.createMenuButton('export-as-pdf', '导出为 PDF');

        const separator = document.createElement('div');
        separator.className = 'livewritemd-editor-context-menu-separator';

        menu.appendChild(insertButton);
        menu.appendChild(downloadButton);
        menu.appendChild(separator);
        menu.appendChild(exportButton);
        menu.appendChild(exportPdfButton);

        document.body.appendChild(menu);
        this.buttons.set('insert-image', insertButton);
        this.buttons.set('download-remote-images', downloadButton);
        this.buttons.set('export-as-html', exportButton);
        this.buttons.set('export-as-pdf', exportPdfButton);

        menu.addEventListener('pointerdown', (event: PointerEvent) => {
            event.stopPropagation();
        });

        menu.addEventListener('click', this.handleMenuClick);
        return menu;
    }

    /**
     * 创建「表格」那一组菜单项（默认隐藏，在单元格上右键时才显示）。
     *
     * 动作名和 TableCommand 一一对应，点击统一走 handleMenuClick。
     *
     * @returns 这一组的容器节点
     */
    private createTableGroup(): HTMLDivElement {
        const group = document.createElement('div');
        group.className = 'livewritemd-editor-context-menu-group';
        group.dataset.group = 'table';
        group.style.display = 'none';

        for (const item of TABLE_MENU_ITEMS) {
            const button = this.createMenuButton(item.action, item.label);
            group.appendChild(button);
            this.buttons.set(item.action, button);
        }
        const separator = document.createElement('div');
        separator.className = 'livewritemd-editor-context-menu-separator';
        group.appendChild(separator);
        return group;
    }

    /**
     * 安装右键菜单样式。
     *
     * @returns void
     */
    private installStyles(): void {
        if (document.getElementById(EditorContextMenu.STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = EditorContextMenu.STYLE_ID;
        style.textContent = `
            .livewritemd-editor-context-menu {
                position: fixed;
                z-index: 9999;
                display: none;
                min-width: 180px;
                padding: 6px;
                border-radius: 10px;
                border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, rgba(127, 127, 127, 0.3)));
                background: var(--vscode-menu-background, var(--vscode-sideBar-background, #252526));
                color: var(--vscode-menu-foreground, var(--vscode-foreground, #d4d4d4));
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
                backdrop-filter: none;
            }

            .livewritemd-editor-context-menu[aria-hidden='true'] {
                pointer-events: none;
            }

            .livewritemd-editor-context-menu-item {
                width: 100%;
                display: flex;
                align-items: center;
                justify-content: flex-start;
                gap: 8px;
                padding: 6px 10px;
                border: none;
                border-radius: 6px;
                background: transparent;
                color: inherit;
                font: inherit;
                text-align: left;
                cursor: pointer;
                line-height: 1.4;
            }

            .livewritemd-editor-context-menu-item:hover:not(:disabled) {
                background: var(--vscode-menu-selectionBackground, rgba(127, 127, 127, 0.18));
                color: var(--vscode-menu-selectionForeground, var(--vscode-foreground, #d4d4d4));
            }

            .livewritemd-editor-context-menu-item:disabled {
                opacity: 0.45;
                cursor: default;
            }

            .livewritemd-editor-context-menu-item[data-active='true'] {
                font-weight: 600;
            }

            .livewritemd-editor-context-menu-separator {
                height: 1px;
                margin: 4px 6px;
                background: var(--vscode-menu-separatorBackground, rgba(127, 127, 127, 0.18));
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * 创建菜单按钮。
     *
     * @param action - 按钮动作标识
     * @param label - 按钮显示文本
     * @returns 菜单按钮节点
     */
    private createMenuButton(action: MenuAction, label: string): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'livewritemd-editor-context-menu-item';
        button.dataset.action = action;
        button.setAttribute('role', 'menuitem');
        button.textContent = label;
        return button;
    }

    /**
     * 安装全局关闭逻辑。
     *
     * @returns void
     */
    private installGlobalDismissHandlers(): void {
        document.addEventListener('click', this.handleDocumentClick, true);
        document.addEventListener('keydown', this.handleDocumentKeydown, true);
        window.addEventListener('blur', this.hide);
        window.addEventListener('resize', this.hide);
        window.addEventListener('scroll', this.hide, true);
    }

    /**
     * 处理正文区域的右键菜单事件。
     *
     * @param event - 鼠标右键事件
     * @returns void
     */
    private readonly handleContextMenu = (event: MouseEvent): void => {
        if (!this.targetEl) {
            return;
        }

        const target = event.target;
        if (!(target instanceof Node) || !this.targetEl.contains(target)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        // 落在表格格子上：多出一组增删行列（回调顺便把光标放进那一格 / 保留框选）
        const inTable = this.actions.resolveTableContext?.(event) ?? false;
        this.tableGroup.style.display = inTable ? '' : 'none';
        this.openAt(event.clientX, event.clientY);
    };

    /**
     * 处理文档点击关闭菜单。
     *
     * @param event - 鼠标点击事件
     * @returns void
     */
    private readonly handleDocumentClick = (event: MouseEvent): void => {
        if (!this.isOpen) {
            return;
        }

        const target = event.target;
        if (target instanceof Node && this.menuEl.contains(target)) {
            return;
        }

        this.hide();
    };

    /**
     * 处理 ESC 键关闭菜单。
     *
     * @param event - 键盘事件
     * @returns void
     */
    private readonly handleDocumentKeydown = (event: KeyboardEvent): void => {
        if (!this.isOpen) {
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            this.hide();
        }
    };

    /**
     * 处理菜单项点击。
     *
     * @param event - 点击事件
     * @returns void
     */
    private readonly handleMenuClick = (event: MouseEvent): void => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const button = target.closest<HTMLButtonElement>('[data-action]');
        if (!button) {
            return;
        }

        const action = button.dataset.action as MenuAction | undefined;
        if (!action || button.disabled) {
            return;
        }

        this.hide();
        // 表格那一组（加/删行列）交给编辑器去改文档
        if (isTableCommand(action)) {
            this.actions.onTableCommand?.(action);
            return;
        }
        if (action === 'insert-image') {
            this.actions.onInsertImage();
            return;
        }

        if (action === 'download-remote-images') {
            this.actions.onDownloadRemoteImages();
            return;
        }

        if (action === 'export-as-html') {
            this.actions.onExportAsHtml();
            return;
        }

        if (action === 'export-as-pdf') {
            this.actions.onExportAsPdf();
            return;
        }
    };

    /**
     * 打开菜单并自动修正边界位置。
     *
     * @param clientX - 鼠标 X 坐标
     * @param clientY - 鼠标 Y 坐标
     * @returns void
     */
    private openAt(clientX: number, clientY: number): void {
        this.isOpen = true;

        this.menuEl.style.display = 'block';
        this.menuEl.style.visibility = 'hidden';
        this.menuEl.style.left = `${Math.max(8, clientX)}px`;
        this.menuEl.style.top = `${Math.max(8, clientY)}px`;

        const rect = this.menuEl.getBoundingClientRect();
        const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
        const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
        this.menuEl.style.left = `${Math.min(clientX, maxLeft)}px`;
        this.menuEl.style.top = `${Math.min(clientY, maxTop)}px`;
        this.menuEl.style.visibility = 'visible';
        this.menuEl.setAttribute('aria-hidden', 'false');
    }

    /**
     * 关闭菜单。
     *
     * @returns void
     */
    private readonly hide = (): void => {
        if (!this.isOpen) {
            return;
        }

        this.isOpen = false;
        this.menuEl.style.display = 'none';
        this.menuEl.setAttribute('aria-hidden', 'true');
    };
}
