# -*- coding: utf-8 -*-
"""markdownEdit.ts 按 §6.x 拆成 edit/ 六个模块。"""
import io, re

BASE = 'src/webview/mindmap/'
p = BASE + 'markdownEdit.ts'
lines = io.open(p, encoding='utf-8').read().split('\n')

decls = []
for i, l in enumerate(lines):
    m = re.match(r'^(?:export )?(?:async )?(?:function|const|interface|type|class)\s+(\w+)', l)
    if m:
        decls.append((i + 1, m.group(1)))

def doc_start(l1):
    i = l1
    while i - 1 >= 2:
        t = lines[i-2].strip()
        if t.startswith('*') or t.startswith('/') or t == '':
            i -= 1
        else:
            break
    return i

spans = {}
for idx, (l1, name) in enumerate(decls):
    s = doc_start(l1)
    e = doc_start(decls[idx + 1][0]) - 1 if idx + 1 < len(decls) else len(lines)
    while lines[e-1].strip() == '':
        e -= 1
    spans[name] = (s, e)

GROUPS = {
    'shared.ts': (['NEW_NODE_TEXT', 'EditResult', 'FoundNode', 'findNodeByUid', 'rangeOf', 'countSubtreeNodes'],
                  '公共件：EditResult / 树查找辅助'),
    'rename.ts': (['renameNode', 'isMediaKind'],
                  '§6.1 改名：heading/list/para 三种写回策略'),
    'add.ts': (['addChildNode', 'addSiblingNode', 'NewNodeSpec', 'addNode',
                'clampHeading', 'isHrLine', 'extendRangeOverHr'],
               '§6.2 新增：子节点/兄弟节点/addNode（按 spec 生成各类插入文本）'),
    'remove.ts': (['deleteNode', 'deleteNodes', 'deleteSelfKeepChildren', 'deleteChildNodes'],
                  '§6.3 删除族'),
    'clipboard.ts': (['extractSubtreeText', 'insertSubtreeFromText', 'shiftHeadingLevel'],
                     '§6.5/6.6 剪贴板：子树提取与粘贴重定级'),
    'move.ts': (['moveNode', 'insertHeadingAtEnd', 'insertHeadingAt', 'insertListItem',
                 'insertBlockLines', 'listIndentOf', 'listContentColumn', 'promoteParagraphToList',
                 'reindentLines', 'listMarkerForDrop', 'transformHeadingBlockToList',
                 'transformListBlockToHeading', 'transformHeadingBlock'],
                '§6.4 拖拽移动：moveNode + 各类型变换辅助'),
}

sym2mod = {}
for mod, (names, _) in GROUPS.items():
    for n in names:
        sym2mod[n] = mod[:-3]

# 外部 import 表
sym2src = {}
head = '\n'.join(lines[:12])
for m in re.finditer(r"import\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']+)';", head, re.S):
    for s in m.group(2).split(','):
        s = s.strip()
        if not s:
            continue
        is_type = bool(m.group(1)) or s.startswith('type ')
        nm = s[5:].strip() if s.startswith('type ') else s
        sym2src[nm] = (m.group(3), is_type)

import os
os.makedirs(BASE + 'edit', exist_ok=True)

for fname, (names, desc) in GROUPS.items():
    body = '\n\n'.join('\n'.join(lines[spans[n][0]-1:spans[n][1]]) for n in names)
    for n in names:
        body = re.sub(r'^(?!(?:export ))((?:async )?(?:function|const|let|interface|type)\s+' + n + r'\b)',
                      r'export \1', body, count=1, flags=re.M)
    # 跨块 import
    used = {}
    for nm, mod in sym2mod.items():
        if mod != fname[:-3] and re.search(r'(?<![\w.])' + re.escape(nm) + r'\b', body):
            used.setdefault(mod, []).append(nm)
    imp = ["import { " + ', '.join(sorted(v)) + " } from './" + k + ".js';" for k, v in sorted(used.items())]
    # 外部 import（types 等）
    ext = {}
    for nm, (src, is_type) in sym2src.items():
        if re.search(r'(?<![\w.])' + re.escape(nm) + r'\b', body):
            ext.setdefault((src, is_type), []).append(nm)
    for (src, is_type), names2 in sorted(ext.items()):
        # edit/ 下沉一级：'./types.js' → '../types.js'
        src2 = src.replace('./', '../', 1) if src.startswith('./') else src
        prefix = 'import type {' if is_type else 'import {'
        imp.append(prefix + ' ' + ', '.join(sorted(names2)) + " } from '" + src2 + "';")
    header = ('/**\n * 导图 Markdown 回写（从 markdownEdit.ts 拆出）：' + desc + '。\n'
              ' *\n * 全部是纯函数：输入 markdown 全文与节点信息，返回编辑结果。\n'
              ' *\n * @module webview/mindmap/edit/' + fname[:-3] + '\n */\n\n')
    io.open(BASE + 'edit/' + fname, 'w', encoding='utf-8', newline='').write(
        header + '\n'.join(imp) + '\n\n' + body + '\n')

os.remove(p)

# mindmapApp.ts 引用重接
app = BASE + 'mindmapApp.ts'
txt = io.open(app, encoding='utf-8').read()
pat = re.compile(r"import\s+(type\s+)?\{([^}]*)\}\s*from\s*'\./markdownEdit\.js';", re.S)
def repl(m):
    syms = [s.strip() for s in m.group(2).split(',') if s.strip()]
    buckets = {}
    for s in syms:
        is_type = bool(m.group(1)) or s.startswith('type ')
        nm = s[5:].strip() if s.startswith('type ') else s
        mod = sym2mod.get(nm)
        assert mod, nm
        buckets.setdefault((mod, is_type), []).append(nm)
    parts = []
    for (mod, is_type), names in sorted(buckets.items()):
        prefix = 'import type {' if is_type else 'import {'
        parts.append(prefix + ' ' + ', '.join(names) + " } from './edit/" + mod + ".js';")
    return '\n'.join(parts)
txt = pat.sub(repl, txt)
io.open(app, 'w', encoding='utf-8', newline='').write(txt)
print('markdownEdit split done')
