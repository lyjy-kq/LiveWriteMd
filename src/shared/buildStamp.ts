/**
 * 构建戳：排查「扩展宿主 / webview 跑的是不是最新包」用。
 *
 * 两侧（extension 激活时、webview 启动时）各往「输出 → LiveWriteMD」通道
 * 写一行 [build] 日志；哪侧缺行或戳不对，哪侧就是旧包。
 * **每次要出验证包时更新这个字符串**（手动的，别指望自动）。
 *
 * @module shared/buildStamp
 */
export const BUILD_STAMP = '2026-10-27+two-zone-prewarm';
