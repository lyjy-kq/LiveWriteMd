# -*- coding: utf-8 -*-
"""从 canvas.ts 抽出 setData 到独立模块（在 split+rebuild 之后运行）。"""
import io, re

BASE = 'src/webview/mindmap/engine/'
p = BASE + 'canvas.ts'
lines = io.open(p, encoding='utf-8').read().split('\n')

d = next(i for i, l in enumerate(lines) if re.match(r'    setData\(', l))
s = d
while lines[s-1].strip().startswith('*') or lines[s-1].strip().startswith('/'):
    s -= 1
e = d + 1
while e < len(lines):
    if re.match(r'    (?:private |public )?(?:async )?\w+\(', lines[e]):
        break
    e += 1
while lines[e-1].strip().startswith('*') or lines[e-1].strip().startswith('/') or lines[e-1].strip() == '':
    e -= 1
block = '\n'.join(lines[s:e])
del lines[s:e]
body = '\n'.join(lines)

fn = '\n'.join(l[4:] if l.startswith('    ') else l for l in block.split('\n'))
# 多行签名：setData(\n tree: ...\n opts?...\n): void {
fn = fn.replace('setData(\n    tree:', 'export function setData(\n    c: MapCanvas,\n    tree:', 1)
assert 'export function setData(' in fn
fn = fn.replace('this.', 'c.')
assert 'this.' not in fn

sym2src = {}
head = '\n'.join(lines[:80])
for m in re.finditer(r"import\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']+)';", head, re.S):
    for x in m.group(2).split(','):
        x = x.strip()
        if not x:
            continue
        is_type = bool(m.group(1)) or x.startswith('type ')
        nm = x[5:].strip() if x.startswith('type ') else x
        sym2src[nm] = (m.group(3), is_type)

imp = ["import type { MapCanvas } from './canvas.js';"]
used = {}
for nm, (src, is_type) in sym2src.items():
    if re.search(r'(?<![\w.])' + re.escape(nm) + r'\b', fn):
        used.setdefault((src, is_type), []).append(nm)
for (src, is_type), names in sorted(used.items()):
    prefix = 'import type {' if is_type else 'import {'
    imp.append(prefix + ' ' + ', '.join(sorted(names)) + " } from '" + src + "';")
consts = re.findall(r'export const (\w+)', io.open(BASE + 'canvasConstants.ts', encoding='utf-8').read())
usedc = sorted(c for c in consts if re.search(r'(?<![\w.])' + c + r'\b', fn))
if usedc:
    imp.append("import { " + ', '.join(usedc) + " } from './canvasConstants.js';")

io.open(BASE + 'setData.ts', 'w', encoding='utf-8', newline='').write('''/**
 * setData —— MapCanvas 的数据入口（从 canvas.ts 拆出）。
 *
 * 新旧模型 diff：uid 复用 + 拖拽 remap + 内容指纹认领旧 DOM/CM 实例。
 * 用旧 uid 在删除后整体前移的模型里查会漏掉兄弟子节点（历史 bug），
 * 所以认领要按新模型重建。
 *
 * @module webview/mindmap/engine/setData
 */

''' + '\n'.join(imp) + '\n\n' + fn + '\n')

# canvas.ts：import + 薄包装
inject = "import { setData as setDataImpl } from './setData.js';"
last_imp = max(m.end() for m in re.finditer(r"import\s[^;]*;", body, re.S) if m.start() < 6000)
body = body[:last_imp] + '\n' + inject + body[last_imp:]
anchor = body.find('    public bindEvents()')
wrapper = '''    /** 数据入口：新旧模型 diff + 实例认领（实现见 setData.ts）。 */
    public setData(tree: MindMapTreeNode, opts?: { uidRemap?: Map<string, string>; keepView?: boolean }) { return setDataImpl(this, tree, opts); }

'''
body = body[:anchor] + wrapper + body[anchor:]
io.open(p, 'w', encoding='utf-8', newline='').write(body)
print('setData extracted')
