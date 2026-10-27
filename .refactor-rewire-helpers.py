# -*- coding: utf-8 -*-
"""重跑 helpers.js 引用分发（widgets 回滚把之前 helpers 的改写也冲掉了）。"""
import io, re, glob

BASE = 'src/webview/codemirror/extensions/livePreview/'
MODS = ['sourceParse', 'codeIndent', 'textMeasure', 'bulletAlign', 'listIndent']

sym2mod = {}
for mod in MODS:
    txt = io.open(BASE + mod + '.ts', encoding='utf-8').read()
    for m in re.finditer(r'export (?:async )?(?:function|const|interface|class)\s+(\w+)', txt):
        sym2mod[m.group(1)] = mod
sym2mod['resolvePreviewImageUrl'] = 'state'
sym2mod['renderInlineMarkdown'] = 'inlineEngine'

pat = re.compile(r"import\s+(type\s+)?\{([^}]*)\}\s*from\s*'(\./)helpers\.js';", re.S)

for f in glob.glob(BASE + '*.ts'):
    txt = io.open(f, encoding='utf-8').read()
    if "./helpers.js'" not in txt:
        continue
    def repl(m):
        syms = [s.strip() for s in m.group(2).split(',') if s.strip()]
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
    print('rewired:', f)
