/**
 * LiveWriteMD Webview Theme Manager
 *
 * This module provides the WebviewThemeManager class that handles theme
 * switching functionality for the Webview editor.
 *
 * Key features:
 * - Theme state management (light/dark)
 * - DOM data-theme attribute synchronization
 * - CSS variable-based theme switching
 *
 * @module webview/theme
 *
 * Design Reference: DES-A-005 - Theme integration design
 * Requirements: REQ-F-008 - Dark/Light theme support
 */

import type { ThemeType } from '../shared/types.js';

// =============================================================================
// WebviewThemeManager Class
// =============================================================================

/**
 * WebviewThemeManager handles theme switching in the Webview.
 *
 * This class manages the current theme state and synchronizes it with the DOM
 * by setting the data-theme attribute on the document body. CSS styles use
 * this attribute to apply theme-specific CSS variables.
 *
 * Design Reference: DES-A-005
 *
 * @example
 * ```typescript
 * const themeManager = new WebviewThemeManager('dark');
 *
 * // Switch to light theme
 * themeManager.setTheme('light');
 *
 * // Get current theme
 * const currentTheme = themeManager.getCurrentTheme();
 * ```
 */
export class WebviewThemeManager {
    /** The current theme setting */
    private currentTheme: ThemeType;

    /**
     * Create a new WebviewThemeManager instance.
     *
     * @param initialTheme - The initial theme to apply (default: 'dark')
     */
    constructor(initialTheme: ThemeType = 'dark') {
        this.currentTheme = initialTheme;
        this.applyThemeToDOM();
    }

    /**
     * Set the current theme.
     *
     * This method updates the internal theme state and immediately applies
     * the change to the DOM by updating the data-theme attribute.
     *
     * @param theme - The theme to apply ('light' or 'dark')
     *
     * Design Reference: DES-A-005
     */
    public setTheme(theme: ThemeType): void {
        this.currentTheme = theme;
        this.applyThemeToDOM();
    }

    /**
     * Get the current theme.
     *
     * @returns The current theme setting
     */
    public getCurrentTheme(): ThemeType {
        return this.currentTheme;
    }

    /**
     * Apply the current theme to the DOM.
     *
     * Sets the data-theme attribute on document.body to enable CSS
     * variable-based theme switching.
     *
     * @private
     */
    private applyThemeToDOM(): void {
        document.body.setAttribute('data-theme', this.currentTheme);
    }
}
