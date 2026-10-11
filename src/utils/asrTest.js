const { BrowserWindow, ipcMain } = require('electron');
const { createRealtimeAsr } = require('./bailianAsr');
const { getPreferences, getMaxSentenceSilenceMs } = require('../storage');

// 「API 配置」页的试听识别：一条独立于会话的 ASR 连接，只服务那个页面。它复用 bailianAsr 的客户端，于是重连
// 退避、socket 关闭时补的那个空 error 监听器等异常抑制照旧生效——页面离开时只是把这条连接一起关掉。
let client = null;

function send(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) windows[0].webContents.send(channel, data);
}

// 与 pipeline.toAsrLanguage 同一口径：ASR 端点要裸 ISO-639-1，偏好里存的是 BCP-47 地区码。
function toAsrLanguage(locale) {
    if (!locale) return null;
    const primary = String(locale).split('-')[0].toLowerCase();
    return primary === 'cmn' ? 'zh' : primary;
}

function start() {
    stop();

    try {
        client = createRealtimeAsr({
            language: toAsrLanguage(getPreferences().selectedLanguage),
            maxSentenceSilenceMs: getMaxSentenceSilenceMs(),
            onSentence: (text, sentenceEnd) => send('asr-test:sentence', { text, sentenceEnd }),
            onState: state => send('asr-test:state', state),
            onError: error => send('asr-test:error', error.message),
        });
        client.start();
        return { success: true };
    } catch (error) {
        console.error('[AsrTest] failed to start:', error);
        client = null;
        return { success: false, error: error.message };
    }
}

// 音频是热路径，用单向 send 而不是 invoke：每 100ms 一帧不值得等一次往返。没有连接时静默丢弃——页面在
// 连接建好之前就可能开始送帧。
function sendAudio(base64) {
    if (!client) return;
    try {
        client.sendAudio(Buffer.from(base64, 'base64'));
    } catch (error) {
        console.error('[AsrTest] failed to send audio:', error);
    }
}

function stop() {
    if (client) {
        client.close();
        client = null;
    }
}

function setupAsrTestIpcHandlers() {
    ipcMain.handle('asr-test:start', () => start());
    ipcMain.handle('asr-test:stop', () => {
        stop();
        return { success: true };
    });
    ipcMain.on('asr-test:audio', (event, base64) => sendAudio(base64));
}

module.exports = {
    setupAsrTestIpcHandlers,
    stopAsrTest: stop,
};
