// 手机提词页的离屏验证:用隐藏的 Electron 窗口加载真实的 teleprompter 页面,驱动真实的事件流,断言 DOM。
// 这里测的是浏览器侧那套合并/渲染/光标逻辑——只有真在 DOM 里跑才作数,纯 Node 断言测不到。
//
// 运行:node_modules/electron/dist/electron.exe scripts/teleprompter-harness.js
// 结果写文件而不是 stdout:Windows 上 Electron 是 GUI 子系统进程,不往父控制台写。默认落在系统 tmp;
// 设 TP_HARNESS_OUT 可改目录,里面生成 tp-results.txt。
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

// 隔离:teleprompter/storage 会往 config.json 写令牌与端口,不能碰用户真实的配置目录。storage 的路径靠
// os.homedir() 惰性求值,所以在 require 应用模块之前改 USERPROFILE/HOME 就够。AppData 两级子目录必须先
// 建好——缺了它们 Electron 起不来(app.whenReady 永不 resolve,进程退 3)。
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-harness-'));
fs.mkdirSync(path.join(ISOLATED_HOME, 'AppData', 'Roaming'), { recursive: true });
fs.mkdirSync(path.join(ISOLATED_HOME, 'AppData', 'Local'), { recursive: true });
process.env.USERPROFILE = ISOLATED_HOME;
process.env.HOME = ISOLATED_HOME;
process.env.APPDATA = path.join(ISOLATED_HOME, 'AppData', 'Roaming');
process.env.LOCALAPPDATA = path.join(ISOLATED_HOME, 'AppData', 'Local');

const { app, BrowserWindow } = require('electron');
// 固定渲染器 locale,好让「语言以桌面端设置为准」这条能被确定性地验证:手机系统语言强制成英文,
// 桌面偏好设成中文,配对后页面应当切成中文。
app.commandLine.appendSwitch('lang', 'en-US');

const REPO = path.resolve(__dirname, '..');
const teleprompter = require(path.join(REPO, 'src', 'utils', 'teleprompter.js'));
const storage = require(path.join(REPO, 'src', 'storage.js'));

