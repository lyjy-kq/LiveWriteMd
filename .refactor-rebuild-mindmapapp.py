# -*- coding: utf-8 -*-
"""mindmapApp.ts 重建：挖掉已拆成员，字段放开 public，补薄包装。"""
import io, re, json

BASE = 'src/webview/mindmap/'
p = BASE + 'mindmapApp.ts'
lines = io.open(p, encoding='utf-8').read().split('\n')
spans = {k: tuple(v) for k, v in json.load(io.open('.refactor-app-spans.json')).items()}
GROUPS = json.load(io.open('.refactor-app-groups.json'))

moved = [n for names in GROUPS.values() for n in names]

cut_spans = sorted(spans[n] for n in moved)
out = []
prev = 0
for s, e in cut_spans:
    out.append('\n'.join(lines[prev:s]))
    prev = e
out.append('\n'.join(lines[prev:]))
body = '\n'.join(out)

# 字段/方法放开 public
body = re.sub(r'^(    )private ', r'\1public ', body, flags=re.M)

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
    return [x for x in (x.strip() for x in parts) if x]

orig = lines
wraps = ['\n    // ---- 薄包装：实现已拆到 app/ 协作模块，签名不变 ----']
for mod, names in GROUPS.items():
    wraps.append('    // ' + mod)
    for n in names:
        s, e = spans[n]
        seg = orig[s:e]
        if n == 'handleWindowKeyDown':
            wraps.append('    public handleWindowKeyDown = (event: KeyboardEvent): void => { appKeys.handleWindowKeyDown(this, event); };')
            continue
        d = next(i for i, l in enumerate(seg)
                 if re.match(r'(?:(?:private|public)\s+)?(?:async\s+)?' + n + r'\(', l.strip()))
        sig = seg[d].strip()
        k = d
        m = None
        while k - d < 25:
            m = re.match(r'(?:(?:private|public)\s+)?(async\s+)?' + n + r'\(([\s\S]*)\)\s*(:\s*[\s\S]*)?\{\s*$', sig)
            if m and not sig.rstrip().endswith(': {'):
                break
            k += 1
            sig += ' ' + seg[k].strip()
        assert m, n
        is_async = (m.group(1) or '').strip()
        args = ' '.join(m.group(2).split())
        ret = (m.group(3) or ': void').strip()
        argnames = ', '.join(a.split(':')[0].strip().replace('?', '') for a in split_args(args))
        call = mod + '.' + n + '(this' + (', ' + argnames if argnames else '') + ')'
        prefix = 'public ' + (is_async + ' ' if is_async else '')
        wraps.append('    {}{}({}){} {{ return {}; }}'.format(prefix, n, args, (' ' + ret) if ret else '', call))
wraps.append('')
wrapper_block = '\n'.join(wraps)

# 插到 constructor 后
blines = body.split('\n')
ctor_start = next(i for i, l in enumerate(blines) if re.match(r'    constructor\(', l))
depth = 0
ctor_end = None
for i in range(ctor_start, len(blines)):
    depth += blines[i].count('{') - blines[i].count('}')
    if depth == 0:
        ctor_end = i
        break
blines = blines[:ctor_end+1] + [wrapper_block] + blines[ctor_end+1:]
body = '\n'.join(blines)

# import 各协作模块
inject = []
for mod in sorted(GROUPS.keys()):
    inject.append("import * as " + mod + " from './app/" + mod + ".js';")
last_imp = max(m.end() for m in re.finditer(r"import\s[^;]*;", body, re.S) if m.start() < 8000)
body = body[:last_imp] + '\n' + '\n'.join(inject) + body[last_imp:]

io.open(p, 'w', encoding='utf-8', newline='').write(body)
print('mindmapApp rebuilt, wrappers:', len(moved))
