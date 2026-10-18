// 设置页「回答字号」实时样例的门控验证:离屏加载真实的 CustomizeView.js,断言样例文字、默认字号,
// 以及拖动滑块后样例当场跟着变。样例字号来自 --response-font-size,和转录区里的回答同一个变量,
// 只有真在 DOM 里量 computed 才算数。
//
// 运行:node_modules/electron/dist/electron.exe scripts/customize-view-harness.js
// 结果写 tp-customize-results.txt 到系统 tmp(或 TP_HARNESS_OUT 指定的目录);Electron 是 GUI 子系统进程,
// 不往父控制台写。ESM 用 http 起个小静态服务;window.require('./defaults') 与 window.require('electron') 用桩顶掉。
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

// 隔离配置目录,避免碰用户真实 config。AppData 两级子目录必须先建。
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-harness-'));
fs.mkdirSync(path.join(ISOLATED_HOME, 'AppData', 'Roaming'), { recursive: true });
fs.mkdirSync(path.join(ISOLATED_HOME, 'AppData', 'Local'), { recursive: true });
process.env.USERPROFILE = ISOLATED_HOME;
process.env.HOME = ISOLATED_HOME;
process.env.APPDATA = path.join(ISOLATED_HOME, 'AppData', 'Roaming');
process.env.LOCALAPPDATA = path.join(ISOLATED_HOME, 'AppData', 'Local');

const { app, BrowserWindow } = require('electron');

const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'src');

const results = [];
const check = (name, ok) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// 桩里的默认值只取组件构造函数与渲染真正读到的键,值抄自 src/defaults.js。
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}</style></head>
<body>
<script>
    const DEFAULTS = {
        uiLanguage: 'zh-CN', customPrompt: '', promptOverrides: {}, knowledgeDir: '',
        detailMode: true, briefThinking: false, detailThinking: false, screenshotThinking: true, screenshotSummary: true,
        selectedLanguage: 'cmn-CN', selectedImageQuality: 'medium',
        audioInputDeviceId: 'default', fontSize: 16,
        backgroundTransparency: 0.48, textTransparency: 0.83,
        maxSentenceSilenceMs: 1500, micMaxSentenceSilenceMs: 2000, micGateDb: -45, micGateDwellMs: 300,
        chatContextTurns: 15, chatMaxTokens: 128000, detailPaneWidth: 0.38, theme: 'gruvbox', nonFocusableSession: true,
        writtenAutoScreenshot: true, writtenScreenshotIntervalSec: 3,
    };
    window.__storedPrefs = {};
    window.require = function (name) {
        if (name === './defaults') {
            return {
                DEFAULT_PREFERENCES: DEFAULTS,
                DEFAULT_CONFIG: { layout: 'normal' },
                getResetPreferences: () => Object.assign({}, DEFAULTS),
                // 组件只按 SETTINGS_KEYS 从源对象拷到目标上,这里照原样做即可。
                applyPreferences: (target, source, keys) => { keys.forEach(key => { if (key in source) target[key] = source[key]; }); },
            };
        }
        if (name === 'electron') return { ipcRenderer: { send() {}, invoke: async () => {} } };
        throw new Error('unexpected require in harness: ' + name);
    };
    window.offerHunter = {
        getDefaultKeybinds: () => ({ moveUp: 'Ctrl+Up', moveDown: 'Ctrl+Down' }),
        getKeybindActions: () => [
            { key: 'moveUp', name: 'Move Window Up' },
            { key: 'moveDown', name: 'Move Window Down' },
        ],
        storage: {
            getPreferences: async () => window.__storedPrefs,
            getKeybinds: async () => null,
            updatePreference: async (key, value) => { window.__storedPrefs[key] = value; },
            setKeybinds: async () => {},
        },
        theme: {
            getAll: () => [{ value: 'gruvbox', name: 'Gruvbox Dark' }],
            apply() {}, save: async () => {}, setAlphas() {},
        },
        // audioMeter 留空:页面在 connectedCallback 里会退回不启动电平表,省掉真实设备枚举。
    };
</script>
<script type="module">
    import '/src/components/views/CustomizeView.js';
    const el = document.createElement('customize-view');
    document.body.appendChild(el);
