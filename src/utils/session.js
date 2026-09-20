const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { startTransportLog, closeTransportLog } = require('./transportLogger');

// Lazy-loaded to avoid a circular dependency (pipeline.js imports from this module).
let _pipeline = null;
function getPipeline() {
    if (!_pipeline) _pipeline = require('./pipeline');
    return _pipeline;
}

let chatSessionActive = false;

// Conversation tracking variables
let currentSessionId = null;
let conversationHistory = [];
let screenAnalysisHistory = [];
// The detailed answers, kept as their own list rather than folded into conversationHistory: they are a
// second answer to the same question, so the History page shows them under their own tab and the short
// transcript stays exactly as long as it was.
let detailHistory = [];
// What the candidate said, in its own list for the same reason the detailed answers are: it is not a
// question, so it never dispatches a turn and has no `ai_response` to pair with. Recorded only so the
// History page can show the transcript the way the live view did — the model sees it through the turn log.
let candidateHistory = [];
// The app is an interview teleprompter, so every recorded session carries the same label. It is still
// written out because the history view reads it, and sessions saved before had other profiles.
const SESSION_PROFILE = 'interview';
let currentProfile = SESSION_PROFILE;
let currentCustomPrompt = null;

// Audio capture variables
let systemAudioProc = null;

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

// Conversation management functions
function initializeNewSession(customPrompt = null) {
    currentSessionId = Date.now().toString();
    startTransportLog(currentSessionId);
    conversationHistory = [];
    screenAnalysisHistory = [];
    detailHistory = [];
    candidateHistory = [];
    currentProfile = SESSION_PROFILE;
    currentCustomPrompt = customPrompt;
    console.log('New conversation session started:', currentSessionId);

    // Save initial session with profile context
    sendToRenderer('save-session-context', {
        sessionId: currentSessionId,
        profile: SESSION_PROFILE,
        customPrompt: customPrompt || '',
    });
}

// Turns now complete out of order: a question asked mid-stream is answered before the answer it
// interrupted. The caller passes its turn sequence as `order` so the recorded history still reads
// in the order the questions were asked.
function saveConversationTurn(transcription, aiResponse, order = 0) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
        order,
    };

    conversationHistory = [...conversationHistory, conversationTurn].sort((a, b) => a.order - b.order);
    console.log('Saved conversation turn:', conversationTurn);

    // Send to renderer to save in IndexedDB
    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

// `order` is the sequence number of the short turn this answers, so the two tabs of the History page
// list the session in the same order even though the detailed answer lands seconds later.
function saveDetailTurn(question, response, order = 0, usedKnowledge = []) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const detailTurn = {
        timestamp: Date.now(),
        question: (question || '').trim(),
        ai_response: response.trim(),
        used_knowledge: usedKnowledge,
        order,
    };

    detailHistory = [...detailHistory, detailTurn].sort((a, b) => a.order - b.order);
    console.log('Saved detail turn:', detailTurn);

    // Sent to the renderer, which persists it; the reply is the whole array, not this turn, so that any
    // number of them arriving in any order leave the stored file identical.
    sendToRenderer('save-detail-turn', {
        sessionId: currentSessionId,
        turn: detailTurn,
        fullHistory: detailHistory,
    });
}

// `order` is the sequence number the committed block itself was given, which the pipeline allocates
// before the question that interrupted the candidate: the block therefore keeps the position it had in
// the live transcript, ahead of that question rather than below it.
function saveCandidateSpeech(text, order = 0) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const candidateTurn = {
        timestamp: Date.now(),
        text: text.trim(),
        order,
    };

    candidateHistory = [...candidateHistory, candidateTurn].sort((a, b) => a.order - b.order);
    console.log('Saved candidate speech:', candidateTurn);

    sendToRenderer('save-candidate-speech', {
        sessionId: currentSessionId,
        turn: candidateTurn,
        fullHistory: candidateHistory,
    });
}

function saveScreenAnalysis(prompt, response, model, order = 0) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const analysisEntry = {
        timestamp: Date.now(),
        prompt: prompt,
        response: response.trim(),
        model: model,
        order,
    };

    screenAnalysisHistory = [...screenAnalysisHistory, analysisEntry].sort((a, b) => a.order - b.order);
    console.log('Saved screen analysis:', analysisEntry);

    // Send to renderer to save
    sendToRenderer('save-screen-analysis', {
        sessionId: currentSessionId,
        analysis: analysisEntry,
        fullHistory: screenAnalysisHistory,
        profile: currentProfile,
        customPrompt: currentCustomPrompt,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

// ── macOS system audio capture ──

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

        // Timeout after 2 seconds
        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture() {
    if (process.platform !== 'darwin') return false;

    // Kill any existing SystemAudioDump processes first
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

    systemAudioProc.stdout.on('data', data => {
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

// ── IPC ──

function setupIpcHandlers() {
    ipcMain.handle('initialize-chat', async (event, customPrompt, selectedLanguage) => {
        chatSessionActive = getPipeline().initializeChatSession(customPrompt, selectedLanguage);
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

    // Handle microphone audio on a separate channel
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

    // Neither pause nor clear ends the session: the sockets stay up for a resume, and the transcript
    // on disk is written turn by turn from persistTurn, so clearing the context never reaches it.
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

    ipcMain.handle('send-image-content', async (event, { data, prompt }) => {
        try {
            if (!data || typeof data !== 'string') {
                console.error('Invalid image data received');
                return { success: false, error: 'Invalid image data' };
            }

            const buffer = Buffer.from(data, 'base64');
            if (buffer.length < 1000) {
                console.error(`Image buffer too small: ${buffer.length} bytes`);
                return { success: false, error: 'Image buffer too small' };
            }

            if (!chatSessionActive) {
                return { success: false, error: 'No active session' };
            }

            return await getPipeline().sendLocalImage(data, prompt);
        } catch (error) {
            console.error('Error sending image:', error);
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

    // Conversation history IPC handlers
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
    saveScreenAnalysis,
    saveDetailTurn,
    saveCandidateSpeech,
    stopMacOSAudioCapture,
    setupIpcHandlers,
};
