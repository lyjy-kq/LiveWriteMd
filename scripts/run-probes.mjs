/**
 * 探针一键回归：编译 → 起/复用静态服务器 → 逐个跑 headless-probe → 校验输出 → 汇总。
 *
 * 用法：
 *   npm run test:probe                跑注册表里的全部探针
 *   npm run test:probe -- split crlf  只跑名字里带这些子串的探针
 *
 * 注册表条目：
 *   name     - test/repro/<name>.html / .ts（脚本路径从 html 里解析，
 *              有的探针 bundle 在 ./<name>.js、有的在 ./probedist/，不用管）
 *   expect   - 输出里必须出现的子串（缺一个就算失败）
 *   forbid   - 输出里不允许出现的子串（默认自带 ERROR / REJECTION / 探针超时）
 *
 * 判失败的探针会把完整输出打印出来，方便直接看现场。
 * 注意：这里只收「能自动断言」的探针；纯诊断页（mapMemProbe 这类）不收。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8740;
const BASE = `http://127.0.0.1:${PORT}`;

/** 回归注册表：输出都是各探针最近一次实测通过时的关键行。 */
const PROBES = [
    // —— live 预览 ——
    {
        name: 'mathIndentProbe',
        expect: ['map: mathNode=true blocks=1'],
    },
    {
        name: 'readmeHeroProbe',
        expect: ['badges=4', 'align=center', 'border=0px'],
    },
    {
        name: 'tableEdgeProbe',
        expect: ['col hover: edgeCells=3', 'row hover: edgeCells=2'],
    },
    {
        name: 'tableImageProbe',
        expect: ['click opened=assets/posters/poster-01.png', 'inCell=true'],
    },
    // —— 导图 ——
    {
        name: 'mindmapEditProbe',
        expect: ['1a. 双击后 mini-CM 出现: PASS'],
        forbid: ['FAIL'],
    },
    {
        name: 'dragSelectedProbe',
        expect: ['selected=true', 'dragging=true'],
    },
    {
        name: 'mapDeleteMenuProbe',
        expect: [
            'menu=true items=3',
            'ui self: writes=1',
            'mixed heading: self disabled=true clickWrites=0',
        ],
    },
    {
        name: 'mapClipboardProbe',
        expect: [
            'multi bar visible=true acts=multi-copy,multi-cut,multi-paste,multi-delete',
            'paste btn=true disabled=false',
            'paste: delta=1 hasA1=true hasB=true jia=true',
            'cut: delta=1 removedB=true',
            'ctrl+v: restoredB=true',
        ],
        forbid: ['MISSING'],
    },
    {
        name: 'mapLinkProbe',
        expect: [
            'ctrl external: openUrl:https://example.com/docs',
            'ctrl file: openFile:notes/other.md',
            'ctrl anchor: messages=0',
        ],
    },
    {
        name: 'ilinkProbe',
        expect: [
            'live: internal=3',
            'live: broken=1',
            'bracketsHidden=true codeIntact=true',
            'live click: jumped=true flashed=true',
            'map: ilinks=2',
            'map: nodeInternal=3',
            'map click: to=0/0 selected=true flash=true',
            'map bidir: backward=true',
        ],
        forbid: ['MISSING'],
    },
    {
        // 引用行聚焦：整片相连的 > 行一起进源码态（含引用里嵌列表、嵌套引用）
        name: 'quoteFocusProbe',
        expect: [
            'render: L3="引用第一行',
            'focus: L3="> 引用第一行',
            'focus: L4="> 引用第二行',
            'leave: L3="引用第一行',
            'L9="> - 引用里的列表项',
            'L12="> > 内层引用',
            // 聚焦时 > 不能被压成 0 宽（cm-md-src-mark 会让它 DOM 里在、眼睛看不到）
            'quoteMarkFont=(无 src-mark span)',
        ],
    },
    {
        // 引用节点进导图 + 删除节点时前后 --- 分割行联动删除
        name: 'mapQuoteProbe',
        expect: [
            'map: quoteNodes=2',
            'quoteStyledLines=3',
            'del single: hrGone=true keepJia=true keepBing=true',
            'del setext: underlineKept=true',
            'del multi: hrGone=true keepJia=true keepDing=true',
        ],
    },
    {
        // 内链箭头遮挡：穿过节点的虚线段被裁掉（采样点不再落在节点上）
        name: 'ilinkStackProbe',
        expect: ['ilinks=2', 'overNode=0'],
    },
    {
        // 引用聚焦的对齐：> 顶到文本列（x=4）、续行悬挂缩进对齐文本列
        name: 'quoteAlignProbe',
        expect: ['render: L1[普通]=x=4.0', 'focus: L3 hangIndent=true'],
    },
    {
        // 性能监控 HUD：字段齐全、忙等制造尖峰、关闭即销毁
        name: 'hudProbe',
        expect: ['hud: allFields=true', '尖峰', 'hud: afterOff=false'],
    },
    {
        // 带空格 / 括号的文件链接（Lezer 拒解析，走逐行正则兜底）
        name: 'spacedLinkProbe',
        expect: [
            'render: spaced=true parens=true angle=true plainText=true',
            'click: openFile=../A Lightweight Gateway to Chaos Engineering.pdf',
        ],
        forbid: ['MISSING'],
    },
    {
        name: 'paraChildProbe',
        expect: ['media child unchanged=true'],
        forbid: ['MISSING'],
    },
    {
        name: 'splitChildProbe',
        expect: [
            'items=child/sibling',
            'belowLowest=true',
            'alignLeft=true',
            'ctx menu split item=false',
            'code split menu visible=false',
        ],
        forbid: ['MISSING'],
    },
    {
        name: 'crlfMapProbe',
        expect: ['"errors": 0', '"tableRendered": true'],
    },
    {
        // 大纲面板：拆分后 import 断链（type 导入当值用 / 漏 export）的回归点
        name: 'outlineProbe',
        expect: [
            'panel: items=5 rows=5',
            'accents: L1=rgba(235, 131, 131, 0.5) L2=rgba(174, 154, 203, 0.5) L3=rgba(125, 181, 205, 0.5)',
            'numbering: edits=5 first="# 1 一级标题" second="## 1.1 二级标题 A"',
            'tooltip: early=false late=true',
        ],
    },
    {
        name: 'mapTableWidthProbe',
        expect: ['edit: editing=true'],
        forbid: ['withinCap=false', 'restored=false'],
    },
    {
        name: 'mapTableEditWidthProbe',
        expect: [
            'edit: editing=true',
            'wrapped=true',
            'hScroll=false',
            'overflow offenders: (none)',
        ],
        forbid: ['withinCap=false'],
    },
];

