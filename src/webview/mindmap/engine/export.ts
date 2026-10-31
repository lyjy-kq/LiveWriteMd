/**
 * 导图导出（PNG / SVG / PDF）。
 *
 * 自研画布导出不依赖任何第三方渲染器：
 * 1. MapCanvas.buildExportSvg() 把世界层克隆进一个 <foreignObject>，
 *    连同页面全部 <style> 与 CSS 变量一起序列化；
 * 2. SVG 直接交回宿主；
 * 3. PNG / PDF 用 <img> 解码 SVG 后画到 canvas：
 *    - PNG 取 canvas.toDataURL('image/png')；
 *    - PDF 用 canvas.toDataURL('image/jpeg')，手工拼一个单页 PDF
 *      （JPEG 可以直接以 /DCTDecode 嵌入，不需要额外的图像编码库）。
 */

import type { MapCanvas } from './canvas.js';
import { walkVisible } from './model.js';
import { computeBounds } from './layout.js';

/** 栅格化结果。 */
export interface RasterResult {
    /** 画布（像素尺寸 = SVG 尺寸 × scale）。 */
    canvas: HTMLCanvasElement;
    /** 逻辑宽度（CSS 像素）。 */
    width: number;
    height: number;
}

/**
 * 把 SVG 文本解码为位图并画到 canvas。
 *
 * @param svgText SVG 文本
 * @param width 逻辑宽度
 * @param height 逻辑高度
 * @param scale 像素倍率（1~2，太大导出的内存会爆）
 * @returns 栅格化后的 canvas
 */
