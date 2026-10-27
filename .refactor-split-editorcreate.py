# -*- coding: utf-8 -*-
"""editor.ts 拆出 editorCreate.ts（create 装配 + 主题侦测 + 调试句柄）。"""
import io, re

p = 'src/webview/codemirror/editor.ts'
lines = io.open(p, encoding='utf-8').read().split('\n')

# ---- 成员定位 ----
decls = []
for i, l in enumerate(lines):
    m = re.match(r'    (?:(?:private|public) )?(?:async )?(\w+)\(', l)
    if m and m.group(1) not in ('if', 'for', 'while', 'switch', 'catch'):
        decls.append((i, m.group(1)))

def doc_start(d):
    s = d
    while s - 1 >= 0 and (lines[s-1].strip().startswith('*') or lines[s-1].strip().startswith('/**')):
        s -= 1
    return s

starts = sorted(doc_start(d) for d, _ in decls)

def method_block(name):
    d = next(i for i, n in decls if n == name)
    s = doc_start(d)
    nxt = next((x for x in starts if x > d), None)
    e = nxt if nxt is not None else len(lines) - 1
    while e - 1 > d and lines[e-1].strip() == '':
        e -= 1
    return s, e

def top_fn_block(marker):
    """顶层函数的块（含文档注释），用下一个顶层声明为界。"""
    d = next(i for i, l in enumerate(lines) if re.match(marker, l))
    s = doc_start(d)
    e = d + 1
    while e < len(lines) and not re.match(r'^(function |export |/\*\*|// ===)', lines[e]):
        e += 1
    while lines[e-1].strip() == '':
        e -= 1
    return s, e

# ---- 提取 ----
extract_order = []
s, e = top_fn_block(r'function detectVsCodeTheme\(')
extract_order.append((s, e, 'detectVsCodeTheme'))
s, e = top_fn_block(r'function copyTextToClipboard\(')
extract_order.append((s, e, 'copyTextToClipboard'))
for n in ['create', 'installDebugHandle', 'startThemeObserver']:
    s, e = method_block(n)
    extract_order.append((s, e, n))
extract_order.sort()

blocks = [(s, e, n, '\n'.join(lines[s:e])) for s, e, n in extract_order]

# ---- 生成 editorCreate.ts ----
def dedent(t):
    return '\n'.join(l[4:] if l.startswith('    ') else l for l in t.split('\n'))

parts = []
for s, e, n, t in blocks:
    if n == 'create':
        t = dedent(t)
        t = t.replace('create(initialContent: string = \'\')',
                      'export function createEditorView(editor: CodeMirrorEditor, initialContent: string = \'\')')
        t = t.replace('this.', 'editor.')
        # installDebugHandle / startThemeObserver 已同模块，直接调
        t = t.replace('editor.installDebugHandle()', 'installDebugHandle(editor)')
        t = t.replace('editor.startThemeObserver()', 'startThemeObserver(editor)')
    elif n in ('installDebugHandle', 'startThemeObserver'):
        t = dedent(t)
        t = re.sub(r'private ' + n + r'\(\)', 'export function ' + n + '(editor: CodeMirrorEditor)', t)
        t = t.replace('this.', 'editor.')
    else:
        t = t.replace('function ' + n + '(', 'export function ' + n + '(')
    parts.append(t)

imports = '''/**
 * CodeMirrorEditor 的视图装配（从 editor.ts 拆出）。
 *
 * createEditorView 是原 create() 方法：构建整套扩展数组（editable/换行/
 * 搜索/快捷键/live preview/图片粘贴……）并 new EditorView。
 * 另含主题侦测、查看模式复制兜底、window.__lwmDebug 调试句柄。
 * 全部以 editor 实例为第一参数；editor 的相关字段已放开为 public。
 *
 * @module webview/codemirror/editorCreate
 */

import { EditorState, Transaction, type Extension } from '@codemirror/state';
import {
    EditorView,
    keymap,
    highlightActiveLine,
    highlightSpecialChars,
    highlightWhitespace,
    lineNumbers,
    rectangularSelection,
    crosshairCursor,
    drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { tunedMarkdownLanguage } from './extensions/markdownParser.js';
import { getSourceRange } from './extensions/livePreview/ranges.js';
import { createThemeExtension } from './extensions/theme';
import { markdownKeymap } from './extensions/keymap.js';
import { codeBlockSelectionPlugin } from './extensions/livePreview/codeBlockSelection.js';
import { createLivePreviewExtension } from './extensions/livePreview/index.js';
import { tableRemeasureEffect } from './extensions/livePreview/state.js';
import { gutterFold } from './extensions/gutterFold.js';
import { listEnterExtension } from './extensions/listEnter.js';
import { settingsState } from '../settings/settingsState.js';
import { searchMatchCount } from './extensions/searchMatchCount.js';
import { searchPanelTheme, searchPanelKeymap, searchPanelPhrases } from './extensions/searchPanel.js';
import { codeLanguages } from './codeLanguages.js';
import type { CodeMirrorEditor } from './editor.js';

'''

