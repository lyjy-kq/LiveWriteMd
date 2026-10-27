# -*- coding: utf-8 -*-
"""canvas.ts (3975) 彻底拆：MapCanvas 方法组 → engine/ 协作模块，类留核心 + 薄包装。"""
import io, re

BASE = 'src/webview/mindmap/engine/'
p = BASE + 'canvas.ts'
lines = io.open(p, encoding='utf-8').read().split('\n')

# ---------------- 成员定位 ----------------
# 方法声明（4 空格缩进）+ 唯一的箭头属性 handleWheel
members = []  # (line1, name, is_arrow)
for i, l in enumerate(lines):
    m = re.match(r'^    (?:private |public )?(?:async )?(\w+)\(', l)
    if m:
        members.append((i + 1, m.group(1), False))
m = None
for i, l in enumerate(lines):
    if re.match(r'^    private handleWheel = \(', l):
        members.append((i + 1, 'handleWheel', True))
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

spans = {}  # name -> [s, e) 0-based
for idx, (l1, name, _) in enumerate(members):
    s = doc_start(l1) - 1
    e = doc_start(members[idx + 1][1 - 1]) - 1 if False else None
    if idx + 1 < len(members):
        e = doc_start(members[idx + 1][0]) - 1
    else:
        # 最后一个成员：到类收尾
        j = next(i for i in range(l1, len(lines)) if lines[i] == '}')
        e = j
    while lines[e-1].strip() == '':
        e -= 1
    spans[name] = (s, e)

# ---------------- 分组 ----------------
GROUPS = {
    'displayPool': (['ensureWrapper', 'refreshWrapperClasses', 'ensureContent', 'placeholderTextOf',
                     'createDisplay', 'setPlaceholder', 'measureNode', 'measureNodes',
                     'scheduleMeasureSettle', 'settleMounted', 'remeasureAll', 'refreshNode',
                     'finishEditDisplay', 'setNodeWidth', 'ensureEditDisplay', 'growNodeHeight',
                     'enforceDisplayCap', 'enqueueSwap', 'interactionActive', 'schedulePump', 'resumePump'],
                    '显示实例生命周期：wrapper/mini-CM 创建、测量、编辑态尺寸、LRU 淘汰与换真泵（性能打磨核心区，整体搬迁）'),
    'mounting': (['mountNode', 'unmountNode', 'positionNode', 'updateViewport',
                  'scheduleViewport', 'schedulePrewarm'],
                 '挂载与虚拟化：视口双圈挂载卸载、空闲预热'),
    'viewport': (['setZoomRenderThresholds', 'directTier', 'tierForZoom', 'syncRenderTier',
                  'applyRenderTier', 'setDisplayCacheEnabled', 'setGestureCrisp', 'setVirtualization',
                  'applyTransform', 'markZooming', 'scheduleWorldLayer', 'viewSize', 'getBounds',
                  'screenToWorld', 'zoomAt', 'fit', 'setZoomPercent', 'getNodeAtViewportCenter',
                  'centerOn', 'getNodeRect'],
                 '视口与渲染档：transform/缩放/fit + 缩放降级档管理'),
    'links': (['relayout', 'syncLinksExtent', 'syncLinks', 'updateLinksVisibility',
               'updateInternalLinksVisibility', 'updateInternalLinkEmphasis', 'syncInternalLinks',
               'syncExpandButtons', 'updateExpandButtonsVisibility'],
              '连线与展开按钮：树连线、内链箭头层、展开按钮同步'),
    'minimap': (['scheduleMinimap', 'minimapGeometry', 'drawMinimap', 'minimapScreenToWorld',
                 'handleMinimapPointerDown', 'handleMinimapPointerMove', 'handleMinimapPointerUp',
                 'minimapJumpTo'],
                '缩略图：几何、离屏 raster 缓存绘制、指针跳转'),
    'pointer': (['bindEvents', 'handlePointerDown', 'openLinkAt', 'capturePointer', 'handlePointerMove',
                 'updateMarquee', 'updateDrag', 'startAutoPan', 'stopAutoPan', 'updateDropCandidate',
                 'canDrop', 'handlePointerUp', 'handlePointerCancel', 'finishDrag', 'handleWheel',
                 'handleDoubleClick', 'handleLayerClick'],
                '指针交互：事件装配、平移/节点/框选三分支、拖拽与自动平移、滚轮缩放、双击'),
    'flags': (['setNodeExpand', 'applyExpandLevel', 'expandAll', 'revealUid', 'setSelected',
               'setInternalLinks', 'flashNode', 'setMultiSelected', 'getMultiSelected', 'setEditing',
               'setNodeExpandedFlag', 'isNodeClamped', 'setSearchHighlight', 'remapFlags', 'setTheme'],
              '外观状态标志：选中/多选/编辑/搜索高亮/展开层级/主题'),
}
# buildExportSvg 并入 export.ts；几何纯函数进 internalLinkGeometry.ts