</script>
</body></html>`;

const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function startServer() {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://x').pathname;
        let file = null;
        if (pathname.startsWith('/src/')) file = path.join(SRC, pathname.slice('/src/'.length));

        // 只允许 src/ 下的文件,且规范化后必须仍在 src/ 内,挡住 ../ 穿越。
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

        const win = new BrowserWindow({ show: false, width: 900, height: 900 });
        win.webContents.on('console-message', (event, level, message) => {
            if (!message.includes('Electron Security Warning')) results.push(`CONSOLE  ${message}`);
        });
        win.webContents.on('did-fail-load', (event, code, desc, failedUrl) => results.push(`FAILLOAD  ${code} ${desc} ${failedUrl}`));
        await win.loadURL(url);
        await wait(600);

        const exec = js => win.webContents.executeJavaScript(js, true);
        // CustomizeView 渲染进 shadow root,文档选择器穿不进去,一律从 shadowRoot 查。
        await exec(`window.__root = () => document.querySelector('customize-view').shadowRoot; window.__q = sel => window.__root().querySelector(sel); void 0`);

        check('customize-view element mounted', await exec(`!!document.querySelector('customize-view')`));
        check('appearance section rendered', (await exec(`window.__q('.page-title').textContent`)).trim() === '设置');
        check('font sample rendered in the appearance section', await exec(`!!window.__q('.font-sample')`));
        check('font sample reads the answer-font caption', (await exec(`window.__q('.font-sample').textContent`)).trim() === '这是回答字号');

        // 默认字号 16px:样例字号来自 --response-font-size,组件在 _loadFromStorage 里按 fontSize 设上。
        check('font sample defaults to the stored answer size', (await exec(`getComputedStyle(window.__q('.font-sample')).fontSize`)) === '16px');

        // 拖「回答字号」滑块:样例当场跟着变,并显示在右上的数值标签里。样例所在 .form-group 里只有这一个滑块。
        await exec(`(() => {
            const group = window.__q('.font-sample').closest('.form-group');
            const slider = group.querySelector('.slider-input');
            slider.value = '24';
            slider.dispatchEvent(new Event('input'));
        })()`);
        await wait(150);
        check('font sample grows with the slider', (await exec(`getComputedStyle(window.__q('.font-sample')).fontSize`)) === '24px');
        check('font sample label reflects the size', (await exec(`window.__q('.font-sample').closest('.form-group').querySelector('.slider-value').textContent`)).trim() === '24px');
        check('font sample caption unchanged after resize', (await exec(`window.__q('.font-sample').textContent`)).trim() === '这是回答字号');
        check('slider change persisted to storage', (await exec(`window.__storedPrefs.fontSize`)) === 24);

        // 笔试自动截图块:标题、开关、间隔,以及描述必须是约定的那句话。
        await exec(
            `window.__written = () => [...window.__root().querySelectorAll('.surface')].find(s => s.querySelector('.surface-title')?.textContent.trim() === '笔试'); void 0`
        );
        check('written test section rendered', await exec(`!!window.__written()`));
        check('written toggle reads 笔试自动截图', (await exec(`window.__written().querySelector('.toggle-label').textContent`)).trim() === '笔试自动截图');
        check(
            'written interval description is the agreed sentence',
            (await exec(`[...window.__written().querySelectorAll('.form-help')].map(el => el.textContent.replace(/\\s+/g, ' ').trim()).includes('隔一段时间自动截图，结合上一帧差异判断是否重新作答。默认 3 秒。')`))
        );
        check('written interval defaults to 3 seconds', (await exec(`window.__written().querySelector('input[type=number]').value`)) === '3');

        // 间隔写入时夹到 0.5–60:手改配置也不能把定时器变成连发。
        await exec(`(() => {
            const input = window.__written().querySelector('input[type=number]');
            input.value = '0.1';
            input.dispatchEvent(new Event('change'));
        })()`);
        await wait(150);
        check('written interval clamped to 0.5 on save', (await exec(`window.__storedPrefs.writtenScreenshotIntervalSec`)) === 0.5);
        check('written interval input reflects the clamp', (await exec(`window.__written().querySelector('input[type=number]').value`)) === '0.5');

        await exec(`(() => {
            const toggle = window.__written().querySelector('input[type=checkbox]');
            toggle.checked = false;
            toggle.dispatchEvent(new Event('change'));
        })()`);
        await wait(150);
        check('written auto-screenshot toggle persisted', (await exec(`window.__storedPrefs.writtenAutoScreenshot`)) === false);

        win.destroy();
    } catch (error) {
        results.push(`FAIL  harness threw: ${error && error.stack ? error.stack : error}`);
    }

    if (server) server.close();
    const outDir = process.env.TP_HARNESS_OUT || os.tmpdir();
    fs.writeFileSync(path.join(outDir, 'tp-customize-results.txt'), results.join('\n') + '\n', 'utf8');
    app.exit(0);
});
