/**
 * 共享 mermaid 渲染助手（导图 mermaid 媒体节点与正文 MermaidWidget 共用）。
 *
 * 从 MermaidWidget.renderAsync 抽出：动态 import mermaid、按主题初始化
 * （全进程一次）、唯一 id 防渲染冲突、inflight 去重、SVG 缓存。
 * 缓存与初始化标记都是 state.ts 的模块级共享状态，正文与导图自然一致。
 *
 * @module webview/codemirror/extensions/livePreview/mermaidRender
 */

import {
    getMermaidTheme,
    mermaidInitialized,
    mermaidRenderPromises,
    mermaidSvgCache,
    rememberMermaidSvg,
    setMermaidInitialized,
} from './state.js';

/** 渲染计数器（唯一 id 防 Mermaid 渲染冲突）。 */
let renderCounter = 0;

/**
 * 把 mermaid 源码渲染成 SVG 字符串。
 *
 * @param source - mermaid 图源码（不含 ```mermaid 围栏）
 * @returns SVG 字符串；渲染失败时抛错（调用方决定怎么显示错误）
 */
export async function renderMermaidSvg(source: string): Promise<string> {
    // 缓存命中直接返回（内容寻址，正文/导图共享）
    const cached = mermaidSvgCache.get(source);
    if (cached) return cached;
    // 同一源码正在渲染：等同一个 Promise，不重复渲染
    const inflight = mermaidRenderPromises.get(source);
    if (inflight) return inflight;

    const mermaid = await import('mermaid');
    if (!mermaidInitialized) {
        const isDark = getMermaidTheme() === 'dark';
        mermaid.default.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: isDark ? 'dark' : 'default',
            themeVariables: isDark
                ? {
                      primaryColor: '#1f2020',
                      primaryBorderColor: '#555',
                      primaryTextColor: '#d4d4d4',
                      lineColor: '#666',
                      secondaryColor: '#2a2d35',
                      tertiaryColor: '#30353f',
                  }
                : {
                      primaryColor: '#ffffff',
                      primaryBorderColor: '#d0d7de',
                      primaryTextColor: '#24292e',
                      lineColor: '#656d76',
                      secondaryColor: '#f6f8fa',
                      tertiaryColor: '#eff1f3',
                  },
        });
        setMermaidInitialized(true);
    }

    const uniqueId = `mermaid-${renderCounter++}`;
    const promise = mermaid.default.render(uniqueId, source).then(({ svg }) => {
        rememberMermaidSvg(source, svg);
        return svg;
    });
    mermaidRenderPromises.set(source, promise);
    try {
        return await promise;
    } finally {
        mermaidRenderPromises.delete(source);
    }
}