sym2mod = {}
for mod, (names, _) in GROUPS.items():
    for n in names:
        sym2mod[n] = mod
sym2mod['buildExportSvg'] = 'export'
sym2mod['computeInternalLinkGeometry'] = 'internalLinkGeometry'
sym2mod['rayExitRect'] = 'internalLinkGeometry'

# ---------------- 常量块（46-143）→ canvasConstants.ts ----------------
const_block = '\n'.join(lines[45:143])
const_block = re.sub(r'^const ', 'export const ', const_block, flags=re.M)
io.open(BASE + 'canvasConstants.ts', 'w', encoding='utf-8', newline='').write('''/**
 * MapCanvas 的调参常量（从 canvas.ts 拆出）。
 *
 * 全部是性能/交互调参：显示实例缓存上限、换真泵节奏、视口余量、
 * 缩略图尺寸、缩放档位阈值等。canvas.ts 与各协作模块共用。
 *
 * @module webview/mindmap/engine/canvasConstants
 */

''' + const_block + '\n')

const_names = re.findall(r'export const (\w+)', const_block)

# ---------------- 类型区：接口导出（协作模块要 import type） ----------------
# 146-300 行保留在 canvas.ts，但接口名改 export（原本部分未导出）
for i in range(145, 301):
    if re.match(r'^interface ', lines[i]):
        lines[i] = 'export ' + lines[i]

# ---------------- 模块代码生成 ----------------
def dedent(t):
    return '\n'.join(l[4:] if l.startswith('    ') else l for l in t.split('\n'))

def convert(name, text):
    t = dedent(text)
    # 签名改写
    s, e = spans[name]
    decl_line = lines[s:e]
    if name == 'handleWheel':
        t = t.replace('private handleWheel = (event: WheelEvent): void => {',
                      'export function handleWheel(c: MapCanvas, event: WheelEvent): void {')
    else:
        # 拼签名到配平右括号
        d = next(i for i, l in enumerate(decl_line) if re.match(r'(?:private |public )?(?:async )?' + name + r'\(', l.strip()))
        sig = decl_line[d].strip()
        k = d
        m = None
        while k - d < 25:
            # 返回类型贪婪匹配到最后一个 { 为止（兼容多行对象字面量返回类型）
            m = re.match(r'(?:private |public )?(async )?' + name + r'\(([\s\S]*)\)\s*(:\s*[\s\S]*)?\{\s*$', sig)
            if m and not sig.rstrip().endswith(": {"):
                break
            k += 1
            sig += ' ' + decl_line[k].strip()
        assert m, name
        is_async = 'async ' if m.group(1) else ''
        args = ' '.join(m.group(2).split())
        ret = (m.group(3) or ': void').strip()
        new_sig = 'export ' + is_async + 'function ' + name + '(c: MapCanvas' + (', ' + args if args else '') + ')' + (' ' + ret if ret else '') + ' {'
        old_sig_lines = '\n'.join(decl_line[d:k+1])
        # t 已 dedent，old_sig 也要去同样缩进再替换
        old_sig_dedent = '\n'.join(l[4:] if l.startswith('    ') else l for l in decl_line[d:k+1])
        assert old_sig_dedent in t, name + ' sig not found after dedent'
        t = t.replace(old_sig_dedent, new_sig, 1)
    t = t.replace('this.', 'c.')
    return t

# 外部符号表：canvas.ts 头部 import（1-45 行 + 146 之前的类型 import）
sym2src = {}
head_region = '\n'.join(lines[:45])
for m in re.finditer(r"import\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']+)';", head_region, re.S):
    for s in m.group(2).split(','):
        s = s.strip()
        if not s:
            continue
        is_type = bool(m.group(1)) or s.startswith('type ')
        nm = s[5:].strip() if s.startswith('type ') else s
        sym2src[nm] = (m.group(3), is_type)

# canvas.ts 的类型接口（type-only 引用回 canvas）
canvas_types = ['DropPayload', 'MapCanvasOptions', 'PointerState', 'DropCandidate', 'DragState',
                'DisplayEntry', 'RenderTier']

