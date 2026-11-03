/**
 * 设置 Schema · 导图与高级分组：思维导图 / 高级。
 *
 * 只是 SETTINGS_SCHEMA 的数据片段，最终在 index.ts 拼装。
 *
 * 「思维导图」在面板里是父分组（导航可展开），下设四个子分组：
 * 外观 / 布局与尺寸 / 交互与性能 / 快速卡片。拆分只是重新归组，
 * 已有设置项的 key、默认值和取值范围保持不变。
 */
import type { SettingSection } from './types.js';

export const MINDMAP_SECTIONS: SettingSection[] = [
    {
        id: 'mindmap',
        label: '思维导图',
        icon: '🧠',
        description:
            '影响导图的配色、展开层级、节点排版和流畅度，导图显示不合意时来这里调。',
        // 父分组的说明保留在导航标题的 tooltip 上；右侧内容区按子分组展示。
        children: [
            {
                id: 'mindmap-appearance',
                label: '外观',
                icon: '🎨',
                description: '节点配色、底色浓度和缩放时的文字观感。',
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
                        // 面板里不显示：用户直接拖卡片左边界调整，值要能持久化
                        key: 'quickCardWidth',
                        label: '卡片宽度',
                        description: '快速卡片的宽度（拖动卡片左边界调整，全局生效）。',
                        control: 'slider',
                        default: 280,
                        min: 160,
                        max: 480,
                        step: 10,
                        unit: 'px',
                        hidden: true,
                    },
                ],
            },
            {
                id: 'mindmap-layout',
                label: '布局与尺寸',
                icon: '📐',
                description: '打开时的展开层级，以及节点文本、代码块的大小与截断规则。',
                items: [
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
                        key: 'mindmapCodeWidth',
                        label: '代码块宽度',
                        description:
                            '代码块节点的最大宽度（1 列 = 1 个等宽字符宽）；节点最窄 40 列。长行不换行，超出后在节点内左右滚动。',
                        control: 'slider',
                        default: 60,
                        min: 40,
                        max: 100,
                        step: 1,
                        unit: '列',
                    },
                ],
            },
            {
                id: 'mindmap-interaction',
                label: '交互与性能',
                icon: '⚡',
                description: '内链箭头和手势期间的清晰度取舍。',
                items: [
                    {
                        key: 'mindmapInternalLinks',
                        label: '显示内链箭头',
                        description:
                            '文档内链接（[[#标题]] 或 [文字](#标题)）在导图中以底层虚线箭头呈现，从内链所在节点指向目标标题节点，点击箭头跳转。',
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
                ],
            },
            {
                id: 'mindmap-quick-card',
                label: '快速卡片',
                icon: '🗂️',
                description:
                    '在导图右边界显示一条快速卡片栏，用来随手记录临时想法。尺寸跟随内容自适应。',
                items: [
                    {
                        key: 'quickCardEnabled',
                        label: '显示快速卡片',
                        description:
                            '在导图右边界显示快速卡片栏，用来记录临时想法。关闭后整条卡片栏隐藏。',
                        control: 'toggle',
                        default: true,
                    },
                ],
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
            {
                // 全局性能监测：从导图模式抽出来，所有模式共用同一个浮层。
                // off / minimal / full 三档，full 才装长任务观察器与 gBCR 包装。
                key: 'perfMonitor',
                label: '性能监测',
                description:
                    '在窗口右上角实时显示当前打开文件的性能数据，实时 / 源码 / 阅读 / 导图 / 幻灯片所有模式通用。极简版只有帧率与堆内存；完整版另含 DOM、文档大小、当前模式专属指标（导图节点、幻灯片页数、文本视口行数）与强制布局速率，并记录帧率跳变和长任务现场（可一键复制成 JSON）。默认关闭。',
                control: 'select',
                default: 'off',
                options: [
                    { value: 'off', label: '关闭' },
                    { value: 'minimal', label: '极简（帧率 + 内存）' },
                    { value: 'full', label: '完整（详细指标）' },
                ],
            },
        ],
    },
];
