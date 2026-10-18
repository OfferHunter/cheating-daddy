const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { startTransportLog, closeTransportLog } = require('./transportLogger');
const teleprompter = require('./teleprompter');
const license = require('./license');

// 延迟加载：pipeline.js 反过来 require 本模块，直接写在顶部会成环。
let _pipeline = null;
function getPipeline() {
    if (!_pipeline) _pipeline = require('./pipeline');
    return _pipeline;
}

let chatSessionActive = false;

let currentSessionId = null;
let conversationHistory = [];
// 详细回答单独一份列表，不并进 conversationHistory：它是对同一个问题的第二个回答，历史页给它自己的
// 标签页，这样精简字幕的长度不会因为详细回答而变长。
let detailHistory = [];
// 面试者发言同理单列：它不是问题，从不派发轮次，也没有 ai_response 可配对，记下来只是让历史页能像实时
// 视图那样还原字幕。模型是通过轮次日志看到它的。
let candidateHistory = [];
// 本应用只做面试提词器，所有会话都带同一个档位标签；仍然写出来是因为历史页会读它，而旧会话存过别的值。
const SESSION_PROFILE = 'interview';
let currentProfile = SESSION_PROFILE;
let currentCustomPrompt = null;

let systemAudioProc = null;

// 主进程→渲染端全部推送的唯一出口,手机提词也搭在这里:白名单频道再往已配对的手机发一份。筛选发生在
// teleprompter 内部,这里只把每一条都交出去,这个函数保持「什么都从这里过」的形态。
function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }

    teleprompter.broadcast(channel, data);
}

function initializeNewSession(customPrompt = null, profile = SESSION_PROFILE) {
    currentSessionId = Date.now().toString();
    startTransportLog(currentSessionId);
    conversationHistory = [];
    detailHistory = [];
    candidateHistory = [];
    currentProfile = profile;
    currentCustomPrompt = customPrompt;
    console.log('New conversation session started:', currentSessionId, 'profile:', profile);

    sendToRenderer('save-session-context', {
        sessionId: currentSessionId,
        profile,
        customPrompt: customPrompt || '',
    });
}

// 日志里只留形状不留内容：转录原文和 AI 回答都要跟着 app.log 被发去排障，所以字符串字段一律换成字符数。
// 各字段长度非零就说明这一路的数据确实落到磁盘了，诊断够用。
function describeTurn(turn) {
    const shape = {};
    for (const [key, value] of Object.entries(turn)) {
        shape[key] = typeof value === 'string' ? `${value.length} chars` : value;
    }
    return shape;
}

// 三个 save 只有字段名和 IPC 频道不同：按 order 插进自己的列表，然后把**整份**列表交给渲染端落盘。
// 传整份而不是这一条，是为了让任意顺序到达的多次写入得到同一个文件。payload 结构不能改，渲染端按
// 频道名分发。
function appendHistory(list, turn, channel, label) {
    const next = [...list, turn].sort((a, b) => a.order - b.order);
    console.log(`Saved ${label}:`, describeTurn(turn));
    sendToRenderer(channel, { sessionId: currentSessionId, turn, fullHistory: next });
    return next;
}

// 轮次是乱序完成的：流式中途插进来的问题会先于被它打断的那个回答落地，所以调用方把自己的轮序号当
// `order` 传进来，历史文件仍然按提问顺序排列。
function saveConversationTurn(transcription, aiResponse, order = 0) {
    if (!currentSessionId) initializeNewSession();

    conversationHistory = appendHistory(
        conversationHistory,
        { timestamp: Date.now(), transcription: transcription.trim(), ai_response: aiResponse.trim(), order },
        'save-conversation-turn',
        'conversation turn'
    );
}

// `order` 是这条详细回答对应的那个精简轮的序号：详细回答晚几秒才回来，但历史页两个标签页要按同一顺序排。
function saveDetailTurn(question, response, order = 0, usedKnowledge = []) {
    if (!currentSessionId) initializeNewSession();

    detailHistory = appendHistory(
        detailHistory,
        { timestamp: Date.now(), question: (question || '').trim(), ai_response: response.trim(), used_knowledge: usedKnowledge, order },
        'save-detail-turn',
        'detail turn'
    );
}

