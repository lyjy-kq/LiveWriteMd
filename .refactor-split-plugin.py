# -*- coding: utf-8 -*-
"""plugin.ts 保守拆：收集器/回写/树装饰各自独立，applyTreeDecorations 整体搬不切。"""
import io, re

BASE = 'src/webview/codemirror/extensions/livePreview/'
p = BASE + 'plugin.ts'
text = io.open(p, encoding='utf-8').read()
lines = text.split('\n')

# ---- 顶层声明 ----
decls = []  # (line1, name)
for i, l in enumerate(lines):
    m = re.match(r'^(?:export )?(?:async )?(?:function|const|let|class|interface)\s+(\w+)', l)
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

spans = {}  # name -> (s1, e1) 1-based inclusive
for idx, (l1, name) in enumerate(decls):
    s = doc_start(l1)
    e = doc_start(decls[idx + 1][0]) - 1 if idx + 1 < len(decls) else len(lines)
    while lines[e-1].strip() == '':
        e -= 1
    spans[name] = (s, e)

GROUPS = {
    'sourceWriteback.ts': (['replaceSourceRange', 'updateImageTitleInSource', 'updateImageWidthInSource',
                            'updateMermaidWidthInSource', 'updateMermaidTitleInSource'],
                           '源码回写助手：把 widget 上的编辑（图片宽度/标题、Mermaid 宽度/标题）写回 Markdown 源码'),
    'collectBlocks.ts': (['collectFootnoteDecorations', 'isRenderableHtmlBlock', 'collectDetailsDecorations'],
                         '块级后处理收集器：脚注引用/定义 + details 折叠块装饰'),
    'collectLinks.ts': (['HeadingAnchor', 'headingAnchorsCache', 'headingAnchorsOf', 'findHeadingPos',
                         'anchorFlashEffect', 'anchorFlashClearEffect', 'anchorFlashLineDeco', 'anchorFlashField',
                         'WIKI_INTERNAL_LINK_RE', 'WIKI_LINK_SKIP_NODES', 'collectWikiInternalLinkDecorations',
                         'SPACED_FILE_LINK_RE', 'looksLikeFilePath', 'collectSpacedFileLinkDecorations',
                         'collectFileLinkDecorations'],
                        '链接收集器：标题锚点（含闪烁 StateField）+ 文档内链 / 带空格链接 / 文件路径链接'),
    'collectInline.ts': (['collectHeadingFontDecorations', 'collectCheckboxDecorations',
                          'collectImageDecorations', 'isWidgetBackedNode', 'addImageLineDecoration'],
                         '行内收集器：标题字体标签 / 复选框 / 图片装饰'),
    'treeDecorations.ts': (['treeLikeIterateTextBlocks', 'isFoldedOf', 'headingSectionEnd',
                            'OTHER_MARKUP_NODES', 'applyTreeDecorations'],
                           '语法树全树装饰：applyTreeDecorations 巨型函数整体搬迁（内部不切）+ 其专用树/折叠工具'),
    'listIndentDecorations.ts': (['TASK_MARK_PX', 'startsNewBlock', 'collectListIndentDecorations'],
                                 '列表缩进装饰：彩虹缩进引导线 + 悬挂缩进'),
}

# ---- 符号归属 ----
sym2mod = {}
for mod, (names, _) in GROUPS.items():
    for n in names:
        sym2mod[n] = mod[:-3]

# ---- 外部 import 表（plugin.ts 头部全部 import） ----
sym2src = {}
for m in re.finditer(r"import\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']+)';", text, re.S):
    for s in m.group(2).split(','):
        s = s.strip()
        if not s:
            continue
        is_type = bool(m.group(1)) or s.startswith('type ')
        nm = s[5:].strip() if s.startswith('type ') else s
        sym2src[nm] = (m.group(3), is_type)

def ext_imports(body):
    used = {}
    for nm, (src, is_type) in sym2src.items():
        if re.search(r'(?<![\w.])' + re.escape(nm) + r'\b', body):
            used.setdefault((src, is_type), []).append(nm)
    out = []
    for (src, is_type), names in sorted(used.items()):
        prefix = 'import type {' if is_type else 'import {'
        out.append(prefix + ' ' + ', '.join(sorted(names)) + " } from '" + src + "';")
    return out

def cross_imports(body, own_mod):
    used = {}
    for nm, mod in sym2mod.items():
        if mod != own_mod and re.search(r'(?<![\w.])' + re.escape(nm) + r'\b', body):
            used.setdefault(mod, []).append(nm)
    return ["import { " + ', '.join(sorted(v)) + " } from './" + k + ".js';"
            for k, v in sorted(used.items())]

# ---- 写组文件（组内所有顶层声明强制 export） ----
for fname, (names, desc) in GROUPS.items():
    body = '\n\n'.join('\n'.join(lines[spans[n][0]-1:spans[n][1]]) for n in names)
    for n in names:
        body = re.sub(r'^(?!(?:export ))((?:async )?(?:function|const|let|class|interface)\s+' + n + r'\b)',
                      r'export \1', body, count=1, flags=re.M)
    header = ('/**\n * Live Preview 装饰管线（从 plugin.ts 拆出）：' + desc + '。\n'
              ' *\n * @module webview/codemirror/extensions/livePreview/' + fname[:-3] + '\n */\n\n')
    io.open(BASE + fname, 'w', encoding='utf-8', newline='').write(
        header + '\n'.join(cross_imports(body, fname[:-3]) + ext_imports(body)) + '\n\n' + body + '\n')

# ---- 重建 plugin.ts ----
cut = sorted(spans[n] for _, (names, _) in GROUPS.items() for n in names)
out = []
prev = 1
for s, e in cut:
    out.append('\n'.join(lines[prev-1:s-1]))
    prev = e + 1
out.append('\n'.join(lines[prev-1:]))
body = '\n'.join(out)

# plugin.ts 补 import 被搬走的符号
moved = []
for nm, mod in sorted(sym2mod.items(), key=lambda x: x[1]):
    if re.search(r'(?<![\w.])' + re.escape(nm) + r'\b', body):
        moved.append((mod, nm))
bymod = {}
for mod, nm in moved:
    bymod.setdefault(mod, []).append(nm)
inject = '\n'.join("import { " + ', '.join(sorted(v)) + " } from './" + k + ".js';"
                   for k, v in sorted(bymod.items()))
# 插到最后一个 import 之后
last_imp = max(m.end() for m in re.finditer(r"import\s[^;]*;", body, re.S) if m.start() < 4000)
body = body[:last_imp] + '\n' + inject + body[last_imp:]

io.open(p, 'w', encoding='utf-8', newline='').write(body)
print('plugin split done; plugin keeps', len([1 for d in decls if d[1] not in sym2mod]), 'decls; imports back:', {k: len(v) for k, v in bymod.items()})
