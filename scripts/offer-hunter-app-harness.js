// 桌面端转录配对逻辑的门控验证:离屏加载真实的 OfferHunterApp.js,直接在它的消息数组上跑事件序列,断言
// 气泡顺序。快速连问的 bug 出在「回答被追加到末尾」这条数组顺序上,而实时视图就是按数组顺序平铺渲染的,
// 所以这里测的正是决定画面的那一步——不看像素,但看的确实是渲染会读到的那份数据。
//
// 运行:node_modules/electron/dist/electron.exe scripts/offer-hunter-app-harness.js
// 结果写 tp-app-results.txt 到系统 tmp(或 TP_HARNESS_OUT 指定的目录)。ESM 用 http 起个小静态服务;
// window.require 的四个目标用桩顶掉。不 new 组件,而是 Object.create(原型) 出一个宿主,绕开构造函数里那堆
// 主进程依赖——要测的方法都是纯数组操作。
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

// 隔离配置目录,避免碰用户真实 config。AppData 两级子目录必须先建。
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ohapp-harness-'));
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
    const DEFAULTS = {
        uiLanguage: 'zh-CN', customPrompt: '', promptOverrides: {}, knowledgeDir: '',
        detailMode: true, briefThinking: false, detailThinking: false, screenshotThinking: true, screenshotSummary: true,
        selectedLanguage: 'cmn-CN', selectedImageQuality: 'medium',
        audioInputDeviceId: 'default', fontSize: 16,
        backgroundTransparency: 0.48, textTransparency: 0.83,
        maxSentenceSilenceMs: 1500, micMaxSentenceSilenceMs: 2000, micGateDb: -45, micGateDwellMs: 300,
        chatContextTurns: 15, chatMaxTokens: 128000, detailPaneWidth: 0.38, theme: 'gruvbox', nonFocusableSession: true,
    };
    window.require = function (name) {
        if (name === './defaults') {
            return { DEFAULT_PREFERENCES: DEFAULTS, DEFAULT_CONFIG: { layout: 'normal' }, getResetPreferences: () => Object.assign({}, DEFAULTS) };
        }
        if (name === 'electron') return { ipcRenderer: { on() {}, send() {}, invoke: async () => {}, removeAllListeners() {} } };
        if (name === './utils/prompts') return { DEFAULT_PROMPT_SEGMENTS: {}, getSystemPrompt: () => '', getDetailSystemPrompt: () => '', getScreenshotSummaryPrompt: () => '', getScreenshotAnswerPrompt: () => '' };
        if (name === './utils/keybinds') return { getDefaultKeybinds: () => ({ moveUp: '', moveDown: '', moveLeft: '', moveRight: '', toggleVisibility: '', toggleClickThrough: '', screenShot: '', scrollUp: '', scrollDown: '', detailPrev: '', detailNext: '', toggleTheme: '', emergencyErase: '', quit: '' }) };
        throw new Error('unexpected require in harness: ' + name);
    };
    window.offerHunter = { clearContext: async () => ({ success: true, turnSeq: 1, detailSeq: 0 }) };
