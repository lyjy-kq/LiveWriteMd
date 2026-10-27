# -*- coding: utf-8 -*-
"""mindmapApp.ts (3017) 彻底拆：方法组 → app/ 协作模块，类留核心 + 薄包装。"""
import io, re, json

BASE = 'src/webview/mindmap/'
p = BASE + 'mindmapApp.ts'
lines = io.open(p, encoding='utf-8').read().split('\n')

# ---------------- 成员定位（方法 + 箭头属性，支持 private async 组合） ----------------
members = []
for i, l in enumerate(lines):
    m = re.match(r'^    (?:(?:private|public)\s+)?(?:async\s+)?(\w+)\(', l)
    if m and m.group(1) not in ('if', 'for', 'while', 'switch', 'catch'):
        members.append((i + 1, m.group(1), False))
for i, l in enumerate(lines):
    if re.match(r'^    private handleWindowKeyDown = \(', l):
        members.append((i + 1, 'handleWindowKeyDown', True))
members.sort()

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
for idx, (l1, name, _) in enumerate(members):
    s = doc_start(l1) - 1
    if idx + 1 < len(members):
        e = doc_start(members[idx + 1][0]) - 1
    else:
        j = next(i for i in range(l1, len(lines)) if lines[i].startswith('}') and
                 not lines[i].startswith(' '))
        e = j
    while lines[e-1].strip() == '':
        e -= 1
    spans[name] = (s, e)

GROUPS = {
    'appSelection': (['handleNodeClick', 'toggleMultiSelection', 'applyMarqueeSelection',
                      'selectNode', 'outlineLineOf', 'clearSelection', 'resetDisplaySelections'],
                     '选中与多选：点选 / Ctrl 多选 / 框选应用 / 清选'),
    'appToolbar': (['createToolbar', 'createMultiToolbar', 'updateMultiBar', 'positionMultiBar',
                    'createAddMenu', 'createSplitMenu', 'createDeleteMenu', 'addQuick',
                    'addFromMenu', 'insertNodeSpec', 'showToolbar', 'positionToolbar'],
                   '浮动工具条：单节点工具条 / 多选操作条 / 添加-拆分-删除三级菜单 / 定位'),
    'appEditSession': (['startEdit', 'measureEditingSourceWidth', 'scheduleGrowEditingNode',
                        'cancelGrowEditingNode', 'applyInlineFormat', 'handleDisplayEdit',
                        'commitEditSession', 'refreshSplitButton', 'captureSplitSelection',
                        'splitSelection', 'finishEdit'],
                       '编辑会话状态机：startEdit/撑高/行内格式/拆分选区/finishEdit'),
    'appStructureEdit': (['commit', 'endEditBeforeStructuralOp', 'addChild', 'addSibling',
                          'deleteSelected', 'deleteFromMenu', 'deleteMultiSelected'],
                         '结构操作：commit 回写 + 增删子/兄弟节点'),
    'appClipboard': (['clipboardTargetUids', 'copySelection', 'pasteFromClipboard',
                      'armDelete', 'clearPendingDelete', 'handleExpandChange', 'expandAllNodes'],
                     '剪贴板（子树复制/粘贴）+ 删除二次确认 + 展开回调'),
    'appLinkage': (['selectNodeAtLine', 'focusLineFromEditor', 'getFocusLine0', 'selectAndCenterUid',
                    'collectHeadings', 'syncInternalLinks', 'resolveInternalLinkUid',
                    'handleInternalLinkNavigate', 'syncPerfHud', 'applySearchHighlight',
                    'findNodeUidAtLine'],
                   '大纲联动 / 内链同步 / 搜索高亮 / perfHud'),
    'appDragDrop': (['validateDropParent', 'handleDrop', 'remapUidSets', 'computeDropRemap'],
                    '拖拽落点校验与 uid 重映射'),
    'appMenus': (['createContextMenu', 'openContextMenu', 'closeContextMenu',
                  'resolveTableMenuContext', 'tablePosAtEvent', 'nearestCellPosByX',
                  'runTableMenuCommand', 'handleExport'],
                 '右键菜单（含表格菜单）+ 导图导出入口'),
    'appKeys': (['handleWindowKeyDown', 'toggleEmptyHint'],
                '全局快捷键分发 + 空文档提示'),
}

