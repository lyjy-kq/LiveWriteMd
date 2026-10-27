/**
 * 文档内链接（内链）共享工具。
 *
 * 内链 = 指向同一文档内某个标题的链接，两种写法等价：
 * - `[[#标题]]`（wiki 风格，Obsidian 同款；不支持 `|` 别名）；
 * - `[文字](#标题)`（标准 Markdown 锚点）。
 *
 * 匹配规则：先按标题文字精确匹配（忽略首尾空白），失败再按 GitHub slug
 * 规则（小写、去标点、空白转连字符）归一化比对；同名标题取文档中第一个。
 *
 * live 预览（plugin.ts）与导图（mindmapApp.ts / canvas.ts）共用这里的
 * 提取与匹配逻辑，保证两种模式下「哪些算内链、指向谁」完全一致。
 *
 * @module shared/internalLink
 */

/**
 * GitHub 风格 slug 化标题文字。
 *
 * trim → 小写 → 去掉标点（保留 CJK 字符范围）→ 空白折叠成单个连字符。
 * 与 GitHub 渲染 README 锚点的算法一致，`[文字](#multi-level-heading)`
 * 这类写法能对上「Multi Level Heading」。
 *
 * @param text - 标题文字（不含 `#` 标记）
 * @returns slug
 */
export function slugifyHeading(text: string): string {
    return text
        .trim()
        .toLowerCase()
        // 与 plugin.ts 原有的锚点 slug 算法保持一致；CJK 范围一律用转义
        // 写法，避免源码编码把正则弄坏
        .replace(/[^\w\s\u3000-\u9fff\uf900-\ufaff-]/g, '')
        .replace(/\s+/g, '-');
}

/**
 * 在标题列表里找内链目标：先精确匹配（忽略首尾空白），失败按 slug 比对。
 *
 * @param headings - 全部标题文字（文档顺序，不含 `#` 标记）
 * @param target - 内链目标（`#` 之后的原始文字）
 * @returns 命中的标题下标（同名取第一个）；找不到返回 -1
 */
export function matchHeadingIndex(headings: readonly string[], target: string): number {
    const want = target.trim();
    if (!want) return -1;
    // 第一遍：精确匹配（Obsidian 习惯，`[[#多级 标题]]` 原样写）
    for (let i = 0; i < headings.length; i++) {
        if (headings[i].trim() === want) return i;
    }
    // 第二遍：slug 归一化（GitHub 习惯，`[文字](#multi-level-heading)`）
    const wantSlug = slugifyHeading(want);
    if (!wantSlug) return -1;
    for (let i = 0; i < headings.length; i++) {
        if (slugifyHeading(headings[i]) === wantSlug) return i;
    }
    return -1;
}

/**
 * 从一段 Markdown 文本里提取全部内链目标（`#` 之后的原始文字）。
 *
 * 行内代码（`` `...` ``）里的写法不识别 —— 与 live 预览的判定口径一致
 * （那边按语法树跳过 InlineCode）。`` ` `` 成对替换为等长空白，
 * 不挪动后续字符的位置（位置信息虽然目前只有 live 侧用，保持一致更稳）。
 *
 * 导图只关心「指向谁」不需要位置，所以这里只返回目标文字列表。
 *
 * @param text - 节点 / 段落的 Markdown 源码
 * @returns 内链目标列表（按出现顺序，未去重、未校验是否存在）
 */
export function extractInternalLinkTargets(text: string): string[] {
    // 行内代码里的 `[[#x]]` / `[a](#x)` 是字面文本，不算内链
    const stripped = text.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
    const targets: string[] = [];
    // wiki 风格：`[[#标题]]`（`![[...]]` 是图片，带 `|` 的别名写法不支持）
    const wikiRe = /\[\[#([^\]\n|]+?)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = wikiRe.exec(stripped))) {
        if (match.index > 0 && stripped[match.index - 1] === '!') continue;
        const target = match[1].trim();
        if (target) targets.push(target);
    }
    // 标准 Markdown：`[文字](#标题)`
    const mdRe = /\[[^\]\n]*\]\(#([^)\n]+?)\)/g;
    while ((match = mdRe.exec(stripped))) {
        const target = match[1].trim();
        if (target) targets.push(target);
    }
    return targets;
}
