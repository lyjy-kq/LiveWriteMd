/**
 * MindMapApp 协作模块（从 mindmapApp.ts 拆出）：全局快捷键分发 + 空文档提示。
 *
 * 全部是原 MindMapApp 方法，this 换成第一参数 app；跨模块调用走 app 上的薄包装方法。
 *
 * @module webview/mindmap/app/appKeys
 */

import type { MindMapApp } from '../mindmapApp.js';
import { toggleBold, toggleInlineCode, toggleItalic } from '../../codemirror/extensions/keymap.js';
import { addChildNode } from '.././edit/add.js';
import { isMediaKind } from '.././edit/rename.js';


// ==================================================================
// 键盘 / 浮层
// ==================================================================

/** 导图内快捷键：Ctrl+Z/Y、Ctrl+F/H、Tab、Enter、F2、Delete。 */
export function handleWindowKeyDown(app: MindMapApp, event: KeyboardEvent): void {
    if (!app.active || app.editSession) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (key === 'f') {
            event.preventDefault();
            event.stopPropagation();
            app.searchBar.open(false);
            return;
        }
        if (key === 'h') {
            event.preventDefault();
            event.stopPropagation();
            app.searchBar.open(true);
            return;
        }
        if (key === 'z' && !event.shiftKey && app.options.onUndo) {
            event.preventDefault();
            event.stopPropagation();
            app.options.onUndo();
            return;
        }
        if ((key === 'y' || (key === 'z' && event.shiftKey)) && app.options.onRedo) {
            event.preventDefault();
            event.stopPropagation();
            app.options.onRedo();
            return;
        }
        // 剪贴板三件套：子树级复制/剪切/粘贴。
        // 编辑会话里不会走到这里（函数开头已 return），编辑态的
        // Ctrl+C/X/V 由 mini-CM 原生处理（文本级）。
        if (key === 'c' || key === 'x') {
            if (app.clipboardTargetUids().length === 0) return;
            event.preventDefault();
            event.stopPropagation();
            if (key === 'c') void app.copySelection();
            else void app.cutSelection();
            return;
        }
        if (key === 'v') {
            event.preventDefault();
            event.stopPropagation();
            void app.pasteFromClipboard();
            return;
        }
        // live 模式的行内格式三连：加粗 / 斜体 / 行内代码。
        // 必须排在 redo 之后：Ctrl+Shift+Z 是重做，不能被当成别的键。
        if (!event.shiftKey && (key === 'b' || key === 'i' || key === 'g')) {
            // 没选中节点时放行，避免把快捷键吞掉却什么都不做
            if (!app.selectedUid) return;
            event.preventDefault();
            event.stopPropagation();
            app.applyInlineFormat(
                app.selectedUid,
                key === 'b' ? toggleBold : key === 'i' ? toggleItalic : toggleInlineCode,
            );
            return;
        }
    }
    if (!app.selectedUid) return;
    const node = app.canvas.getNode(app.selectedUid);
    if (!node) return;
    const kind = node.kind;
    const media = isMediaKind(kind);
    // Tab = 加子节点；段落也放行（addChildNode 会先把它升级成列表项）
    if (event.key === 'Tab' && kind !== 'meta' && !media) {
        event.preventDefault();
        app.addChild();
    } else if (
        event.key === 'Enter' &&
        // 段落与引用不加兄弟节点（文本类叶节点，直接编辑内容即可）
        kind !== 'para' &&
        kind !== 'quote' &&
        kind !== 'meta' &&
        kind !== 'root' &&
        !media
    ) {
        event.preventDefault();
        app.addSibling();
    } else if (event.key === 'F2') {
        event.preventDefault();
        app.startEdit(app.selectedUid);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && kind !== 'root') {
        event.preventDefault();
        app.deleteSelected();
    }
};


/** 空文档提示浮层。 */
export function toggleEmptyHint(app: MindMapApp, empty: boolean) : void {
    const existing = app.container.querySelector<HTMLElement>('.lwm-empty-hint');
    existing?.remove();
    if (!empty || !app.active) return;
    const hint = document.createElement('div');
    hint.className = 'lwm-empty-hint';
    hint.textContent =
        '文档还没有标题或列表：选中根节点后按 Tab（或工具条「＋子节点」）开始编写。';
    app.container.appendChild(hint);
}
