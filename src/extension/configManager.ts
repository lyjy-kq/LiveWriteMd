/**
 * ConfigManager - VS Code Extension Configuration Management
 *
 * Provides centralized access to LiveWriteMD extension configuration values
 * from VS Code workspace settings. All configuration keys are defined
 * in package.json under contributes.configuration.
 *
 * Design Reference: DES-A-009, DES-F-002
 * Requirement: REQ-NF-007
 *
 * @module extension/configManager
 */

import * as vscode from 'vscode';
import type { LiveWriteMdEditorSettings } from '../shared/types.js';
import {
    ALL_SETTING_ITEMS,
    type SettingValue,
} from '../shared/settingsSchema.js';

// =============================================================================
// Custom Error Types
// =============================================================================

/**
 * Error thrown when a required configuration value is missing or invalid.
 *
 * This error indicates that the VS Code configuration system returned
 * undefined for a required setting, which should not happen when
 * package.json defaults are properly defined.
 */
export class ConfigurationError extends Error {
    /**
     * Creates a new ConfigurationError.
     *
     * @param message - Descriptive error message including the configuration key
     */
    constructor(message: string) {
        super(message);
        this.name = 'ConfigurationError';

        // Maintains proper stack trace for where error was thrown (V8 engines)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, ConfigurationError);
        }
    }
}

// =============================================================================
// ConfigManager Class
// =============================================================================

/**
 * Manages access to LiveWriteMD extension configuration values.
 *
 * This class provides static methods to retrieve configuration values
 * from VS Code's workspace configuration system. All values are defined
 * in package.json with appropriate defaults, types, and constraints.
 *
 * Configuration Keys (defined in package.json):
 * - liveWriteMd.largeFileWarningThreshold: Large file size threshold in bytes
 * - liveWriteMd.syncDebounceMs: Debounce delay for sync operations in milliseconds
 * - liveWriteMd.enableDebugLog: Enable/disable debug logging
 * - liveWriteMd.fontScale: Editor body font scale multiplier
 *
 * @example
 * ```typescript
 * // Get large file threshold
 * const threshold = ConfigManager.getLargeFileThreshold();
 *
 * // Check if debug logging is enabled
 * if (ConfigManager.isDebugLogEnabled()) {
 *     console.log('Debug mode active');
 * }
 *
 * // Get debounce delay for sync operations
 * const debounceMs = ConfigManager.getSyncDebounceMs();
 * ```
 */
export class ConfigManager {
    /**
     * The configuration section name for LiveWriteMD settings.
     * All LiveWriteMD configuration keys are prefixed with this section.
     */
    private static readonly CONFIG_SECTION = 'liveWriteMd';

    /**
     * Default value for large file warning threshold (1MB).
     * Used as fallback when VS Code configuration is not available.
     */
    private static readonly DEFAULT_LARGE_FILE_THRESHOLD = 1048576;

    /**
     * Default value for sync debounce delay (300ms).
     * Used as fallback when VS Code configuration is not available.
     */
    private static readonly DEFAULT_SYNC_DEBOUNCE_MS = 300;

    /**
     * Default value for debug log enabled flag.
     * Used as fallback when VS Code configuration is not available.
     */
    private static readonly DEFAULT_DEBUG_LOG_ENABLED = false;

    /** Default value for line numbers */
    private static readonly DEFAULT_LINE_NUMBERS = true;

    /** Default value for word wrap */
    private static readonly DEFAULT_WORD_WRAP = true;

    /** Default value for readable line length (px, 0 = unlimited) */
    private static readonly DEFAULT_READABLE_LINE_LENGTH = 900;

    /** Default value for editor font scale */
    private static readonly DEFAULT_FONT_SCALE = 1;

    /** Default value for theme override */
    private static readonly DEFAULT_THEME: 'auto' | 'dark' | 'light' = 'auto';

    /** Default value for default editor mode */
    private static readonly DEFAULT_MODE: 'live' | 'source' | 'viewer' = 'live';

    /**
     * Default value for image save folder name.
     * Images will be saved to this folder relative to the .md file.
     *
     * Design Reference: DES-D-002
     * Requirement: REQ-3A-003
     */
    private static readonly DEFAULT_IMAGE_SAVE_FOLDER = 'assets';

