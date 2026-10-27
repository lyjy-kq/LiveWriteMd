/**
 * 当前 VS Code 主题类型判定（从 editorProvider.ts 拆出）。
 *
 * 单独成文件是为了避免循环依赖：providerMessages（消息分发）和
 * mindmapPanelManager 都需要它，而它们又被 editorProvider 依赖。
 *
 * @module extension/editor/themeType
 */

import * as vscode from 'vscode';
import type { ThemeType } from '../../shared/types.js';
import { ConfigManager } from './configManager.js';

/**
 * Get the current theme type based on VS Code's color theme kind.
 *
 * @returns 'light' or 'dark' based on the current VS Code theme
 */
export function getThemeType(): ThemeType {
    const override = ConfigManager.getThemeOverride();
    if (override !== 'auto') {
        return override;
    }
    const kind = vscode.window.activeColorTheme?.kind;
    switch (kind) {
        case vscode.ColorThemeKind.Light:
        case vscode.ColorThemeKind.HighContrastLight:
            return 'light';
        case vscode.ColorThemeKind.Dark:
        case vscode.ColorThemeKind.HighContrast:
        default:
            return 'dark';
    }
}
