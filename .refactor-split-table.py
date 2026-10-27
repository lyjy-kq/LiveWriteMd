# -*- coding: utf-8 -*-
"""tableRender.ts 拆成 9 个 table 模块 + 重写全部外部引用。"""
import io, re, glob

BASE = 'src/webview/codemirror/extensions/livePreview/'
lines = io.open(BASE + 'tableRender.ts', encoding='utf-8').read().split('\n')

# ---- 顶层声明清单（行号 1-based） ----
decls = []  # (line1, kind, name)
for i, l in enumerate(lines):
    m = re.match(r'^(export )?(async )?(function|const|let|class|interface)\s+(\w+)', l)
    if m:
        decls.append((i + 1, m.group(3), m.group(4), bool(m.group(1))))

def doc_start(l1):
    i = l1
    while i - 1 >= 2:
        t = lines[i-2].strip()
        if t.startswith('*') or t.startswith('/') or t == '':
            i -= 1
        else:
            break
    return i

# ---- 模块分配（按声明行落区间） ----
MODS = [
    ('tableTypes', 57, 165, '表格常量与类型：列宽常量 / CSS 类名 / TableLine / TableBlock'),
    ('tableRead', 166, 298, '语法树读表格骨架：readTable / readRow / findTables'),
    ('tableDetect', 299, 492, '文本形状兜底识别（语法树认不出的表格）：splitRowText / looksLikeTable / findTextTables'),
    ('tableMeasure', 493, 769, '量宽基础设施：DOM 标尺 / cellWidthCache / measureCells'),
    ('tableColumns', 770, 1125, '列宽分配算法：columnWidthCache / distributeColumns / columnWidthsFor'),
    ('tableWiring', 1126, 1309, '量宽与编辑器接线：tableResizePlugin / availableTableWidth / 未量表格探测'),
    ('tableDecorations', 1310, 1564, '表格装饰：collectTableDecorations 把表格画成格子 + EmptyCellWidget'),
    ('tableLocate', 1565, 1694, '表格定位与输入 handler：isInTableCell / findTableAt / 源码模式 / 管道符转义 / 输入法'),
    ('tableCellSelection', 1695, len(lines), '框选单元格：cellAt / tableBlockAt / CellSelectionStyle / tableCellSelection'),
]

def mod_of(line1):
    for name, a, b, _ in MODS:
        if a <= line1 <= b:
            return name
    raise AssertionError(line1)

# ---- 切块 ----
blocks = {m[0]: [] for m in MODS}
for idx, (line1, kind, name, exported) in enumerate(decls):
    s = doc_start(line1)
    e = doc_start(decls[idx + 1][1 - 1]) if idx + 1 < len(decls) else len(lines) + 1
    e = doc_start(decls[idx + 1][0]) if idx + 1 < len(decls) else len(lines) + 1
    blocks[mod_of(line1)].append((s, e, name))

# ---- 符号 → 模块（供跨块 import 与外部重接） ----
sym2mod = {name: mod_of(line1) for line1, kind, name, exported in decls}

# ---- 写模块 ----
extern_region = '\n'.join(lines[0:56])
sym2src = {}
for m in re.finditer(r"import\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']+)';", extern_region, re.S):
    for s in m.group(2).split(','):
        s = s.strip()
        if not s:
            continue
        is_type = bool(m.group(1)) or s.startswith('type ')
        nm = s[5:].strip() if s.startswith('type ') else s
        sym2src[nm] = (m.group(3), is_type)

for name, a, b, desc in MODS:
    body = '\n\n'.join('\n'.join(lines[s-1:e-1]).strip('\n') for s, e, _ in blocks[name])
    # 跨块引用：用到的其他块符号全部 export + import
    used_cross = {}
    for sym, mod in sym2mod.items():
        if mod != name and re.search(r'(?<![\w.])' + re.escape(sym) + r'\b', body):
            used_cross.setdefault(mod, []).append(sym)
    # 本块声明但被他块引用的符号要 export（后处理：先收集反向需求）
    ext = []
    for symname, (src, is_type) in sym2src.items():
        if re.search(r'(?<![\w.])' + re.escape(symname) + r'\b', body):
            ext.append((src, is_type, symname))
    imp = []
    for mod, syms in sorted(used_cross.items()):
        imp.append("import { " + ', '.join(sorted(syms)) + " } from './" + mod + ".js';")
    bysrc = {}
    for src, is_type, nm in ext:
        bysrc.setdefault((src, is_type), []).append(nm)
    for (src, is_type), names in sorted(bysrc.items()):
        prefix = 'import type {' if is_type else 'import {'
        imp.append(prefix + ' ' + ', '.join(sorted(names)) + " } from '" + src + "';")
    header = ('/**\n * 表格（从 tableRender.ts 拆出）：' + desc + '。\n'
              ' *\n * @module webview/codemirror/extensions/livePreview/' + name + '\n */\n\n')
    io.open(BASE + name + '.ts', 'w', encoding='utf-8', newline='').write(
        header + '\n'.join(imp) + '\n\n' + body + '\n')

# ---- 反向：被他块引用的符号必须 export ----
need_export = set()
for name, a, b, desc in MODS:
    txt = io.open(BASE + name + '.ts', encoding='utf-8').read()
    for sym, mod in sym2mod.items():
        if mod != name and re.search(r'(?<![\w.])' + re.escape(sym) + r'\b', txt):
            need_export.add(sym)
for sym in need_export:
    mod = sym2mod[sym]
    f = BASE + mod + '.ts'
    txt = io.open(f, encoding='utf-8').read()
    txt = re.sub(r'^(?!(?:export ))((?:async )?(?:function|const|let|class|interface)\s+' + sym + r'\b)',
                 r'export \1', txt, count=1, flags=re.M)
    io.open(f, 'w', encoding='utf-8', newline='').write(txt)

import os
os.remove(BASE + 'tableRender.ts')

# ---- 外部引用重接（./tableRender.js 与 ../tableRender.js 等） ----
pat = re.compile(r"import\s+(type\s+)?\{([^}]*)\}\s*from\s*'((?:\.\.?/)*?)tableRender\.js';", re.S)
changed = 0
for f in glob.glob('src/**/*.ts', recursive=True):
    txt = io.open(f, encoding='utf-8').read()
    if 'tableRender.js' not in txt:
        continue
    def repl(m):
        syms = [s.strip() for s in m.group(2).split(',') if s.strip()]
        buckets = {}
        for s in syms:
            is_type = bool(m.group(1)) or s.startswith('type ')
            nm = s[5:].strip() if s.startswith('type ') else s
            mod = sym2mod.get(nm)
            assert mod, '未知符号: ' + nm + ' in ' + f
            buckets.setdefault((mod, is_type), []).append(nm)
        parts = []
        for (mod, is_type), names in sorted(buckets.items()):
            prefix = 'import type {' if is_type else 'import {'
            parts.append(prefix + ' ' + ', '.join(names) + " } from '" + m.group(3) + mod + ".js';")
        return '\n'.join(parts)
    new = pat.sub(repl, txt)
    if new != txt:
        io.open(f, 'w', encoding='utf-8', newline='').write(new)
        changed += 1
        print('rewired:', f)
print('tableRender split done, external rewired:', changed)
