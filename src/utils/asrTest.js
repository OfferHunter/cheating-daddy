const { BrowserWindow, ipcMain } = require('electron');
const { createRealtimeAsr } = require('./asr');
const { getMaxSentenceSilenceMs } = require('../storage');

// 「API 配置」页的试听识别：一条独立于会话的 ASR 连接，只服务那个页面。它复用与正式会话同一个分发器和
// 客户端，于是重连退避、socket 关闭时补的那个空 error 监听器等异常抑制照旧生效——页面离开时只是把这条
// 连接一起关掉。
//
// provider 由页面给：翻到哪一页就试哪一家，与当前启用的是不是它无关。
let client = null;

function send(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) windows[0].webContents.send(channel, data);
}

function start(provider) {
    stop();

    try {
        client = createRealtimeAsr({
            provider,
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
    ipcMain.handle('asr-test:start', (event, provider) => start(provider));
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
