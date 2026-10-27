/**
 * 文件路径识别与位置解析测试。
 *
 * 该文件覆盖 Live Preview 中普通文本路径的识别，以及路径后缀行列范围的解析行为。
 */

import { describe, expect, it } from 'vitest';

import { findFileLinkAtText, findFileLinkMatches, parseFileLinkTarget } from './fileLink.js';

describe('findFileLinkAtText', () => {
    it('能够识别句子中的反斜杠路径与行号后缀', () => {
        const text =
            '请查看 src\\webview\\codemirror\\extensions\\livePreview\\decorations.ts:22 这一行';
        const cursorIndex = text.indexOf('decorations.ts') + 3;

        expect(findFileLinkAtText(text, cursorIndex)?.rawText).toBe(
            'src\\webview\\codemirror\\extensions\\livePreview\\decorations.ts:22'
        );
    });

    it('能够从中文标点包裹的路径中截取正确范围', () => {
        const text =
            '位置是：src/webview/codemirror/extensions/livePreview/decorations.ts:21-33。';
        const cursorIndex = text.indexOf('decorations.ts') + 5;

        expect(findFileLinkAtText(text, cursorIndex)?.target.filePath).toBe(
            'src/webview/codemirror/extensions/livePreview/decorations.ts'
        );
    });

    it('能够识别反引号包裹的路径文本', () => {
        const text =
            '请打开 `src\\webview\\codemirror\\extensions\\livePreview\\decorations.ts:22` 查看';
        const cursorIndex = text.indexOf('decorations.ts') + 1;

        expect(findFileLinkAtText(text, cursorIndex)?.target.selection?.startLine).toBe(22);
    });
});

describe('findFileLinkMatches', () => {
    it('能够提取整行中的可点击文件路径范围', () => {
        const text =
            '见 src/webview/codemirror/extensions/livePreview/decorations.ts:22 与 src/shared/fileLink.ts';

        expect(findFileLinkMatches(text).map((item) => item.rawText)).toEqual([
            'src/webview/codemirror/extensions/livePreview/decorations.ts:22',
            'src/shared/fileLink.ts',
        ]);
    });
});

describe('parseFileLinkTarget', () => {
    it('能够解析行范围后缀', () => {
        expect(parseFileLinkTarget('src\\webview\\decorations.ts:21-33')).toEqual({
            filePath: 'src\\webview\\decorations.ts',
            selection: {
                startLine: 21,
                startColumn: 1,
                endLine: 33,
                endColumn: 1,
            },
        });
    });

    it('能够解析带起止列的范围后缀', () => {
        expect(parseFileLinkTarget('src/webview/decorations.ts:21:3-33:8')).toEqual({
            filePath: 'src/webview/decorations.ts',
            selection: {
                startLine: 21,
                startColumn: 3,
                endLine: 33,
                endColumn: 8,
            },
        });
    });

    it('能够解析 Windows 绝对路径与行范围后缀', () => {
        expect(
            parseFileLinkTarget(
                'C:\\Users\\s-lyjy\\Desktop\\code\\flow-md-vsix-extracted\\src\\webview\\codemirror\\extensions\\livePreview\\decorations.ts:21-33'
            )
        ).toEqual({
            filePath:
                'C:\\Users\\s-lyjy\\Desktop\\code\\flow-md-vsix-extracted\\src\\webview\\codemirror\\extensions\\livePreview\\decorations.ts',
            selection: {
                startLine: 21,
                startColumn: 1,
                endLine: 33,
                endColumn: 1,
            },
        });
    });
});