</script>
<script type="module">
    import { OfferHunterApp } from '/src/components/app/OfferHunterApp.js';
    const P = OfferHunterApp.prototype;

    // 只造出这些方法用得到的那几格状态,不跑构造函数(那里要一堆主进程依赖)。messages/detailMessages/
    // detailCurrent 是 Lit 的响应式属性,原型上带着 setter,赋值会去碰未初始化的更新队列;用同名的自有数据
    // 属性盖掉它们,赋值就只是赋值。
    const mkHost = () => {
        const h = Object.create(P);
        Object.defineProperty(h, 'messages', { value: [], writable: true, configurable: true });
        Object.defineProperty(h, 'detailMessages', { value: [], writable: true, configurable: true });
        Object.defineProperty(h, 'detailCurrent', { value: null, writable: true, configurable: true });
        h._msgSeq = 0;
        h._turnFloorId = 0;
        h._detailFloorId = 0;
        h._detailFollowing = true;
        h.requestUpdate = () => {};
        return h;
    };

    window.__run = async () => {
        const out = [];
        const shape = h => h.messages.map(m => m.role + '|' + m.text);
        const scenario = async (name, fn) => {
            try {
                out.push([name, await fn()]);
            } catch (error) {
                out.push([name + '  [threw: ' + (error && error.stack ? error.stack : error) + ']', false]);
            }
        };

        // 1. 快速连问:三个问题先到齐,三个回答随后到达,应一对一插在各自问题下面。
        await scenario('burst answers interleave question,answer,question,answer', async () => {
            const h = mkHost();
            h.upsertTranscription('JVM的内存机制', true, 'interviewer', null, 1);
            h.upsertTranscription('Java的双亲委派机制', true, 'interviewer', null, 2);
            h.upsertTranscription('Java的面向对象机制有哪些部分', true, 'interviewer', null, 3);
            h.addNewResponse({ turnId: 1, text: '答一' });
            h.addNewResponse({ turnId: 2, text: '答二' });
            h.addNewResponse({ turnId: 3, text: '答三' });
            return JSON.stringify(shape(h)) === JSON.stringify([
                'interviewer|JVM的内存机制', 'assistant|答一',
                'interviewer|Java的双亲委派机制', 'assistant|答二',
                'interviewer|Java的面向对象机制有哪些部分', 'assistant|答三',
            ]);
        });

        // 2. 中间态先到、定稿随后:应只有一条问题气泡,且带着 turnId 让回答找得到它。
        await scenario('a streamed question collapses to one bubble and keeps its turnId', async () => {
            const h = mkHost();
            h.upsertTranscription('JVM的内存', false, 'interviewer', null, null);
            h.upsertTranscription('JVM的内存机制', true, 'interviewer', null, 1);
            h.addNewResponse({ turnId: 1, text: '答' });
            return JSON.stringify(shape(h)) === JSON.stringify(['interviewer|JVM的内存机制', 'assistant|答']);
        });

        // 3. 中间态还在流、回答却来了(理论上不该发生):退化成追加,不丢内容。
        await scenario('an answer with no matching question is still appended', async () => {
            const h = mkHost();
            h.upsertTranscription('半句话', false, 'interviewer', null, null);
            h.addNewResponse({ turnId: 5, text: '答' });
            return JSON.stringify(shape(h)) === JSON.stringify(['interviewer|半句话', 'assistant|答']);
        });

        // 4. 清空上下文:已问已答的问题全清空。
        await scenario('clearing drops a finished question and its answer', async () => {
            const h = mkHost();
            h.upsertTranscription('q', true, 'interviewer', null, 1);
            h.addNewResponse({ turnId: 1, text: 'a' });
            h.completeResponse({ turnId: 1 });
            await h.handleClearContext();
            return h.messages.length === 0;
        });

        // 5. 清空上下文:还在流式的回答和它的问题一起留,别把半句冻断。
        await scenario('clearing keeps an in-flight answer together with its question', async () => {
            const h = mkHost();
            h.upsertTranscription('q', true, 'interviewer', null, 2);
            h.addNewResponse({ turnId: 2, text: '半个回答' });
            await h.handleClearContext();
            return JSON.stringify(shape(h)) === JSON.stringify(['interviewer|q', 'assistant|半个回答']);
        });

        // 6. 清空上下文:只问到一半、背后没有回答的问题,应清掉,不留孤零零一个考官问题。
        await scenario('clearing drops a question that has no answer behind it', async () => {
            const h = mkHost();
            h.upsertTranscription('正在问的问题', false, 'interviewer', null, null);
            await h.handleClearContext();
            return h.messages.length === 0;
        });

        return out;
    };
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
        const out = await exec(`window.__run()`);
        for (const [name, ok] of out) check(name, ok);

        win.destroy();
    } catch (error) {
        results.push(`FAIL  harness threw: ${error && error.stack ? error.stack : error}`);
    }

    if (server) server.close();
    const outDir = process.env.TP_HARNESS_OUT || os.tmpdir();
    fs.writeFileSync(path.join(outDir, 'tp-app-results.txt'), results.join('\n') + '\n', 'utf8');
    app.exit(0);
});
