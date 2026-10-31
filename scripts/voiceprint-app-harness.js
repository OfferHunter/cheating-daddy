// 声纹检测页 + 正式会话页的「整条链路」验证：加载真实的 OfferHunterApp，用假 ipcRenderer 模拟主进程推送，
// 检查准备阶段中间态是否逐字改写同一个气泡（身份未出时圆标为「?」），以及确认后正式页的居中虚线部分结果
// 是否逐字增长、句子定稿后被清除。
// 运行:node_modules/electron/dist/electron.exe scripts/voiceprint-app-harness.js
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

// 隔离配置目录，避免碰用户真实 config。
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceprint-app-harness-'));
fs.mkdirSync(path.join(ISOLATED_HOME, 'AppData', 'Roaming'), { recursive: true });
fs.mkdirSync(path.join(ISOLATED_HOME, 'AppData', 'Local'), { recursive: true });
process.env.USERPROFILE = ISOLATED_HOME;
process.env.HOME = ISOLATED_HOME;
process.env.APPDATA = path.join(ISOLATED_HOME, 'AppData', 'Roaming');
process.env.LOCALAPPDATA = path.join(ISOLATED_HOME, 'AppData', 'Local');

const { app, BrowserWindow } = require('electron');
const defaults = require('../src/defaults');

const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'src');
const OUT_DIR = process.env.TP_HARNESS_OUT || os.tmpdir();

const results = [];
const check = (name, ok) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// 经典脚本共享全局作用域，桩必须包在 IIFE 里，否则会撞上 renderer.js 的顶层 const。
const STUB = `<script>
    (() => {
        window.__listeners = {};
        const ipcRenderer = {
            on(channel, fn) { (window.__listeners[channel] ||= []).push(fn); },
            removeAllListeners(channel) { delete window.__listeners[channel]; },
            removeListener() {},
            send() {},
            invoke() { return Promise.resolve(); },
        };
        const DEFAULT_CONFIG = ${JSON.stringify(defaults.DEFAULT_CONFIG)};
        const DEFAULT_PREFERENCES = ${JSON.stringify(defaults.DEFAULT_PREFERENCES)};
        window.require = name => {
            if (name === './defaults') {
                return {
                    DEFAULT_CONFIG,
                    DEFAULT_PREFERENCES,
                    applyPreferences(target, prefs, keys) {
                        for (const entry of keys) {
                            const [prefKey, field] = typeof entry === 'string' ? [entry, entry] : entry;
                            target[field] = prefs?.[prefKey] ?? DEFAULT_PREFERENCES[prefKey];
                        }
                    },
                };
            }
            if (name === 'electron') return { ipcRenderer };
            if (name === 'electron-squirrel-startup') return false;
            if (name === './utils/keybinds') return { getDefaultKeybinds: () => null, getKeybindActions: () => [] };
            if (name === './utils/prompts') return { DEFAULT_PROMPT_SEGMENTS: {} };
            throw new Error('unexpected require in harness: ' + name);
        };
        window.offerHunter = {
            storage: { getConfig: async () => DEFAULT_CONFIG, getPreferences: async () => DEFAULT_PREFERENCES },
            license: { getStatus: async () => ({ activated: true }) },
            getVersion: async () => 'harness',
        };
        window.__emit = (channel, data) => (window.__listeners[channel] || []).forEach(fn => fn({}, data));
    })();
</script>`;

