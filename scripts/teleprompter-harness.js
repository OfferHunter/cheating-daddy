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

        const url = `http://127.0.0.1:${status.port}/`;
        const code = status.code;

        const win = new BrowserWindow({ show: false, width: 420, height: 900 });
        await win.loadURL(url);
        await wait(400);

        const exec = js => win.webContents.executeJavaScript(js, true);

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

        // ---- 问题 ----
        teleprompter.broadcast('transcription-final', { text: '什么是闭包？', speaker: 'interviewer' });
        await wait(150);

        // ---- 精要流式 ----
        teleprompter.broadcast('new-response', { turnId: 1, text: '闭包是**函数**加其词法环境。' });
        await wait(150);
        check('brief turn rendered', await exec(`document.querySelectorAll('#feed .turn').length === 1`));
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

        // ---- 字号:问题与回答同用一个默认值,设置页调一处两边一起变并持久化 ----
        check('question and answer share one default size', (await exec(`getComputedStyle(document.querySelector('#feed .question')).fontSize`)) === (await exec(`getComputedStyle(document.querySelector('#feed .answer')).fontSize`)));
        check('settings hidden initially', await exec(`!(${shown('settings')})`));
        await exec(`document.getElementById('settingsBtn').click()`);
        await wait(120);
        check('hamburger opens settings', await exec(shown('settings')));

        await exec(`(() => { const r = document.getElementById('fontRange'); r.value = '24'; r.dispatchEvent(new Event('input')); })()`);
        await wait(120);
        check('font size applies to answer', (await exec(`getComputedStyle(document.querySelector('#feed .answer')).fontSize`)) === '24px');
        check('font size applies to question too', (await exec(`getComputedStyle(document.querySelector('#feed .question')).fontSize`)) === '24px');
        check('font size persisted to localStorage', (await exec(`localStorage.getItem('offerHunterTeleprompterFontSize')`)) === '24');
        check('font value label reflects the size', (await exec(`document.getElementById('fontValue').textContent`)).trim() === '24px');

        await exec(`document.getElementById('settingsClose').click()`);
        await wait(120);
        check('close button hides settings', await exec(`!(${shown('settings')})`));

        win.destroy();
    } catch (error) {
        results.push(`FAIL  harness threw: ${error && error.stack ? error.stack : error}`);
    }

    const outDir = process.env.TP_HARNESS_OUT || os.tmpdir();
    fs.writeFileSync(path.join(outDir, 'tp-results.txt'), results.join('\n') + '\n', 'utf8');
    teleprompter.stopTeleprompter();
    app.exit(0);
});
