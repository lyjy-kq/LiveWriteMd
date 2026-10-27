# -*- coding: utf-8 -*-
"""把 './widgets.js' 的引用按符号分发到 6 个新模块。"""
import io, re, glob

BASE = 'src/webview/codemirror/extensions/livePreview/'
NEW = ['mediaWidgets', 'simpleWidgets', 'frontmatterWidget',
       'mermaidWidget', 'mathWidgets', 'htmlBlockWidget']

sym2mod = {}
for mod in NEW:
    txt = io.open(BASE + mod + '.ts', encoding='utf-8').read()
    for m in re.finditer(r'export (?:class|function|const|interface)\s+(\w+)', txt):
        sym2mod[m.group(1)] = mod
print('symbols:', len(sym2mod))

pat = re.compile(r"import\s+(type\s+)?\{([^}]*)\}\s*from\s*'((?:\.\./)*[\w./]*?)widgets\.js';", re.S)

def relocate(txt, depth_up):
    """depth_up: 引用方相对 livePreview 的目录深度差（import 前缀长度）。"""
    def repl(m):
        syms = [s.strip() for s in m.group(2).split(',') if s.strip()]
        buckets = {}
        for s in syms:
            is_type = bool(m.group(1)) or s.startswith('type ')
            name = s[5:].strip() if s.startswith('type ') else s
            mod = sym2mod.get(name)
            assert mod, '未知符号: ' + name
            buckets.setdefault((mod, is_type), []).append(name)
        parts = []
        for (mod, is_type), names in sorted(buckets.items()):
            # group(3) 已是 widgets.js 之前的目录前缀，直接拼接模块名
            base = m.group(3)
            p = 'import type {' if is_type else 'import {'
            parts.append(p + ' ' + ', '.join(names) + " } from '" + base + mod + ".js';")
        return '\n'.join(parts)
    return pat.sub(repl, txt)

changed = 0
for f in glob.glob('src/**/*.ts', recursive=True):
    txt = io.open(f, encoding='utf-8').read()
    if 'widgets.js' not in txt:
        continue
    new = relocate(txt, 0)
    if new != txt:
        io.open(f, 'w', encoding='utf-8', newline='').write(new)
        changed += 1
        print('rewritten:', f)
print('files changed:', changed)
