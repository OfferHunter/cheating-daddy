// 笔试视图的门控验证:离屏加载真实的 AssistantView.js,断言笔试模式只剩详细面板——空态文案随暂停切换,
// 有回答时面板占满内容区、没有转录/分栏抓手/输入栏;同时回归面试模式仍是转录+分栏。
// 跑真实组件比读模板可靠:这些差异正是 render() 分支和 CSS 一起决定的。
//
// 运行:node_modules/electron/dist/electron.exe scripts/assistant-view-harness.js
// 结果写 tp-assistant-results.txt 到系统 tmp(或 TP_HARNESS_OUT 指定的目录);Electron 是 GUI 子系统进程,
// 不往父控制台写。ESM 用 http 起个小静态服务;window.require('./defaults') 与 window.require('electron') 用桩顶掉。
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

// 隔离配置目录,避免碰用户真实 config。AppData 两级子目录必须先建。
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'av-harness-'));
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
<html lang="zh-CN"><head><meta charset="utf-8"><style>:root{--border-strong:#444444} html,body{margin:0;height:100%} assistant-view{display:block;height:100%}</style></head>
<body>
<script>
    window.require = function (name) {
        if (name === './defaults') {
            return {
                DEFAULT_PREFERENCES: { uiLanguage: 'zh-CN', detailPaneWidth: 0.38, fontSize: 16 },
                DEFAULT_CONFIG: {},
                getResetPreferences: () => ({}),
            };
        }
        if (name === 'electron') {
            return { ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: async () => {} } };
        }
        throw new Error('unexpected require in harness: ' + name);
    };
    window.offerHunter = {
        storage: {
            getPreferences: async () => ({ detailPaneWidth: 0.38 }),
            updatePreference: async () => {},
        },
    };
