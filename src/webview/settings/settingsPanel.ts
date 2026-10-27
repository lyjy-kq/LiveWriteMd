/**
 * SettingsPanel —— LiveWriteMD 应用内设置面板（Obsidian 风格）。
 *
 * - 左侧分组导航，右侧当前分组的设置项（滚动）；
 * - 控件实现已拆到 settingsControls.ts；样式在 settingsPanelStyles.ts；
 * - 任何改动：① 立即写入 settingsState（同一 DOM 实时预览），
 *   ② 通过 onChange 回调交给外部把单项设置持久化到 VS Code 配置；
 * - Esc / 关闭按钮 / 点遮罩关闭。
 *
 * @module webview/settings/settingsPanel
 */

import {
    SETTINGS_SCHEMA,
    getSettingItem,
    type SettingValue,
} from '../../shared/settings/index.js';
import { settingsState } from './settingsState.js';
import { PANEL_STYLES } from './settingsPanelStyles.js';
import { renderControl, fontListTargets, pendingEdits } from './settingsControls.js';
import { appendFontOptions, setKnownSystemFonts } from './settingsControls.js';

/** 设置改动回调：把单项设置持久化。 */
export type SettingChangeHandler = (key: string, value: SettingValue) => void;

// =============================================================================
// SettingsPanel
// =============================================================================

class SettingsPanelImpl {
    /** 根元素。 */
    private root: HTMLElement;
    /** 导航按钮容器。 */
    private navEl: HTMLElement;
    /** 设置项容器。 */
    private contentEl: HTMLElement;
    /** 当前选中分组 id。 */
    private activeSection = SETTINGS_SCHEMA[0].id;
    /** 持久化回调。 */
    private onChange: SettingChangeHandler | null = null;
    /** 「已应用」提示的定时器。 */
    private applyHintTimer: number | null = null;