    /**
     * Retrieves the large file warning threshold in bytes.
     *
     * Files larger than this threshold will trigger a warning dialog
     * when opened in the LiveWriteMD editor. A value of 0 disables the warning.
     *
     * Configuration Key: liveWriteMd.largeFileWarningThreshold
     * Default: 1048576 (1MB)
     * Minimum: 0
     *
     * @returns The threshold in bytes
     * @throws {ConfigurationError} If the configuration value is undefined
     *
     * @example
     * ```typescript
     * const threshold = ConfigManager.getLargeFileThreshold();
     * if (fileSize > threshold && threshold > 0) {
     *     showLargeFileWarning();
     * }
     * ```
     */
    static getLargeFileThreshold(): number {
        const value = vscode.workspace
            .getConfiguration(this.CONFIG_SECTION)
            .get<number>('largeFileWarningThreshold', this.DEFAULT_LARGE_FILE_THRESHOLD);

        if (value === undefined) {
            throw new ConfigurationError(
                'Configuration value missing for key: liveWriteMd.largeFileWarningThreshold. ' +
                    'Please ensure package.json defines the default value.'
            );
        }

        return value;
    }

    /**
     * Retrieves the sync debounce delay in milliseconds.
     *
     * This delay is used to debounce synchronization between the
     * VS Code TextDocument and the Webview editor to prevent
     * excessive updates during rapid editing.
     *
     * Configuration Key: liveWriteMd.syncDebounceMs
     * Default: 300ms
     * Minimum: 50ms
     * Maximum: 2000ms
     *
     * @returns The debounce delay in milliseconds
     * @throws {ConfigurationError} If the configuration value is undefined
     *
     * @example
     * ```typescript
     * const debounceMs = ConfigManager.getSyncDebounceMs();
     * const debouncedSync = debounce(syncContent, debounceMs);
     * ```
     */
    static getSyncDebounceMs(): number {
        const value = vscode.workspace
            .getConfiguration(this.CONFIG_SECTION)
            .get<number>('syncDebounceMs', this.DEFAULT_SYNC_DEBOUNCE_MS);

        if (value === undefined) {
            throw new ConfigurationError(
                'Configuration value missing for key: liveWriteMd.syncDebounceMs. ' +
                    'Please ensure package.json defines the default value.'
            );
        }

        return value;
    }

    /**
     * Checks if debug logging is enabled.
     *
     * When enabled, the Logger will output debug-level messages
     * to the LiveWriteMD Output Channel. This is useful for development
     * and troubleshooting.
     *
     * Configuration Key: liveWriteMd.enableDebugLog
     * Default: false
     *
     * @returns true if debug logging is enabled, false otherwise
     * @throws {ConfigurationError} If the configuration value is undefined
     *
     * @example
     * ```typescript
     * if (ConfigManager.isDebugLogEnabled()) {
     *     Logger.debug('Detailed diagnostic information');
     * }
     * ```
     */
    static isDebugLogEnabled(): boolean {
        const value = vscode.workspace
            .getConfiguration(this.CONFIG_SECTION)
            .get<boolean>('enableDebugLog', this.DEFAULT_DEBUG_LOG_ENABLED);

        if (value === undefined) {
            throw new ConfigurationError(
                'Configuration value missing for key: liveWriteMd.enableDebugLog. ' +
                    'Please ensure package.json defines the default value.'
            );
        }

        return value;
    }

    /**
     * Retrieves the word wrap setting.
     *
     * Configuration Key: liveWriteMd.wordWrap
     * Default: true
     *
     * @returns true if word wrap is enabled
     */
    static getLineNumbers(): boolean {
        return vscode.workspace
            .getConfiguration(this.CONFIG_SECTION)
            .get<boolean>('lineNumbers', this.DEFAULT_LINE_NUMBERS);
    }

    static getWordWrap(): boolean {
        return vscode.workspace
            .getConfiguration(this.CONFIG_SECTION)
            .get<boolean>('wordWrap', this.DEFAULT_WORD_WRAP);
    }