</script>
<script type="module">
    import '/src/components/views/AssistantView.js';
    const el = document.createElement('assistant-view');
    el.sessionMode = 'written';
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

        const win = new BrowserWindow({ show: false, width: 800, height: 600 });
        win.webContents.on('console-message', (event, level, message) => {
            if (!message.includes('Electron Security Warning')) results.push(`CONSOLE  ${message}`);
        });
        win.webContents.on('did-fail-load', (event, code, desc, failedUrl) => results.push(`FAILLOAD  ${code} ${desc} ${failedUrl}`));
        await win.loadURL(url);
        await wait(600);

        const exec = js => win.webContents.executeJavaScript(js, true);
        // AssistantView 渲染进 shadow root,一律从 shadowRoot 查。
        await exec(`window.__el = () => document.querySelector('assistant-view');
            window.__root = () => window.__el().shadowRoot;
            window.__q = sel => window.__root().querySelector(sel); void 0`);

        check('assistant-view element mounted', await exec(`!!document.querySelector('assistant-view')`));

        // 笔试空态:等待题目,且没有转录/输入栏/分栏抓手。
        check('written empty state waits for the question', (await exec(`window.__q('.written-empty').textContent`)).trim() === '正在等待笔试题目…');
        check('written mode has no transcript column', await exec(`!window.__q('.chat-wrap')`));
        check('written mode has no detail split handle', await exec(`!window.__q('.split-handle')`));
        check('written mode has no text input bar', await exec(`!window.__q('.input-bar')`));

        // 暂停:同一块空态改成已暂停。暂停开关在上层,这里只验证文案跟着属性走。
        await exec(`window.__el().paused = true`);
        await wait(150);
        check('written empty state reflects pause', (await exec(`window.__q('.written-empty').textContent`)).trim() === '自动截图已暂停');
        await exec(`window.__el().paused = false`);
        await wait(150);

        // 采集/发送失败:空态换成错误本身,并压过暂停文案;清掉后回到等待题目。
        await exec(`window.__el().writtenError = '屏幕捕获失败: NotAllowedError: Permission denied'`);
        await wait(150);
        check(
            'written empty state shows the capture error',
            (await exec(`window.__q('.written-empty').textContent`)).trim() === '屏幕捕获失败: NotAllowedError: Permission denied'
        );
        check('written error is marked as danger', await exec(`window.__q('.written-empty').classList.contains('error')`));
        await exec(`window.__el().paused = true`);
        await wait(150);
        check(
            'written error wins over the paused text',
            (await exec(`window.__q('.written-empty').textContent`)).includes('NotAllowedError')
        );
        await exec(`(() => { const el = window.__el(); el.paused = false; el.writtenError = ''; })()`);
        await wait(150);
        check(
            'clearing the error restores the waiting state',
            (await exec(`window.__q('.written-empty').textContent`)).trim() === '正在等待笔试题目…'
        );

        // 两条回答:长滚动里并排渲染,不再有右下角翻页。
        await exec(`(() => {
            const el = window.__el();
            el.detailMessages = [
                { detailId: 1, turnSeq: 1, question: '', text: '第一题的答案', final: true },
                { detailId: 2, turnSeq: 2, question: '', text: '第二题的答案', final: true },
            ];
            el.detailCurrent = 2;
        })()`);
        await wait(200);
        check('written answers replace the empty state', await exec(`!window.__q('.written-empty') && window.__root().querySelectorAll('.written-answer').length === 2`));
        check('both answer bodies rendered', (await exec(`[...window.__root().querySelectorAll('.detail-body')].map(el => el.textContent).join('|')`)).includes('第一题的答案'));
        check('written mode has no previous/next pagination', await exec(`!window.__q('.detail-nav')`));
        // 长横线分隔:第二条回答带上边框,横跨整列。
        check(
            'written answers are separated by a full-width rule',
            await exec(`(() => {
                const second = window.__root().querySelectorAll('.written-answer')[1];
                const style = getComputedStyle(second);
                // 显示缩放会让 1px 折算成带小数的值,只要求是一条可见的实线。
                return parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle === 'solid';
            })()`)
        );
        check('written mode still has no transcript column', await exec(`!window.__q('.chat-wrap') && !window.__q('.input-bar')`));
        check(
            'written scroll fills the content area',
            await exec(`(() => {
                const scroll = window.__q('.written-scroll').getBoundingClientRect();
                const shell = window.__q('.written-shell').getBoundingClientRect();
                return Math.abs(scroll.width - shell.width) < 1;
            })()`)
        );

        // 左侧导航:每条回答一根短横线,整体半透明,点第一根就高亮第一根。
        check('written nav renders one dash per answer', await exec(`window.__root().querySelectorAll('.written-nav .nav-dash').length === 2`));
        check('written nav is translucent', (await exec(`getComputedStyle(window.__q('.written-nav')).opacity`)) === '0.55');
        await exec(`window.__root().querySelectorAll('.nav-dash')[0].click()`);
        await wait(150);
        check('clicking a nav dash activates it', await exec(`window.__root().querySelectorAll('.nav-dash')[0].classList.contains('active')`));

        // 底部两个按钮:缓存按钮带张数,发送按钮就是改名后的原截图按钮。
        check('written actions show the cache button', (await exec(`window.__q('.cache-btn').textContent`)).includes('截图进入缓存'));
        check('written actions show the screenshot-and-send button', (await exec(`window.__q('.analyze-btn').textContent`)).includes('截图并发送'));
        await exec(`window.__el().screenshotCacheCount = 2`);
        await wait(150);
        check('cache button shows the cached count', (await exec(`window.__q('.cache-btn').textContent`)).includes('(2)'));

        // 两个按钮必须同款:字号、字体、高度一致,缓存按钮也有图标,文字才不会一左一右错位。
        const buttonMetrics = await exec(`(() => {
            const send = getComputedStyle(window.__q('.analyze-btn'));
            const cache = getComputedStyle(window.__q('.cache-btn'));
            return {
                sameFont: send.fontFamily === cache.fontFamily && send.fontSize === cache.fontSize,
                sameHeight: send.height === cache.height,
                samePadding: send.padding === cache.padding,
                cacheHasIcon: !!window.__q('.cache-btn svg'),
            };
        })()`);
        check('cache button matches the send button font', buttonMetrics.sameFont);
        check('cache button matches the send button height', buttonMetrics.sameHeight);
        check('cache button matches the send button padding', buttonMetrics.samePadding);
        check('cache button has the send button icon', buttonMetrics.cacheHasIcon);

        // 左下角向下箭头:与手机端同款,贴底时淡下去,翻上去后点击回到底端。
        check('written actions lead with a jump-to-latest arrow', await exec(`!!window.__q('.written-jump')`));
        check(
            'jump arrow sits at the left edge of the actions row',
            await exec(`(() => {
                const row = window.__q('.written-actions');
                const btn = window.__q('.written-jump');
                const inner = row.getBoundingClientRect().left + parseFloat(getComputedStyle(row).paddingLeft);
                return Math.abs(btn.getBoundingClientRect().left - inner) <= 1;
            })()`)
        );
        check('jump arrow dims while pinned to the bottom', await exec(`window.__q('.written-jump').classList.contains('at-bottom')`));

        // 真实窗口里 :host 自带 flex 列布局;harness 的外层规则把它盖成了 block,这里用行内样式还原,
        // 否则 .written-scroll 会随内容长高而不出现滚动条。
        await exec(`(() => { const el = window.__el(); el.style.display = 'flex'; el.style.flexDirection = 'column'; })()`);
        await exec(`(() => {
            const el = window.__el();
            el.detailMessages = Array.from({ length: 30 }, (_, i) => ({
                detailId: 100 + i,
                turnSeq: 100 + i,
                question: '',
                text: '第' + (i + 1) + '题答案：' + '内容'.repeat(60),
                final: true,
            }));
        })()`);
        await wait(300);
        check(
            'written feed becomes scrollable with many answers',
            await exec(`(() => { const s = window.__q('.written-scroll'); return s.scrollHeight > s.clientHeight + 50; })()`)
        );
        // 隐藏窗口里程序化改 scrollTop 不一定派发 scroll,补发一次,让模拟与真实滚动等价。
        await exec(`(() => { const s = window.__q('.written-scroll'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); })()`);
        await wait(200);
        check('jump arrow lights up once scrolled up', await exec(`!window.__q('.written-jump').classList.contains('at-bottom')`));
        await exec(`window.__q('.written-jump').click()`);
        await wait(250);
        check(
            'jump arrow scrolls the written feed to the bottom',
            await exec(`(() => { const s = window.__q('.written-scroll'); return s.scrollHeight - s.clientHeight - s.scrollTop <= 2; })()`)
        );
        check('jump arrow dims again at the bottom', await exec(`window.__q('.written-jump').classList.contains('at-bottom')`));

        // 面试模式:转录 + 左侧导航 + 左下箭头,右侧详细面板连续长滚动并按轮次与左侧联动。
        await exec(`(() => {
            const el = window.__el();
            el.sessionMode = 'interview';
            const longQuestion = n => '问题' + n + '：' + '背景描述'.repeat(40);
            el.messages = [
                { id: 1, role: 'interviewer', text: longQuestion(1), turnId: 101, final: true },
                { id: 2, role: 'assistant', text: '精要回答一', turnId: 101, final: true },
                { id: 3, role: 'interviewer', text: longQuestion(2), turnId: 102, final: true },
                { id: 4, role: 'assistant', text: '精要回答二', turnId: 102, final: true },
                { id: 5, role: 'interviewer', text: longQuestion(3), turnId: 103, final: true },
            ];
            el.detailMessages = [1, 2, 3].map(n => ({
                detailId: n,
                turnSeq: 100 + n,
                question: '问题' + n,
                text: '详细答案' + n + '：' + '详细内容'.repeat(80),
                final: true,
            }));
            el.detailCurrent = null;
        })()`);
        await wait(400);

        check('interview mode keeps the transcript column', await exec(`!!window.__q('.chat-wrap') && !!window.__q('.chat-scroll')`));
        check('interview mode keeps the input bar', await exec(`!!window.__q('.input-bar')`));
        check('interview input bar shows 截图并发送', (await exec(`window.__q('.input-bar .analyze-btn').textContent`)).includes('截图并发送'));
        check('interview input bar shows 截图进入缓存', (await exec(`window.__q('.input-bar .cache-btn').textContent`)).includes('截图进入缓存'));
        check('interview mode shows the split handle with detail answers', await exec(`!!window.__q('.split-handle') && !!window.__q('.detail-pane')`));

        check('interview detail pane has no pagination buttons', await exec(`!window.__q('.detail-nav')`));
        check('interview detail pane renders every answer', await exec(`window.__root().querySelectorAll('.detail-answer').length === 3`));
        check(
            'interview answers are separated by a full-width rule',
            await exec(`(() => {
                const second = window.__root().querySelectorAll('.detail-answer')[1];
                const style = getComputedStyle(second);
                return parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle === 'solid';
            })()`)
        );
        check('interview left nav has one dash per turn', await exec(`window.__root().querySelectorAll('.chat-wrap .written-nav .nav-dash').length === 3`));
        check('interview has a jump-to-latest arrow', await exec(`!!window.__q('.chat-jump')`));
        check('interview jump arrow dims at the bottom', await exec(`window.__q('.chat-jump').classList.contains('at-bottom')`));

        // 左侧往上滚:第一根高亮,右侧跟到第一轮,箭头亮起。
        await exec(`(() => { const s = window.__q('.chat-scroll'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); })()`);
        await wait(250);
        check(
            'transcript scroll activates the first turn dash',
            await exec(`window.__root().querySelectorAll('.chat-wrap .nav-dash')[0].classList.contains('active')`)
        );
        check('interview jump arrow lights up once scrolled up', await exec(`!window.__q('.chat-jump').classList.contains('at-bottom')`));
        check(
            'transcript scroll pulls the detail pane to the same turn',
            await exec(`(() => {
                const d = window.__q('.detail-scroll');
                const first = window.__root().querySelectorAll('.detail-answer')[0];
                return Math.abs(first.getBoundingClientRect().top - d.getBoundingClientRect().top) <= 2;
            })()`)
        );

        // 点第二根导航短横线:右侧详细面板滚到第二条,标题计数跟着走。
        await exec(`window.__root().querySelectorAll('.chat-wrap .nav-dash')[1].click()`);
        await wait(250);
        check(
            'clicking a turn dash scrolls the detail pane to that answer',
            await exec(`(() => {
                const d = window.__q('.detail-scroll');
                const second = window.__root().querySelectorAll('.detail-answer')[1];
                return Math.abs(second.getBoundingClientRect().top - d.getBoundingClientRect().top) <= 2;
            })()`)
        );
        check(
            'clicking a turn dash activates that dash',
            await exec(`window.__root().querySelectorAll('.chat-wrap .nav-dash')[1].classList.contains('active')`)
        );
        check('detail head counts the active answer', (await exec(`window.__q('.detail-head').textContent`)).includes('2 / 3'));

        // 右侧往上滚:左侧高亮与转录滚到同一轮。
        await exec(`(() => {
            const d = window.__q('.detail-scroll');
            const second = window.__root().querySelectorAll('.detail-answer')[1];
            d.scrollTop = second.getBoundingClientRect().top - d.getBoundingClientRect().top + d.scrollTop;
            d.dispatchEvent(new Event('scroll'));
        })()`);
        await wait(250);
        check(
            'detail scroll activates the same turn dash on the left',
            await exec(`window.__root().querySelectorAll('.chat-wrap .nav-dash')[1].classList.contains('active')`)
        );
        check(
            'detail scroll brings the transcript to the same question',
            await exec(`(() => {
                const s = window.__q('.chat-scroll');
                const turn = window.__root().querySelectorAll('.turn-marker')[1];
                return Math.abs(turn.getBoundingClientRect().top - s.getBoundingClientRect().top) <= 2;
            })()`)
        );

        // 左下箭头:两栏一起回到底端并淡下去。
        await exec(`window.__q('.chat-jump').click()`);
        await wait(250);
        check(
            'interview jump arrow pins both panes to the bottom',
            await exec(`(() => {
                const s = window.__q('.chat-scroll');
                const d = window.__q('.detail-scroll');
                const chatAtBottom = s.scrollHeight - s.clientHeight - s.scrollTop <= 2;
                const detailAtBottom = d.scrollHeight - d.clientHeight - d.scrollTop <= 2;
                return chatAtBottom && detailAtBottom;
            })()`)
        );
        check('interview jump arrow dims again at the bottom', await exec(`window.__q('.chat-jump').classList.contains('at-bottom')`));

        win.destroy();
    } catch (error) {
        results.push(`FAIL  harness threw: ${error && error.stack ? error.stack : error}`);
    }

    if (server) server.close();
    const outDir = process.env.TP_HARNESS_OUT || os.tmpdir();
    fs.writeFileSync(path.join(outDir, 'tp-assistant-results.txt'), results.join('\n') + '\n', 'utf8');
    app.exit(0);
});
