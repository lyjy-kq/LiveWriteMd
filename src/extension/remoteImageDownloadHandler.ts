/**
 * LiveWriteMD 网络图片下载处理器。
 *
 * 这个模块负责扫描 Markdown 正文中的网络图片链接，将图片下载到
 * 文档同级的 `assets` 目录，并把正文中的链接改写为本地相对路径。
 */

import * as path from 'path';
import * as vscode from 'vscode';

import {
    getUniqueFileName,
    sanitizeFileName,
} from './imageSaveHandler.js';

/** 支持的网络图片协议。 */
const REMOTE_IMAGE_PROTOCOLS = new Set(['http:', 'https:']);

/** 用于匹配 Markdown 图片语法的正则。 */
const MARKDOWN_IMAGE_REGEX =
    /!\[([^\]]*?)\]\((?:<)?(https?:\/\/[^)\s>]+)(?:>)?(?:\s+((?:"[^"]*"|'[^']*'|\([^)]+\))))?\)/g;

/** 用于匹配 Obsidian wiki 图片语法的正则。 */
const WIKI_IMAGE_REGEX = /!\[\[([^\]\n]+?)\]\]/g;

/**
 * 网络图片链接的基础信息。
 */
interface RemoteImageReference {
    /** 图片原始链接。 */
    readonly url: string;
}

/**
 * 下载处理结果。
 */
export interface DownloadRemoteImagesResult {
    /** 下载并重写后的正文内容。 */
    readonly content: string;
    /** 成功下载的图片数量。 */
    readonly downloadedCount: number;
    /** 下载失败的原始 URL 列表。 */
    readonly failedUrls: string[];
}

/**
 * 提取正文中的网络图片引用。
 *
 * @param content - Markdown 正文内容
 * @returns 网络图片引用列表
 */
function extractRemoteImageReferences(content: string): RemoteImageReference[] {
    const references: RemoteImageReference[] = [];

    for (const match of content.matchAll(MARKDOWN_IMAGE_REGEX)) {
        const url = match[2];
        if (!isRemoteImageUrl(url)) {
            continue;
        }

        references.push({
            url,
        });
    }

    for (const match of content.matchAll(WIKI_IMAGE_REGEX)) {
        const inner = match[1];
        const [rawTarget] = inner.split('|', 1);
        if (!isRemoteImageUrl(rawTarget)) {
            continue;
        }

        references.push({
            url: rawTarget,
        });
    }

    return references;
}

/**
 * 判断给定字符串是否为可下载的网络图片地址。
 *
 * @param value - 待判断的字符串
 * @returns 是否为 http/https 图片地址
 */
function isRemoteImageUrl(value: string): boolean {
    try {
        const parsed = new URL(value.trim());
        return REMOTE_IMAGE_PROTOCOLS.has(parsed.protocol);
    } catch {
        return false;
    }
}

/**
 * 将文件名中的路径分隔和非法字符规范化。
 *
 * @param value - 原始文件名
 * @returns 规范化后的文件名
 */
function normalizeFileName(value: string): string {
    const trimmed = value.trim();
    const baseName = path.basename(trimmed);
    return sanitizeFileName(baseName || 'image.png');
}

/**
 * 从网络图片地址和响应头中推断最终文件名。
 *
 * @param imageUrl - 网络图片地址
 * @param contentType - 响应头中的 content-type
 * @returns 可用于写入磁盘的文件名
 */
function buildFileName(imageUrl: string, contentType: string | null): string {
    const url = new URL(imageUrl);

    let candidate = '';
    try {
        candidate = decodeURIComponent(path.basename(url.pathname));
    } catch {
        candidate = path.basename(url.pathname);
    }

    if (!candidate) {
        candidate = 'image';
    }

    let fileName = normalizeFileName(candidate);
    const ext = path.extname(fileName);
    if (!ext) {
        const inferredExt = inferExtensionFromContentType(contentType);
        fileName = normalizeFileName(`${fileName}${inferredExt}`);
    }

    return fileName;
}

/**
 * 从 content-type 推断图片扩展名。
 *
 * @param contentType - HTTP 响应头中的 content-type
 * @returns 文件扩展名
 */
function inferExtensionFromContentType(contentType: string | null): string {
    const normalized = contentType?.split(';', 1)[0].trim().toLowerCase() ?? '';
    switch (normalized) {
        case 'image/jpeg':
            return '.jpg';
        case 'image/png':
            return '.png';
        case 'image/gif':
            return '.gif';
        case 'image/webp':
            return '.webp';
        case 'image/bmp':
            return '.bmp';
        case 'image/svg+xml':
            return '.svg';
        case 'image/x-icon':
        case 'image/vnd.microsoft.icon':
            return '.ico';
        default:
            return '.png';
    }
}

/**
 * 计算下载后的本地相对路径。
 *
 * @param folderName - 保存目录名
 * @param fileName - 文件名
 * @returns 可写入正文的相对图片路径
 */
function buildRelativeImagePath(folderName: string, fileName: string): string {
    return `./${folderName.replace(/\\/g, '/')}/${fileName}`;
}

/**
 * 下载单张网络图片并写入 assets 目录。
 *
 * @param imageUrl - 网络图片地址
 * @param saveDir - 图片保存目录
 * @returns 写入后的相对路径
 */
async function downloadImageToAssets(imageUrl: string, saveDir: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await fetch(imageUrl, {
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const binary = new Uint8Array(await response.arrayBuffer());
        const fileName = await prepareUniqueImageName(imageUrl, saveDir, response.headers.get('content-type'));
        const filePath = path.join(saveDir, fileName);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), binary);

        const folderName = path.basename(saveDir);
        return buildRelativeImagePath(folderName, fileName);
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * 计算图片下载后的唯一文件名。
 *
 * @param imageUrl - 网络图片地址
 * @param saveDir - 图片保存目录
 * @param contentType - 响应头中的 content-type
 * @returns 唯一文件名
 */
async function prepareUniqueImageName(
    imageUrl: string,
    saveDir: string,
    contentType: string | null
): Promise<string> {
    const baseName = buildFileName(imageUrl, contentType);
    return getUniqueFileName(saveDir, baseName);
}

/**
 * 下载正文中的网络图片并重写链接。
 *
 * @param content - Markdown 正文内容
 * @param documentUri - 当前 Markdown 文档 URI
 * @returns 下载与重写结果
 */
export async function downloadRemoteImagesToAssets(
    content: string,
    documentUri: vscode.Uri
): Promise<DownloadRemoteImagesResult> {
    const references = extractRemoteImageReferences(content);
    if (references.length === 0) {
        return {
            content,
            downloadedCount: 0,
            failedUrls: [],
        };
    }

    const docDir = path.dirname(documentUri.fsPath);
    const folderName = 'assets';
    const saveDir = path.join(docDir, folderName);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(saveDir));

    const downloadedPathByUrl = new Map<string, string>();
    const failedUrls: string[] = [];
    const uniqueUrls = [...new Set(references.map((reference) => reference.url))];

    for (const imageUrl of uniqueUrls) {
        try {
            const relativePath = await downloadImageToAssets(imageUrl, saveDir);
            downloadedPathByUrl.set(imageUrl, relativePath);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[LiveWriteMD] Failed to download image: ${imageUrl} (${errorMessage})`);
            failedUrls.push(imageUrl);
        }
    }

    const rewrittenContent = rewriteRemoteImageLinks(content, downloadedPathByUrl);

    return {
        content: rewrittenContent,
        downloadedCount: downloadedPathByUrl.size,
        failedUrls,
    };
}

/**
 * 根据下载结果重写正文中的网络图片链接。
 *
 * @param content - 原始正文内容
 * @param downloadedPathByUrl - URL 到本地相对路径的映射
 * @returns 重写后的正文内容
 */
function rewriteRemoteImageLinks(
    content: string,
    downloadedPathByUrl: Map<string, string>
): string {
    const rewrittenMarkdown = content.replace(
        MARKDOWN_IMAGE_REGEX,
        (match: string, altText: string, url: string, title: string | undefined) => {
            const localPath = downloadedPathByUrl.get(url);
            if (!localPath) {
                return match;
            }

            const titleSuffix = title ? ` ${title}` : '';
            return `![${altText}](${localPath}${titleSuffix})`;
        }
    );

    return rewrittenMarkdown.replace(WIKI_IMAGE_REGEX, (match: string, inner: string) => {
        const [rawTarget, alias] = inner.split('|', 2);
        const localPath = downloadedPathByUrl.get(rawTarget);
        if (!localPath) {
            return match;
        }

        return alias ? `![[${localPath}|${alias}]]` : `![[${localPath}]]`;
    });
}
