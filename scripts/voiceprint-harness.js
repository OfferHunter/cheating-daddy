// 声纹检测页的离屏验证：加载真实的 VoiceprintView.js，喂进几行假句子，检查标题、气泡、speaker 编号圆标、
// 「如果这是你，请按下Y」只出现在最新一行、未定稿或编号未知时按 Y 不生效。
// 结果写 tp-voiceprint-results.txt 到系统 tmp(或 TP_HARNESS_OUT)；截图写同目录的 tp-voiceprint.png。
// 运行:node_modules/electron/dist/electron.exe scripts/voiceprint-harness.js
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

// 隔离配置目录,避免碰用户真实 config。
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceprint-harness-'));
fs.mkdirSync(path.join(ISOLATED_HOME, 'AppData', 'Roaming'), { recursive: true });
fs.mkdirSync(path.join(ISOLATED_HOME, 'AppData', 'Local'), { recursive: true });
process.env.USERPROFILE = ISOLATED_HOME;
process.env.HOME = ISOLATED_HOME;
process.env.APPDATA = path.join(ISOLATED_HOME, 'AppData', 'Roaming');
process.env.LOCALAPPDATA = path.join(ISOLATED_HOME, 'AppData', 'Local');

const { app, BrowserWindow } = require('electron');

const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'src');
const OUT_DIR = process.env.TP_HARNESS_OUT || os.tmpdir();

