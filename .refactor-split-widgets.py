# -*- coding: utf-8 -*-
"""widgets.ts 按 widget 族群拆成 6 个文件。"""
import io, re

BASE = 'src/webview/codemirror/extensions/livePreview/'
lines = io.open(BASE + 'widgets.ts', encoding='utf-8').read().split('\n')

# ---- 1. 解析 import 区（第 10-36 行）：符号 → (来源, 是否 type) ----
import_region = '\n'.join(lines[9:37])
sym2src = {}
for m in re.finditer(r"import\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']+)';", import_region, re.S):
    is_type_decl = bool(m.group(1))
    src = m.group(3)
    for s in m.group(2).split(','):
        s = s.strip()
        if not s:
            continue
        is_type = is_type_decl or s.startswith('type ')
        name = s[5:].strip() if s.startswith('type ') else s
        sym2src[name] = (src, is_type)

# ---- 2. 计算切块 ----
def doc_start(decl_line1):
    """1-based 声明行 → 向上吃掉 doc 注释/banner/空行，返回 1-based 块起点。"""
    i = decl_line1 - 1
    while i - 1 >= 1:
        t = lines[i-2].strip()
        if t.startswith('*') or t.startswith('/') or t == '':
            i -= 1
        else:
            break
    return i

img_start = doc_start(485)  # ImageWidget 文档注释起点（Checkbox 与 Image 的分界）

CUTS = [41, 93, 244, 383, img_start, 743, 952, 1171, 1518, len(lines) + 1]

def seg(a, b):
    return '\n'.join(lines[a-1:b-1])

GROUPS = [
    ('mediaWidgets.ts', [seg(CUTS[0], CUTS[1]), seg(CUTS[4], CUTS[5])],
     '图片与媒体 widget：媒体宽度调整助手 + ImageWidget + InlineHtmlImageWidget'),
    ('simpleWidgets.ts', [seg(CUTS[1], CUTS[2]), seg(CUTS[3], CUTS[4]), seg(CUTS[5], CUTS[6])],
     '小件 widget 集合：分割线 / 列表圆点 / 字体文本 / gutter 折叠 / 复选框 / 代码块复制 / 脚注 / Details'),
    ('frontmatterWidget.ts', [seg(CUTS[2], CUTS[3])],
     'Frontmatter 属性面板 widget（含模块级 frontmatterCollapsed 单例状态）'),
    ('mermaidWidget.ts', [seg(CUTS[6], CUTS[7])],
     'Mermaid 图 widget：异步渲染、SVG 缓存、预览浮层接线'),
    ('mathWidgets.ts', [seg(CUTS[7], CUTS[8])],
     '数学公式 widget：行内 + 块级（含 mathScaleCache 与盒高测量）'),
    ('htmlBlockWidget.ts', [seg(CUTS[8], CUTS[9])],
     'HTML 块 widget：标签白名单 + 安全 href + 片段构建'),
]

for fname, parts, desc in GROUPS:
    body = '\n\n'.join(p.strip('\n') for p in parts)
    # 用到的符号 → 按来源聚合 import
    used = {}
    for name, (src, is_type) in sym2src.items():
        if re.search(r'(?<![\w.])' + re.escape(name) + r'\b', body):
            key = (src, is_type)
            used.setdefault(key, []).append(name)
    imp_lines = []
    for (src, is_type), names in sorted(used.items()):
        prefix = 'import type {' if is_type else 'import {'
        imp_lines.append(prefix + ' ' + ', '.join(sorted(names)) + " } from '" + src + "';")
    header = ('/**\n * Live Preview Widget（从 widgets.ts 拆出）：' + desc + '。\n'
              ' *\n * @module webview/codemirror/extensions/livePreview/' + fname[:-3] + '\n */\n\n')
    io.open(BASE + fname, 'w', encoding='utf-8', newline='').write(
        header + '\n'.join(imp_lines) + '\n\n' + body + '\n')
    print(fname, len(imp_lines), 'imports')

import os
os.remove(BASE + 'widgets.ts')
print('widgets.ts removed')