// `order` 在发言块首次定稿时分配；后续片段更新同一条记录。这样它在历史里的位置与
// 它在实时字幕里的位置一致，排在那个问题前面而不是后面。
function saveCandidateSpeech(text, order = 0) {
    if (!currentSessionId) initializeNewSession();

    candidateHistory = appendHistory(
        candidateHistory.filter(entry => entry.order !== order),
        { timestamp: Date.now(), text: text.trim(), order },
        'save-candidate-speech',
        'candidate speech'
    );
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        console.log('Checking for existing SystemAudioDump processes...');

        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', code => {
            if (code === 0) {
                console.log('Killed existing SystemAudioDump processes');
            } else {
                console.log('No existing SystemAudioDump processes found');
            }
            resolve();
        });

        killProc.on('error', err => {
            console.log('Error checking for existing processes (this is normal):', err.message);
            resolve();
        });

        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture() {
    if (process.platform !== 'darwin') return false;

    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
        },
    };

    systemAudioProc = spawn(systemAudioPath, [], spawnOptions);

    if (!systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);
    // 只记第一次。区分「进程起来了但一声不出」（多半是没拿到屏幕录制权限）和「压根没起来」——两者的
    // 日志长得很像，这一行把扬声器失效的两条岔路分开。
    let sawFirstChunk = false;

    systemAudioProc.stdout.on('data', data => {
        if (!sawFirstChunk) {
            sawFirstChunk = true;
            console.log('[SystemAudioDump] first audio data received:', data.length, 'bytes');
        }

        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;

            getPipeline().processLocalAudio(monoChunk, 'system');

            if (process.env.DEBUG_AUDIO) {
                console.log(`Processed audio chunk: ${chunk.length} bytes`);
                saveDebugAudio(monoChunk, 'system_audio');
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }
}

function setupIpcHandlers() {
    ipcMain.handle('initialize-chat', async (event, customPrompt, mode) => {
        // 激活门控只放在这一个入口:它把 chatSessionActive 置真,而音频/文本/截图/清空上下文全都先校验这个
        // 标志,所以没激活时整条实时管线一起关掉,不必在每个 handler 里重复检查。渲染端本来也把未激活用户
        // 挡在引导页,这里防的是绕过界面直接调 IPC——源码公开,改掉渲染端那行判断太容易了。
        if (!license.isActivated()) {
            console.error('initialize-chat refused: license not activated');
            return false;
        }
        chatSessionActive = getPipeline().initializeChatSession(customPrompt, mode);
        return chatSessionActive;
    });

    ipcMain.handle('send-audio-content', async (event, { data }) => {
        if (!chatSessionActive) return { success: false, error: 'No active session' };
        try {
            getPipeline().processLocalAudio(Buffer.from(data, 'base64'), 'system');
            return { success: true };
        } catch (error) {
            console.error('Error sending system audio:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-mic-audio-content', async (event, { data }) => {
        if (!chatSessionActive) return { success: false, error: 'No active session' };
        try {
            getPipeline().processLocalAudio(Buffer.from(data, 'base64'), 'mic');
            return { success: true };
        } catch (error) {
            console.error('Error sending mic audio:', error);
            return { success: false, error: error.message };
        }
    });

    // 暂停和清空都不结束会话：socket 留着等恢复，而磁盘上的记录是 persistTurn 一轮一轮写的，清空上下文
    // 永远碰不到它。
    ipcMain.handle('set-audio-paused', async (event, value) => {
        if (!chatSessionActive) return { success: false, error: 'No active session' };
        try {
            getPipeline().setPaused(value);
            return { success: true };
        } catch (error) {
            console.error('Error pausing audio:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('clear-context', async event => {
        if (!chatSessionActive) return { success: false, error: 'No active session' };
        try {
            return { success: true, ...getPipeline().clearContext() };
        } catch (error) {
            console.error('Error clearing context:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-image-content', async (event, { data }) => {
        try {
            // 手动截图可以带一叠缓存帧(长题目分屏截取),所以这里接受字符串或字符串数组。
            const frames = Array.isArray(data) ? data : [data];
            if (!frames.length || frames.some(frame => typeof frame !== 'string' || !frame)) {
                console.error('Invalid image data received');
                return { success: false, error: 'Invalid image data' };
            }

            for (const frame of frames) {
                const buffer = Buffer.from(frame, 'base64');
                if (buffer.length < 1000) {
                    console.error(`Image buffer too small: ${buffer.length} bytes`);
                    return { success: false, error: 'Image buffer too small' };
                }
            }

            if (!chatSessionActive) {
                return { success: false, error: 'No active session' };
            }

            return await getPipeline().sendLocalImage(frames);
        } catch (error) {
            console.error('Error sending image:', error);
            return { success: false, error: error.message };
        }
    });

    // 笔试自动截图：渲染端按间隔抓帧，这一帧和上一张「已作答」的帧一起交给模型判断要不要重新作答。
    // 判断和作答都在主进程，因为 API 密钥和轮次状态都在这里。
    ipcMain.handle('auto-screenshot', async (event, { data }) => {
        if (!chatSessionActive) return { success: false, error: 'No active session' };
        if (!data || typeof data !== 'string') return { success: false, error: 'Invalid image data' };

        try {
            return await getPipeline().autoScreenshot(data);
        } catch (error) {
            console.error('Error handling auto screenshot:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { success: false, error: 'Invalid text message' };
        }

        if (!chatSessionActive) {
            return { success: false, error: 'No active session' };
        }

        try {
            return await getPipeline().sendLocalText(text.trim());
        } catch (error) {
            console.error('Error sending text:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async event => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture();
            return { success };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async event => {
        try {
            stopMacOSAudioCapture();
            getPipeline().closeLocalSession();
            chatSessionActive = false;
            closeTransportLog();
            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-current-session', async event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting current session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            console.error('Error starting new session:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    saveDetailTurn,
    saveCandidateSpeech,
    stopMacOSAudioCapture,
    setupIpcHandlers,
};
