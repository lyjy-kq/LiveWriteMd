/**
 * live preview 内部共用的小类型。
 *
 * 只放「几个模块都要用、又小到不值得单开模块」的类型。
 * （这个文件之前丢了，各个模块还在 `import type ... from './types.js'`，
 * 因为 type import 打包时会被直接擦掉，所以一直没人发现。）
 *
 * @module webview/codemirror/extensions/livePreview/types
 */

/** 文档里的一个区间，按「行」算：from/to 都是行首/行尾位置。 */
export interface ILineRange {
    from: number;
    to: number;
}

/** frontmatter（YAML 头部）里的一条属性。 */
export interface FrontmatterProperty {
    /** 属性名（`title`、`tags` 这些） */
    key: string;
    /** 属性值，多行值已经拼成一段文本 */
    value: string;
}
