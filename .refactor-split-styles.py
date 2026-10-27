# -*- coding: utf-8 -*-
"""styles.ts 按注释分节拆成 4 个样式片段 + helpers（边界全部程序定位）。"""
import io, re

p = 'src/webview/codemirror/extensions/livePreview/styles.ts'
lines = io.open(p, encoding='utf-8').read().split('\n')

# ---- 定位 ----
check_svg_decl = next(i for i, l in enumerate(lines) if l.startswith('const CHECK_SVG'))
helpers_start = check_svg_decl
while not lines[helpers_start].strip().startswith('/**'):
    helpers_start -= 1
create_fn = next(i for i, l in enumerate(lines) if l.startswith('export function createBaseThemeStyles'))
helpers_end = create_fn
while lines[helpers_end - 1].strip().startswith('*') or lines[helpers_end-1].strip().startswith('/**') or lines[helpers_end-1].strip() == '':
    helpers_end -= 1
helpers = lines[helpers_start:helpers_end]

obj_open = next(i for i, l in enumerate(lines) if 'EditorView.baseTheme({' in l)
obj_close = next(i for i, l in enumerate(lines) if l.strip() == '});' and i > obj_open)
content_end = obj_close
while lines[content_end - 1].strip() == '':
    content_end -= 1

# 分节横幅：成对的 // ==== 行， opener 是偶数位置
banners = [i for i, l in enumerate(lines)
           if re.match(r'^\s*// ={10,}\s*$', l) and obj_open < i < obj_close]
openers = banners[0::2]
print('sections:', len(openers))

# 组边界（opener 下标）：第 0 / 8 / 17 / 22 个 opener
group_idx = [0, 8, 17, 22, len(openers)]
FRAGS = [
    ('stylesText.ts', 'TEXT_STYLES',
     '文本与语法：语法高亮覆盖 / 标题 / 粗斜体 / 标记符压 0 宽 / 行内代码 / 链接 / 引用 / 围栏代码块'),
    ('stylesBlock.ts', 'BLOCK_STYLES',
     '块级元素：选区 / 列表圆点 / Setext / hr / HTML 块 / 隐藏行 / 表格 / Mermaid / 复选框'),
    ('stylesMedia.ts', 'MEDIA_STYLES',
     '媒体与杂项：图片 / 脚注 / Details 折叠块 / 圆点定位'),
    ('stylesChrome.ts', 'CHROME_STYLES',
     '界面构件：折叠箭头 / 折叠角花 / 缩进引导线 / 标题折叠 / 代码块缩进导引 / Frontmatter / KaTeX'),
]

outdir = 'src/webview/codemirror/extensions/livePreview/'

# helpers 文件
helpers_txt = '\n'.join(helpers)
helpers_txt = helpers_txt.replace('const CHECK_SVG', 'export const CHECK_SVG')
helpers_txt = helpers_txt.replace('function tone(', 'export function tone(')
io.open(outdir + 'stylesHelpers.ts', 'w', encoding='utf-8', newline='').write(
    '/**\n * 样式片段共用的助手（从 styles.ts 拆出）：复选框对勾 SVG + 语义色混色函数。\n *\n'
    ' * @module webview/codemirror/extensions/livePreview/stylesHelpers\n */\n\n'
    + helpers_txt + '\n')

for gi, (fname, export_name, desc) in enumerate(FRAGS):
    a = openers[group_idx[gi]]
    b = openers[group_idx[gi + 1]] if group_idx[gi + 1] < len(openers) else content_end
    content = '\n'.join(lines[a:b])
    imports = []
    if 'tone(' in content:
        imports.append("import { tone } from './stylesHelpers.js';")
    if 'CHECK_SVG' in content:
        imports.append("import { CHECK_SVG } from './stylesHelpers.js';")
    header = ('/**\n * Live Preview 样式片段（从 styles.ts 拆出）：' + desc + '。\n *\n'
              ' * 只是 baseTheme 大对象的一部分；styles.ts 里按原顺序 spread 合并。\n'
              ' *\n * @module webview/codemirror/extensions/livePreview/' + fname[:-3] + '\n */\n\n')
    if imports:
        header += '\n'.join(imports) + '\n\n'
    io.open(outdir + fname, 'w', encoding='utf-8', newline='').write(
        header + 'export const ' + export_name + ' = {\n' + content + '\n};\n')

new_main = '''/**
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
'''
io.open(p, 'w', encoding='utf-8', newline='').write(new_main)
print('styles split done')