io.open('src/webview/codemirror/editorCreate.ts', 'w', encoding='utf-8', newline='').write(
    imports + '\n\n'.join(parts) + '\n')

# ---- 重建 editor.ts ----
out = []
prev = 0
for s, e, n, t in blocks:
    out.append('\n'.join(lines[prev:s]))
    prev = e
out.append('\n'.join(lines[prev:]))
body = ''.join(out)

# create 薄包装插在原位置（被挖掉的第一个成员块处）
create_s = next(s for s, e, n, t in blocks if n == 'create')
# 在剩余文本中找 create 原位置：其前后文是 applySettings 的注释/下一个成员。用锚点：
wrapper = '''    /**
     * Create and initialize the CodeMirror editor.
     * 实现已拆到 editorCreate.ts（扩展装配太长，独立成文件），这里只做转发。
     *
     * @param initialContent - Optional initial content to populate the editor
     * @returns Promise that resolves when the editor is ready
     */
    create(initialContent: string = ''): Promise<void> {
        return createEditorView(this, initialContent);
    }

'''
# 插在 destroy 方法之后（destroy 原本紧跟 create 之后被挖走的位置附近）
d = next(i for i, l in enumerate(body.split('\n')) if re.match(r'    (public )?destroy\(', l))
blines = body.split('\n')
# 找 destroy 块结束
dd = next(i for i, nn in [(x, y) for x, y in decls] if nn == 'destroy')
anchor_idx = None
for i, l in enumerate(blines):
    if re.match(r'    (public )?destroy\(', l):
        anchor_idx = i
        break
# destroy 结束行 = 下一个成员起点
after = blines[:anchor_idx]
rest = blines[anchor_idx:]
# 找到 rest 中下一个成员（reportViewportLine 等）或 installDebugHandle 挖空后的内容
inserted = False
for i, l in enumerate(rest):
    if i > 0 and re.match(r'    (private|public|/\*\*)', l.strip()) is None and (l.startswith('    /**') or re.match(r'    (private|public) ', l)):
        pass
# 简化：直接在 destroy 声明行前插入 wrapper（顺序无关，类方法无所谓先后）
body = '\n'.join(blines[:anchor_idx]) + '\n' + wrapper + '\n'.join(blines[anchor_idx:])

# 字段/方法放开为 public（editorCreate 需要访问）
for f in ['container', 'view', 'onChangeCallback', 'onSelectionChangeCallback',
          'suppressOnChange', 'editableCompartment', 'livePreviewCompartment',
          'themeCompartment', 'themeObserver', 'lineWrappingCompartment',
          'lineNumbersCompartment', 'activeLineCompartment', 'whitespaceCompartment',
          'pasteHandler']:
    body = re.sub(r'^(    )private (readonly )?' + f + r'\b', r'\1public \2' + f, body, flags=re.M)
for mname in ['adjustFontScale', 'scheduleViewportLineReport', 'reportViewportLine']:
    body = re.sub(r'^(    )private ' + mname + r'\(', r'\1public ' + mname + '(', body, flags=re.M)

# import editorCreate
body = body.replace(
    "import { codeLanguages } from './codeLanguages.js';",
    "import { codeLanguages } from './codeLanguages.js';\nimport { createEditorView } from './editorCreate.js';")

io.open(p, 'w', encoding='utf-8', newline='').write(body)
print('editorCreate split done')
