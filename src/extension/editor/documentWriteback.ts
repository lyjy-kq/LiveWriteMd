/**
 * 整篇写回 TextDocument 的公共逻辑（customEditor 与独立导图面板共用）。
 *
 * 背景——为什么一笔普通的 WorkspaceEdit 会失败：
 * 扩展侧调用 applyEdit 时，VS Code 会把文本编辑钉上**扩展宿主此刻记录的
 * 文档版本号**（extHostBulkEdits 里 `versionId: getTextDocumentVersion(uri)`）。
 * 主进程落地前会拿模型当前版本号比对，不一致就整笔拒绝，日志里是
 * `xxx has changed in the meantime`，applyEdit 返回 false（不抛异常）。
 *
 * 文件被外部工具改过之后，扩展宿主手里的版本号可能停在旧值（它没跟上
 * 渲染进程里的模型重载）。这时无论重试多少次，钉的都是同一个旧版本号，
 * 保存永远失败 —— 这就是「外部改过文档后导图保存一直报错」的成因。
 *
 * 绕开的办法：给同一资源的编辑顺带塞一个 createFile(ignoreIfExists)。
 * VS Code 认为「这次要新建文件」，就不会再给该文件的文本编辑附版本号
 * （create 的文件不存在旧版本可比）。文件本来就在，create 这一步会被
 * ignoreIfExists 直接跳过：不产生文件操作、不多出撤销步骤，只是让整篇
 * 替换能落下。落下的同时主进程会把新版本号回推给扩展宿主，状态自愈。
 */

import * as vscode from 'vscode';
import { Logger } from '../logger.js';

/**
 * 整篇替换的范围终点。
 *
 * 故意不用 `document.lineCount`：扩展宿主里的文档可能比真实模型旧
 * （外部改动后没跟上），用它算出的终点会短一截，替换完会留下旧的尾部。
 * 越界的行号会被 TextModel.validateRange 夹到模型末尾，等价于「全文」。
 */
function fullDocumentRange(): vscode.Range {
    return new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0);
}

/**
 * 构造一笔整篇替换编辑。
 *
 * @param uri 目标文档
 * @param content 新的全文
 * @param unpinVersion true 时用 createFile 让 VS Code 不给编辑钉版本号
 */
function buildFullTextEdit(
    uri: vscode.Uri,
    content: string,
    unpinVersion: boolean
): vscode.WorkspaceEdit {
    const edit = new vscode.WorkspaceEdit();
    if (unpinVersion) {
        // 只能传 ignoreIfExists，**不能**传 overwrite：VS Code 里「文件已存在
        // 就跳过 create」的条件是 overwrite 未设置且 ignoreIfExists 为真。
        // 传了 overwrite:false 反而会真的去创建已存在的文件并报错。
        edit.createFile(uri, { ignoreIfExists: true });
    }
    edit.replace(uri, fullDocumentRange(), content);
    return edit;
}

/**
 * 把整篇内容写回文档：先走普通编辑（保留 Undo/Redo 语义），
 * 被版本号钉死拒绝时再走一次「解除版本钉」的编辑。
 *
 * @param uri 目标文档
 * @param content 新的全文
 * @returns 是否成功落下
 */
export async function applyFullText(uri: vscode.Uri, content: string): Promise<boolean> {
    if (await vscode.workspace.applyEdit(buildFullTextEdit(uri, content, false))) {
        return true;
    }
    // 走到这里通常是外部改过文件、扩展宿主的版本号过期了。
    const applied = await vscode.workspace.applyEdit(buildFullTextEdit(uri, content, true));
    if (applied) {
        Logger.warn(
            `applyFullText: version-pinned edit rejected, reapplied without pin (${uri.fsPath})`
        );
    }
    return applied;
}
