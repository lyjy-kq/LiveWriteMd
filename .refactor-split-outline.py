# -*- coding: utf-8 -*-
"""拆分 outlinePanel.ts：以「下一个成员的文档注释起点」为块尾。"""
import io, re

p = 'src/webview/outline/outlinePanel.ts'
lines = io.open(p, encoding='utf-8').read().split('\n')

# 所有类成员（方法）声明行
decls = []  # (decl_line_idx, name)
for i, l in enumerate(lines):
    m = re.match(r'    (?:private|public) (?:async )?(\w+)\(', l)
    if m and m.group(1) not in ('if', 'for', 'while', 'switch', 'catch'):
        decls.append((i, m.group(1)))

def doc_start(d):
    s = d
    while s - 1 >= 0 and (lines[s-1].strip().startswith('*') or lines[s-1].strip().startswith('/**')):
        s -= 1
    return s

starts = sorted(doc_start(d) for d, _ in decls)

def block_of(name):
    d = next(i for i, n in decls if n == name)
    s = doc_start(d)
    nxt = next((x for x in starts if x > d), None)
    e = nxt if nxt is not None else len(lines) - 1
    while e - 1 > d and lines[e-1].strip() == '':
        e -= 1
    return s, e  # [s, e)

GROUPS = {
    'outlineHeadingParse.ts': ['parseHeadings', 'pushHeadingNode', 'normalizeHeadingText'],
    'outlineRender.ts': ['render', 'renderNodes', 'findActiveNodeId', 'syncActiveState',
                         'buildToggleIcon', 'buildIndentGuides'],
    'outlineActionBar.ts': ['resolveActionBarElement', 'resolveActionButton', 'buildActionGlyph',
                            'resolveTooltipElement', 'scheduleTooltip', 'cancelTooltipTimer',
                            'showTooltip', 'positionTooltip', 'hideTooltip',
                            'restoreScrollPosition', 'updateActionBarState', 'escapeHtml'],
    'outlineEvents.ts': ['bindEvents'],
}

extracted = {}
for fname, names in GROUPS.items():
    for n in names:
        s, e = block_of(n)
        extracted[n] = '\n'.join(lines[s:e])

HEADERS = {
    'outlineHeadingParse.ts': '''/**
 * 大纲面板：Markdown 标题解析（从 outlinePanel.ts 拆出）。
 *
 * 三个函数互相调用、只依赖入参，是类里唯一的纯逻辑块。
 * OutlineNode 类型留在 outlinePanel.ts（面板与渲染都用），type-only 导入。
 *
 * @module webview/outline/outlineHeadingParse
 */

import type { OutlineNode } from './outlinePanel.js';
''',
    'outlineRender.ts': '''/**
 * 大纲面板：标题树渲染（从 outlinePanel.ts 拆出）。
 *
 * 全部是把 this 换成 panel 的原类方法；字段直读直写（panel 字段已放开
 * 为 public），跨模块调用仍走 panel 上的薄包装方法。
 *
 * @module webview/outline/outlineRender
 */

import type { OutlinePanel, OutlineNode } from './outlinePanel.js';
''',
    'outlineActionBar.ts': '''/**
 * 大纲面板：底部操作栏与悬浮提示（从 outlinePanel.ts 拆出）。
 *
 * 编号操作栏（编号/去编号按钮）+ 标题 hover tooltip。
 * 同 outlineRender：原类方法把 this 换成 panel。
 *
 * @module webview/outline/outlineActionBar
 */

import type { OutlinePanel } from './outlinePanel.js';
''',
    'outlineEvents.ts': '''/**
 * 大纲面板：事件装配（从 outlinePanel.ts 拆出）。
 *
 * bindEvents 一个方法独占：拖拽调宽、点击折叠/跳转、hover 提示的
 * 事件监听全在这里登记。
 *
 * @module webview/outline/outlineEvents
 */

import type { OutlinePanel } from './outlinePanel.js';
''',
}

