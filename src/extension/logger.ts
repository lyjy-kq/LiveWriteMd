/**
 * Logger - VS Code Extension Logging Utility
 *
 * Provides structured logging to the VS Code Output Channel "LiveWriteMD"
 * with configurable debug output control via ConfigManager.
 *
 * Design Reference: DES-A-008, DES-F-002
 * Requirement: REQ-NF-006
 *
 * Log Format: [LiveWriteMD] [{LEVEL}] {YYYY-MM-DD HH:mm:ss.SSS} {message}
 *
 * @module extension/logger
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from './configManager';

// =============================================================================
// Log Level Enum
// =============================================================================

/**
 * Log level identifiers for categorizing log messages.
 *
 * - ERROR: Critical errors that may cause functionality failure
 * - WARN: Warning conditions that should be reviewed
 * - INFO: General informational messages about normal operation
 * - DEBUG: Detailed diagnostic information (controlled by config)
 */
export enum LogLevel {
    /** Critical errors that may cause functionality failure */
    ERROR = 'ERROR',
    /** Warning conditions that should be reviewed */
    WARN = 'WARN',
    /** General informational messages about normal operation */
    INFO = 'INFO',
    /** Detailed diagnostic information (controlled by config) */
    DEBUG = 'DEBUG',
}

// =============================================================================
// Logger Class
// =============================================================================

/**
 * Singleton Logger class for LiveWriteMD extension.
 *
 * Provides structured logging to VS Code's Output Channel with:
 * - Consistent log formatting: [LiveWriteMD] [{LEVEL}] {timestamp} {message}
 * - Debug log control via ConfigManager.isDebugLogEnabled()
 * - Error object handling with stack trace output
 * - Automatic output channel management
 *
 * @example
 * ```typescript
 * // Initialize logger (optional - auto-initializes on first use)
 * Logger.initialize();
 *
 * // Log messages at different levels
 * Logger.error('Something went wrong', new Error('details'));
 * Logger.warn('Potential issue detected');
 * Logger.info('Operation completed successfully');
 * Logger.debug('Detailed diagnostic info'); // Only if debug enabled
 *
 * // Show the output channel
 * Logger.show();
 *
 * // Cleanup on extension deactivate
 * Logger.dispose();
 * ```
 */
export class Logger {
    /**
     * The name of the Output Channel displayed in VS Code
     */
    private static readonly CHANNEL_NAME = 'LiveWriteMD';

    /**
     * Singleton instance of the VS Code Output Channel
     */
    private static outputChannel: vscode.OutputChannel | null = null;

    /**
     * Path to the debug log file (set when enableDebugLog is true)
     */
    private static logFilePath: string | null = null;

