// 帮助页顶部「激活提示 + 激活码输入」的门控验证:离屏加载真实的 HelpView.js,断言标题是激活状态、
// 输入框位于标题之下、帮助标题/说明被下沉,以及错误码与成功覆盖码的行内反馈。
// 结果写 tp-help-results.txt 到系统 tmp(或 TP_HARNESS_OUT);截图写同目录的 tp-help.png。
// 运行:node_modules/electron/dist/electron.exe scripts/help-view-harness.js
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

// 隔离配置目录,避免碰用户真实 config。
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'help-harness-'));
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
        --accent: #3b82f6; --accent-hover: #2563eb;
        --success: #22c55e; --warning: #d4a017; --danger: #ef4444;
        --font: 'Inter', system-ui, sans-serif;
        --font-mono: 'Consolas', monospace;
        --font-size-xs: 11px; --font-size-sm: 13px; --font-size-base: 14px; --font-size-lg: 16px; --font-size-xl: 20px;
        --font-weight-normal: 400; --font-weight-medium: 500; --font-weight-semibold: 600;
        --space-xs: 4px; --space-sm: 8px; --space-md: 16px; --space-lg: 24px;
        --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px;
        --transition: 150ms ease;
    }
    html, body { margin: 0; height: 100%; background: #0a0a0a; }
</style></head>
<body>
<script>
    const DEFAULTS = {
        uiLanguage: 'zh-CN', briefThinking: false, detailThinking: false, screenshotThinking: true,
    };
    const CONFIG = {
        chatBaseUrl: 'https://api.deepseek.com', deepseekModel: 'deepseek-chat',
        bailianModel: 'paraformer-realtime-v2', bailianWsUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    };
    window.require = function (name) {
        if (name === './defaults') return { DEFAULT_CONFIG: CONFIG, DEFAULT_PREFERENCES: DEFAULTS };
        if (name === './utils/keybinds') {
            return {
                getDefaultKeybinds: () => ({
                    moveUp: 'Ctrl+Up', moveDown: 'Ctrl+Down', toggleVisibility: 'Ctrl+\\\\',
                    toggleClickThrough: 'Ctrl+M', screenShot: 'Ctrl+Enter', screenShotToCache: 'Ctrl+Shift+Enter',
                    scrollUp: 'Ctrl+Shift+Up', detailPrev: 'Ctrl+Shift+[', toggleTheme: 'Ctrl+Shift+L',
                    quit: 'Ctrl+Shift+Q', emergencyErase: 'Ctrl+Shift+E',
                }),
                getKeybindActions: () => ([
                    { key: 'moveUp' }, { key: 'toggleVisibility' }, { key: 'toggleClickThrough' },
                    { key: 'screenShot' }, { key: 'screenShotToCache' }, { key: 'scrollUp' },
                    { key: 'detailPrev' }, { key: 'toggleTheme' }, { key: 'quit' }, { key: 'emergencyErase' },
                ]),
            };
        }
        throw new Error('unexpected require in harness: ' + name);
    };
    window.__license = { activated: true, expiresAt: null };
    window.__activatedCodes = [];
    window.offerHunter = {
        license: {
            getStatus: async () => window.__license,
            activate: async code => {
                window.__activatedCodes.push(code);
                if (code === 'OH2.BAD') return { success: false, error: 'machine' };
                // 多留半小时余量:渲染时已过去几百毫秒,按 floor 折算会从 3 小时掉到 2 小时。
                window.__license = { activated: true, expiresAt: Date.now() + 2 * 86400000 + 3.5 * 3600000 };
                return { success: true };
            },
        },
    };
</script>
<script type="module">
    import '/src/components/views/HelpView.js';
    document.body.appendChild(document.createElement('help-view'));
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

        const win = new BrowserWindow({ show: false, width: 1000, height: 900, backgroundColor: '#0a0a0a' });
        win.webContents.on('console-message', (event, level, message) => {
            if (!message.includes('Electron Security Warning')) results.push(`CONSOLE  ${message}`);
        });
        win.webContents.on('did-fail-load', (event, code, desc, failedUrl) => results.push(`FAILLOAD  ${code} ${desc} ${failedUrl}`));
        await win.loadURL(url);
        await wait(700);

        const exec = js => win.webContents.executeJavaScript(js, true);
        await exec(`window.__root = () => document.querySelector('help-view').shadowRoot; window.__q = sel => window.__root().querySelector(sel); void 0`);

        check('help-view mounted', await exec(`!!document.querySelector('help-view')`));
        check(
            'page title is the permanent activation prompt',
            (await exec(`window.__q('h1.page-title').textContent`)).trim() === '您的产品已永久激活'
        );
        check('activation code input rendered', await exec(`!!window.__q('.activation-form .code-input')`));
        check(
            'activation input placeholder prompts for a new code',
            (await exec(`window.__q('.activation-form .code-input').placeholder`)) === '输入新的激活码'
        );
        check('activation submit button rendered', (await exec(`window.__q('.activation-form button').textContent`)).trim() === '激活');

        const helpHeading = await exec(`(() => {
            const heading = window.__q('h2.help-heading');
            const form = window.__q('.activation-form');
            return {
                tag: heading.tagName,
                text: heading.textContent.trim(),
                belowForm: heading.getBoundingClientRect().top > form.getBoundingClientRect().top,
                fontSize: getComputedStyle(heading).fontSize,
                titleFontSize: getComputedStyle(window.__q('h1.page-title')).fontSize,
            };
        })()`);
        check('help heading keeps its title size below the form', helpHeading.tag === 'H2' && helpHeading.text === '帮助和支持');
        check('help heading sits below the activation form', helpHeading.belowForm);
        check('help heading matches the page-title size', helpHeading.fontSize === helpHeading.titleFontSize);
        check(
            'help intro sits below the activation form',
            (await exec(`window.__q('p.intro').getBoundingClientRect().top > window.__q('.activation-form').getBoundingClientRect().top`))
        );

        // 错误码:与本机不符的码在输入框下方给出行内错误,不触碰原有激活状态。
        await exec(`(() => {
            const input = window.__q('.activation-form .code-input');
            input.value = 'OH2.BAD';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            window.__q('.activation-form button').click();
        })()`);
        await wait(200);
        check(
            'wrong-machine code shows an inline error',
            (await exec(`window.__q('.activation-feedback.error')?.textContent.trim()`)) === '该激活码属于其他电脑。'
        );
        check('rejected code is still sent to the main process', (await exec(`window.__activatedCodes[0]`)) === 'OH2.BAD');

        // 覆盖成功:写入新码后标题立刻换成新的剩余时间,输入框清空并显示成功提示。
        await exec(`(() => {
            const input = window.__q('.activation-form .code-input');
            input.value = 'OH2.VALID';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            window.__q('.activation-form button').click();
        })()`);
        await wait(250);
        check(
            'accepted code replaces the title with the new remaining time',
            (await exec(`window.__q('h1.page-title').textContent`)).trim() === '您的产品已激活，剩余时间 2 天 3 小时'
        );
        check(
            'accepted code shows an inline success message',
            (await exec(`window.__q('.activation-feedback.success')?.textContent.trim()`)) === '激活成功，激活码已更新。'
        );
        check('accepted code clears the input', (await exec(`window.__q('.activation-form .code-input').value`)) === '');
        check('error message is gone after success', await exec(`!window.__q('.activation-feedback.error')`));

        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(OUT_DIR, 'tp-help.png'), image.toPNG());
        results.push(`SHOT  ${path.join(OUT_DIR, 'tp-help.png')}`);

        win.destroy();
    } catch (error) {
        results.push(`FAIL  harness threw: ${error && error.stack ? error.stack : error}`);
    }

    if (server) server.close();
    fs.writeFileSync(path.join(OUT_DIR, 'tp-help-results.txt'), results.join('\n') + '\n', 'utf8');
    app.exit(0);
});
