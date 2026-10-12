// 主页「电脑+手机端」的门控验证:离屏加载真实的 MainView.js,把 offerHunter.teleprompter 换成可控的桩,
// 断言未配对时「开始会话」禁用、配对翻转后启用。跑真实组件比读代码可靠——按钮状态是渲染出来的。
//
// 运行:node_modules/electron/dist/electron.exe scripts/main-view-harness.js
// 结果写 tp-main-results.txt 到系统 tmp(或 TP_HARNESS_OUT 指定的目录);Electron 是 GUI 子系统进程,
// 不往父控制台写。ESM 用 http 起个小静态服务;window.require('./defaults') 用桩顶掉(只有 i18n 用到)。
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

// 隔离配置目录,和 teleprompter-harness 一样,避免碰用户真实 config。AppData 两级子目录必须先建。
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-harness-'));
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

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}</style></head>
<body>
<script>
    window.__tp = { running: true, url: 'http://192.168.1.5:8765', code: '123456', paired: false };
    window.require = function (name) {
        if (name === './defaults') return { DEFAULT_PREFERENCES: { uiLanguage: 'zh-CN' } };
        throw new Error('unexpected require in harness: ' + name);
    };
    window.offerHunter = {
        teleprompter: {
            getStatus: async () => Object.assign({}, window.__tp),
            regenerateCode: async () => Object.assign({}, window.__tp),
        },
    };
</script>
<script type="module">
    import '/src/components/views/MainView.js';
    const el = document.createElement('main-view');
    document.body.appendChild(el);
</script>
</body></html>`;

const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function startServer() {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://x').pathname;
        let file;
        if (pathname === '/' || pathname === '/index.html') {
            file = null;
        } else if (pathname.startsWith('/src/')) {
            file = path.join(SRC, pathname.slice('/src/'.length));
        } else {
            file = null;
        }

        // 只允许 src/ 下的文件,且规范化后必须仍在 src/ 内,挡住 ../ 穿越。
        if (file && !path.resolve(file).startsWith(path.resolve(SRC) + path.sep)) file = null;

        if (file === null && pathname !== '/' && pathname !== '/index.html') {
            res.writeHead(404);
            res.end('not found');
            return;
        }
        if (pathname === '/' || pathname === '/index.html') {
            res.writeHead(200, { 'content-type': MIME['.html'] });
            res.end(PAGE);
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

        const win = new BrowserWindow({ show: false, width: 480, height: 900 });
        win.webContents.on('console-message', (event, level, message) => {
            if (!message.includes('Electron Security Warning')) results.push(`CONSOLE  ${message}`);
        });
        win.webContents.on('did-fail-load', (event, code, desc, failedUrl) => results.push(`FAILLOAD  ${code} ${desc} ${failedUrl}`));
        await win.loadURL(url);
        await wait(600);

        const exec = js => win.webContents.executeJavaScript(js, true);
        // MainView 渲染进 shadow root,document.querySelector 穿不进去,一律从 shadowRoot 查。
        await exec(`window.__root = () => document.querySelector('main-view').shadowRoot; window.__q = sel => window.__root().querySelector(sel); void 0`);
        const disabled = `window.__q('.start-button').disabled`;

        check('main-view element mounted', await exec(`!!document.querySelector('main-view')`));
        check('start button rendered', await exec(`!!window.__q('.start-button')`));

        // 切到「电脑+手机端」那一页。
        await exec(`document.querySelector('main-view').pageIndex = 1`);
        await wait(150);

        check('pairing box shows the address', (await exec(`window.__q('.pair-value').textContent`)).trim() === 'http://192.168.1.5:8765');
        check('pairing box shows the code', (await exec(`window.__q('.pair-code').textContent`)).trim() === '123456');
        check('status reads waiting before pairing', (await exec(`window.__q('.pair-status').textContent`)).includes('等待手机连接'));

        // 未配对:按钮禁用,点了也不启动。
        await exec(`window.__started = 0; document.querySelector('main-view').onStart = () => { window.__started += 1; }; void 0`);
        check('start button disabled before pairing', await exec(disabled));
        await exec(`window.__q('.start-button').click()`);
        await wait(100);
        check('clicking disabled button does not start', (await exec(`window.__started`)) === 0);

        // 手机连上:轮询(1.5s)后按钮应启用,点击才真正启动。
        await exec(`window.__tp.paired = true`);
        await wait(1800);
        check('start button enabled after phone pairs', await exec(`!${disabled}`));
        check('status reads connected after pairing', (await exec(`window.__q('.pair-status').textContent`)).includes('手机已连接'));
        await exec(`window.__q('.start-button').click()`);
        await wait(100);
        check('clicking enabled button starts the session', (await exec(`window.__started`)) === 1);

        // 手机断开:按钮应重新禁用。
        await exec(`window.__tp.paired = false`);
        await wait(1800);
        check('start button re-disabled when phone drops', await exec(disabled));

        win.destroy();
    } catch (error) {
        results.push(`FAIL  harness threw: ${error && error.stack ? error.stack : error}`);
    }

    if (server) server.close();
    const outDir = process.env.TP_HARNESS_OUT || os.tmpdir();
    fs.writeFileSync(path.join(outDir, 'tp-main-results.txt'), results.join('\n') + '\n', 'utf8');
    app.exit(0);
});
