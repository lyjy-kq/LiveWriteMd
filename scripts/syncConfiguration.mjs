/**
 * syncConfiguration —— 把 settingsSchema 同步进 package.json。
 *
 * settingsSchema.ts 是设置的单一数据源；本脚本把每个设置项转换成 VS Code 的
 * contributes.configuration.property（type/default/enum/range/description），
 * 写回 package.json。schema 改动后跑一次：
 *
 *   node scripts/syncConfiguration.mjs
 *
 * 这样面板、扩展读取、VS Code 原生设置页三处始终一致，不用手抄 30+ 配置。
 *
 * @module scripts/syncConfiguration
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const schemaPath = path.join(
    rootDir,
    'src/shared/settingsSchema.ts'
);
const pkgPath = path.join(rootDir, 'package.json');

// 用 esbuild 把 schema TS 打成临时 ESM（schema 无运行时依赖，产物很干净）
const result = await build({
    entryPoints: [schemaPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    loader: { '.ts': 'ts' },
});
const tempSchema = path.join(rootDir, 'node_modules/.cache-settings-schema.mjs');
fs.writeFileSync(tempSchema, result.outputFiles[0].text);
const schema = await import(
    'file://' + tempSchema.replace(/\\/g, '/')
);
fs.unlinkSync(tempSchema);

/**
 * 把一个设置项转换成 VS Code configuration property。
 */
function toProperty(item) {
    const property = {};
    if (item.description) property.description = item.description;

    switch (item.control) {
        case 'toggle':
            property.type = 'boolean';
            property.default = Boolean(item.default);
            break;

        case 'slider':
            property.type = 'number';
            property.default = Number(item.default);
            if (typeof item.min === 'number') property.minimum = item.min;
            if (typeof item.max === 'number') property.maximum = item.max;
            if (typeof item.step === 'number') property.multipleOf = item.step;
            break;

        case 'color':
            property.type = 'string';
            property.default = String(item.default);
            // 颜色默认空串=自动；给出格式提示
            property.pattern = '^$|^#[0-9a-fA-F]{3,8}$|^rgba?\\(|^[a-z]+$';
            property.patternErrorMessage =
                '请输入 CSS 颜色（如 #338122、rgba(...) ），留空表示跟随主题。';
            break;

        case 'select':
            property.type = 'string';
            property.default = String(item.default);
            property.enum = (item.options ?? []).map((o) => o.value);
            property.enumDescriptions = (item.options ?? []).map(
                (o) => o.label
            );
            break;

        case 'text':
        default:
            property.type = 'string';
            property.default = String(item.default);
            if (item.placeholder) {
                property.description =
                    (item.description ? item.description + ' ' : '') +
                    `占位提示：${item.placeholder}`;
            }
            break;
    }

    return property;
}

// 生成全部 properties（key 带 flowMd 前缀由 configuration section 提供，这里用裸 key）
const generated = {};
for (const item of schema.ALL_SETTING_ITEMS) {
    generated[item.key] = toProperty(item);
}

// 读 package.json，更新 contributes.configuration
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const configuration = pkg.contributes?.configuration;
if (!configuration) {
    throw new Error('package.json 缺少 contributes.configuration');
}

// 保留 schema 之外可能存在的额外 key（理论上所有 key 都在 schema 里）
const existingProps = configuration.properties ?? {};
configuration.properties = { ...existingProps, ...generated };

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

const count = Object.keys(generated).length;
console.log(`FlowMD configuration 已同步：${count} 项设置写入 package.json`);
