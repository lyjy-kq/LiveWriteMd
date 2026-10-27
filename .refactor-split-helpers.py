# -*- coding: utf-8 -*-
"""helpers.ts 拆成 5 个模块 + 重写全部 helpers.js 引用。"""
import io, re, os, glob

BASE = 'src/webview/codemirror/extensions/livePreview/'
p = BASE + 'helpers.ts'
lines = io.open(p, encoding='utf-8').read().split('\n')

def block(a, b):
    return '\n'.join(lines[a-1:b])

# ---- 切块 ----
source_parse = block(28, 325)      # escapeHtml 起（跳过头部注释/imports/re-export，单独写）
code_indent = block(326, 458)
text_measure = block(459, 692)
bullet_align = block(693, 801)
list_indent = block(802, len(lines))

mods = {
    'sourceParse.ts': ('''/**
 * 源码解析小工具（从 helpers.ts 拆出）。
 *
 * escapeHtml / <font> 标签安全样式白名单 / 图片 destination 拆分 /
 * 表格对齐解析 / frontmatter 解析 / 围栏代码块语言与内容提取。
 *
 * @module webview/codemirror/extensions/livePreview/sourceParse
 */

import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import type { FrontmatterProperty } from './types.js';

''' + source_parse),
    'codeIndent.ts': ('''/**
 * 围栏代码块缩进导引（从 helpers.ts 拆出）。
 *
 * 量缩进列数、生成彩虹缩进色带的 background 样式。
 *
 * @module webview/codemirror/extensions/livePreview/codeIndent
 */

''' + code_indent),
    'textMeasure.ts': ('''/**
 * 文本测量（从 helpers.ts 拆出）。
 *
 * Canvas 字宽测量 + MeasureEnv 环境。measureCache 是绑定 #editor DOM 的
 * 全进程单例，被表格量宽 / openScale / openWrap / plugin / BulletWidget 共享。
 *
 * @module webview/codemirror/extensions/livePreview/textMeasure
 */

''' + text_measure),
    'bulletAlign.ts': ('''/**
 * 列表圆点垂直对齐补偿（从 helpers.ts 拆出）。
 *
 * 0 高 inline-block 的 middle 对齐点实测，供 BulletWidget 做像素级补偿。
 *
 * @module webview/codemirror/extensions/livePreview/bulletAlign
 */

''' + bullet_align),
    'listIndent.ts': ('''/**
 * 列表缩进全家桶（从 helpers.ts 拆出）。
 *
 * 缩进列数 / 空白像素宽 / 缩进单位探测 / 列表标记解析 / 行高与基线测量 /
 * 彩虹缩进色带样式生成。
 *
 * @module webview/codemirror/extensions/livePreview/listIndent
 */

import { measureTextIn, type MeasureEnv } from './textMeasure.js';

''' + list_indent),
}

for fname, content in mods.items():
    io.open(BASE + fname, 'w', encoding='utf-8', newline='').write(content)

# ---- 符号 → 模块映射 ----
sym2mod = {}
for fname in mods:
    txt = mods[fname]
    for m in re.finditer(r'export (?:async )?(?:function|const|interface|class)\s+(\w+)', txt):
        sym2mod[m.group(1)] = fname[:-3]
    for m in re.finditer(r'export type\s+(?:interface\s+)?(\w+)', txt):
        sym2mod[m.group(1)] = fname[:-3]
# 两个 re-export 的符号直连源头
sym2mod['resolvePreviewImageUrl'] = 'state'
sym2mod['renderInlineMarkdown'] = 'inlineEngine'

# ---- 重写所有 './helpers.js' 引用 ----
pat = re.compile(r"import\s+(type\s+)?\{([^}]*)\}\s*from\s*'\./helpers\.js';", re.S)
count = 0
for f in glob.glob(BASE + '*.ts'):
    txt = io.open(f, encoding='utf-8').read()
    if './helpers.js' not in txt:
        continue
    def repl(m):
        global count
        count += 1
        syms = [s.strip() for s in m.group(2).split(',') if s.strip()]
        # 拆分 「type X」内联标记
        buckets = {}
        for s in syms:
            is_type = bool(m.group(1)) or s.startswith('type ')
            name = s[5:].strip() if s.startswith('type ') else s
            mod = sym2mod.get(name)
            assert mod, '未知符号: ' + name + ' in ' + f
            buckets.setdefault((mod, is_type), []).append(name)
        parts = []
        for (mod, is_type), names in sorted(buckets.items()):
            prefix = 'import type {' if is_type else 'import {'
            parts.append(prefix + ' ' + ', '.join(names) + " } from './" + mod + ".js';")
        return '\n'.join(parts)
    txt = pat.sub(repl, txt)
    io.open(f, 'w', encoding='utf-8', newline='').write(txt)

os.remove(p)
print('helpers split done, rewritten imports:', count)