export async function rasterizeSvg(
    svgText: string,
    width: number,
    height: number,
    scale = 2
): Promise<RasterResult> {
    // 必须用 data: URL，不能用 blob: URL！
    // blob: 是不透明源，SVG（尤其含 foreignObject）以 blob 加载后再画进
    // canvas 会把画布标记为 tainted，toDataURL 直接抛 SecurityError。
    const url = `data:image/svg+xml;base64,${textToBase64(svgText)}`;
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('SVG 解码失败'));
        image.src = url;
    });
    // 浏览器 canvas 有最大边/面积限制（Chrome 单边约 65535、面积约 2.68 亿像素）。
    // 大导图按 2x 导出会直接创建失败，这里按长边自适应降倍率。
    const maxSide = 8192;
    const maxArea = 64_000_000;
    const sideScale = maxSide / Math.max(width, height, 1);
    const areaScale = Math.sqrt(maxArea / Math.max(width * height, 1));
    const actualScale = Math.max(0.1, Math.min(scale, sideScale, areaScale));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * actualScale));
    canvas.height = Math.max(1, Math.round(height * actualScale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建导出画布');
    ctx.fillStyle = readBackgroundColor();
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { canvas, width, height };
}

/** UTF-8 文本 → base64（分块，避免大 SVG 触发参数过多）。 */
function textToBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/** 导出位图的底色：跟随编辑器背景，透明时退回深色。 */
function readBackgroundColor(): string {
    const value = getComputedStyle(document.body)
        .getPropertyValue('--vscode-editor-background')
        .trim();
    return value || '#1e1e1e';
}

/**
 * canvas → PNG dataURL。
 *
 * @param canvas 位图画布
 * @returns data:image/png;base64,...
 */
export function toPngDataUrl(canvas: HTMLCanvasElement): string {
    return canvas.toDataURL('image/png');
}

/**
 * canvas → 单页 PDF 的 dataURL。
 *
 * PDF 结构（手工构造，只依赖 JPEG 直嵌）：
 *   1 Catalog → 2 Pages → 3 Page
 *   4 Contents：`q W 0 0 H 0 0 cm /Im0 Do Q`
 *   5 Image XObject：/DCTDecode（JPEG 字节原样塞入）
 *
 * @param canvas 位图画布
 * @returns data:application/pdf;base64,...
 */
export function toPdfDataUrl(canvas: HTMLCanvasElement): string {
    const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const jpeg = base64ToBytes(jpegDataUrl.split(',')[1] ?? '');

    // PDF 用 pt 作为单位；按 0.75 换算，长边限制在 2000pt 内，避免阅读器卡死
    const maxPt = 2000;
    const ratio = Math.min(1, maxPt / Math.max(canvas.width, canvas.height));
    const pageWidth = Math.max(1, canvas.width * 0.75 * ratio);
    const pageHeight = Math.max(1, canvas.height * 0.75 * ratio);

    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    let byteLength = 0;

    const pushText = (text: string): void => {
        const bytes = encoder.encode(text);
        chunks.push(bytes);
        byteLength += bytes.length;
    };
    const pushBytes = (bytes: Uint8Array): void => {
        chunks.push(bytes);
        byteLength += bytes.length;
    };
    const object = (id: number, body: string, stream?: Uint8Array): void => {
        offsets[id] = byteLength;
        pushText(`${id} 0 obj\n${body}\n`);
        if (stream) {
            pushBytes(stream);
            pushText('\nendstream\n');
        }
        pushText('endobj\n');
    };

    pushText('%PDF-1.4\n%âãÏÓ\n');

    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    object(
        3,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(
            2
        )}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`
    );
    const content = `q\n${pageWidth.toFixed(2)} 0 0 ${pageHeight.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`;
    const contentBytes = encoder.encode(content);
    object(4, `<< /Length ${contentBytes.length} >>\nstream`, contentBytes);
    object(
        5,
        `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${
            canvas.height
        } /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${
            jpeg.length
        } >>\nstream`,
        jpeg
    );

    // xref：每条固定 20 字节（"0000000000 00000 n \n"）
    const xrefOffset = byteLength;
    let xref = `xref\n0 6\n0000000000 65535 f \n`;
    for (let id = 1; id <= 5; id += 1) {
        xref += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
    }
    xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    pushText(xref);

    // 合并所有分片
    const total = new Uint8Array(byteLength);
    let cursor = 0;
    for (const chunk of chunks) {
        total.set(chunk, cursor);
        cursor += chunk.length;
    }
    return `data:application/pdf;base64,${bytesToBase64(total)}`;
}

/** base64 → 二进制。 */
function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** 二进制 → base64（分块，避免大文件触发参数过多）。 */
function bytesToBase64(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}


// =============================================================================
// SVG 导出构建（从 canvas.ts 拆出，原 MapCanvas.buildExportSvg 方法）
// =============================================================================


// ==================================================================
// 导出
// ==================================================================

/**
 * 生成导出用 SVG 文本。
 *
 * 步骤：
 * 1. 临时关掉虚拟化，把全部可见节点挂进 DOM 并换成真实显示实例
 *    （占位的纯文本导出去没有意义）；
 * 2. 把世界层整体克隆进一个 foreignObject；
 * 3. 把页面上全部 <style> 与容器上的 CSS 变量一起塞进去 —— 我们的
 *    .lwm-* 样式与 token 颜色都不是内联的，不注入就会全丢；
 * 4. 恢复虚拟化，按视口重新裁剪。
 *
 * @returns SVG 文本与逻辑尺寸
 */
export function buildExportSvg(c: MapCanvas) : { svg: string; width: number; height: number } {
    const fallback = {
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
        width: 1,
        height: 1,
    };
    if (!c.root) return fallback;

    // 导出中途可能抛错（克隆/序列化）；用 finally 保证临时关闭的
    // 虚拟化一定恢复，否则画布会永远全量挂载、内存回落不了。
    try {
    c.virtualization = false;
    walkVisible(c.root, (node) => {
        c.ensureWrapper(node);
        // 导出前把占位换成真实显示（上限 500 个，超大文档保留占位保底）
        if (!node.display && c.displays.size < 500) {
            c.createDisplay(node);
            c.measureNode(node);
        }
        c.mountNode(node);
    });
    c.relayout();
    c.updateViewport();

    const bounds = computeBounds(c.root);
    const padding = 40;
    const width = Math.max(1, Math.ceil(bounds.width + padding * 2));
    const height = Math.max(1, Math.ceil(bounds.height + padding * 2));

    const clone = c.worldEl.cloneNode(true) as HTMLDivElement;
    clone.style.transform = `translate3d(${padding - bounds.left}px, ${
        padding - bounds.top
    }px, 0)`;
    // 缩放层带着运行时的 scale（屏幕缩放），导出必须还原成世界坐标：
    // 导出图由外层 wrapper 决定尺寸，内容应保持 1:1。
    clone.querySelector<HTMLElement>('.lwm-scaler')?.style.setProperty(
        'transform',
        ''
    );
    // 交互用的浮层不参与导出
    clone
        .querySelectorAll('.lwm-expand-btn, .lwm-drop-line')
        .forEach((el) => el.remove());
    // CodeMirror 的 .cm-widgetBuffer 是无 src 的布局占位 <img>：
    // SVG 作为 <img> 解码时，foreignObject 里的 <img> 会让画布被 taint，
    // 导致 PNG/PDF 导出抛 SecurityError。它们只是空占位，删掉不影响排版。
    clone.querySelectorAll('img.cm-widgetBuffer').forEach((el) => el.remove());
    // 视口裁剪时留下 display:none 的连线/节点一律恢复显示（此时都已挂载）
    clone.querySelectorAll<HTMLElement>('.lwm-links path').forEach((path) => {
        path.style.display = '';
    });
    // 连线层是嵌套 <svg>：克隆体已经按当前包围盒给了尺寸，但导出图
    // 额外加了 padding 且可能被平移，这里统一放大到整张导出图的范围，
    // 并显式允许溢出，避免 foreignObject 把超出视口的线裁掉。
    const linksClone = clone.querySelector('.lwm-links') as SVGSVGElement | null;
    if (linksClone) {
        linksClone.setAttribute('width', String(width));
        linksClone.setAttribute('height', String(height));
        linksClone.style.overflow = 'visible';
    }

    // 页面全部样式（含 CodeMirror 注入的 StyleModule 与 token 色表）
    const styleText = Array.from(document.querySelectorAll('style'))
        .map((el) => el.textContent ?? '')
        .join('\n');

    // 容器上的 CSS 变量逐条抄进导出根节点：var(--vscode-*) / 字体缩放
    // 这些都定义在 webview 根/容器上，克隆体自己继承不到
    const computed = getComputedStyle(c.container);
    let vars = '';
    for (let i = 0; i < computed.length; i += 1) {
        const name = computed[i];
        if (!name.startsWith('--')) continue;
        vars += `${name}:${computed.getPropertyValue(name)};`;
    }
    const background =
        computed.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';

    const wrapper = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    wrapper.setAttribute(
        'style',
        `position:relative;width:${width}px;height:${height}px;overflow:hidden;` +
            `background:${background};${vars}`
    );
    const styleEl = document.createElement('style');
    styleEl.textContent = styleText;
    wrapper.appendChild(styleEl);
    wrapper.appendChild(clone);

    const svgRoot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgRoot.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svgRoot.setAttribute('width', String(width));
    svgRoot.setAttribute('height', String(height));
    svgRoot.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const foreignObject = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'foreignObject'
    );
    foreignObject.setAttribute('x', '0');
    foreignObject.setAttribute('y', '0');
    foreignObject.setAttribute('width', String(width));
    foreignObject.setAttribute('height', String(height));
    foreignObject.appendChild(wrapper);
    svgRoot.appendChild(foreignObject);

    const svg = new XMLSerializer().serializeToString(svgRoot);

    return { svg, width, height };
    } finally {
        // 恢复虚拟化：按视口重新裁剪（离屏实例保留，回视口直接复用）
        c.virtualization = true;
        c.updateViewport();
    }
}
