/**
 * CodeMirror Keymap Extension
 *
 * This module provides the keymap configuration for the LiveWriteMD editor,
 * including default keybindings, history (undo/redo), and Markdown-specific
 * shortcuts like Bold (Ctrl/Cmd+B) and Italic (Ctrl/Cmd+I).
 *
 * @module webview/codemirror/extensions/keymap
 *
 * Design References:
 * - DES-A-004: CodeMirror 6 editor design
 * - DES-F-003: Webview file responsibilities
 *
 * Requirements:
 * - REQ-F-002: Webview CodeMirror initialization
 */

import { type Extension } from '@codemirror/state';
import { EditorView, keymap, type KeyBinding } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

/**
 * Wraps selected text with the given markers (e.g., ** for bold, * for italic).
 * If the selected text is already wrapped, removes the markers (toggle off).
 *
 * @param view - The CodeMirror EditorView
 * @param marker - The marker string (e.g., '**' for bold, '*' for italic)
 * @returns true if the command was executed, false otherwise
 */
function toggleMarkdownFormatting(view: EditorView, marker: string): boolean {
    const { state } = view;
    const { from, to } = state.selection.main;

    // If no selection, return false (do nothing)
    if (from === to) {
        return false;
    }

    const markerLength = marker.length;

    // Check if the selection is already wrapped with the marker
    const beforeSelection = state.sliceDoc(Math.max(0, from - markerLength), from);
    const afterSelection = state.sliceDoc(to, Math.min(state.doc.length, to + markerLength));

    const isAlreadyWrapped = beforeSelection === marker && afterSelection === marker;

    let changes;
    let newSelection;

    if (isAlreadyWrapped) {
        // Remove the markers (toggle off)
        changes = [
            { from: from - markerLength, to: from, insert: '' },
            { from: to, to: to + markerLength, insert: '' },
        ];
        // Adjust selection to stay on the unwrapped text
        newSelection = { anchor: from - markerLength, head: to - markerLength };
    } else {
        // Add the markers (toggle on)
        changes = [
            { from: from, to: from, insert: marker },
            { from: to, to: to, insert: marker },
        ];
        // Adjust selection to cover the newly wrapped text (excluding markers)
        newSelection = { anchor: from + markerLength, head: to + markerLength };
    }

    view.dispatch({
        changes,
        selection: newSelection,
    });

    return true;
}

/**
 * Toggles bold formatting on the selected text.
 * Uses ** markers for Markdown bold syntax.
 *
 * @param view - The CodeMirror EditorView
 * @returns true if the command was executed, false otherwise
 */
function toggleBold(view: EditorView): boolean {
    return toggleMarkdownFormatting(view, '**');
}

/**
 * Toggles italic formatting on the selected text.
 * Uses * markers for Markdown italic syntax.
 *
 * @param view - The CodeMirror EditorView
 * @returns true if the command was executed, false otherwise
 */
function toggleItalic(view: EditorView): boolean {
    return toggleMarkdownFormatting(view, '*');
}

/**
 * Markdown-specific keybindings.
 *
 * These keybindings provide common Markdown formatting shortcuts:
 * - Mod-b: Toggle bold (**text**)
 * - Mod-i: Toggle italic (*text*)
 *
 * Note: 'Mod' resolves to Cmd on macOS and Ctrl on other platforms.
 *
 * @example
 * ```typescript
 * import { keymap } from '@codemirror/view';
 * import { markdownKeymap } from './keymap';
 *
 * const extensions = [keymap.of(markdownKeymap)];
 * ```
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
];

/**
 * Creates the complete keymap extension bundle for the LiveWriteMD editor.
 *
 * This function returns an array of CodeMirror extensions that provide:
 * 1. History support (undo/redo functionality)
 * 2. Default keybindings (basic text editing)
 * 3. History keybindings (Ctrl/Cmd+Z for undo, Ctrl/Cmd+Shift+Z for redo)
 * 4. Markdown-specific shortcuts (Bold: Ctrl/Cmd+B, Italic: Ctrl/Cmd+I)
 *
 * @returns Array of CodeMirror extensions for keymap functionality
 *
 * @example
 * ```typescript
 * import { EditorState } from '@codemirror/state';
 * import { EditorView } from '@codemirror/view';
 * import { createLiveWriteMdKeymap } from './keymap';
 *
 * const state = EditorState.create({
 *     doc: '# Hello World',
 *     extensions: createLiveWriteMdKeymap(),
 * });
 *
 * const view = new EditorView({
 *     state,
 *     parent: document.getElementById('editor'),
 * });
 * ```
 *
 * @see {@link markdownKeymap} for Markdown-specific keybindings
 * @see {@link https://codemirror.net/docs/ref/#commands.defaultKeymap} for default keybindings
 * @see {@link https://codemirror.net/docs/ref/#commands.historyKeymap} for history keybindings
 */
export function createLiveWriteMdKeymap(): Extension[] {
    return [
        // History support (undo/redo)
        history(),

        // Keybindings in precedence order:
        // 1. Markdown shortcuts (highest precedence)
        // 2. History keymap (undo/redo)
        // 3. Default keymap (basic editing)
        keymap.of([...markdownKeymap, ...historyKeymap, ...defaultKeymap]),
    ];
}
