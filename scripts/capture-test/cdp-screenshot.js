#!/usr/bin/env node
// 走 Chromium 层的抓取，作为 WDA 路线的对照。
//
// 这一路完全不经过 DWM，所以 SetWindowDisplayAffinity（WDA_MONITOR / WDA_EXCLUDEFROMCAPTURE）管不到它：
//   - Page.captureScreenshot   抓的是渲染器自己的帧缓冲
//   - Runtime.evaluate          直接读出屏幕上的文字，"知道应用显示了什么"根本不需要像素
//
// 需要应用带着调试端口启动：
//   npx electron . --remote-debugging-port=9222
//   # 或打包版：
//   "海王AI面试助手.exe" --remote-debugging-port=9222
//
// 然后：
//   node scripts/capture-test/cdp-screenshot.js          # 输出到 out/cdp.png 与 out/cdp-dom.txt
//   node scripts/capture-test/cdp-screenshot.js 9222

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const port = Number(process.argv[2] || 9222);
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let body = '';
            res.on('data', c => (body += c));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

(async () => {
    let targets;
    try {
        targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    } catch (e) {
        console.error(`连不上 127.0.0.1:${port} 的 DevTools 端点：${e.message}`);
        console.error(`先带 --remote-debugging-port=${port} 启动应用。`);
        process.exit(1);
    }

    const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) {
        console.error('没有 page 目标，实际拿到：', targets.map(t => t.type));
        process.exit(1);
    }
    console.log(`已附加: ${page.title} <${page.url}>`);

    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    let id = 0;
    const pending = new Map();
    ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        }
    });
    const send = (method, params = {}) =>
        new Promise(resolve => {
            const i = ++id;
            pending.set(i, resolve);
            ws.send(JSON.stringify({ id: i, method, params }));
        });

    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });
    await send('Page.enable');

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) {
        const png = path.join(outDir, 'cdp.png');
        fs.writeFileSync(png, Buffer.from(shot.result.data, 'base64'));
        console.log(`写出 ${path.relative(process.cwd(), png)}  <- Page.captureScreenshot（渲染器帧缓冲）`);
    } else {
        console.error('captureScreenshot 失败:', shot.error || shot);
    }

    // 组件是 Lit，内容渲染进 open shadow DOM；document.body.innerText 不穿透 shadow 边界，会读到空。
    // 这里递归下钻每一层 shadowRoot 收集文字。
    const expr = `(() => {
        const chunks = [];
        const walk = (root) => {
            const text = root === document ? (document.body ? document.body.innerText : '') : (root.textContent || '');
            if (text && text.trim()) chunks.push(text.trim());
            for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) walk(el.shadowRoot);
            }
        };
        walk(document);
        return chunks.join('\\n');
    })()`;
    const dom = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    const text = dom.result && dom.result.result && dom.result.result.value;
    if (typeof text === 'string') {
        const txt = path.join(outDir, 'cdp-dom.txt');
        fs.writeFileSync(txt, text, 'utf8');
        console.log(`写出 ${path.relative(process.cwd(), txt)}  <- 递归 shadowRoot 文本（${text.length} 个字符的屏上文字，全程不碰像素）`);
    } else {
        console.error('读取 DOM 文本失败:', dom.error || dom);
    }

    ws.close();
})().catch(e => {
    console.error(e);
    process.exit(1);
});
