# -*- coding: utf-8 -*-
"""previewOverlay.ts 拆成 overlayShell / overlayControls / imagePreview / mermaidPreview。
交叉引用（shell <-> controls <-> 入口）全部扫描自动补 import。"""
import io, re

BASE = 'src/webview/codemirror/extensions/livePreview/'
lines = io.open(BASE + 'previewOverlay.ts', encoding='utf-8').read().split('\n')

def block(a, b):
    return '\n'.join(lines[a-1:b])

# 外部符号表（import 区 8-17 行）
import_region = '\n'.join(lines[7:17])
sym2src = {}
for m in re.finditer(r"import\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']+)';", import_region, re.S):
    for s in m.group(2).split(','):
        s = s.strip()
        if not s:
            continue
        is_type = bool(m.group(1)) or s.startswith('type ')
        name = s[5:].strip() if s.startswith('type ') else s
        sym2src[name] = (m.group(3), is_type)

# ---- 切块 ----
shell_body = '\n\n'.join(p.strip('\n') for p in
                         [block(22, 131), block(155, 572), block(928, 1038)])
mermaid_consts = block(132, 154)
controls_body = block(573, 927).strip('\n')
image_body = block(1039, 1124).strip('\n') \
    .replace('activeOverlayRoot = mounted;', 'setActiveOverlayRoot(mounted);')
mermaid_body = (mermaid_consts + '\n\n' + block(1125, len(lines))).strip('\n') \
    .replace('activeOverlayRoot = mountOverlayRoot(options.mountHost, root, options.themeScope);',
             'setActiveOverlayRoot(mountOverlayRoot(options.mountHost, root, options.themeScope));')

# shell 追加 setter
shell_body += '''

/**
 * 登记当前激活的浮层根节点（全局只允许一个浮层）。
 * 两个入口（imagePreview / mermaidPreview）挂载后通过它登记，
 * closeActivePreviewOverlay 据此关闭。
 */
export function setActiveOverlayRoot(root: HTMLElement | null): void {
    activeOverlayRoot = root;
}'''

# shell 里非 export 但被别块需要的成员要导出
for name in ['closeActivePreviewOverlay', 'flashButtonState', 'showPreviewActionStatus',
             'resolvePreviewTitle', 'bindEditablePreviewTitle', 'readSvgCanvasSize',
             'normalizeSvgMarkup', 'mountOverlayRoot', 'createOverlayShell']:
    shell_body = re.sub(r'(?<!export )(?<!export async )function ' + name + r'\(',
                        'export function ' + name + '(', shell_body)
for name in ['attachPanZoom', 'queuePreviewFit']:
    controls_body = re.sub(r'(?<!export )function ' + name + r'\(',
                           'export function ' + name + '(', controls_body)
# attachPanZoom 是多行签名
controls_body = controls_body.replace('export function attachPanZoom(viewport: HTMLElement, stage: HTMLElement): {',
                                      'export function attachPanZoom(viewport: HTMLElement, stage: HTMLElement): {')
# interface PreviewActionOptions / PreviewTitleOptions / ImagePreviewOverlayOptions / MermaidPreviewOverlayOptions 导出
for name in ['PreviewActionOptions', 'PreviewTitleOptions']:
    shell_body = shell_body.replace('interface ' + name, 'export interface ' + name)

def exports_of(body):
    return set(re.findall(r'export (?:async )?(?:function|const|interface|class)\s+(\w+)', body)) | \
           set(re.findall(r'export interface\s+(\w+)', body))

shell_exports = exports_of(shell_body)
controls_exports = exports_of(controls_body)

def cross_imports(body, exports, mod):
    used = sorted(n for n in exports if re.search(r'(?<![\w.])' + re.escape(n) + r'\b', body))
    if not used:
        return ''
    return "import { " + ', '.join(used) + " } from './" + mod + ".js';"

def ext_imports(body):
    used = {}
    for name, (src, is_type) in sym2src.items():
        if re.search(r'(?<![\w.])' + re.escape(name) + r'\b', body):
            used.setdefault((src, is_type), []).append(name)
    out = []
    for (src, is_type), names in sorted(used.items()):
        prefix = 'import type {' if is_type else 'import {'
        out.append(prefix + ' ' + ', '.join(sorted(names)) + " } from '" + src + "';")
    return out

def write(fname, desc, body, extra):
    header = ('/**\n * 预览浮层（从 previewOverlay.ts 拆出）：' + desc + '。\n'
              ' *\n * @module webview/codemirror/extensions/livePreview/' + fname[:-3] + '\n */\n\n')
    io.open(BASE + fname, 'w', encoding='utf-8', newline='').write(
        header + '\n'.join(extra) + '\n\n' + body + '\n')

# shell 与 controls 互查（可能双向）
shell_from_controls = cross_imports(shell_body, controls_exports, 'overlayControls')
controls_from_shell = cross_imports(controls_body, shell_exports, 'overlayShell')

write('overlayShell.ts', '共享基础设施：单例状态、关闭、标题、SVG 工具、浮层外壳', shell_body,
      ext_imports(shell_body) + ([shell_from_controls] if shell_from_controls else []))
write('overlayControls.ts', '操作按钮组与拖拽缩放（attachPanZoom）', controls_body,
      ext_imports(controls_body) + ([controls_from_shell] if controls_from_shell else []))
write('imagePreview.ts', '图片预览入口 openImagePreviewOverlay', image_body,
      ext_imports(image_body) + [cross_imports(image_body, shell_exports, 'overlayShell'),
                                 cross_imports(image_body, controls_exports, 'overlayControls')])
write('mermaidPreview.ts', 'Mermaid 预览入口 openMermaidPreviewOverlay + 失败兜底', mermaid_body,
      ext_imports(mermaid_body) + [cross_imports(mermaid_body, shell_exports, 'overlayShell'),
                                   cross_imports(mermaid_body, controls_exports, 'overlayControls')])

import os
os.remove(BASE + 'previewOverlay.ts')
print('shell<-controls:', shell_from_controls)
print('controls<-shell:', controls_from_shell)
print('overlay split done')
