# -*- coding: utf-8 -*-
"""editor.ts 拆出 codeLanguages.ts。"""
import io, re

p = 'src/webview/codemirror/editor.ts'
text = io.open(p, encoding='utf-8').read()
lines = text.split('\n')

# 1. 先抽语言表块（原文 122-242 行，0-based 121:242）
block = '\n'.join(lines[121:242])
assert 'createLazyLanguageDescription' in block and block.rstrip().endswith('];')
del lines[121:242]

# 2. 收集要搬走的 import 行（语言包 + legacy modes）
move_imports = []
keep_lines = []
moving = False
for i, l in enumerate(lines):
    if l.startswith('// CM6 language packages'):
        moving = True
    if moving:
        move_imports.append(l)
        if "mode/diff'" in l:
            moving = False
        continue
    keep_lines.append(l)

# 3. editor.ts 主体不再用 LanguageSupport/StreamLanguage（先摘掉那行 import 再断言）
body = '\n'.join(keep_lines)
body = body.replace(
    "import { LanguageDescription, LanguageSupport, StreamLanguage, syntaxTree } from '@codemirror/language';",
    "import { LanguageDescription, syntaxTree } from '@codemirror/language';\n"
    "// 代码块语言表拆到同目录 codeLanguages.ts；re-export 保持调用方不变\n"
    "import { codeLanguages } from './codeLanguages.js';\n"
    "export { codeLanguages } from './codeLanguages.js';")
for sym in ['LanguageSupport', 'StreamLanguage']:
    assert not re.search(r'\b' + sym + r'\b', body), sym + ' still used'

# 4. 写 codeLanguages.ts
header = '''/**
 * 代码块语法高亮语言表（从 editor.ts 拆出）。
 *
 * 约 20 种语言的懒加载 LanguageDescription：直接 import 语言包而非
 * @codemirror/language-data 的动态 import()（esbuild IIFE 包里动态 import 不可用）。
 * 主编辑器与导图节点 mini-CM 共用同一份。
 *
 * @module webview/codemirror/codeLanguages
 */

import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';

'''
imports_txt = '\n'.join(move_imports).strip('\n')
io.open('src/webview/codemirror/codeLanguages.ts', 'w', encoding='utf-8', newline='').write(
    header + imports_txt + '\n\n' + block + '\n')
io.open(p, 'w', encoding='utf-8', newline='').write(body)
print('codeLanguages split done')