sym2mod = {}
for mod, (names, _) in GROUPS.items():
    for n in names:
        sym2mod[n] = mod

# 外部 import 表
sym2src = {}
head_region = '\n'.join(lines[:110])
for m in re.finditer(r"import\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']+)';", head_region, re.S):
    for s in m.group(2).split(','):
        s = s.strip()
        if not s:
            continue
        is_type = bool(m.group(1)) or s.startswith('type ')
        nm = s[5:].strip() if s.startswith('type ') else s
        sym2src[nm] = (m.group(3), is_type)

def dedent(t):
    return '\n'.join(l[4:] if l.startswith('    ') else l for l in t.split('\n'))

def convert(name, seg_lines):
    t = dedent('\n'.join(seg_lines))
    if name == 'handleWindowKeyDown':
        t = t.replace('private handleWindowKeyDown = (event: KeyboardEvent): void => {',
                      'export function handleWindowKeyDown(app: MindMapApp, event: KeyboardEvent): void {')
    else:
        d = next(i for i, l in enumerate(seg_lines)
                 if re.match(r'(?:(?:private|public)\s+)?(?:async\s+)?' + name + r'\(', l.strip()))
        sig = seg_lines[d].strip()
        k = d
        m = None
        while k - d < 25:
            m = re.match(r'(?:(?:private|public)\s+)?(async\s+)?' + name + r'\(([\s\S]*)\)\s*(:\s*[\s\S]*)?\{\s*$', sig)
            if m and not sig.rstrip().endswith(': {'):
                break
            k += 1
            sig += ' ' + seg_lines[k].strip()
        assert m, name
        is_async = 'async ' if m.group(1) else ''
        args = ' '.join(m.group(2).split())
        ret = (m.group(3) or ': void').strip()
        new_sig = ('export ' + is_async + 'function ' + name + '(app: MindMapApp' +
                   (', ' + args if args else '') + ') ' + ret + ' {')
        old = '\n'.join(l[4:] if l.startswith('    ') else l for l in seg_lines[d:k+1])
        assert old in t, name + ' sig not found'
        t = t.replace(old, new_sig, 1)
    t = t.replace('this.', 'app.')
    return t

def build_imports(body, own_mod):
    out = ["import type { MindMapApp } from '../mindmapApp.js';"]
    ext = {}
    for nm, (src, is_type) in sym2src.items():
        if re.search(r'(?<![\w.])' + re.escape(nm) + r'\b', body):
            ext.setdefault((src, is_type), []).append(nm)
    for (src, is_type), names in sorted(ext.items()):
        # app/ 下沉一级：相对 import 统一再退一级；裸包名（@codemirror 等）不动
        src2 = ('../' + src) if src.startswith('.') else src
        prefix = 'import type {' if is_type else 'import {'
        out.append(prefix + ' ' + ', '.join(sorted(names)) + " } from '" + src2 + "';")
    return out

import os
os.makedirs(BASE + 'app', exist_ok=True)
for mod, (names, desc) in GROUPS.items():
    body = '\n\n'.join(convert(n, lines[spans[n][0]:spans[n][1]]) for n in names)
    header = ('/**\n * MindMapApp 协作模块（从 mindmapApp.ts 拆出）：' + desc + '。\n'
              ' *\n * 全部是原 MindMapApp 方法，this 换成第一参数 app；'
              '跨模块调用走 app 上的薄包装方法。\n'
              ' *\n * @module webview/mindmap/app/' + mod + '\n */\n\n')
    io.open(BASE + 'app/' + mod + '.ts', 'w', encoding='utf-8', newline='').write(
        header + '\n'.join(build_imports(body, mod)) + '\n\n' + body + '\n')

io.open('.refactor-app-spans.json', 'w').write(json.dumps({k: list(v) for k, v in spans.items()}))
io.open('.refactor-app-groups.json', 'w').write(json.dumps({k: v[0] for k, v in GROUPS.items()}))
print('app modules written')