def build_imports(body, own_mod):
    out = []
    # 常量
    used_consts = sorted(n for n in const_names if re.search(r'(?<![\w.])' + n + r'\b', body))
    if used_consts:
        out.append("import { " + ', '.join(used_consts) + " } from './canvasConstants.js';")
    # canvas 类型 + 跨模块函数
    used_types = sorted(n for n in canvas_types if re.search(r'(?<![\w.])' + re.escape(n) + r'\b', body))
    used_fns = sorted(n for n, mod in sym2mod.items() if mod != own_mod and
                      re.search(r'(?<![\w.])' + re.escape(n) + r'\b', body))
    # 跨模块函数引用：统一从 canvas.js 拿（类上有薄包装，运行时等同）——
    # 但 type-only 与值 import 要分开；函数走 canvas.js 的 wrapper 会循环依赖！
    # 所以跨模块函数直接按归属模块 import。
    bymod = {}
    for n in used_fns:
        bymod.setdefault(sym2mod[n], []).append(n)
    for mod, names in sorted(bymod.items()):
        out.append("import { " + ', '.join(names) + " } from './" + mod + ".js';")
    if used_types:
        out.append("import type { " + ', '.join(used_types) + " } from './canvas.js';")
    # MapCanvas 本体类型
    out.append("import type { MapCanvas } from './canvas.js';")
    # 外部包/其他模块
    ext = {}
    for nm, (src, is_type) in sym2src.items():
        if re.search(r'(?<![\w.])' + re.escape(nm) + r'\b', body):
            ext.setdefault((src, is_type), []).append(nm)
    for (src, is_type), names in sorted(ext.items()):
        prefix = 'import type {' if is_type else 'import {'
        out.append(prefix + ' ' + ', '.join(sorted(names)) + " } from '" + src + "';")
    return out

# 跨模块调用形式修正：被抽走的函数在别的模块里是 c.method(...) 调用形态，
# 但在「目标模块自身以外」的模块里，c.method 调用 wrapper 即可（wrapper 留在类上）。
# 因此函数体里的 c.xxx(...) 不需要改 —— wrapper 全覆盖。

for mod, (names, desc) in GROUPS.items():
    body = '\n\n'.join(convert(n, '\n'.join(lines[spans[n][0]:spans[n][1]])) for n in names)
    header = ('/**\n * MapCanvas 协作模块（从 canvas.ts 拆出）：' + desc + '。\n'
              ' *\n * 全部是原 MapCanvas 方法，this 换成第一参数 c；'
              '跨模块调用走 c 上的薄包装方法，行为与拆前完全一致。\n'
              ' *\n * @module webview/mindmap/engine/' + mod + '\n */\n\n')
    imps = [x for x in build_imports(body, mod) if not x.startswith("import { " + ', '.join([]) )]
    # 移除对自身模块的 import
    imps = [x for x in imps if ("./" + mod + ".js") not in x]
    io.open(BASE + mod + '.ts', 'w', encoding='utf-8', newline='').write(
        header + '\n'.join(imps) + '\n\n' + body + '\n')

# buildExportSvg → export.ts 追加
s, e = spans['buildExportSvg']
svg_body = convert('buildExportSvg', '\n'.join(lines[s:e]))
exp_file = BASE + 'export.ts'
exp_txt = io.open(exp_file, encoding='utf-8').read()
exp_txt += '\n\n// =============================================================================\n'
exp_txt += '// SVG 导出构建（从 canvas.ts 拆出，原 MapCanvas.buildExportSvg 方法）\n'
exp_txt += '// =============================================================================\n\n' + svg_body + '\n'
io.open(exp_file, 'w', encoding='utf-8', newline='').write(exp_txt)

# 几何纯函数 → internalLinkGeometry.ts（原本就是模块级，无 this）
geo_start = next(i for i, l in enumerate(lines) if l.startswith('function computeInternalLinkGeometry'))
# 带上文档注释
gs = geo_start
while lines[gs-1].strip().startswith('*') or lines[gs-1].strip().startswith('/'):
    gs -= 1
geo_body = '\n'.join(lines[gs:]).strip('\n')
geo_body = re.sub(r'^function ', 'export function ', geo_body, flags=re.M)
io.open(BASE + 'internalLinkGeometry.ts', 'w', encoding='utf-8', newline='').write('''/**
 * 内链箭头几何（从 canvas.ts 拆出）：贝塞尔箭头路径与矩形出射线，纯函数。
 *
 * @module webview/mindmap/engine/internalLinkGeometry
 */

''' + geo_body + '\n')

import json
io.open('.refactor-canvas-spans.json', 'w').write(json.dumps({k: v for k, v in spans.items()}))
io.open('.refactor-canvas-groups.json', 'w').write(json.dumps({k: v[0] for k, v in GROUPS.items()}))
print('modules written')
