/**
 * 代码块语法高亮语言表（从 editor.ts 拆出）。
 *
 * 约 20 种语言，全部走**动态 import**：webview 现在是 ESM + splitting
 * （scripts/build-webview.mjs），动态 import 会被 esbuild 拆成独立 chunk，
 * 只有文档里真的出现该语言的代码块时才会请求、解析对应的语法解析器。
 *
 * 这一点对首屏很关键：这些 @lezer/lang-* 解析器加起来约 460KB（cpp / php /
 * rust / java / python / sql / go 各占几十 KB），静态 import 会把它们全部
 * 塞进入口 bundle，每个 Markdown 文件打开时都要白白编译一遍。改成懒加载后
 * 入口只剩语言描述表本身（几 KB），打开文件不再为「可能用不到的语言」买单。
 *
 * 主编辑器与导图节点 mini-CM、幻灯片块编辑器共用同一份。
 *
 * @module webview/codemirror/codeLanguages
 */

import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';

/**
 * 创建延迟加载的代码块语言描述。
 *
 * `load` 是 CodeMirror 在真正需要解析该语言时才调用的异步函数；
 * 这里返回的 Promise 由 CM 自己 await，所以可以直接用动态 import。
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
    /** 真正需要解析该语言时才执行的支持构造函数（内部动态 import）。 */
    load: () => Promise<LanguageSupport>;
}): LanguageDescription {
    return LanguageDescription.of({
        name: options.name,
        alias: options.alias,
        extensions: options.extensions,
        // LanguageDescription.load 本身就是异步契约，这里直接透传
        load: options.load,
    });
}

/**
 * 代码块语言描述表。
 *
 * 每个条目的 `load` 都会触发独立 chunk 的按需加载；顺序只影响
 * 「同名/同别名」匹配时的优先级，不影响首屏体积。
 */
export const codeLanguages: readonly LanguageDescription[] = [
    createLazyLanguageDescription({
        name: 'JavaScript',
        alias: ['js', 'jsx', 'ecmascript', 'node'],
        extensions: ['js', 'mjs', 'cjs', 'jsx'],
        load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
    }),
    createLazyLanguageDescription({
        name: 'TypeScript',
        alias: ['ts', 'tsx', 'typescriptreact'],
        extensions: ['ts', 'tsx', 'mts', 'cts'],
        load: async () =>
            (await import('@codemirror/lang-javascript')).javascript({
                typescript: true,
                jsx: true,
            }),
    }),
    createLazyLanguageDescription({
        name: 'Python',
        alias: ['py', 'py3'],
        extensions: ['py', 'pyw'],
        load: async () => (await import('@codemirror/lang-python')).python(),
    }),
    createLazyLanguageDescription({
        name: 'HTML',
        alias: ['htm', 'xhtml'],
        extensions: ['html', 'htm'],
        load: async () => (await import('@codemirror/lang-html')).html(),
    }),
    createLazyLanguageDescription({
        name: 'CSS',
        extensions: ['css'],
        load: async () => (await import('@codemirror/lang-css')).css(),
    }),
    createLazyLanguageDescription({
        name: 'JSON',
        alias: ['jsonc', 'json5'],
        extensions: ['json'],
        load: async () => (await import('@codemirror/lang-json')).json(),
    }),
    createLazyLanguageDescription({
        name: 'Java',
        extensions: ['java'],
        load: async () => (await import('@codemirror/lang-java')).java(),
    }),
    createLazyLanguageDescription({
        name: 'C++',
        alias: ['cpp', 'c', 'cc', 'cxx', 'h', 'hpp'],
        extensions: ['cpp', 'c', 'cc', 'h', 'hpp'],
        load: async () => (await import('@codemirror/lang-cpp')).cpp(),
    }),
    createLazyLanguageDescription({
        name: 'Rust',
        alias: ['rs'],
        extensions: ['rs'],
        load: async () => (await import('@codemirror/lang-rust')).rust(),
    }),
    createLazyLanguageDescription({
        name: 'Go',
        alias: ['golang'],
        extensions: ['go'],
        load: async () => (await import('@codemirror/lang-go')).go(),
    }),
    createLazyLanguageDescription({
        name: 'SQL',
        extensions: ['sql'],
        load: async () => (await import('@codemirror/lang-sql')).sql(),
    }),
    createLazyLanguageDescription({
        name: 'PHP',
        extensions: ['php'],
        load: async () => (await import('@codemirror/lang-php')).php(),
    }),
    createLazyLanguageDescription({
        name: 'XML',
        alias: ['svg', 'xsl', 'xsd'],
        extensions: ['xml', 'svg', 'xsl'],
        load: async () => (await import('@codemirror/lang-xml')).xml(),
    }),
    createLazyLanguageDescription({
        name: 'YAML',
        alias: ['yml'],
        extensions: ['yaml', 'yml'],
        load: async () => (await import('@codemirror/lang-yaml')).yaml(),
    }),
    // —— 以下为 CM5 老模式：用 StreamLanguage 包一层，同样按需加载 ——
    createLazyLanguageDescription({
        name: 'Shell',
        alias: ['bash', 'sh', 'zsh', 'ksh', 'shell'],
        extensions: ['sh', 'bash', 'zsh'],
        load: async () =>
            new LanguageSupport(
                StreamLanguage.define(
                    (await import('@codemirror/legacy-modes/mode/shell')).shell
                )
            ),
    }),
    createLazyLanguageDescription({
        name: 'PowerShell',
        alias: ['ps1', 'psm1', 'pwsh'],
        extensions: ['ps1', 'psm1'],
        load: async () =>
            new LanguageSupport(
                StreamLanguage.define(
                    (await import('@codemirror/legacy-modes/mode/powershell')).powerShell
                )
            ),
    }),
    createLazyLanguageDescription({
        name: 'Ruby',
        alias: ['rb'],
        extensions: ['rb'],
        load: async () =>
            new LanguageSupport(
                StreamLanguage.define(
                    (await import('@codemirror/legacy-modes/mode/ruby')).ruby
                )
            ),
    }),
    createLazyLanguageDescription({
        name: 'Dockerfile',
        alias: ['docker'],
        extensions: ['dockerfile'],
        load: async () =>
            new LanguageSupport(
                StreamLanguage.define(
                    (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile
                )
            ),
    }),
    createLazyLanguageDescription({
        name: 'TOML',
        extensions: ['toml'],
        load: async () =>
            new LanguageSupport(
                StreamLanguage.define(
                    (await import('@codemirror/legacy-modes/mode/toml')).toml
                )
            ),
    }),
    createLazyLanguageDescription({
        name: 'Diff',
        alias: ['patch'],
        extensions: ['diff', 'patch'],
        load: async () =>
            new LanguageSupport(
                StreamLanguage.define(
                    (await import('@codemirror/legacy-modes/mode/diff')).diff
                )
            ),
    }),
];