const results = [];
const check = (name, ok) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
    :root {
        --ui-alpha: 0.8; --text-alpha: 1;
        --bg-app: #0a0a0a; --bg-surface: #111111; --bg-elevated: #191919; --bg-hover: #1f1f1f;
        --text-primary: #f5f5f5; --text-secondary: #999999; --text-muted: #555555;
        --border: #222222; --border-strong: #333333;
        --accent: #3b82f6; --accent-hover: #2563eb; --btn-primary-text: #ffffff;
        --link-color: #60a5fa;
        --success: #22c55e; --warning: #d4a017; --danger: #ef4444;
        --font: 'Inter', system-ui, sans-serif; --font-mono: 'Consolas', monospace;
        --font-size-xs: 11px; --font-size-sm: 13px; --font-size-base: 14px; --font-size-lg: 16px; --font-size-xl: 20px;
        --font-weight-normal: 400; --font-weight-medium: 500; --font-weight-semibold: 600;
        --space-xs: 4px; --space-sm: 8px; --space-md: 16px; --space-lg: 24px;
        --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px;
        --transition: 150ms ease;
    }
    html, body { margin: 0; height: 100%; background: #0a0a0a; }
    voiceprint-view { display: block; height: 100vh; }
</style></head>
<body>
<script>
    const DEFAULTS = { uiLanguage: 'zh-CN' };
    window.require = function (name) {
        if (name === './defaults') return { DEFAULT_CONFIG: {}, DEFAULT_PREFERENCES: DEFAULTS };
        throw new Error('unexpected require in harness: ' + name);
    };
    window.__confirmed = [];
</script>
<script type="module">
    import '/src/components/views/VoiceprintView.js';
    const view = document.createElement('voiceprint-view');
    view.onConfirm = id => { window.__confirmed.push(id); };
    document.body.appendChild(view);
    window.__view = view;
</script>
</body></html>`;

const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function startServer() {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://x').pathname;
        let file = null;
        if (pathname.startsWith('/src/')) file = path.join(SRC, pathname.slice('/src/'.length));
        if (file && !path.resolve(file).startsWith(path.resolve(SRC) + path.sep)) file = null;

        if (pathname === '/' || pathname === '/index.html') {
            res.writeHead(200, { 'content-type': MIME['.html'] });
            res.end(PAGE);
            return;
        }
        if (!file) {
            res.writeHead(404);
            res.end('not found');
            return;
        }
        fs.readFile(file, (error, data) => {
            if (error) {
                res.writeHead(404);
                res.end('not found');
                return;
            }
            res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/plain' });
            res.end(data);
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

app.whenReady().then(async () => {
    let server = null;
    try {
        server = await startServer();
        const url = `http://127.0.0.1:${server.address().port}/`;

        const win = new BrowserWindow({ show: false, width: 900, height: 720, backgroundColor: '#0a0a0a' });
        win.webContents.on('console-message', (event, level, message) => {
            if (!message.includes('Electron Security Warning')) results.push(`CONSOLE  ${message}`);
        });
        win.webContents.on('did-fail-load', (event, code, desc, failedUrl) => results.push(`FAILLOAD  ${code} ${desc} ${failedUrl}`));
        await win.loadURL(url);
        await wait(500);

        const exec = js => win.webContents.executeJavaScript(js, true);
        await exec(`window.__root = () => window.__view.shadowRoot;
            window.__q = sel => window.__root().querySelector(sel);
            window.__all = sel => [...window.__root().querySelectorAll(sel)]; void 0`);

        check('voiceprint-view mounted', await exec(`!!window.__view`));
        check(
            'title reads 正在进行声纹检测...',
            (await exec(`window.__q('.detect-title').textContent`)).trim() === '正在进行声纹检测...'
        );
        check(
            'empty state asks the user to say a sentence of their own',
            (await exec(`window.__q('.detect-empty').textContent`)).includes('请先说一句明显属于你自己的话')
        );

        // 三句：前两句已定稿（speaker 1、2），最后一句仍是中间态（speaker -1）。
        await exec(`window.__view.lines = [
            { id: 1, sentenceId: 0, text: '你好，我是候选人。', speakerId: 1, final: true },
            { id: 2, sentenceId: 1, text: '请先做一个自我介绍。', speakerId: 2, final: true },
            { id: 3, sentenceId: 2, text: '好的，我毕业', speakerId: -1, final: false },
        ]; void 0`);
        await wait(120);

        check('one bubble per line', (await exec(`window.__all('.bubble').length`)) === 3);
        check(
            'speaker ids render in the badge',
            (await exec(`window.__all('.speaker-badge').map(b => b.textContent.trim()).join(',')`)) === '1,2,?'
        );
        check('bubble list is horizontally centered', (await exec(`getComputedStyle(window.__q('.bubble-list')).alignItems`)) === 'center');
        check('list scrolls vertically', (await exec(`getComputedStyle(window.__q('.detect-scroll')).overflowY`)) === 'auto');
        check('only the latest row carries the Y hint', (await exec(`window.__all('.confirm-hint').length`)) === 1);
        check(
            'the hint sits next to the newest bubble',
            await exec(`window.__all('.bubble-row').indexOf(window.__q('.confirm-hint').closest('.bubble-row')) === 2`)
        );
        check('hint text matches the request', (await exec(`window.__q('.confirm-hint').textContent`)).trim().includes('如果这是你，请按下Y'));
        check('hint is disabled while the newest line is uncertain', await exec(`window.__q('.confirm-hint').disabled`));

        // 未定稿时按 Y 什么都不该发生。
        await exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' })); void 0`);
        await wait(80);
        check('pressing Y on an uncertain line is ignored', (await exec(`window.__confirmed.length`)) === 0);

        // 最新一句定稿且编号可靠后，提示可点，按 Y 把该编号交给主进程。
        await exec(`window.__view.lines = [
            { id: 3, sentenceId: 2, text: '好的，我毕业于某大学。', speakerId: 3, final: true },
        ]; void 0`);
        await wait(120);
        check('hint becomes clickable once the speaker is known', await exec(`!window.__q('.confirm-hint').disabled`));
        check('the confirmed line shows its speaker id', (await exec(`window.__q('.speaker-badge').textContent`)).trim() === '3');

        await exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Y' })); void 0`);
        await wait(120);
        check('pressing Y confirms the newest line\'s speaker id', (await exec(`window.__confirmed.join(',')`)) === '3');

        await exec(`window.__q('.confirm-hint').click(); void 0`);
        await wait(120);
        check('clicking the hint confirms as well', (await exec(`window.__confirmed.join(',')`)) === '3,3');

        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(OUT_DIR, 'tp-voiceprint.png'), image.toPNG());
        results.push(`SHOT  ${path.join(OUT_DIR, 'tp-voiceprint.png')}`);

        // 识别服务失败：标题换成「语音服务异常：」，下面一行小字写具体错误，Y 不再生效。
        await exec(`window.__view.error = 'handshake rejected 4002: signature error'; void 0`);
        await wait(120);
        check('error title replaces the detection title', (await exec(`window.__q('.detect-title').textContent`)).trim() === '语音服务异常：');
        check('error title is marked as an error', await exec(`window.__q('.detect-title').classList.contains('error')`));
        check('error detail sits under the title', await exec(`(() => {
            const title = window.__q('.detect-title').getBoundingClientRect();
            const detail = window.__q('.detect-error').getBoundingClientRect();
            return detail.top >= title.bottom - 1;
        })()`));
        check('error detail carries the message', (await exec(`window.__q('.detect-error').textContent`)).trim() === 'handshake rejected 4002: signature error');
        check('error detail uses the small font', (await exec(`getComputedStyle(window.__q('.detect-error')).fontSize`)) === '11px');
        check('the Y hint disappears on error', (await exec(`window.__all('.confirm-hint').length`)) === 0);
        await exec(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' })); void 0`);
        await wait(80);
        check('pressing Y on error is ignored', (await exec(`window.__confirmed.join(',')`)) === '3,3');

        // 一句话都还没识别出来就失败：空状态提示让位给错误，而不是继续叫人说话。
        await exec(`window.__view.lines = []; void 0`);
        await wait(120);
        check('empty prompt is hidden while the service is down', await exec(`!window.__q('.detect-empty')`));
        check('error detail stays visible with no lines', (await exec(`window.__q('.detect-error').textContent`)).trim().length > 0);

        const errorImage = await win.webContents.capturePage();
        fs.writeFileSync(path.join(OUT_DIR, 'tp-voiceprint-error.png'), errorImage.toPNG());
        results.push(`SHOT  ${path.join(OUT_DIR, 'tp-voiceprint-error.png')}`);

        win.destroy();
    } catch (error) {
        results.push(`FAIL  harness threw: ${error && error.stack ? error.stack : error}`);
    }

    if (server) server.close();
    fs.writeFileSync(path.join(OUT_DIR, 'tp-voiceprint-results.txt'), results.join('\n') + '\n', 'utf8');
    app.exit(0);
});