    /**
     * Initializes the Logger by creating the VS Code Output Channel.
     *
     * This method is idempotent - calling it multiple times will only
     * create one output channel instance.
     *
     * @remarks
     * The logger will auto-initialize on first use if not explicitly
     * initialized. Explicit initialization is recommended in the
     * extension's activate() function.
     */
    static initialize(): void {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel(this.CHANNEL_NAME);
        }
    }

    /**
     * Enables file logging. When enabled, all log messages are also written
     * to a file in the OS temp directory.
     *
     * @returns The path to the log file
     */
    static enableFileLogging(): string {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        this.logFilePath = path.join(os.tmpdir(), `livewritemd-debug-${timestamp}.log`);
        fs.writeFileSync(
            this.logFilePath,
            `LiveWriteMD Debug Log - Started at ${new Date().toISOString()}\n`,
            'utf-8'
        );
        return this.logFilePath;
    }

    /**
     * Returns the current log file path, or null if file logging is not enabled.
     */
    static getLogFilePath(): string | null {
        return this.logFilePath;
    }

    /**
     * Disposes the Logger and releases the Output Channel.
     *
     * Should be called in the extension's deactivate() function to
     * properly clean up resources.
     */
    static dispose(): void {
        if (this.outputChannel) {
            this.outputChannel.dispose();
            this.outputChannel = null;
        }
    }

    /**
     * Shows the LiveWriteMD Output Channel in VS Code.
     *
     * Useful for directing user attention to log output when
     * displaying important messages or errors.
     */
    static show(): void {
        this.ensureInitialized();
        this.outputChannel?.show();
    }

    /**
     * Logs an error message.
     *
     * Error messages are always output regardless of debug settings.
     * When an Error object is provided, its message and stack trace
     * are included in the output.
     *
     * @param message - The error description
     * @param error - Optional Error object with additional details
     *
     * @example
     * ```typescript
     * Logger.error('Failed to save file');
     * Logger.error('Database connection failed', new Error('timeout'));
     * ```
     */
    static error(message: string, error?: Error): void {
        this.log(LogLevel.ERROR, message);
        if (error) {
            this.log(LogLevel.ERROR, `  Error: ${error.message}`);
            if (error.stack) {
                this.log(LogLevel.ERROR, `  Stack: ${error.stack}`);
            }
        }
    }

    /**
     * Logs a warning message.
     *
     * Warning messages are always output regardless of debug settings.
     * Use for conditions that are not errors but should be reviewed.
     *
     * @param message - The warning description
     *
     * @example
     * ```typescript
     * Logger.warn('Large file detected - performance may be affected');
     * ```
     */
    static warn(message: string): void {
        this.log(LogLevel.WARN, message);
    }

    /**
     * Logs an informational message.
     *
     * Info messages are always output regardless of debug settings.
     * Use for general status updates and normal operation events.
     *
     * @param message - The informational message
     *
     * @example
     * ```typescript
     * Logger.info('Extension activated');
     * Logger.info('File synchronized successfully');
     * ```
     */
    static info(message: string): void {
        if (ConfigManager.isDebugLogEnabled()) {
            this.log(LogLevel.INFO, message);
        }
    }

    /**
     * Logs a debug message.
     *
     * Debug messages are only output when debug logging is enabled
     * via the `liveWriteMd.enableDebugLog` configuration setting.
     * Use for detailed diagnostic information during development.
     *
     * @param message - The debug message
     *
     * @example
     * ```typescript
     * Logger.debug('Processing message: ' + JSON.stringify(message));
     * Logger.debug('State before update: ' + currentState);
     * ```
     */
    static debug(message: string): void {
        if (ConfigManager.isDebugLogEnabled()) {
            // Auto-enable file logging on first debug call (handles late config sync in Remote SSH)
            if (!this.logFilePath) {
                const filePath = this.enableFileLogging();
                this.log(LogLevel.INFO, `Debug log file (late init): ${filePath}`);
            }
            this.log(LogLevel.DEBUG, message);
        }
    }

    // =========================================================================
    // Private Methods
    // =========================================================================

    /**
     * Ensures the output channel is initialized before logging.
     *
     * @private
     */
    private static ensureInitialized(): void {
        if (!this.outputChannel) {
            this.initialize();
        }
    }

    /**
     * Formats and outputs a log message.
     *
     * Log format: [LiveWriteMD] [{LEVEL}] {YYYY-MM-DD HH:mm:ss.SSS} {message}
     *
     * @param level - The log level
     * @param message - The message to log
     * @private
     */
    private static log(level: LogLevel, message: string): void {
        this.ensureInitialized();
        const formattedMessage = this.formatMessage(level, message);
        this.outputChannel?.appendLine(formattedMessage);

        // Also write to file if file logging is enabled
        if (this.logFilePath) {
            try {
                fs.appendFileSync(this.logFilePath, formattedMessage + '\n', 'utf-8');
            } catch {
                // Silently ignore file write errors
            }
        }
    }

    /**
     * Formats a log message according to the standard format.
     *
     * Format: [LiveWriteMD] [{LEVEL}] {YYYY-MM-DD HH:mm:ss.SSS} {message}
     *
     * @param level - The log level
     * @param message - The message to format
     * @returns The formatted log message
     * @private
     */
    private static formatMessage(level: LogLevel, message: string): string {
        const timestamp = this.formatTimestamp(new Date());
        return `[LiveWriteMD] [${level}] ${timestamp} ${message}`;
    }

    /**
     * Formats a date as YYYY-MM-DD HH:mm:ss.SSS
     *
     * @param date - The date to format
     * @returns The formatted timestamp string
     * @private
     */
    private static formatTimestamp(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        const milliseconds = String(date.getMilliseconds()).padStart(3, '0');

        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
    }
}
