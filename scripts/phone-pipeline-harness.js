// 手机模式的端到端验证（真实 pipeline + 真实腾讯云 socket，假音频）：
// 用一段 24k PCM 冒充渲染端麦克风泵，喂进 processLocalAudio，检查声纹检测阶段是否收到中间态句子、
// 同一句的文本是否逐步变长（streaming），以及定稿时是否带上 speaker_id。
// 凭据从本机配置读取后只在内存里交给 storage，不打印、不落盘。
// 运行: node_modules/electron/dist/electron.exe scripts/phone-pipeline-harness.js <24k-pcm> [真实 home]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL_HOME = process.env.USERPROFILE || os.homedir();
const REAL_CREDENTIALS = path.join(REAL_HOME, 'AppData', 'Roaming', 'offer-hunter-config', 'credentials.json');

const PCM_FILE = process.argv[2];
if (!PCM_FILE) {
    console.error('usage: electron scripts/phone-pipeline-harness.js <24k-mono-s16le.pcm>');
    process.exit(1);
}

// 隔离配置目录：历史、日志、preferences 都写到这里，不碰用户真实数据。
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-pipeline-harness-'));
fs.mkdirSync(path.join(ISOLATED_HOME, 'AppData', 'Roaming'), { recursive: true });
fs.mkdirSync(path.join(ISOLATED_HOME, 'AppData', 'Local'), { recursive: true });
process.env.USERPROFILE = ISOLATED_HOME;
process.env.HOME = ISOLATED_HOME;
process.env.APPDATA = path.join(ISOLATED_HOME, 'AppData', 'Roaming');
process.env.LOCALAPPDATA = path.join(ISOLATED_HOME, 'AppData', 'Local');

const { app, BrowserWindow } = require('electron');

const OUT_DIR = process.env.TP_HARNESS_OUT || os.tmpdir();
const results = [];
const check = (name, ok) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    const credentials = JSON.parse(fs.readFileSync(REAL_CREDENTIALS, 'utf8'));

    // 先把真实凭据塞进 storage，再加载 pipeline（tencentAsr 在 require 时解构这个函数）。
    const storage = require('../src/storage');
    storage.getTencentCredentials = () => ({
        appId: credentials.tencentAppId || '',
        secretId: credentials.tencentSecretId || '',
        secretKey: credentials.tencentSecretKey || '',
    });

    const pipeline = require('../src/utils/pipeline');

    const win = new BrowserWindow({
        show: false,
        width: 400,
        height: 300,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    win.webContents.on('console-message', (event, level, message) => {
        if (!message.includes('Electron Security Warning')) results.push(`CONSOLE  ${message}`);
    });
    await win.loadURL('data:text/html,<html><body></body></html>');
    await win.webContents.executeJavaScript(`(() => {
        window.__events = [];
        const { ipcRenderer } = require('electron');
        ipcRenderer.on('diarization-sentence', (_, data) => window.__events.push({ t: Date.now(), ...data }));
        ipcRenderer.on('diarization-error', (_, data) => window.__events.push({ t: Date.now(), error: data && data.message }));
    })(); void 0`);

    pipeline.initializeChatSession(null, 'phone');
    await wait(2500); // 等握手

    const pcm = fs.readFileSync(path.resolve(PCM_FILE));
    const CHUNK = 4800; // 100ms @24k s16 mono
    let offset = 0;
    while (offset < pcm.length) {
        pipeline.processLocalAudio(pcm.subarray(offset, Math.min(offset + CHUNK, pcm.length)), 'mic');
        offset += CHUNK;
        await wait(100);
    }
    await wait(3000); // 让服务端把最后一句定稿

    const events = await win.webContents.executeJavaScript('window.__events');
    const bodies = events.filter(e => !e.error);
    const interims = bodies.filter(e => !e.final);
    const finals = bodies.filter(e => e.final);

    results.push(`EVENTS  total=${bodies.length} interim=${interims.length} final=${finals.length} errors=${events.length - bodies.length}`);
    check('no diarization error', events.every(e => !e.error));
    check('interim results arrive during calibration', interims.length > 0);
    check('final results arrive during calibration', finals.length > 0);
    check('finals carry a real speaker id', finals.every(e => Number.isFinite(e.speakerId) && e.speakerId >= 0));
    check('finals carry a sentence id', finals.every(e => Number.isInteger(e.sentenceId)));

    // streaming 的核心：同一个 sentenceId 在定稿前应出现多段不同长度的文本。
    const bySentence = new Map();
    for (const event of interims) {
        if (!bySentence.has(event.sentenceId)) bySentence.set(event.sentenceId, new Set());
        bySentence.get(event.sentenceId).add(event.text);
    }
    const growing = [...bySentence.entries()].filter(([, texts]) => texts.size > 1);
    check('at least one sentence grows through multiple interim texts', growing.length > 0);
    results.push(`GROWTH  ${[...bySentence.entries()].map(([id, texts]) => `${id}:${texts.size}`).join(' ')}`);

    // 逐条打出前 12 条事件的时间线，便于人工核对节奏（内容就是 harness 自带的合成语音）。
    results.push('TIMELINE');
    for (const event of bodies.slice(0, 12)) {
        results.push(`  +${event.t - bodies[0].t}ms id=${event.sentenceId} spk=${event.speakerId} final=${event.final} len=${(event.text || '').length}`);
    }

    pipeline.closeLocalSession();
    win.destroy();
}

app.whenReady().then(async () => {
    try {
        await main();
    } catch (error) {
        results.push(`FAIL  harness threw: ${error && error.stack ? error.stack : error}`);
    }
    fs.writeFileSync(path.join(OUT_DIR, 'tp-phone-pipeline-results.txt'), results.join('\n') + '\n', 'utf8');
    app.exit(0);
});
