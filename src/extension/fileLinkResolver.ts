/**
 * 扩展侧文件路径解析器。
 *
 * 该模块负责把 webview 传来的原始路径文本解析为最终文件路径，并根据
 * 当前文档目录优先、workspace 根目录回退的顺序决定实际要打开的目标文件。
 */

import * as path from 'path';

import {
    parseFileLinkTarget,
    type FileLinkSelection,
    type ParsedFileLinkTarget,
} from '../shared/link/fileLink.js';

/**
 * 最终解析出的文件跳转结果。
 */
export interface ResolvedFileLinkTarget {
    /** 最终用于打开文件的绝对路径。 */
    filePath: string;
    /** 可选的跳转范围。 */
    selection: FileLinkSelection | null;
}

/**
 * 为原始路径文本生成候选文件路径列表。
 *
 * @param parsedTarget - 已拆分出的路径与位置后缀
 * @param documentPath - 当前 Markdown 文档绝对路径
 * @param workspacePaths - 当前文档所属 workspace 的根路径列表
 * @returns 按优先级排列的候选绝对路径
 */
function buildCandidatePaths(
    parsedTarget: ParsedFileLinkTarget,
    documentPath: string,
    workspacePaths: string[]
): string[] {
    if (path.isAbsolute(parsedTarget.filePath)) {
        return [path.normalize(parsedTarget.filePath)];
    }

    const candidatePaths: string[] = [
        path.resolve(path.dirname(documentPath), parsedTarget.filePath),
    ];

    for (const workspacePath of workspacePaths) {
        const workspaceCandidate = path.resolve(workspacePath, parsedTarget.filePath);
        if (!candidatePaths.includes(workspaceCandidate)) {
            candidatePaths.push(workspaceCandidate);
        }
    }

    return candidatePaths;
}

/**
 * 把原始路径文本解析为最终文件路径与跳转范围。
 *
 * @param rawText - webview 发送的原始路径文本
 * @param documentPath - 当前 Markdown 文档绝对路径
 * @param workspacePaths - 当前文档所属 workspace 的根路径列表
 * @param fileExists - 文件存在性判断函数，便于单元测试替换
 * @returns 解析后的最终结果
 */
export function resolveFileLinkTarget(
    rawText: string,
    documentPath: string,
    workspacePaths: string[],
    fileExists: (candidate: string) => boolean
): ResolvedFileLinkTarget {
    const normalizedText = rawText.split('#')[0].trim();
    const parsedTarget = parseFileLinkTarget(normalizedText) ?? {
        filePath: normalizedText,
        selection: null,
    };
    const candidates = buildCandidatePaths(parsedTarget, documentPath, workspacePaths);
    const existingCandidate = candidates.find((candidate) => fileExists(candidate));

    return {
        filePath: existingCandidate ?? candidates[0],
        selection: parsedTarget.selection,
    };
}