    /**
     * Retrieves the readable line length setting.
     *
     * Configuration Key: liveWriteMd.readableLineLength
     * Default: 900
     *
     * @returns Max content width in px (0 = unlimited)
     */
    static getReadableLineLength(): number {
        return vscode.workspace
            .getConfiguration(this.CONFIG_SECTION)
            .get<number>('readableLineLength', this.DEFAULT_READABLE_LINE_LENGTH);
    }

    /**
     * Retrieves the editor body font scale multiplier.
     *
     * Configuration Key: liveWriteMd.fontScale
     * Default: 1
     *
     * @returns Font scale multiplier for the editor body
     */
    static getFontScale(): number {
        return vscode.workspace
            .getConfiguration(this.CONFIG_SECTION)
            .get<number>('fontScale', this.DEFAULT_FONT_SCALE);
    }

    /**
     * Retrieves the theme override setting.
     *
     * Configuration Key: liveWriteMd.theme
     * Default: 'auto'
     *
     * @returns 'auto', 'dark', or 'light'
     */
    static getThemeOverride(): 'auto' | 'dark' | 'light' {
        return vscode.workspace
            .getConfiguration(this.CONFIG_SECTION)
            .get<'auto' | 'dark' | 'light'>('theme', this.DEFAULT_THEME);
    }

    /**
     * Returns editor settings as a single object for INIT message.
     *
     * @returns LiveWriteMdEditorSettings with lineNumbers, wordWrap, readableLineLength, and fontScale
     */
    /**
     * Retrieves the default editor mode setting.
     *
     * Configuration Key: liveWriteMd.defaultMode
     * Default: 'live'
     *
     * @returns 'live', 'source', or 'viewer'
     */
    static getDefaultMode(): 'live' | 'source' | 'viewer' {
        return vscode.workspace
            .getConfiguration(this.CONFIG_SECTION)
            .get<'live' | 'source' | 'viewer'>('defaultMode', this.DEFAULT_MODE);
    }

    /**
     * Retrieves the image save folder setting.
     *
     * Specifies the folder name where dropped/pasted images are saved,
     * relative to the directory of the current .md file.
     *
     * Configuration Key: liveWriteMd.imageSaveFolder
     * Default: 'assets'
     *
     * Design Reference: DES-D-002
     * Requirement: REQ-3A-003
     *
     * @returns Folder name for image saving (relative to .md file)
     *
     * @example
     * ```typescript
     * const folder = ConfigManager.getImageSaveFolder();
     * // folder === 'assets' (default) or user-configured value
     * const savePath = path.join(path.dirname(mdFilePath), folder);
     * ```
     */
    static getImageSaveFolder(): string {
        return vscode.workspace
            .getConfiguration(this.CONFIG_SECTION)
            .get<string>('imageSaveFolder', this.DEFAULT_IMAGE_SAVE_FOLDER);
    }

    static getEditorSettings(): LiveWriteMdEditorSettings {
        return {
            lineNumbers: this.getLineNumbers(),
            wordWrap: this.getWordWrap(),
            readableLineLength: this.getReadableLineLength(),
            fontScale: this.getFontScale(),
        };
    }

    /**
     * 读取全部设置（遍历 schema），用于 INIT / settingsChange 下发。
     *
     * 每项从 VS Code 配置读取，缺失时回落到 schema 默认值，因此返回对象
     * 一定包含所有已登记的键。
     *
     * @returns key -> 当前值（含默认）
     */
    static getAllSettings(): Record<string, SettingValue> {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        const result: Record<string, SettingValue> = {};
        for (const item of ALL_SETTING_ITEMS) {
            const value = config.get<SettingValue>(item.key, item.default);
            result[item.key] = value ?? item.default;
        }
        return result;
    }

    /**
     * 把单项设置写回 VS Code 配置。
     *
     * 默认写入全局（用户）设置；显式传入 target 时可写到工作区。
     *
     * @param key - 设置键（不含 liveWriteMd.）
     * @param value - 新值
     * @param target - 写入目标，默认 Global
     */
    static async updateSetting(
        key: string,
        value: SettingValue,
        target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
    ): Promise<void> {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        await config.update(key, value, target);
    }
}