    constructor() {
        // 注入样式
        const style = document.createElement('style');
        style.textContent = PANEL_STYLES;
        document.head.appendChild(style);

        this.root = document.createElement('div');
        this.root.id = 'livewritemd-settings-root';
        this.root.innerHTML = `
            <div class="fms-overlay"></div>
            <div class="fms-window" role="dialog" aria-modal="true" aria-label="LiveWriteMD 设置">
                <div class="fms-header">
                    <span class="fms-header-title">LiveWriteMD 设置</span>
                    <button class="fms-close" type="button" aria-label="关闭">✕</button>
                </div>
                <div class="fms-body">
                    <div class="fms-nav"></div>
                    <div class="fms-content"></div>
                </div>
                <div class="fms-footer">
                    <button class="fms-apply" type="button">应用</button>
                    <span class="fms-apply-hint"></span>
                </div>
            </div>
        `;
        document.body.appendChild(this.root);

        this.navEl = this.root.querySelector('.fms-nav')!;
        this.contentEl = this.root.querySelector('.fms-content')!;

        // 底部「应用」：把输入框里尚未持久化的值写回配置，并完整重跑一遍 CSS；
        // 顺便给一个短提示，避免用户不确定有没有生效。
        const applyBtn = this.root.querySelector<HTMLButtonElement>('.fms-apply')!;
        const applyHint = this.root.querySelector<HTMLElement>('.fms-apply-hint')!;
        applyBtn.addEventListener('click', () => {
            this.applyPending();
            applyHint.textContent = '已应用';
            applyHint.setAttribute('data-show', 'true');
            if (this.applyHintTimer !== null) window.clearTimeout(this.applyHintTimer);
            this.applyHintTimer = window.setTimeout(() => {
                applyHint.setAttribute('data-show', 'false');
            }, 1200);
        });

        // 关闭交互
        this.root.querySelector('.fms-close')!.addEventListener('click', () => this.close());
        this.root.querySelector('.fms-overlay')!.addEventListener('click', () => this.close());
        this.root.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.close();
        });

        this.buildNav();
    }

    /**
     * 注册设置改动的持久化回调。
     *
     * 设置面板的打开入口统一收编到 VSCode 编辑器标题栏（openSettings 命令），
     * webview 内不再挂启动按钮；这里只保存回调，供 open() 时提交改动使用。
     *
     * @param onChange - 设置改动的持久化回调
     */
    registerChangeHandler(onChange: SettingChangeHandler): void {
        this.onChange = onChange;
    }

    /** 构建左侧分组导航。 */
    private buildNav(): void {
        for (const section of SETTINGS_SCHEMA) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'fms-nav-btn';
            btn.innerHTML = `<span class="fms-nav-icon">${section.icon}</span><span>${section.label}</span>`;
            btn.addEventListener('click', () => {
                this.activeSection = section.id;
                this.syncNavActive();
                this.buildContent();
            });
            this.navEl.appendChild(btn);
        }
    }

    /** 同步导航高亮。 */
    private syncNavActive(): void {
        const buttons = this.navEl.querySelectorAll('.fms-nav-btn');
        SETTINGS_SCHEMA.forEach((section, index) => {
            buttons[index].setAttribute(
                'data-active',
                String(section.id === this.activeSection)
            );
        });
    }

    /** 构建当前分组的设置项。 */
    private buildContent(): void {
        const section = SETTINGS_SCHEMA.find((s) => s.id === this.activeSection);
        if (!section) return;
        this.contentEl.scrollTop = 0;
        this.contentEl.innerHTML = '';
        // 旧 datalist 已随 innerHTML 一起销毁，同步清掉引用，避免字体列表
        // 晚到时往已脱离文档的节点里填数据。
        fontListTargets.clear();

        const title = document.createElement('div');
        title.className = 'fms-section-title';
        title.textContent = `${section.icon} ${section.label}`;
        this.contentEl.appendChild(title);

        for (const item of section.items) {
            const row = document.createElement('div');
            row.className = 'fms-row';

            const info = document.createElement('div');
            info.className = 'fms-info';
            info.innerHTML = `<div class="fms-label">${item.label}</div>`;
            if (item.description) {
                const desc = document.createElement('div');
                desc.className = 'fms-desc';
                desc.textContent = item.description;
                info.appendChild(desc);
            }

            const control = renderControl(item, {
                commit: (value: SettingValue) => {
                    // ① 实时写入（同一 DOM 立即预览）
                    settingsState.set(item.key, value);
                    // ② 持久化
                    this.onChange?.(item.key, value);
                },
            });

            const ctrlWrap = document.createElement('div');
            ctrlWrap.className = 'fms-control';
            ctrlWrap.appendChild(control);

            row.appendChild(info);
            row.appendChild(ctrlWrap);
            this.contentEl.appendChild(row);
        }
    }

    /**
     * 打开面板。
     *
     * @param onChange - 单项设置持久化回调
     */
    open(onChange?: SettingChangeHandler): void {
        if (onChange) this.onChange = onChange;
        this.syncNavActive();
        this.buildContent();
        this.root.setAttribute('data-open', 'true');
        // 焦点放到窗口以便 Esc
        (this.root.querySelector('.fms-window') as HTMLElement).focus();
    }

    /**
     * 收到扩展宿主枚举出的系统字体列表。
     *
     * 面板可能已经渲染好（先打开、字体列表后到），这里就地更新每个
     * datalist 的选项，不重建面板，避免用户正在看的内容被重置。
     *
     * @param fonts 字体家族名（扩展侧已去重排序）
     */
    setSystemFonts(fonts: string[]): void {
        const clean = (Array.isArray(fonts) ? fonts : [])
            .filter((name): name is string => typeof name === 'string')
            .map((name) => name.trim())
            .filter((name) => name.length > 0);
        if (clean.length === 0) return;
        setKnownSystemFonts(clean);
        for (const list of fontListTargets) {
            list.innerHTML = '';
            appendFontOptions(list, clean);
        }
    }

    /**
     * 提交所有「已预览未保存」的输入，并重跑一遍全部 CSS 变量。
     *
     * 正常失焦时 change 已经提交过，这里主要覆盖：
     * - 用户打字后直接点「应用」；
     * - 焦点还在输入框里时用 Esc 关闭面板。
     */
    private applyPending(): void {
        for (const [key, value] of pendingEdits) {
            settingsState.set(key, value);
            this.onChange?.(key, value);
        }
        pendingEdits.clear();
        settingsState.reapplyAll();
    }

    /** 关闭面板。 */
    close(): void {
        // 关面板前把没来得及提交的输入保存掉，避免「看着已经改了、重开又变回去」
        if (pendingEdits.size > 0) this.applyPending();
        this.root.setAttribute('data-open', 'false');
    }

    /** 是否打开。 */
    get isOpen(): boolean {
        return this.root.getAttribute('data-open') === 'true';
    }
}

/** 全局单例。 */
export const settingsPanel = new SettingsPanelImpl();

// 防止未使用告警（getSettingItem 供外部按需使用）
void getSettingItem;
