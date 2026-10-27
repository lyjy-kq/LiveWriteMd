# -*- coding: utf-8 -*-
"""通用搬迁器：按 move_map git mv 文件，并重写所有受影响的相对 import。"""
import io, re, os, glob, subprocess

LP = 'src/webview/codemirror/extensions/livePreview/'

MOVE = {}
def mv(group, names):
    for n in names:
        MOVE[LP + n + '.ts'] = LP + group + '/' + n + '.ts'

mv('decor', ['decorations', 'tokenColors', 'layoutMetrics', 'codeBlockSelection',
             'styles', 'stylesText', 'stylesBlock', 'stylesMedia', 'stylesChrome', 'stylesHelpers'])
mv('inline', ['inlineEngine', 'openScale', 'openWrap', 'wrapSim', 'focusMarks', 'autoPair'])
mv('measure', ['textMeasure', 'bulletAlign', 'listIndent', 'codeIndent', 'sourceParse'])
mv('table', ['tableTypes', 'tableRead', 'tableDetect', 'tableMeasure', 'tableColumns',
             'tableWiring', 'tableDecorations', 'tableLocate', 'tableCellSelection',
             'tableCommands', 'tableHoverControls'])
mv('widgets', ['mediaWidgets', 'simpleWidgets', 'frontmatterWidget',
               'mermaidWidget', 'mathWidgets', 'htmlBlockWidget'])
mv('overlay', ['overlayShell', 'overlayControls', 'imagePreview', 'mermaidPreview'])
mv('math', ['mathCollect', 'mathRender'])
mv('interaction', ['scrollHack', 'lineForce'])

# 1. 建目录 + git mv
for d in ['decor', 'inline', 'measure', 'table', 'widgets', 'overlay', 'math', 'interaction']:
    os.makedirs(LP + d, exist_ok=True)
for old, new in MOVE.items():
    subprocess.run(['git', 'mv', old, new], check=True)

# 2. 反向映射：新路径 → 旧路径（用于解析该文件 import 的原始基准目录）
inv = {v: k for k, v in MOVE.items()}

def norm(p):
    return p.replace('\\', '/')

def resolve(base_dir, spec):
    return norm(os.path.normpath(os.path.join(base_dir, spec)))

def to_spec(target_noext, from_dir):
    r = norm(os.path.relpath(target_noext, from_dir))
    if not r.startswith('.'):
        r = './' + r
    return r + '.js'

import_pat = re.compile(r"(from\s+')(\.[^']+)(')")

changed = 0
for f in glob.glob('src/**/*.ts', recursive=True):
    fn = norm(f)
    f_old = inv.get(fn, fn)
    dir_old = norm(os.path.dirname(f_old))
    dir_new = norm(os.path.dirname(fn))
    txt = io.open(f, encoding='utf-8').read()
    def repl(m):
        spec = m.group(2)
        if not spec.endswith('.js'):
            return m.group(0)
        t_old = resolve(dir_old, spec)[:-3]  # 去 .js
        t_old_ts = t_old + '.ts'
        t_new = MOVE.get(t_old_ts, t_old_ts)[:-3]
        if t_new == t_old and dir_new == dir_old:
            return m.group(0)
        return m.group(1) + to_spec(t_new, dir_new) + m.group(3)
    new_txt = import_pat.sub(repl, txt)
    if new_txt != txt:
        io.open(f, 'w', encoding='utf-8', newline='').write(new_txt)
        changed += 1
print('moved', len(MOVE), 'files; rewrote imports in', changed, 'files')
