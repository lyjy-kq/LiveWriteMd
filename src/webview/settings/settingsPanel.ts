/**
 * SettingsPanel —— LiveWriteMD 应用内设置面板（Obsidian 风格）。
 *
 * - 左侧分组导航（带搜索框），右侧当前分组的设置项（滚动）；
 * - 新手引导：首个分组顶部有一张「怎么调」卡片，可收起、可从标题栏 ? 重新打开；
 *   每个分组有说明、每个设置项有「改了会发生什么」的描述；
 * - 已改动的设置项会标出来，并可单独 / 一键恢复默认；
 * - 控件实现已拆到 settingsControls.ts；样式在 settingsPanelStyles.ts；
 * - 任何改动：① 立即写入 settingsState（同一 DOM 实时预览），
 *   ② 通过 onChange 回调交给外部把单项设置持久化到 VS Code 配置；
 * - Esc / 关闭按钮 / 点遮罩关闭。
 *
 * @module webview/settings/settingsPanel
 */

import {
    SETTINGS_SCHEMA,
    ALL_SETTING_ITEMS,
    type SettingItem,
    type SettingSection,
    type SettingValue,
} from '../../shared/settings/index.js';
import { settingsState } from './settingsState.js';
import { PANEL_STYLES } from './settingsPanelStyles.js';
import { renderControl, fontListTargets, pendingEdits } from './settingsControls.js';
import { appendFontOptions, setKnownSystemFonts } from './settingsControls.js';

/** 设置改动回调：把单项设置持久化。 */
export type SettingChangeHandler = (key: string, value: SettingValue) => void;

/** 新手引导卡片「已收起」的本地记录（只影响界面，不进 VS Code 配置）。 */
const GUIDE_DISMISS_KEY = 'livewritemd.settingsGuideDismissed';