const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function startServer() {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://x').pathname;

        if (pathname === '/' || pathname === '/index.html') {
            // 把桩代码插在 App 模块脚本之前，模块顶层就会读 window.require('./defaults')。
            const html = fs
                .readFileSync(path.join(SRC, 'index.html'), 'utf8')
                .replace('<script type="module" src="components/app/OfferHunterApp.js"></script>', `${STUB}\n<script type="module" src="components/app/OfferHunterApp.js"></script>`);
            res.writeHead(200, { 'content-type': MIME['.html'] });
            res.end(html);
            return;
        }

        const file = pathname.startsWith('/src/') ? path.join(SRC, pathname.slice('/src/'.length)) : path.join(SRC, pathname.replace(/^\//, ''));
        if (!path.resolve(file).startsWith(path.resolve(SRC) + path.sep)) {
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
        const win = new BrowserWindow({ show: false, width: 1000, height: 760, backgroundColor: '#0a0a0a' });
        win.webContents.on('console-message', (event, level, message) => {
            if (!message.includes('Electron Security Warning')) results.push(`CONSOLE  ${message}`);
        });
        await win.loadURL(url);
        await wait(800);

        const exec = js => win.webContents.executeJavaScript(js, true);
        await exec(`window.__app = document.getElementById('offerHunter');
            window.__app.currentView = 'voiceprint';
            window.__app.sessionMode = 'interview';
            window.__app.requestUpdate();
            window.__vp = () => window.__app.shadowRoot.querySelector('voiceprint-view');
            window.__av = () => window.__app.shadowRoot.querySelector('assistant-view');
            window.__bubbles = () => window.__vp() ? [...window.__vp().shadowRoot.querySelectorAll('.bubble')] : [];
            window.__texts = () => window.__bubbles().map(b => b.textContent.trim());
            window.__badges = () => window.__vp() ? [...window.__vp().shadowRoot.querySelectorAll('.speaker-badge')].map(b => b.textContent.trim()) : [];
            window.__partial = () => window.__av() ? window.__av().shadowRoot.querySelector('.partial-bubble') : null;
            void 0`);
        await wait(300);

        check('app mounted and switched to the voiceprint view', await exec(`!!window.__vp()`));

        // 第一条句子的中间态：句子进列表，但身份未出，圆标是「?」。
        await exec(`window.__emit('diarization-sentence', { text: '你好', speakerId: -1, sentenceId: 1, final: false }); void 0`);
        await wait(150);
        check('first interim opens a bubble', (await exec(`window.__bubbles().length`)) === 1);
        check('first interim text is shown', (await exec(`window.__texts()[0]`)).includes('你好'));
        check('an interim line shows a question mark badge', (await exec(`window.__badges().join(',')`)) === '?');
        check('the Y hint is disabled for an interim line', await exec(`window.__vp().shadowRoot.querySelector('.confirm-hint').disabled`));

        // 同一句继续变长：应该改写同一个气泡，而不是新增一个。
        await exec(`window.__emit('diarization-sentence', { text: '你好，我是候选人', speakerId: -1, sentenceId: 1, final: false }); void 0`);
        await wait(150);
        check('interim updates the same bubble instead of adding one', (await exec(`window.__bubbles().length`)) === 1);
        check('interim text grows in place', (await exec(`window.__texts()[0]`)).includes('你好，我是候选人'));

        // 定稿：同一行换成带编号 0 的气泡，提示变为可点。
        await exec(`window.__emit('diarization-sentence', { text: '你好，我是候选人。', speakerId: 0, sentenceId: 1, final: true }); void 0`);
        await wait(150);
        check('the confirmed line keeps its bubble', (await exec(`window.__bubbles().length`)) === 1);
        check('final keeps the text', (await exec(`window.__texts()[0]`)).includes('你好，我是候选人。'));
        check('final speaker id lands in the badge', (await exec(`window.__badges().join(',')`)) === '0');
        check('the Y hint becomes clickable once the speaker is known', await exec(`!window.__vp().shadowRoot.querySelector('.confirm-hint').disabled`));

        // 第二条句子：中间态进来时多出一个「?」气泡，提示跟到这一行并重新变为不可点。
        await exec(`window.__emit('diarization-sentence', { text: '请先做', speakerId: -1, sentenceId: 2, final: false }); void 0`);
        await wait(150);
        check('second sentence interim opens another bubble', (await exec(`window.__bubbles().length`)) === 2);
        check('second sentence text is visible while still interim', (await exec(`window.__texts()[1]`)).includes('请先做'));
        check('the newest interim badge is a question mark', (await exec(`window.__badges().join(',')`)) === '0,?');
        check('the Y hint follows the newest line', await exec(`window.__vp().shadowRoot.querySelector('.confirm-hint').closest('.bubble-row') === window.__vp().shadowRoot.querySelectorAll('.bubble-row')[1]`));

        // 确认后回到正式会话页：还没认出说话人的那句话变成居中的虚线部分结果，逐字增长，定稿后清除。
        await exec(`window.__app.currentView = 'assistant'; window.__app.requestUpdate(); void 0`);
        await wait(300);
        check('confirmation lands on the live view', await exec(`!!window.__av()`));

        await exec(`window.__emit('phone-partial', { text: '好的，我来' }); void 0`);
        await wait(150);
        check('live page shows a partial bubble for undetermined speech', (await exec(`!!window.__partial()`)));
        check('partial text is visible', (await exec(`window.__partial().textContent.trim()`)) === '好的，我来');
        check(
            'partial bubble is centered',
            (await exec(`getComputedStyle(window.__partial().closest('.partial-row')).justifyContent`)) === 'center'
        );
        check('partial bubble has a dashed border', (await exec(`getComputedStyle(window.__partial()).borderTopStyle`)) === 'dashed');

        await exec(`window.__emit('phone-partial', { text: '好的，我来做个自我介绍' }); void 0`);
        await wait(150);
        check('partial text grows in place', (await exec(`window.__partial().textContent.trim()`)) === '好的，我来做个自我介绍');
        check('there is still only one partial bubble', (await exec(`window.__av().shadowRoot.querySelectorAll('.partial-bubble').length`)) === 1);

        // 句子定稿：部分结果清掉，定稿文本带着说话人进正常气泡。
        await exec(`window.__emit('transcription-update', { text: '好的，我来做个自我介绍。', speaker: 'interviewer' });
            window.__emit('phone-partial', { text: '' }); void 0`);
        await wait(150);
        check('partial bubble disappears once the sentence is settled', (await exec(`!window.__partial()`)));
        check('the settled sentence joins the transcript', (await exec(`window.__av().shadowRoot.querySelector('.chat-list').textContent`)).includes('好的，我来做个自我介绍。'));

        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(OUT_DIR, 'tp-voiceprint-app.png'), image.toPNG());
        results.push(`SHOT  ${path.join(OUT_DIR, 'tp-voiceprint-app.png')}`);

        win.destroy();
    } catch (error) {
        results.push(`FAIL  harness threw: ${error && error.stack ? error.stack : error}`);
    }

    if (server) server.close();
    fs.writeFileSync(path.join(OUT_DIR, 'tp-voiceprint-app-results.txt'), results.join('\n') + '\n', 'utf8');
    app.exit(0);
});