const DEFAULT_FORBID = ['ERROR', 'REJECTION', '探针超时'];

/** 等服务器端口起来。 */
async function waitServer(proc, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${BASE}/test/repro/_probe.html`, { method: 'HEAD' });
            if (res.ok || res.status === 404) return true;
        } catch {
            /* 还没起来 */
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    proc?.kill('SIGKILL');
    throw new Error('静态服务器启动超时');
}

/** 从探针 html 里解析 bundle 输出路径（相对 test/repro/）。 */
function scriptOutOf(htmlPath) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const m = html.match(/<script[^>]+src="(\.\/[^"]+\.js)"/);
    if (!m) throw new Error(`${htmlPath} 里找不到 script src`);
    return m[1].slice(2);
}

/** 编译一个探针。 */
async function compileProbe(name) {
    const ts = path.join(root, 'test/repro', `${name}.ts`);
    const html = path.join(root, 'test/repro', `${name}.html`);
    const outRel = scriptOutOf(html);
    await build({
        entryPoints: [ts],
        outfile: path.join(root, 'test/repro', outRel),
        bundle: true,
        format: 'esm',
        loader: { '.css': 'text' },
        logLevel: 'silent',
    });
}

/** 跑一个探针，返回 { ok, output, reason }。 */
function runProbe(name, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(
            process.execPath,
            [path.join(root, 'scripts/headless-probe.mjs'), `${BASE}/test/repro/${name}.html`],
            { cwd: root }
        );
        let output = '';
        child.stdout.on('data', (d) => (output += d));
        child.stderr.on('data', (d) => (output += d));
        const killer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({ ok: false, output, reason: `外层超时（>${timeoutMs / 1000}s）` });
        }, timeoutMs);
        child.on('exit', () => {
            clearTimeout(killer);
            resolve({ ok: true, output, reason: '' });
        });
    });
}

async function main() {
    // 名字过滤：npm run test:probe -- split crlf
    const filters = process.argv.slice(2);
    const probes = PROBES.filter((p) =>
        filters.length === 0 || filters.some((f) => p.name.toLowerCase().includes(f.toLowerCase()))
    );
    if (probes.length === 0) {
        console.error('没有匹配的探针');
        process.exit(2);
    }

    // 服务器：已有实例就复用（不杀），没有就自己起一个、跑完收掉
    let serverProc = null;
    let serverUp = false;
    try {
        const res = await fetch(`${BASE}/test/repro/_probe.html`, { method: 'HEAD' });
        serverUp = res.ok || res.status === 404;
    } catch {
        /* 没在跑 */
    }
    if (!serverUp) {
        console.log('起临时静态服务器…');
        serverProc = spawn(process.execPath, [path.join(root, 'scripts/dev-browser.mjs')], {
            cwd: root,
            stdio: 'ignore',
        });
        await waitServer(serverProc);
    }

    const results = [];
    try {
        for (const probe of probes) {
            const startedAt = Date.now();
            process.stdout.write(`[${probe.name}] 编译…`);
            try {
                await compileProbe(probe.name);
            } catch (error) {
                results.push({ name: probe.name, ok: false, reason: `编译失败: ${error}` });
                process.stdout.write('编译失败\n');
                continue;
            }
            process.stdout.write('运行…\n');
            const { output, reason } = await runProbe(probe.name, 120000);
            const expect = probe.expect ?? [];
            const forbid = [...DEFAULT_FORBID, ...(probe.forbid ?? [])];
            const missing = expect.filter((t) => !output.includes(t));
            const hit = forbid.filter((t) => output.includes(t));
            const ok = !reason && missing.length === 0 && hit.length === 0;
            results.push({
                name: probe.name,
                ok,
                reason:
                    reason ||
                    (missing.length ? `缺输出: ${missing.join(' | ')}` : '') +
                        (hit.length ? `${missing.length ? '；' : ''}出现禁止串: ${hit.join(' | ')}` : ''),
                output,
                ms: Date.now() - startedAt,
            });
            console.log(`  ${ok ? 'PASS' : 'FAIL'} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
        }
    } finally {
        if (serverProc) {
            console.log('收掉临时服务器');
            serverProc.kill('SIGKILL');
        }
    }

    // 汇总
    console.log('\n========== 汇总 ==========');
    const failed = results.filter((r) => !r.ok);
    for (const r of results) {
        console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.reason ? `  — ${r.reason}` : ''}`);
    }
    for (const r of failed) {
        console.log(`\n----- ${r.name} 完整输出 -----`);
        console.log(r.output?.trim() || '(无输出)');
    }
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
    console.error(error);
    process.exit(2);
});
