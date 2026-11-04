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
 * 基础主题扩展**只创建一次**。
 *
 * EditorView.baseTheme() 每次调用都会生成一个新的 StyleModule（一组约
 * 两百条 CSS 规则）。导图 / 幻灯片里的每个 mini-CM 都会调
 * createLivePreviewDisplayExtension()，以前等于每建一个节点编辑器就往
 * document 里再挂一份重复样式：节点越多，样式重算与内存越重，实测同一
 * 个块建页从 11ms 涨到 50ms。StyleModule 本身支持被同一 document 里的
 * 多个 EditorView 共用（mount 是按 document 去重的），所以提到模块级
 * 复用即可，渲染结果完全一致。
 */
const BASE_THEME: Extension = EditorView.baseTheme({
    ...TEXT_STYLES,
    ...BLOCK_STYLES,
    ...MEDIA_STYLES,
    ...CHROME_STYLES,
});

/** 返回共享的基础主题扩展（不要在调用方 new 新的 StyleModule）。 */
export function createBaseThemeStyles(): Extension {
    return BASE_THEME;
}
