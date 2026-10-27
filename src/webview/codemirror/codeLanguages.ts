/**
 * 代码块语法高亮语言表（从 editor.ts 拆出）。
 *
 * 约 20 种语言的懒加载 LanguageDescription：直接 import 语言包而非
 * @codemirror/language-data 的动态 import()（esbuild IIFE 包里动态 import 不可用）。
 * 主编辑器与导图节点 mini-CM 共用同一份。
 *
 * @module webview/codemirror/codeLanguages
 */

import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';

// CM6 language packages (static imports for IIFE bundle compatibility)
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { sql } from '@codemirror/lang-sql';
import { php } from '@codemirror/lang-php';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';

// Legacy modes (CM5 → CM6 via StreamLanguage)
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { diff } from '@codemirror/legacy-modes/mode/diff';

/**
 * 创建延迟加载的代码块语言描述。
 *
 * @param options - 语言名称、别名、扩展名与加载函数。
 * @returns CodeMirror 可识别的语言描述。
 */
function createLazyLanguageDescription(options: {
    /** 语言展示名称。 */
    name: string;
    /** 代码块 info 字符串可使用的别名。 */
    alias?: string[];
    /** 文件扩展名提示。 */
    extensions?: string[];
    /** 真正需要解析该语言时才执行的支持构造函数。 */
    load: () => LanguageSupport;
}): LanguageDescription {
    return LanguageDescription.of({
        name: options.name,
        alias: options.alias,
        extensions: options.extensions,
        load: async () => options.load(),
    });
}

/**
 * Statically-loaded language descriptions for fenced code block syntax highlighting.
 * Uses direct imports instead of @codemirror/language-data's dynamic import()
 * which doesn't work in esbuild IIFE bundles.
 */
// 导出给后续 mini-CM（导图节点内嵌编辑器）复用：与主编辑器同一套懒加载语言表
export const codeLanguages: readonly LanguageDescription[] = [
    createLazyLanguageDescription({
        name: 'JavaScript',
        alias: ['js', 'jsx', 'ecmascript', 'node'],
        extensions: ['js', 'mjs', 'cjs', 'jsx'],
        load: () => javascript({ jsx: true }),
    }),
    createLazyLanguageDescription({
        name: 'TypeScript',
        alias: ['ts', 'tsx'],
        extensions: ['ts', 'tsx', 'mts', 'cts'],
        load: () => javascript({ typescript: true, jsx: true }),
    }),
    createLazyLanguageDescription({
        name: 'Python',
        alias: ['py'],
        extensions: ['py', 'pyw'],
        load: () => python(),
    }),
    createLazyLanguageDescription({
        name: 'HTML',
        alias: ['htm'],
        extensions: ['html', 'htm'],
        load: () => html(),
    }),
    createLazyLanguageDescription({ name: 'CSS', extensions: ['css'], load: () => css() }),
    createLazyLanguageDescription({
        name: 'JSON',
        alias: ['jsonc'],
        extensions: ['json'],
        load: () => json(),
    }),
    createLazyLanguageDescription({ name: 'Java', extensions: ['java'], load: () => java() }),
    createLazyLanguageDescription({
        name: 'C++',
        alias: ['cpp', 'c', 'cc', 'cxx', 'h', 'hpp'],
        extensions: ['cpp', 'c', 'cc', 'h', 'hpp'],
        load: () => cpp(),
    }),
    createLazyLanguageDescription({ name: 'Rust', alias: ['rs'], extensions: ['rs'], load: () => rust() }),
    createLazyLanguageDescription({ name: 'Go', alias: ['golang'], extensions: ['go'], load: () => go() }),
    createLazyLanguageDescription({ name: 'SQL', extensions: ['sql'], load: () => sql() }),
    createLazyLanguageDescription({ name: 'PHP', extensions: ['php'], load: () => php() }),
    createLazyLanguageDescription({
        name: 'XML',
        alias: ['svg', 'xsl', 'xsd'],
        extensions: ['xml', 'svg', 'xsl'],
        load: () => xml(),
    }),
    createLazyLanguageDescription({
        name: 'YAML',
        alias: ['yml'],
        extensions: ['yaml', 'yml'],
        load: () => yaml(),
    }),
    createLazyLanguageDescription({
        name: 'Shell',
        alias: ['bash', 'sh', 'zsh', 'ksh'],
        extensions: ['sh', 'bash', 'zsh'],
        load: () => new LanguageSupport(StreamLanguage.define(shell)),
    }),
    createLazyLanguageDescription({
        name: 'PowerShell',
        alias: ['ps1', 'psm1', 'pwsh'],
        extensions: ['ps1', 'psm1'],
        load: () => new LanguageSupport(StreamLanguage.define(powerShell)),
    }),
    createLazyLanguageDescription({
        name: 'Ruby',
        alias: ['rb'],
        extensions: ['rb'],
        load: () => new LanguageSupport(StreamLanguage.define(ruby)),
    }),
    createLazyLanguageDescription({
        name: 'Dockerfile',
        alias: ['docker'],
        extensions: ['dockerfile'],
        load: () => new LanguageSupport(StreamLanguage.define(dockerFile)),
    }),
    createLazyLanguageDescription({
        name: 'TOML',
        extensions: ['toml'],
        load: () => new LanguageSupport(StreamLanguage.define(toml)),
    }),
    createLazyLanguageDescription({
        name: 'Diff',
        alias: ['patch'],
        extensions: ['diff', 'patch'],
        load: () => new LanguageSupport(StreamLanguage.define(diff)),
    }),
];