const results = [];
function check(name, ok) {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function bindBlocker(port) {
    return new Promise((resolve, reject) => {
        const blocker = http.createServer(() => {});
        blocker.once('error', reject);
        blocker.listen(port, '0.0.0.0', () => resolve(blocker));
    });
}

app.whenReady().then(async () => {
    try {
        // ---- 端口自适应:占住配置里的首选端口与它后面一个,启动应顺延到再后面一个,而不是跳到随机临时端口 ----
        // 随机起点避免撞上本机常驻占用;连续 5 次都占不上就跳过这项,不因环境巧合让整个 harness 失败。
        let base = null;
        const blockers = [];
        for (let attempt = 0; attempt < 5 && base === null; attempt += 1) {
            const candidate = 30000 + Math.floor(Math.random() * 10000);
            try {
                blockers.push(await bindBlocker(candidate));
                blockers.push(await bindBlocker(candidate + 1));
                base = candidate;
            } catch {
                for (const blocker of blockers.splice(0)) blocker.close();
            }
        }

        if (base === null) {
            results.push('SKIP  occupied port shifts forward within scan span');
        } else {
            storage.updateConfig('teleprompterPort', base);
        }

        const status = await teleprompter.startTeleprompter();
        if (base !== null) {
            check('occupied port shifts forward within scan span', status.port >= base + 2 && status.port <= base + 9);
            for (const blocker of blockers) blocker.close();
        }

        // 手机下达的指令在服务里只是一个回调:harness 收下动作名即可断言,不必真的去驱动一个桌面窗口。
        const commands = [];
        teleprompter.setCommandHandler(action => commands.push(action));

        const url = `http://127.0.0.1:${status.port}/`;
        const code = status.code;

        // ---- 主题跟随:桌面推来的令牌渲染成 /theme.css,手机页打开时取一次 ----
        const fetchText = target =>
            new Promise((resolve, reject) => {
                http.get(target, res => {
                    let body = '';
                    res.on('data', chunk => (body += chunk));
                    res.on('end', () => resolve({ status: res.statusCode, body }));
                }).on('error', reject);
            });

        // 推主题之前:空 :root,手机页继续用 app.css 的兜底值(gruvbox)。
        check('theme.css is empty before the desktop pushes a theme', (await fetchText(`${url}theme.css`)).body === ':root{}');

        // 用一个亮色背景,顺带验证 color-scheme 跟着背景亮度走(而不是 html 里写死的 dark)。
        teleprompter.setTheme({
            '--bg-app': 'rgb(240, 240, 240)',
            '--text-primary': 'rgb(20, 20, 20)',
            '--accent': '#123456',
            '--btn-primary-text': '#654321',
        });
        const themeCss = (await fetchText(`${url}theme.css`)).body;
        check('theme.css carries the pushed tokens', themeCss.includes('--accent:#123456'));
        check('a light background flips color-scheme to light', themeCss.includes('color-scheme:light'));

        // backgroundThrottling:false 与真实主窗口一致:隐藏窗口默认会把 rAF/定时器降频,而页面里的
        // suppressScroll/syncGuard 都靠 rAF 复位,降频会让它们一直挂着,滚动相关的断言就假失败。
        const win = new BrowserWindow({ show: false, width: 420, height: 900, webPreferences: { backgroundThrottling: false } });
        await win.loadURL(url);
        await wait(400);

        const exec = js => win.webContents.executeJavaScript(js, true);

        check('pushed token lands on :root', (await exec(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`)) === '#123456');
        check('pushed token reaches a rendered element', (await exec(`getComputedStyle(document.getElementById('pairBtn')).backgroundColor`)) === 'rgb(18, 52, 86)');
        check('color-scheme follows the pushed background', (await exec(`getComputedStyle(document.documentElement).colorScheme`)) === 'light');

        // 用 computed display 判断显隐,而不是 .hidden 属性:属性为 true 不等于真的没渲染
        // (`display: flex` 会盖掉 `hidden` 的 `display: none`,两屏就会叠在一起)。
        const shown = id => `getComputedStyle(document.getElementById('${id}')).display !== 'none'`;

        // ---- 配对前 ----
        check('pairing screen visible', await exec(shown('pairing')));
        check('stage actually hidden before pairing', await exec(`!(${shown('stage')})`));
        check('phone locale drives initial language', (await exec(`document.querySelector('[data-i18n="pairBtn"]').textContent`)).trim() === 'Pair');

        // ---- 配对(桌面偏好设成中文,页面上手机 locale 是英文,配对后应切成中文) ----
        storage.updatePreference('uiLanguage', 'zh-CN');
        await exec(`(() => { const c = document.getElementById('code'); c.value = ${JSON.stringify(code)}; c.dispatchEvent(new Event('input')); })()`);
        await wait(600);
        check('stage visible after pairing', await exec(shown('stage')));
        check('pairing actually hidden after pairing', await exec(`!(${shown('pairing')})`));
        check('conn online after pairing', await exec(`document.getElementById('conn').classList.contains('online')`));
        check('desktop language preference drives phone UI', (await exec(`document.getElementById('modeBrief').textContent`)).trim() === '精要');

        // ---- 底部控制栏(一栏按钮,不再折叠)+ 顶栏刷新:动作要能变成发给桌面的指令 ----
        check('control bar has a screenshot button', await exec(`!!document.getElementById('shotBtn')`));
        check('control buttons are visible', await exec(`getComputedStyle(document.getElementById('controlItems')).display !== 'none'`));
        check('control bar has no collapse toggle', await exec(`!document.getElementById('controlToggle')`));
        check('control bar sits flush with the bottom edge', await exec(`Math.abs(document.getElementById('controlbar').getBoundingClientRect().bottom - window.innerHeight) <= 1`));
        check('control bar is transparent', await exec(`getComputedStyle(document.getElementById('controlbar')).backgroundColor === 'rgba(0, 0, 0, 0)'`));
        check('control bar has no divider line', await exec(`getComputedStyle(document.getElementById('controlbar')).borderTopWidth === '0px'`));
        // 底栏脱离文档流浮在正文上,空处让指针穿过去——这样它既不占一行、也不「挡住后面的字」。
        check('control bar floats over the feed instead of occupying a layout row', await exec(`getComputedStyle(document.getElementById('controlbar')).position === 'absolute'`));
        check('the empty control-bar strip lets clicks pass through', await exec(`getComputedStyle(document.getElementById('controlbar')).pointerEvents === 'none'`));
        check('control bar has a jump-to-latest arrow', await exec(`!!document.getElementById('scrollBtn')`));
        check('screenshot button sits at the right edge', await exec(`(() => { const c = document.getElementById('controlItems'); const b = document.getElementById('shotBtn').getBoundingClientRect(); const inner = c.getBoundingClientRect().right - parseFloat(getComputedStyle(c).paddingRight); return Math.abs(b.right - inner) <= 1; })()`));
        check('jump-to-latest arrow sits at the left edge', await exec(`(() => { const c = document.getElementById('controlItems'); const b = document.getElementById('scrollBtn').getBoundingClientRect(); const inner = c.getBoundingClientRect().left + parseFloat(getComputedStyle(c).paddingLeft); return Math.abs(b.left - inner) <= 1; })()`));
        await exec(`document.getElementById('shotBtn').click()`);
        await wait(120);
        check('screenshot button sends the screenshot command', commands.includes('screenshot'));
        await exec(`document.getElementById('refreshBtn').click()`);
        await wait(120);
        check('refresh button sends the clear-context command', commands.includes('clear-context'));

        // ---- 左侧导航:悬浮在正文上、没有分割线 ----
        check('nav floats above the feed', await exec(`getComputedStyle(document.getElementById('nav')).position === 'absolute'`));
        check('nav has no divider line', await exec(`getComputedStyle(document.getElementById('nav')).borderRightWidth === '0px'`));

        // ---- 问题 ----
        teleprompter.broadcast('transcription-final', { text: '什么是闭包？', speaker: 'interviewer' });
        await wait(150);

        // ---- 精要流式 ----
        teleprompter.broadcast('new-response', { turnId: 1, text: '闭包是**函数**加其词法环境。' });
        await wait(150);
        check('brief turn rendered', await exec(`document.querySelectorAll('#feed .turn').length === 1`));
        check('nav shows one dash per turn', await exec(`document.querySelectorAll('#nav .nav-dash').length === 1`));
        check('nav keeps its natural size with a single dash', await exec(`Math.abs(document.getElementById('nav').getBoundingClientRect().height - 3) <= 1`));
        check('brief markdown applied', await exec(`!!document.querySelector('#feed .answer strong')`));
        check('brief question attached', await exec(`document.querySelector('#feed .question').textContent.includes('闭包')`));
        check('cursor shown while streaming', await exec(`document.querySelector('#feed .answer').classList.contains('cursor')`));

        teleprompter.broadcast('update-response', { turnId: 1, text: '闭包是**函数**加其词法环境。可捕获外层变量。' });
        await wait(150);
        check('brief text updated', await exec(`document.querySelector('#feed .answer').textContent.includes('可捕获外层变量')`));
        check('cursor still shown mid-stream', await exec(`document.querySelector('#feed .answer').classList.contains('cursor')`));

        teleprompter.broadcast('response-complete', { turnId: 1 });
        await wait(150);
        check('cursor cleared after completion', await exec(`!document.querySelector('#feed .answer').classList.contains('cursor')`));

        // ---- 候选人转录不应显示(只显示面试官问题) ----
        teleprompter.broadcast('transcription-final', { text: '我认为闭包是……', speaker: 'user' });
        await wait(150);
        check('candidate speech not shown', await exec(`!document.querySelector('#feed .question').textContent.includes('我认为闭包是')`));

        // ---- 非白名单频道不外发 ----
        const before = await exec(`document.getElementById('feed').innerHTML`);
        teleprompter.broadcast('save-session-context', { customPrompt: 'SECRET' });
        teleprompter.broadcast('some-private-channel', { apiKey: 'sk-SECRET' });
        await wait(150);
        check('non-whitelisted channels never reach page', (await exec(`document.getElementById('feed').innerHTML`)) === before);
        check('secret never in page HTML', !(await exec(`document.documentElement.outerHTML`)).includes('SECRET'));

        // ---- 详细回答与模式切换 ----
        teleprompter.broadcast('new-detail-response', { detailId: 'd1', turnSeq: 1, question: '什么是闭包？', text: '详细：闭包指……' });
        await wait(150);
        await exec(`document.getElementById('modeDetail').click()`);
        await wait(150);
        check('detail mode shows detail answer', await exec(`document.querySelector('#feed .answer').textContent.includes('闭包指')`));
        teleprompter.broadcast('detail-response-complete', { detailId: 'd1', turnSeq: 1, ok: true });
        await wait(150);
        check('detail cursor cleared after completion', await exec(`!document.querySelector('#feed .answer').classList.contains('cursor')`));

        // 详细回答失败要显示错误行而不是空白
        teleprompter.broadcast('new-detail-response', { detailId: 'd2', turnSeq: 2, question: '第二问', text: '' });
        teleprompter.broadcast('detail-response-complete', { detailId: 'd2', turnSeq: 2, ok: false, error: 'x' });
        await wait(150);
        check('failed detail shows error row', await exec(`!!document.querySelector('#feed .error')`));

        // ---- 切回精要,原内容仍在 ----
        await exec(`document.getElementById('modeBrief').click()`);
        await wait(150);
        check('brief persists across mode switch', await exec(`document.querySelector('#feed .answer').textContent.includes('可捕获外层变量')`));

        // ---- 新一轮会话清空 ----
        teleprompter.broadcast('session-initializing', true);
        await wait(150);
        check('new session clears feed', await exec(`document.querySelectorAll('#feed .turn').length === 0`));

        // ---- 背靠背事件不丢:60 对 new+complete 一次性灌入,应得 60 条错误行 ----
        await exec(`document.getElementById('modeDetail').click()`);
        await wait(100);
        for (let i = 0; i < 60; i += 1) {
            teleprompter.broadcast('new-detail-response', { detailId: `s${i}`, turnSeq: i, question: `q${i}`, text: '' });
            teleprompter.broadcast('detail-response-complete', { detailId: `s${i}`, turnSeq: i, ok: false, error: 'x' });
        }
        await wait(600);
        check('back-to-back bursts lose no events', (await exec(`document.querySelectorAll('#feed .error').length`)) === 60);

        // ---- 左侧导航:每条回答一横线,点击跳到那块开头并高亮 ----
        check('nav tracks every turn', (await exec(`document.querySelectorAll('#nav .nav-dash').length`)) === 60);
        check('nav clamps its span to a third of the screen', await exec(`(() => {
            const n = 60;
            const expected = Math.min(n * 3 + (n - 1) * 8, Math.round(window.innerHeight / 3));
            return Math.abs(document.getElementById('nav').getBoundingClientRect().height - expected) <= 1;
        })()`));
        const firstTurnTop = await exec(`document.querySelector('#feed .turn').offsetTop`);
        await exec(`document.querySelectorAll('#nav .nav-dash')[0].click()`);
        await wait(150);
        check('clicking the first dash jumps to the first turn', (await exec(`document.getElementById('feed').scrollTop`)) === firstTurnTop);
        check('first dash highlighted after jump', await exec(`document.querySelectorAll('#nav .nav-dash')[0].classList.contains('active')`));
        await exec(`document.querySelectorAll('#nav .nav-dash')[59].click()`);
        await wait(150);
        check('clicking the last dash jumps toward the bottom', await exec(`document.getElementById('feed').scrollTop > 0`));
        check('last dash highlighted after jump', await exec(`document.querySelectorAll('#nav .nav-dash')[59].classList.contains('active')`));

        // ---- 问题流式:先于回答出现、随转录增长、定稿后停光标 ----
        teleprompter.broadcast('session-initializing', true);
        await wait(150);
        await exec(`document.getElementById('modeBrief').click()`);
        await wait(100);

        teleprompter.broadcast('transcription-update', { text: '请介绍', speaker: 'interviewer' });
        await wait(150);
        check('question appears before any answer', await exec(`document.querySelectorAll('#feed .turn').length === 1 && !document.querySelector('#feed .answer').textContent`));
        check('question streams with its own cursor', await exec(`document.querySelector('#feed .question').classList.contains('cursor')`));

        teleprompter.broadcast('transcription-update', { text: '请介绍一下闭包', speaker: 'interviewer' });
        await wait(150);
        check('question text grows as transcript streams', await exec(`document.querySelector('#feed .question').textContent.includes('闭包')`));

        teleprompter.broadcast('transcription-final', { text: '请介绍一下闭包', speaker: 'interviewer' });
        await wait(150);
        check('question cursor stops at final', await exec(`!document.querySelector('#feed .question').classList.contains('cursor')`));

        // 回答到达时收养同一个块:仍旧只有一个 turn,问题不会重复也不会闪没。
        teleprompter.broadcast('new-response', { turnId: 7, text: '闭包是函数加其词法环境。' });
        await wait(150);
        check('answer adopts the streamed question block', await exec(`document.querySelectorAll('#feed .turn').length === 1`));
        check('adopted block keeps question and gains answer', await exec(`document.querySelector('#feed .question').textContent.includes('闭包') && document.querySelector('#feed .answer').textContent.includes('词法环境')`));
        teleprompter.broadcast('response-complete', { turnId: 7 });
        await wait(150);

        // ---- 字号:问题与回答各自独立,默认都是最小档 12px,分别调节、各自持久化 ----
        check('question defaults to the 12px floor', (await exec(`getComputedStyle(document.querySelector('#feed .question')).fontSize`)) === '12px');
        check('answer defaults to the 12px floor', (await exec(`getComputedStyle(document.querySelector('#feed .answer')).fontSize`)) === '12px');
        check('settings hidden initially', await exec(`!(${shown('settings')})`));
        await exec(`document.getElementById('settingsBtn').click()`);
        await wait(120);
        check('hamburger opens settings', await exec(shown('settings')));
        // 设置页顶栏:左上角是返回键,右上角是标题「设置」。
        check('settings bar leads with the back button', await exec(`document.querySelector('#settings .topbar').firstElementChild.id === 'settingsBack'`));
        check('settings title sits on the right', await exec(`document.querySelector('#settings .topbar').lastElementChild.classList.contains('settings-title') && document.querySelector('.settings-title').textContent.trim() === '设置'`));

        await exec(`(() => { const r = document.getElementById('questionRange'); r.value = '24'; r.dispatchEvent(new Event('input')); })()`);
        await wait(120);
        check('question size applies to question', (await exec(`getComputedStyle(document.querySelector('#feed .question')).fontSize`)) === '24px');
        check('question knob leaves answer untouched', (await exec(`getComputedStyle(document.querySelector('#feed .answer')).fontSize`)) !== '24px');
        check('question size persisted', (await exec(`localStorage.getItem('offerHunterTeleprompterQuestionFont')`)) === '24');
        check('question value label reflects the size', (await exec(`document.getElementById('questionValue').textContent`)).trim() === '24px');

        await exec(`(() => { const r = document.getElementById('answerRange'); r.value = '30'; r.dispatchEvent(new Event('input')); })()`);
        await wait(120);
        check('answer size applies to answer', (await exec(`getComputedStyle(document.querySelector('#feed .answer')).fontSize`)) === '30px');
        check('answer knob leaves question untouched', (await exec(`getComputedStyle(document.querySelector('#feed .question')).fontSize`)) === '24px');
        check('answer size persisted', (await exec(`localStorage.getItem('offerHunterTeleprompterAnswerFont')`)) === '30');

        // 「锁定到最底端」这项已删除:改成「贴底才跟随」,不再需要开关。
        check('the bottom-lock setting is gone', await exec(`!document.getElementById('bottomLockToggle')`));

        await exec(`document.getElementById('settingsBack').click()`);
        await wait(120);
        check('back button hides settings', await exec(`!(${shown('settings')})`));

        // ---- 快速连问:三个问题先到齐、回答才陆续来,必须一一配对且各自留下正确的问题文本 ----
        teleprompter.broadcast('session-initializing', true);
        await wait(150);
        // 第一个问题先来一段中间态再去定稿:定稿事件带着该轮的 turnId,占位块据此改名成答案的 id。
        teleprompter.broadcast('transcription-update', { text: 'JVM的内存', speaker: 'interviewer' });
        teleprompter.broadcast('transcription-final', { text: 'JVM的内存机制', speaker: 'interviewer', turnId: 1 });
        teleprompter.broadcast('transcription-final', { text: 'Java的双亲委派机制', speaker: 'interviewer', turnId: 2 });
        teleprompter.broadcast('transcription-final', { text: 'Java的面向对象机制有哪些部分', speaker: 'interviewer', turnId: 3 });
        await wait(150);
        check('rapid questions render one block each', await exec(`document.querySelectorAll('#feed .turn').length === 3`));
        check('rapid questions keep their own text', await exec(`(() => {
            const qs = Array.from(document.querySelectorAll('#feed .turn .question')).map(q => q.textContent);
            return qs[0].includes('JVM的内存机制') && qs[1].includes('Java的双亲委派机制') && qs[2].includes('Java的面向对象机制有哪些部分');
        })()`));

        teleprompter.broadcast('new-response', { turnId: 1, text: '答一' });
        teleprompter.broadcast('new-response', { turnId: 2, text: '答二' });
        teleprompter.broadcast('new-response', { turnId: 3, text: '答三' });
        teleprompter.broadcast('response-complete', { turnId: 1 });
        teleprompter.broadcast('response-complete', { turnId: 2 });
        teleprompter.broadcast('response-complete', { turnId: 3 });
        await wait(200);
        check('every answer pairs with its own question', await exec(`(() => {
            const pairs = Array.from(document.querySelectorAll('#feed .turn')).map(t => [t.querySelector('.question').textContent, t.querySelector('.answer').textContent]);
            return pairs.length === 3
                && pairs.some(([q, a]) => q.includes('JVM') && a.includes('答一'))
                && pairs.some(([q, a]) => q.includes('双亲委派') && a.includes('答二'))
                && pairs.some(([q, a]) => q.includes('面向对象') && a.includes('答三'));
        })()`));

        // ---- 清空上下文:不留孤零零的考官问题,但仍在流式的回答要保住 ----
        teleprompter.broadcast('session-initializing', true);
        await wait(150);
        teleprompter.broadcast('transcription-final', { text: '一个没有得到回答的问题', speaker: 'interviewer', turnId: 99 });
        await wait(150);
        check('an unanswered question still renders as a block', await exec(`document.querySelectorAll('#feed .turn').length === 1`));
        await exec(`document.getElementById('refreshBtn').click()`);
        await wait(150);
        check('clearing drops a question that was never answered', await exec(`document.querySelectorAll('#feed .turn').length === 0`));
        check('clearing falls back to the waiting placeholder', await exec(`!!document.querySelector('#feed .empty')`));

        teleprompter.broadcast('transcription-final', { text: '正在流式回答的问题', speaker: 'interviewer', turnId: 100 });
        teleprompter.broadcast('new-response', { turnId: 100, text: '半个回答' });
        await wait(150);
        await exec(`document.getElementById('refreshBtn').click()`);
        await wait(150);
        check('clearing keeps an answer that is still streaming', await exec(`document.querySelectorAll('#feed .turn').length === 1 && document.querySelector('#feed .answer').textContent.includes('半个回答')`));

        // ---- 顶栏暂停键:刷新键右侧,点了发 toggle-pause,桌面回播状态时图标跟着换 ----
        check('pause button sits right of the refresh button', await exec(`document.getElementById('refreshBtn').nextElementSibling.id === 'pauseBtn'`));
        await exec(`document.getElementById('pauseBtn').click()`);
        await wait(120);
        check('pause button sends the toggle-pause command', commands.includes('toggle-pause'));
        check('pause button flips to the resume icon optimistically', await exec(`document.getElementById('pauseBtn').classList.contains('paused')`));
        teleprompter.broadcast('update-status', 'Paused');
        await wait(100);
        check('update-status keeps the pause button paused', await exec(`document.getElementById('pauseBtn').classList.contains('paused')`));
        teleprompter.broadcast('update-status', 'Listening...');
        await wait(100);
        check('update-status clears paused on resume', await exec(`!document.getElementById('pauseBtn').classList.contains('paused')`));

        // ---- 结束会话键:暂停键右侧的电源图标,点了发 end-session(桌面据此收尾会话并回主页) ----
        check('end-session button sits right of the pause button', await exec(`document.getElementById('pauseBtn').nextElementSibling.id === 'endBtn'`));
        check('end-session button is drawn in the danger color', await exec(`document.getElementById('endBtn').classList.contains('danger')`));
        await exec(`document.getElementById('endBtn').click()`);
        await wait(120);
        check('end-session button sends the end-session command', commands.includes('end-session'));

        // ---- 截图按钮离底与离右等距 ----
        check('screenshot button is inset equally from the bottom and the right', await exec(`(() => {
            const b = document.getElementById('shotBtn').getBoundingClientRect();
            return Math.abs((window.innerWidth - b.right) - (window.innerHeight - b.bottom)) <= 1;
        })()`));

        // ---- 截图作答并入精要:桌面端原本只让它进详情面板,靠 screenshot 标记把它也带到手机上 ----
        teleprompter.broadcast('session-initializing', true);
        await wait(150);
        teleprompter.broadcast('new-detail-response', { detailId: 'shot1', turnSeq: 42, question: '对屏幕截图的作答', text: '', screenshot: true });
        await wait(120);
        check('screenshot answer opens a brief block labelled 截图', await exec(`(() => {
            const turns = document.querySelectorAll('#feed .turn');
            return turns.length === 1 && turns[0].querySelector('.question').textContent.includes('截图');
        })()`));
        teleprompter.broadcast('update-detail-response', { detailId: 'shot1', turnSeq: 42, text: '这是对截图的作答', screenshot: true });
        teleprompter.broadcast('detail-response-complete', { detailId: 'shot1', turnSeq: 42, ok: true, screenshot: true });
        await wait(150);
        check('screenshot answer text lands in the brief block', await exec(`document.querySelector('#feed .answer').textContent.includes('这是对截图的作答')`));
        check('screenshot brief block stops streaming after completion', await exec(`!document.querySelector('#feed .answer').classList.contains('cursor')`));
        // 普通详细回答不带标记:不该在精要里凭空冒出块
        teleprompter.broadcast('session-initializing', true);
        await wait(150);
        teleprompter.broadcast('new-detail-response', { detailId: 'd9', turnSeq: 9, question: '普通问题', text: '详细内容' });
        await wait(120);
        check('a normal detail answer does not spawn a brief block', await exec(`document.querySelectorAll('#feed .turn').length === 0`));

        // ---- 跟随行为:只在贴底时跟随;翻上去就不跟;向下箭头拉回底端并重新跟随 ----
        teleprompter.broadcast('session-initializing', true);
        await wait(150);
        for (let i = 0; i < 40; i += 1) {
            teleprompter.broadcast('transcription-final', { text: `跟随问题${i}`, speaker: 'interviewer', turnId: 1000 + i });
            teleprompter.broadcast('new-response', { turnId: 1000 + i, text: `跟随回答内容第${i}轮。` });
            teleprompter.broadcast('response-complete', { turnId: 1000 + i });
        }
        await wait(500);
        const atFeedBottom = () => exec(`(() => { const f = document.getElementById('feed'); return f.scrollHeight - f.clientHeight - f.scrollTop <= 4; })()`);
        check('feed becomes scrollable with many turns', await exec(`document.getElementById('feed').scrollHeight > document.getElementById('feed').clientHeight + 50`));
        check('new content keeps the feed pinned to the bottom while following', await atFeedBottom());

        // 翻到顶部 → 停止跟随;再来新内容不应把画面拽回去
        // 注意:隐藏窗口(show:false)里程序化改 scrollTop 有时不派发 scroll 事件,页面就以为还贴着底、
        // 继续跟随。真实用户滚动一定会发 scroll,所以这里补发一次,让模拟和真实滚动等价,免得整条用例随机翻车。
        await exec(`(() => { const f = document.getElementById('feed'); f.scrollTop = 0; f.dispatchEvent(new Event('scroll')); })()`);
        await wait(200);
        teleprompter.broadcast('transcription-final', { text: '翻上去之后的新问题', speaker: 'interviewer', turnId: 2000 });
        teleprompter.broadcast('new-response', { turnId: 2000, text: '翻上去之后的新回答' });
        await wait(250);
        check('a new turn does not yank the view while scrolled up', (await exec(`document.getElementById('feed').scrollTop`)) === 0);
        check('jump-to-latest arrow dims once off the bottom', await exec(`!document.getElementById('scrollBtn').classList.contains('at-bottom')`));

        // 点箭头 → 回到底端并恢复跟随
        await exec(`document.getElementById('scrollBtn').click()`);
        await wait(250);
        check('jump-to-latest scrolls back to the bottom', await atFeedBottom());
        check('jump-to-latest arrow dims once back at the bottom', await exec(`document.getElementById('scrollBtn').classList.contains('at-bottom')`));
        teleprompter.broadcast('transcription-final', { text: '箭头之后的又一问', speaker: 'interviewer', turnId: 3000 });
        teleprompter.broadcast('new-response', { turnId: 3000, text: '箭头之后的又一答' });
        await wait(250);
        check('following resumes after using the jump-to-latest button', await atFeedBottom());

        // ---- 顶栏三档滑块:精要/详细单栏、兼有双栏。设置里已无独立开关 ----
        await exec(`document.getElementById('settingsBtn').click()`);
        await wait(120);
        check('settings no longer carries a split toggle', await exec(`!document.getElementById('splitToggle')`));
        await exec(`document.getElementById('settingsBack').click()`);
        await wait(120);

        check(
            'top bar exposes the three slots',
            await exec(
                `!!document.getElementById('modeBrief') && !!document.getElementById('modeDetail') && !!document.getElementById('modeBoth')`
            )
        );
        check('brief is the active slot by default', await exec(`document.getElementById('modeBrief').classList.contains('active')`));
        check(
            'the mode slider hugs the right edge, left of the settings button',
            await exec(`(() => {
                const m = document.querySelector('.modes').getBoundingClientRect();
                const s = document.getElementById('settingsBtn').getBoundingClientRect();
                return m.left > window.innerWidth / 2 && m.right <= s.left + 1;
            })()`)
        );
        check(
            'single feed shows and split view hides before choosing 兼有',
            await exec(`!document.getElementById('feed').hidden && document.getElementById('splitView').hidden`)
        );

        await exec(`document.getElementById('modeBoth').click()`);
        await wait(150);
        check('choosing 兼有 marks that slot active', await exec(`document.getElementById('modeBoth').classList.contains('active')`));
        check('the slider stays visible in 兼有', await exec(`getComputedStyle(document.querySelector('.modes')).display !== 'none'`));
        check('choosing 兼有 shows both panes and hides the single feed', await exec(`getComputedStyle(document.getElementById('splitView')).display !== 'none' && document.getElementById('feed').hidden`));
        check('split pane divider is present', await exec(`!!document.getElementById('splitHandle')`));
        check('兼有 choice persisted', (await exec(`localStorage.getItem('offerHunterTeleprompterSplit')`)) === '1');

        // 左右两栏各装各的:精要进左栏,详细进右栏
        teleprompter.broadcast('session-initializing', true);
        await wait(150);
        teleprompter.broadcast('transcription-final', { text: '左右并排的问题', speaker: 'interviewer', turnId: 5 });
        teleprompter.broadcast('new-response', { turnId: 5, text: '精要回答' });
        teleprompter.broadcast('new-detail-response', { detailId: 'p5', turnSeq: 5, question: '左右并排的问题', text: '详细回答' });
        await wait(200);
        check('brief pane renders the brief answer', await exec(`document.querySelector('#feedBrief .answer').textContent.includes('精要回答')`));
        check('detail pane renders the detail answer', await exec(`document.querySelector('#feedDetail .answer').textContent.includes('详细回答')`));

        await exec(`document.getElementById('modeBrief').click()`);
        await wait(150);
        check('returning to 精要 restores the single feed and hides the split', await exec(`document.getElementById('modeBrief').classList.contains('active') && !document.getElementById('feed').hidden && document.getElementById('splitView').hidden`));
        check('leaving 兼有 clears the persisted flag', (await exec(`localStorage.getItem('offerHunterTeleprompterSplit')`)) === '0');

        win.destroy();
    } catch (error) {
        results.push(`FAIL  harness threw: ${error && error.stack ? error.stack : error}`);
    }

    const outDir = process.env.TP_HARNESS_OUT || os.tmpdir();
    fs.writeFileSync(path.join(outDir, 'tp-results.txt'), results.join('\n') + '\n', 'utf8');
    teleprompter.stopTeleprompter();
    app.exit(0);
});
