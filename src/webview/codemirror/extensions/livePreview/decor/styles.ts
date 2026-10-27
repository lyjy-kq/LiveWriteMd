/**
 * Live Preview Styles —— 拼装入口。
 *
 * 全部 CSS-in-JS 片段按域拆在同目录四个文件中（stylesText / stylesBlock /
 * stylesMedia / stylesChrome），这里按原顺序 spread 合并后交给
 * EditorView.baseTheme()。
 *
 * Colors are hardcoded (not CSS variables) so that LiveWriteMD's theme override
 * works independently of VS Code's active color theme. Dark colors are the
 * default; light overrides use the `&light` baseTheme prefix.
 *
 * @module webview/codemirror/extensions/livePreview/styles
 */

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { TEXT_STYLES } from './stylesText.js';
import { BLOCK_STYLES } from './stylesBlock.js';
import { MEDIA_STYLES } from './stylesMedia.js';
import { CHROME_STYLES } from './stylesChrome.js';

/**
 * Creates the base theme extension with all live preview CSS styles.
 */
export function createBaseThemeStyles(): Extension {
    return EditorView.baseTheme({
        ...TEXT_STYLES,
        ...BLOCK_STYLES,
        ...MEDIA_STYLES,
        ...CHROME_STYLES,
    });
}
