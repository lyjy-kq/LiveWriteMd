/**
 * 设置 Schema · 导图与高级分组：思维导图 / 高级。
 *
 * 只是 SETTINGS_SCHEMA 的数据片段，最终在 index.ts 拼装。
 */
import type { SettingSection } from './types.js';

export const MINDMAP_SECTIONS: SettingSection[] = [
    {
        id: 'mindmap',
        label: '思维导图',
        icon: '🧠',
        description:
            '影响导图的配色、展开层级、节点排版和流畅度，导图显示不合意时来这里调。',
        items: [
            {
                key: 'mindmapTheme',
                label: '导图配色',
                description: '设为自动时跟随编辑器当前的明 / 暗主题。',
                control: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: '自动（跟随编辑器）' },
                    { value: 'default', label: '默认（经典浅色）' },
                    { value: 'dark', label: '深色' },
                ],
            },
            {
                key: 'mindmapDefaultExpandLevel',
                label: '默认展开层级',
                description: '打开导图时默认展开到第几层，0 = 只显示根节点。',
                control: 'slider',
                default: 2,
                min: 0,
                max: 6,
                step: 1,
                unit: '层',
            },
            {
                key: 'mindmapInternalLinks',
                label: '显示内链箭头',
                description:
                    '文档内链接（[[#标题]] 或 [文字](#标题)）在导图中以底层虚线箭头呈现，从内链所在节点指向目标标题节点，点击箭头跳转。',
                control: 'toggle',
                default: true,
            },
            {
                key: 'mindmapPerfMonitor',
                label: '性能监测',
                description:
                    '在画布右上角实时显示性能数据。极简版无边框，只显示帧率与堆内存；完整版另含实例数 / 换真队列 / 强制布局速率，并记录帧率跳变与长任务现场（可一键复制成 JSON）。默认关闭。',
                control: 'select',
                default: 'off',
                options: [
                    { value: 'off', label: '关闭' },
                    { value: 'minimal', label: '极简（帧率 + 内存）' },
                    { value: 'full', label: '完整（详细指标）' },
                ],
            },
            {
                // 影响「文字观感」的旋钮：底色越淡，文字与底色的对比度越高。
                // 实测同一段文字 16% → 0% 时 Laplacian 119 → 133（+12%），
                // 高倍缩放下大字占比更高，观感差别更明显。
                key: 'mindmapNodeWash',
                label: '节点底色浓度',
                description:
                    '节点背景色 = 标题色按该比例混入。比例越低，底色越淡、文字与底色的对比越强，笔画看起来更清晰；0 = 完全透明（只剩边框）。',
                control: 'slider',
                default: 8,
                min: 0,
                max: 40,
                step: 1,
                unit: '%',
            },
            {
                // 高倍缩放时的「阅读增强」：只压底色浓度，不动字形和布局。
                // 这是目前唯一实测能提升高倍下文字观感的旋钮（见 canvas.ts
                // HI_ZOOM_THRESHOLD 的说明：重新排版 / 像素对齐都实测无变化）。
                key: 'mindmapHiZoomContrast',
                label: '高倍缩放增强清晰度',
                description:
                    '缩放超过 150% 时，把节点底色浓度压到原来的 35%，提高文字与底色的对比，大字更清晰；关闭后任何缩放比例都保持统一底色。',
                control: 'toggle',
                default: true,
            },
            {
                // 手势期间默认提升合成层（帧率优先）。打开后不要提升：
                // 文字在拖动/缩放过程中也保持 LCD 次像素抗锯齿并按当前比例
                // 重新栅格化，代价是每帧重绘视口，大文档可能掉帧。
                key: 'mindmapGestureCrisp',
                label: '手势期间保持清晰',
                description:
                    '开启（默认）时，拖动和滚轮缩放期间不提升合成层，文字在运动中也按当前比例重新栅格化、保留次像素抗锯齿；关闭后手势期间临时提升合成层换帧率，运动中的文字是缓存位图（略灰）。实测 60~74 个可见节点时两者帧间隔相同。',
                control: 'toggle',
                default: true,
            },
            {
                key: 'mindmapNodeMaxWidth',
                label: '节点最大宽度',
                description:
                    '文本节点一行最多排几列（1 列 = 1 个中文字宽），超出换行；与「节点最大行数」共同决定截断点。',
                control: 'slider',
                default: 20,
                min: 5,
                max: 60,
                step: 1,
                unit: '列',
            },
            {
                key: 'mindmapNodeMaxLines',
                label: '节点最大行数',
                description:
                    '文本节点最多显示几行，超出部分截断加省略号；点击已选中的节点可先展开到最大行数，再点进入编辑。',
                control: 'slider',
                default: 3,
                min: 1,
                max: 10,
                step: 1,
                unit: '行',
            },
            {
                key: 'mindmapCodeMinWidth',
                label: '代码块最小宽度',
                description:
                    '代码块节点的最小宽度（1 列 = 1 个等宽字符宽），避免短代码的节点过窄；0 = 不设最小宽度。',
                control: 'slider',
                default: 10,
                min: 0,
                max: 60,
                step: 1,
                unit: '列',
            },
        ],
    },
    {
        id: 'advanced',
        label: '高级',
        icon: '🧩',
        description:
            '主题、同步延迟、拖拽判定等底层选项，通常保持默认，遇到具体问题时再改。',
        items: [
            {
                key: 'theme',
                label: '主题',
                description: '设为自动时跟随 VS Code 当前主题。',
                control: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: '自动（跟随 VS Code）' },
                    { value: 'dark', label: '深色' },
                    { value: 'light', label: '浅色' },
                ],
            },
            {
                key: 'syncDebounceMs',
                label: '同步防抖时间',
                description: 'Webview 与文档同步前的等待毫秒数，打字快时可适当调大。',
                control: 'slider',
                default: 300,
                min: 50,
                max: 2000,
                step: 50,
                unit: 'ms',
            },
            {
                key: 'dragThreshold',
                label: '拖拽判定距离',
                description: '鼠标移动超过多少像素才视为「拖选」并展开整行。',
                control: 'slider',
                default: 4,
                min: 2,
                max: 15,
                step: 1,
                unit: 'px',
            },
            {
                key: 'doubleClickPin',
                label: '双击钉住源码态',
                description: '关闭后双击不再钉住整行的源码显示。',
                control: 'toggle',
                default: true,
            },
            {
                key: 'largeFileWarningThreshold',
                label: '大文件警告阈值',
                description: '单位字节，0 表示关闭警告。',
                control: 'text',
                default: 1048576,
                placeholder: '1048576',
            },
            {
                key: 'pdfBrowserPath',
                label: 'PDF 导出浏览器路径',
                description: '导出 PDF 所用 Edge/Chrome 可执行文件，留空自动探测。',
                control: 'text',
                default: '',
                placeholder: '留空自动探测',
            },
            {
                key: 'enableDebugLog',
                label: '启用调试日志',
                description: '详细日志输出到「输出」面板的 LiveWriteMD 通道。',
                control: 'toggle',
                default: false,
            },
        ],
    },
];