def convert(name, text, panel_first):
    t = text
    t = '\n'.join(l[4:] if l.startswith('    ') else l for l in t.split('\n'))
    if panel_first:
        pat = r'private (async )?' + name + r'\(([^)]*)\)'
        def sig_repl(m):
            inner = m.group(2)
            suffix = (', ' + inner) if inner.strip() else ''
            return 'export ' + (m.group(1) or '') + 'function ' + name + '(panel: OutlinePanel' + suffix + ')'
        t = re.sub(pat, sig_repl, t, count=1)
        t = t.replace('this.', 'panel.')
    else:
        pat = r'private (async )?' + name + r'\('
        def sig_repl2(m):
            return 'export ' + (m.group(1) or '') + 'function ' + name + '('
        t = re.sub(pat, sig_repl2, t, count=1)
        for n in GROUPS['outlineHeadingParse.ts']:
            t = t.replace('this.' + n + '(', n + '(')
    return t

for fname, names in GROUPS.items():
    panel_first = fname != 'outlineHeadingParse.ts'
    body = '\n\n'.join(convert(n, extracted[n], panel_first) for n in names)
    io.open('src/webview/outline/' + fname, 'w', encoding='utf-8', newline='').write(
        HEADERS[fname] + '\n' + body + '\n')

# ---------- 重建 outlinePanel.ts ----------
spans = sorted((block_of(n)[0], block_of(n)[1], n) for f, names in GROUPS.items() for n in names)
out = []
prev = 0
for s, e, n in spans:
    out.append('\n'.join(lines[prev:s]))
    prev = e
out.append('\n'.join(lines[prev:]))
body = ''.join(out)

# 字段区 private → public（拆出去的模块直接读写）
body = re.sub(r'^(    )private ([\w]+\s*[:=])', lambda m: m.group(1) + 'public ' + m.group(2),
              body, flags=re.M)

# 薄包装：照原签名生成，方法体转调提取出的自由函数
def split_args(args):
    """按顶层逗号切参数（泛型 Map<string, number> 里的逗号不算）。"""
    parts, depth, cur = [], 0, ''
    for ch in args:
        if ch in '<([{':
            depth += 1
        elif ch in '>)]}':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(cur)
            cur = ''
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return parts

wraps = []
for fname, names in GROUPS.items():
    panel_first = fname != 'outlineHeadingParse.ts'
    for n in names:
        d = next(i for i, nn in decls if nn == n)
        # 签名可能跨行（如 pushHeadingNode），先拼到配平的右括号
        sig_text = lines[d].strip()
        k = d
        while sig_text.count('(') > sig_text.count(')'):
            k += 1
            sig_text += ' ' + lines[k].strip()
        m = re.match(r'private (async )?(\w+)\(([\s\S]*?)\)(: [^{\n]+)?\{?', sig_text)
        args = ' '.join(m.group(3).split())
        ret = (m.group(4) or ': void').strip()
        argnames = ', '.join(a.split(':')[0].strip() for a in split_args(args) if a.strip())
        callee_args = (argnames + ', ') if argnames else ''
        if panel_first:
            call = '{}(this, {})'.format(n, argnames) if argnames else '{}(this)'.format(n)
        else:
            call = '{}({})'.format(n, argnames)
        wraps.append(
            '    private {}({}){} {{\n        return {};\n    }}'.format(
                n, args, ' ' + ret, call))
wrapper_block = ('    // ---- 薄包装：实现已拆到同目录 outlineXxx.ts，签名不变 ----\n'
                 + '\n'.join(wraps) + '\n\n')
anchor = body.find('    public setContent(')
doc = body.rfind('    /**', 0, anchor)
body = body[:doc] + wrapper_block + body[doc:]

imports_add = ("import { parseHeadings, pushHeadingNode, normalizeHeadingText } from './outlineHeadingParse.js';\n"
               "import { render, renderNodes, findActiveNodeId, syncActiveState, buildToggleIcon, buildIndentGuides } from './outlineRender.js';\n"
               "import {\n"
               "    resolveActionBarElement, resolveActionButton, buildActionGlyph,\n"
               "    resolveTooltipElement, scheduleTooltip, cancelTooltipTimer,\n"
               "    showTooltip, positionTooltip, hideTooltip,\n"
               "    restoreScrollPosition, updateActionBarState, escapeHtml,\n"
               "} from './outlineActionBar.js';\n"
               "import { bindEvents } from './outlineEvents.js';\n")
body = body.replace("import { settingsState } from '../settings/settingsState.js';",
                    "import { settingsState } from '../settings/settingsState.js';\n" + imports_add)

io.open(p, 'w', encoding='utf-8', newline='').write(body)
print('outlinePanel rebuilt')
