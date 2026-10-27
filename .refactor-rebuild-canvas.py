# -*- coding: utf-8 -*-
"""canvas.ts 重建：挖掉已拆成员，字段放开 public，补薄包装。"""
import io, re, json

BASE = 'src/webview/mindmap/engine/'
p = BASE + 'canvas.ts'
lines = io.open(p, encoding='utf-8').read().split('\n')
spans = {k: tuple(v) for k, v in json.load(io.open('.refactor-canvas-spans.json')).items()}

GROUPS = json.load(io.open('.refactor-canvas-groups.json'))

# 全部要挖掉的成员名
moved = [n for names in GROUPS.values() for n in names] + ['buildExportSvg']
moved_set = set(moved)

# 常量块行区间（0-based 45:143）与几何函数区也要挖
geo_start = next(i for i, l in enumerate(lines) if l.startswith('function computeInternalLinkGeometry'))
gs = geo_start
while lines[gs-1].strip().startswith('*') or lines[gs-1].strip().startswith('/'):
    gs -= 1

cut_spans = [(spans[n][0], spans[n][1]) for n in moved]
cut_spans.append((45, 143))       # 常量块
cut_spans.append((gs, len(lines)))  # 几何函数到文件尾
cut_spans.sort()

out = []
prev = 0
for s, e in cut_spans:
    out.append('\n'.join(lines[prev:s]))
    prev = e
out.append('\n'.join(lines[prev:]))
body = '\n'.join(out)

# ---- 字段/方法 private → public（协作模块直读直写） ----
body = re.sub(r'^(    )private ', r'\1public ', body, flags=re.M)

# ---- 薄包装 ----
def split_args(args):
    parts, depth, cur = [], 0, ''
    for ch in args:
        if ch in '<([{':
            depth += 1
        elif ch in '>)]}':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(cur); cur = ''
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return [x for x in (p.strip() for p in parts) if x]

orig_lines = io.open(p, encoding='utf-8').read().split('\n')
wraps = ['\n    // ---- 薄包装：实现已拆到同目录协作模块（displayPool/mounting/viewport/links/minimap/pointer/flags/export）----']
for mod, names in GROUPS.items():
    wraps.append('    // ' + mod)
    for n in names:
        s, e = spans[n]
        seg = orig_lines[s:e]
        if n == 'handleWheel':
            wraps.append('    public handleWheel = (event: WheelEvent): void => { pointer.handleWheel(this, event); };')
            continue
        d = next(i for i, l in enumerate(seg) if re.match(r'(?:private |public )?(?:async )?' + n + r'\(', l.strip()))
        sig = seg[d].strip()
        k = d
        m = None
        while k - d < 25:
            m = re.match(r'(?:private |public )?(async )?' + n + r'\(([\s\S]*)\)\s*(:\s*[\s\S]*)?\{\s*$', sig)
            if m and not sig.rstrip().endswith(": {"):
                break
            k += 1
            sig += ' ' + seg[k].strip()
        assert m, n
        is_async = (m.group(1) or '').strip()
        args = ' '.join(m.group(2).split())
        ret = (m.group(3) or ': void').strip()
        argnames = ', '.join(a.split(':')[0].strip().replace('?', '') for a in split_args(args))
        call = mod + '.' + n + '(this' + (', ' + argnames if argnames else '') + ')'
        if is_async:
            wraps.append('    public async {}({}){} {{ return {}; }}'.format(n, args, (' ' + ret) if ret else '', call))
        else:
            wraps.append('    public {}({}){} {{ return {}; }}'.format(n, args, (' ' + ret) if ret else '', call))
# buildExportSvg 的包装（并入 export.ts）
wraps.append('    // export')
wraps.append('    public buildExportSvg(): string { return buildExportSvg(this); }')
wraps.append('')
wrapper_block = '\n'.join(wraps)

# 包装插到 constructor 结束后：找 constructor 块尾
ctor_start = next(i for i, l in enumerate(body.split('\n')) if re.match(r'    constructor\(', l))
blines = body.split('\n')
depth = 0
ctor_end = None
for i in range(ctor_start, len(blines)):
    depth += blines[i].count('{') - blines[i].count('}')
    if depth == 0:
        ctor_end = i
        break
blines = blines[:ctor_end+1] + [wrapper_block] + blines[ctor_end+1:]
body = '\n'.join(blines)

# ---- import 调整 ----
# 常量改从 canvasConstants 来
used_consts = sorted(set(re.findall(r'export const (\w+)', io.open(BASE + 'canvasConstants.ts', encoding='utf-8').read())))
used_in_body = [c for c in used_consts if re.search(r'(?<![\w.])' + c + r'\b', body)]
inject = ["import { " + ', '.join(used_in_body) + " } from './canvasConstants.js';"]
# 各协作模块 import（namespace 形式，薄包装调用）
mods = sorted(set(GROUPS.keys()))
for mod in mods:
    inject.append("import * as " + mod + " from './" + mod + ".js';")
inject.append("import { buildExportSvg } from './export.js';")
inject.append("import { computeInternalLinkGeometry, rayExitRect } from './internalLinkGeometry.js';")

last_imp = max(m.end() for m in re.finditer(r"import\s[^;]*;", body, re.S) if m.start() < 6000)
body = body[:last_imp] + '\n' + '\n'.join(inject) + body[last_imp:]

io.open(p, 'w', encoding='utf-8', newline='').write(body)
print('canvas.ts rebuilt, wrappers:', len(moved))