/** 哪些控件自带「回到默认」按钮：再给行尾加一个「恢复默认」就重复了。 */
const SELF_RESET_CONTROLS = new Set<SettingItem['control']>(['color', 'font']);

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
    /** 搜索框。 */
    private searchEl: HTMLInputElement;
    /** 「全部恢复默认」按钮。 */
    private resetAllBtn: HTMLButtonElement;
    /** 「已应用 / 已恢复」提示。 */
    private applyHint: HTMLElement;
    /** 当前选中分组 id。 */
    private activeSection = SETTINGS_SCHEMA[0].id;
    /** 当前搜索词（空串 = 正常分组视图）。 */
    private query = '';
    /** 持久化回调。 */
    private onChange: SettingChangeHandler | null = null;
    /** 「已应用」提示的定时器。 */
    private applyHintTimer: number | null = null;
    /** 「全部恢复默认」的二次确认状态（第一次只变红提示）。 */
    private resetAllArmed = false;
    private resetAllTimer: number | null = null;
    /** 通过标题栏「?」临时强制显示引导（忽略之前的收起记录）。 */
    private guideForced = false;

    constructor() {
        // 注入样式
        const style = document.createElement('style');
        style.textContent = PANEL_STYLES;
        document.head.appendChild(style);

        this.root = document.createElement('div');
        this.root.id = 'livewritemd-settings-root';
        this.root.innerHTML = `
            <div class="fms-overlay"></div>
            <div class="fms-window" role="dialog" aria-modal="true" aria-label="LiveWriteMD 设置" tabindex="-1">
                <div class="fms-header">
                    <span class="fms-header-title">LiveWriteMD 设置</span>
                    <span class="fms-header-sub">改动即时预览，自动保存</span>
                    <button class="fms-help" type="button" title="使用说明">?</button>
                    <button class="fms-close" type="button" aria-label="关闭">✕</button>
                </div>
                <div class="fms-body">
                    <div class="fms-nav">
                        <input class="fms-search" type="search" spellcheck="false"
                            placeholder="搜索设置…" aria-label="搜索设置" />
                        <div class="fms-nav-list"></div>
                    </div>
                    <div class="fms-content"></div>
                </div>
                <div class="fms-footer">
                    <button class="fms-apply" type="button">应用</button>
                    <span class="fms-apply-hint"></span>
                    <span class="fms-footer-note">开关 / 滑杆 / 颜色即时生效；文本框回车或失焦保存</span>
                    <button class="fms-reset-all" type="button" title="把所有设置恢复为默认值">全部恢复默认</button>
                </div>
            </div>
        `;
        document.body.appendChild(this.root);

        this.navEl = this.root.querySelector('.fms-nav-list')!;
        this.contentEl = this.root.querySelector('.fms-content')!;
        this.searchEl = this.root.querySelector<HTMLInputElement>('.fms-search')!;
        this.resetAllBtn = this.root.querySelector<HTMLButtonElement>('.fms-reset-all')!;
        this.applyHint = this.root.querySelector<HTMLElement>('.fms-apply-hint')!;

        // 底部「应用」：把输入框里尚未持久化的值写回配置，并完整重跑一遍 CSS；
        // 顺便给一个短提示，避免用户不确定有没有生效。
        const applyBtn = this.root.querySelector<HTMLButtonElement>('.fms-apply')!;
        applyBtn.addEventListener('click', () => {
            this.applyPending();
            this.showHint('已应用');
        });

        // 全部恢复默认：第一次点击只进入「确认」态，4 秒内再点一次才执行
        // （设置项很多，误点一次代价不小；webview 里 window.confirm 会被吞掉）。
        this.resetAllBtn.addEventListener('click', () => this.handleResetAll());

        // 标题栏「?」：重新展开新手引导，并回到第一个分组
        this.root.querySelector('.fms-help')!.addEventListener('click', () => {
            this.guideForced = true;
            this.activeSection = SETTINGS_SCHEMA[0].id;
            this.clearSearch();
            this.syncNavActive();
            this.buildContent();
        });

        // 搜索：输入即过滤全部分组（按名称 / 说明 / 配置键匹配）
        this.searchEl.addEventListener('input', () => {
            const q = this.searchEl.value.trim();
            if (q === this.query) return;
            this.query = q;
            this.buildContent();
        });
        // 搜索框里的 Esc 先清搜索词，再按一次才关面板
        this.searchEl.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !this.searchEl.value) return;
            e.preventDefault();
            e.stopPropagation();
            this.clearSearch();
            this.buildContent();
            this.searchEl.focus();
        });
        // 面板里按「/」快速定位到搜索框（输入框里按 / 仍是正常输入）
        this.root.addEventListener('keydown', (e) => {
            if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
            const tag = (e.target as HTMLElement | null)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            e.preventDefault();
            this.searchEl.focus();
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
            btn.title = section.description ?? section.label;
            btn.addEventListener('click', () => {
                this.activeSection = section.id;
                this.clearSearch();
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

    /** 清空搜索词（不重建内容，调用方决定何时 buildContent）。 */
    private clearSearch(): void {
        this.query = '';
        this.searchEl.value = '';
    }

    /** 构建当前视图：搜索时是全量结果，否则是当前分组。 */
    private buildContent(): void {
        this.contentEl.scrollTop = 0;
        this.contentEl.innerHTML = '';
        // 旧 datalist 已随 innerHTML 一起销毁，同步清掉引用，避免字体列表
        // 晚到时往已脱离文档的节点里填数据。
        fontListTargets.clear();

        if (this.query) {
            this.buildSearchResults();
            return;
        }

        const section =
            SETTINGS_SCHEMA.find((s) => s.id === this.activeSection) ?? SETTINGS_SCHEMA[0];
        // 新手引导只放在第一个分组：首次打开面板就能看到，又不占其它分组的视野
        if (section.id === SETTINGS_SCHEMA[0].id) {
            const guide = this.buildGuide();
            if (guide) this.contentEl.appendChild(guide);
        }
        this.contentEl.appendChild(this.buildSectionHead(section));
        for (const item of section.items) {
            this.contentEl.appendChild(this.buildRow(item));
        }
    }

    /** 分组标题 + 一句话说明。 */
    private buildSectionHead(section: SettingSection): HTMLElement {
        const head = document.createElement('div');
        head.className = 'fms-section-head';

        const title = document.createElement('div');
        title.className = 'fms-section-title';
        title.textContent = `${section.icon} ${section.label}`;
        head.appendChild(title);

        if (section.description) {
            const desc = document.createElement('div');
            desc.className = 'fms-section-desc';
            desc.textContent = section.description;
            head.appendChild(desc);
        }
        return head;
    }

    /**
     * 新手引导卡片。
     *
     * 收起后记在 localStorage（不进 VS Code 配置）；标题栏的「?」可以随时重新展开。
     */
    private buildGuide(): HTMLElement | null {
        const visible =
            this.guideForced ||
            (() => {
                try {
                    return localStorage.getItem(GUIDE_DISMISS_KEY) !== '1';
                } catch {
                    // localStorage 不可用（极少见）：默认展示，不影响设置功能
                    return true;
                }
            })();
        if (!visible) return null;

        const card = document.createElement('div');
        card.className = 'fms-guide';
        card.innerHTML = `
            <div class="fms-guide-head">
                <span class="fms-guide-title">👋 第一次用？按这三步调</span>
                <button class="fms-guide-close" type="button" title="收起引导">×</button>
            </div>
            <ol class="fms-guide-steps">
                <li><b>左边选分组</b>：按用途分好了（编辑器 / 标题与文字 / 表格 / 思维导图…），
                    每个分组标题下都写了它影响什么。</li>
                <li><b>右边直接改</b>：开关点一下；滑杆左右拖；颜色点色块，
                    <b>留空或点「重置」一般表示跟随主题</b>（个别项是「不显示」，见该项说明）；
                    字体框输入几个字母就会筛选。</li>
                <li><b>不用手动保存</b>：开关 / 滑杆 / 颜色立刻生效；文本框和字体框按回车或点空白处生效。
                    改动会写进 VS Code 用户设置，下次打开仍然保留。</li>
            </ol>
            <div class="fms-guide-tip">
                改坏了？把鼠标移到设置项上，行尾会出现「恢复默认」；也可以点底部「全部恢复默认」。
                找不到某项？在左上角搜索框输入关键词（试试「字体」「行距」「表格」「导图」）。
            </div>
        `;
        card.querySelector('.fms-guide-close')!.addEventListener('click', () => {
            this.guideForced = false;
            try {
                localStorage.setItem(GUIDE_DISMISS_KEY, '1');
            } catch {
                /* localStorage 不可用：本次会话收起即可 */
            }
            this.buildContent();
        });
        return card;
    }

    /** 搜索模式：跨分组列出匹配项，点分组小标签可直接跳回该分组并定位。 */
    private buildSearchResults(): void {
        const query = this.query.toLowerCase();
        const matches: Array<{ section: SettingSection; item: SettingItem }> = [];
        for (const section of SETTINGS_SCHEMA) {
            for (const item of section.items) {
                const haystack = [item.label, item.description, item.key, section.label]
                    .filter(Boolean)
                    .join('\n')
                    .toLowerCase();
                if (haystack.includes(query)) matches.push({ section, item });
            }
        }

        const head = document.createElement('div');
        head.className = 'fms-section-head';
        head.innerHTML = `
            <div class="fms-section-title">🔍 搜索结果</div>
            <div class="fms-section-desc">匹配「${escapeHtml(this.query)}」的设置 ${matches.length} 项</div>
        `;
        this.contentEl.appendChild(head);

        if (matches.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'fms-empty';
            empty.innerHTML =
                '没有找到匹配的设置。<br>试试更短的关键词，例如「字体」「行距」「颜色」「导图」。';
            this.contentEl.appendChild(empty);
            return;
        }

        for (const { section, item } of matches) {
            this.contentEl.appendChild(this.buildRow(item, section));
        }
    }

    /**
     * 一行设置：名称（+ 分组标签 / 已改动标记）/ 描述 / 控件 / 恢复默认。
     *
     * @param item 设置项
     * @param section 搜索模式下用来显示「来自哪个分组」的小标签；分组视图不传
     */
    private buildRow(item: SettingItem, section?: SettingSection): HTMLElement {
        const row = document.createElement('div');
        row.className = 'fms-row';
        row.dataset.key = item.key;

        const info = document.createElement('div');
        info.className = 'fms-info';

        const label = document.createElement('div');
        label.className = 'fms-label';
        // 搜索结果里的分组小标签：点一下跳回那个分组并定位到本行
        if (section) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'fms-row-chip';
            chip.textContent = section.label;
            chip.title = `前往「${section.label}」分组`;
            chip.addEventListener('click', () => this.revealItem(section.id, item.key));
            label.appendChild(chip);
        }
        label.appendChild(document.createTextNode(item.label));

        const badge = document.createElement('span');
        badge.className = 'fms-mod-badge';
        badge.textContent = '已改动';
        label.appendChild(badge);
        info.appendChild(label);

        if (item.description) {
            const desc = document.createElement('div');
            desc.className = 'fms-desc';
            desc.textContent = item.description;
            info.appendChild(desc);
        }

        const control = renderControl(item, {
            commit: (value: SettingValue) => {
                // ① 实时写入（同一 DOM 立即预览） ② 持久化
                this.commitItem(item.key, value);
                this.syncRowState(row, item);
            },
        });

        const ctrlWrap = document.createElement('div');
        ctrlWrap.className = 'fms-control';
        ctrlWrap.appendChild(control);

        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'fms-row-reset';
        reset.textContent = '恢复默认';
        reset.title = `恢复为默认值：${String(item.default) === '' ? '跟随主题' : String(item.default)}`;
        // 颜色 / 字体控件自己就有「重置 / 跟随」，这里不再重复
        if (SELF_RESET_CONTROLS.has(item.control)) reset.style.display = 'none';
        reset.addEventListener('click', () => this.resetItem(item));

        row.appendChild(info);
        row.appendChild(ctrlWrap);
        row.appendChild(reset);
        this.syncRowState(row, item);
        return row;
    }

    /** 刷新某一行的「已改动」标记与「恢复默认」可见性（不重建控件）。 */
    private syncRowState(row: HTMLElement, item: SettingItem): void {
        const modified = !this.isDefault(item);
        row.setAttribute('data-modified', String(modified));
        // 自动按钮已经隐藏的行（颜色 / 字体）保持隐藏，只更新标记
        if (!SELF_RESET_CONTROLS.has(item.control)) {
            const reset = row.querySelector<HTMLElement>('.fms-row-reset');
            if (reset) reset.style.display = modified ? '' : 'none';
        }
    }

    /** 当前值是否等于默认值。 */
    private isDefault(item: SettingItem): boolean {
        const current = settingsState.get(item.key);
        if (typeof item.default === 'number') return Number(current) === item.default;
        return String(current ?? '') === String(item.default);
    }

    /** 写入单项并持久化。 */
    private commitItem(key: string, value: SettingValue): void {
        settingsState.set(key, value);
        this.onChange?.(key, value);
    }

    /** 单项恢复默认（保持当前滚动位置）。 */
    private resetItem(item: SettingItem): void {
        pendingEdits.delete(item.key);
        this.commitItem(item.key, item.default);
        const scrollTop = this.contentEl.scrollTop;
        this.buildContent();
        this.contentEl.scrollTop = scrollTop;
        this.showHint('已恢复默认');
    }

    /** 「全部恢复默认」：两段确认，避免误触。 */
    private handleResetAll(): void {
        if (!this.resetAllArmed) {
            this.resetAllArmed = true;
            this.resetAllBtn.textContent = '再点一次确认';
            this.resetAllBtn.setAttribute('data-armed', 'true');
            if (this.resetAllTimer !== null) window.clearTimeout(this.resetAllTimer);
            this.resetAllTimer = window.setTimeout(() => this.disarmResetAll(), 4000);
            return;
        }
        this.disarmResetAll();

        pendingEdits.clear();
        for (const item of ALL_SETTING_ITEMS) {
            // 逐项提交：和手动改一遍等价，扩展侧照常写 VS Code 用户设置
            this.commitItem(item.key, item.default);
        }
        // 字体栈 / 导图底色这类「多个键共同决定」的变量，最后统一重算一遍
        settingsState.reapplyAll();
        this.buildContent();
        this.showHint('已恢复全部默认值');
    }

    /** 退出「全部恢复默认」的确认态。 */
    private disarmResetAll(): void {
        if (this.resetAllTimer !== null) {
            window.clearTimeout(this.resetAllTimer);
            this.resetAllTimer = null;
        }
        this.resetAllArmed = false;
        this.resetAllBtn.textContent = '全部恢复默认';
        this.resetAllBtn.removeAttribute('data-armed');
    }

    /** 从搜索结果跳到所属分组，并高亮定位那一行。 */
    private revealItem(sectionId: string, key: string): void {
        this.activeSection = sectionId;
        this.clearSearch();
        this.syncNavActive();
        this.buildContent();
        const row = this.contentEl.querySelector<HTMLElement>(
            `.fms-row[data-key="${key}"]`
        );
        if (!row) return;
        row.scrollIntoView({ block: 'center' });
        row.setAttribute('data-flash', 'true');
        window.setTimeout(() => row.removeAttribute('data-flash'), 1200);
    }

    /** 底部短提示（已应用 / 已恢复默认）。 */
    private showHint(text: string): void {
        this.applyHint.textContent = text;
        this.applyHint.setAttribute('data-show', 'true');
        if (this.applyHintTimer !== null) window.clearTimeout(this.applyHintTimer);
        this.applyHintTimer = window.setTimeout(() => {
            this.applyHint.setAttribute('data-show', 'false');
        }, 1400);
    }

    /**
     * 打开面板。
     *
     * @param onChange - 单项设置持久化回调
     */
    open(onChange?: SettingChangeHandler): void {
        if (onChange) this.onChange = onChange;
        // 每次打开都回到干净的浏览状态：无搜索、无「确认恢复」
        this.clearSearch();
        this.disarmResetAll();
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
            this.commitItem(key, value);
        }
        pendingEdits.clear();
        settingsState.reapplyAll();
        // 「已改动」标记跟着刷新（不重建控件，避免打断正在拖的滑杆）
        for (const row of this.contentEl.querySelectorAll<HTMLElement>('.fms-row')) {
            const key = row.dataset.key;
            const item = ALL_SETTING_ITEMS.find((i) => i.key === key);
            if (item) this.syncRowState(row, item);
        }
    }

    /** 关闭面板。 */
    close(): void {
        // 关面板前把没来得及提交的输入保存掉，避免「看着已经改了、重开又变回去」
        if (pendingEdits.size > 0) this.applyPending();
        this.disarmResetAll();
        this.root.setAttribute('data-open', 'false');
    }

    /** 是否打开。 */
    get isOpen(): boolean {
        return this.root.getAttribute('data-open') === 'true';
    }
}

/** 转义用户输入，避免搜索词里的 < > 被当成 HTML。 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 全局单例。 */
export const settingsPanel = new SettingsPanelImpl();
