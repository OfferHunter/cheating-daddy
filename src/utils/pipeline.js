const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn, saveScreenAnalysis } = require('./session');
const { getChatModel, requestChat } = require('./chat');
const { transcribe: transcribeWithSiliconFlow } = require('./siliconflow');
const { createRealtimeAsr } = require('./bailianAsr');
const { logTransportEvent } = require('./transportLogger');
const { getConfig, getPreferences } = require('../storage');

let localConversationHistory = [];
let currentSystemPrompt = null;
let isLocalActive = false;
let transcriptionLanguage = null;

// 'stream' pipes PCM straight to the Bailian websocket and lets its server-side VAD end turns;
// 'batch' keeps the original buffer-the-whole-utterance-then-upload path.
let asrMode = 'batch';
let asrClient = null;
// Only one capture feeds a session. Without headphones the same voice arrives over both the
// loopback and the microphone, which would transcribe every question twice.
let activeSource = 'system';

// Text for the turn currently being assembled from streaming sentences. The server rewrites an
// in-flight sentence as it hears more, so the uncommitted tail is held separately and only folded
// in when it is committed or rescued by the idle flush.
let turnText = '';
let interimText = '';
let streamSilenceMs = 0;

// One chat request at a time. Text that lands mid-request is merged here and dispatched as the
// next single turn rather than fired concurrently or dropped.
let isChatInFlight = false;
let queuedTurnText = '';

let isSpeaking = false;
let speechBuffers = [];
let silenceFrameCount = 0;
let speechFrameCount = 0;
// Audio kept while idle so the onset of an utterance isn't clipped when detection finally fires.
let speechPreRoll = [];

// Voice detection is tuned from preferences. These fallbacks must match DEFAULT_PREFERENCES in
// storage.js and the Reference Levels shown in CustomizeView.js.
const VAD_FRAME_MS = 100;
const FALLBACK_VAD = { speechThreshold: 0.02, silenceBeforeCut: 1.5, triggerFrames: 2 };

// The server's VAD (max_sentence_silence in bailianAsr.js) is the only turn boundary. A final
// sentence therefore ends the turn on the spot; there is no client-side settle window, because a
// window armed on the last final expires while the speaker is still talking.
//
// The server's silence timer normally ends a turn. If the stream stays quiet this long with text
// still pending, no final sentence is coming and the turn is flushed anyway. Keep this above the
// server's max_sentence_silence or it flushes half a sentence.
const STREAM_IDLE_FLUSH_MS = 3000;

let vadSettings = null;
let resampleRemainder = Buffer.alloc(0);

function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveVadSettings(prefs) {
    const silenceSeconds = positiveNumber(prefs.vadSilenceBeforeCut, FALLBACK_VAD.silenceBeforeCut);

    return {
        speechThreshold: positiveNumber(prefs.vadSpeechThreshold, FALLBACK_VAD.speechThreshold),
        speechFramesRequired: Math.max(1, Math.round(positiveNumber(prefs.vadTriggerFrames, FALLBACK_VAD.triggerFrames))),
        // Idle audio arrives in 100 ms frames, so seconds convert at 10 frames per second.
        silenceFramesRequired: Math.max(1, Math.round((silenceSeconds * 1000) / VAD_FRAME_MS)),
    };
}

function resample24kTo16k(inputBuffer) {
    const combined = Buffer.concat([resampleRemainder, inputBuffer]);
    const inputSamples = Math.floor(combined.length / 2);
    const outputSamples = Math.floor((inputSamples * 2) / 3);
    const outputBuffer = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        const sourcePosition = (i * 3) / 2;
        const sourceIndex = Math.floor(sourcePosition);
        const fraction = sourcePosition - sourceIndex;
        const firstSample = combined.readInt16LE(sourceIndex * 2);
        const secondSample = sourceIndex + 1 < inputSamples ? combined.readInt16LE((sourceIndex + 1) * 2) : firstSample;
        const interpolated = Math.round(firstSample + fraction * (secondSample - firstSample));
        outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
    }

    const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
    const remainderStart = consumedInputSamples * 2;
    resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);

    return outputBuffer;
}

function calculateRms(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
}

function processVad(pcm16kBuffer) {
    const rms = calculateRms(pcm16kBuffer);
    const isVoice = rms > vadSettings.speechThreshold;

    if (isVoice) {
        speechFrameCount += 1;
        silenceFrameCount = 0;

        if (!isSpeaking && speechFrameCount >= vadSettings.speechFramesRequired) {
            isSpeaking = true;
            // Adopt the retained idle audio instead of dropping the frames that triggered detection.
            speechBuffers = speechPreRoll;
            speechPreRoll = [];
            console.log('[Pipeline] Speech started (RMS:', rms.toFixed(4), 'threshold:', vadSettings.speechThreshold.toFixed(4), ')');
            sendToRenderer('update-status', 'Listening... (speech detected)');
        }
    } else {
        silenceFrameCount += 1;
        speechFrameCount = 0;

        if (isSpeaking && silenceFrameCount >= vadSettings.silenceFramesRequired) {
            isSpeaking = false;
            const audioData = Buffer.concat(speechBuffers);
            speechBuffers = [];
            console.log('[Pipeline] Speech ended, accumulated', audioData.length, 'bytes');
            sendToRenderer('update-status', 'Transcribing...');
            handleSpeechEnd(audioData);
            return;
        }
    }

    if (isSpeaking) {
        speechBuffers.push(Buffer.from(pcm16kBuffer));
    } else {
        // Idle: keep a short tail so a quiet onset is still there once detection fires.
        speechPreRoll.push(Buffer.from(pcm16kBuffer));
        if (speechPreRoll.length > vadSettings.speechFramesRequired) {
            speechPreRoll.shift();
        }
    }
}

// The ASR endpoint wants a bare ISO-639-1 code, but preferences store BCP-47 locales.
function toAsrLanguage(locale) {
    if (!locale) {
        return null;
    }

    const primary = String(locale).split('-')[0].toLowerCase();
    return primary === 'cmn' ? 'zh' : primary;
}

function createWavBuffer(pcm16Buffer) {
    const header = Buffer.alloc(44);
    const byteRate = 16000 * 2;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm16Buffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm16Buffer.length, 40);

    return Buffer.concat([header, pcm16Buffer]);
}

async function transcribeAudio(pcm16kBuffer) {
    const text = (await transcribeWithSiliconFlow(createWavBuffer(pcm16kBuffer), toAsrLanguage(transcriptionLanguage))).trim();
    console.log('[Pipeline] Transcription (siliconflow):', text);
    return text;
}

async function handleSpeechEnd(audioData) {
    if (!isLocalActive) return;

    if (audioData.length < 16000) {
        console.log('[Pipeline] Audio too short, skipping');
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    try {
        const transcription = await transcribeAudio(audioData);

        if (!transcription || transcription.length < 2) {
            console.log('[Pipeline] Empty transcription, skipping');
            sendToRenderer('update-status', 'Listening...');
            return;
        }

        logTransportEvent('asr.sentence_final', { mode: asrMode, text: transcription });
        sendToRenderer('transcription-final', { text: transcription });
        dispatchTurn(transcription);
    } catch (error) {
        console.error('[Pipeline] Transcription error:', error);
        sendToRenderer('update-status', 'Transcription error: ' + error.message);
    }
}

// ── Streaming turn assembly ──

// The committed sentences plus whatever tail the server has not confirmed yet.
function mergeTurnText() {
    if (turnText && interimText) return `${turnText} ${interimText}`;
    return turnText || interimText;
}

function handleAsrSentence(text, sentenceEnd) {
    if (!isLocalActive || !text) return;

    const sentence = text.trim();
    if (!sentence) return;

    if (!sentenceEnd) {
        // Provisional: it replaces the previous interim rather than appending to it.
        interimText = sentence;
        sendToRenderer('transcription-update', { text: mergeTurnText() });
        return;
    }

    turnText = turnText ? `${turnText} ${sentence}` : sentence;
    interimText = '';
    console.log('[Pipeline] ASR sentence:', sentence);
    logTransportEvent('asr.sentence_final', { mode: asrMode, text: sentence });
    sendToRenderer('transcription-update', { text: turnText });

    flushTurn();
}

function flushTurn() {
    // An uncommitted tail is still better than losing the utterance entirely.
    const text = mergeTurnText().trim();
    turnText = '';
    interimText = '';
    streamSilenceMs = 0;

    if (!isLocalActive || text.length < 2) return;

    console.log('[Pipeline] Turn dispatched:', text);
    // The question bubble is settled first, then the answer streams into its own.
    sendToRenderer('transcription-final', { text });
    dispatchTurn(text);
}

function dispatchTurn(text) {
    const trimmed = (text || '').trim();
    if (!trimmed || trimmed.length < 2) return;

    if (isChatInFlight) {
        queuedTurnText = queuedTurnText ? `${queuedTurnText} ${trimmed}` : trimmed;
        console.log('[Pipeline] Chat in flight, merging turn:', trimmed);
        return;
    }

    isChatInFlight = true;
    logTransportEvent('asr.turn_dispatched', { mode: asrMode, text: trimmed });
    sendToRenderer('update-status', 'Generating response...');

    sendTurn(trimmed)
        .catch(() => {})
        .finally(() => {
            isChatInFlight = false;
            if (queuedTurnText) {
                const pending = queuedTurnText;
                queuedTurnText = '';
                dispatchTurn(pending);
            }
        });
}

// Status text and a safety flush only: the server's VAD owns turn boundaries in streaming mode.
function trackStreamLevel(pcm16k) {
    const rms = calculateRms(pcm16k);

    if (rms > vadSettings.speechThreshold) {
        streamSilenceMs = 0;
        speechFrameCount += 1;

        if (!isSpeaking && speechFrameCount >= vadSettings.speechFramesRequired) {
            isSpeaking = true;
            console.log('[Pipeline] Speech started (RMS:', rms.toFixed(4), ')');
            sendToRenderer('update-status', 'Listening... (speech detected)');
        }
        return;
    }

    speechFrameCount = 0;
    isSpeaking = false;
    streamSilenceMs += VAD_FRAME_MS;

    if ((turnText || interimText) && streamSilenceMs >= STREAM_IDLE_FLUSH_MS) {
        flushTurn();
    }
}

function startAsrClient() {
    asrClient = createRealtimeAsr({
        language: toAsrLanguage(transcriptionLanguage),
        onSentence: handleAsrSentence,
        onState: state => {
            if (state === 'reconnecting') {
                sendToRenderer('update-status', 'Reconnecting transcription...');
            }
        },
        onError: error => {
            // Unrecoverable for this session: drop to the batch path so answers keep flowing.
            console.error('[Pipeline] Streaming ASR failed, falling back to batch:', error.message);
            asrMode = 'batch';
            if (asrClient) {
                asrClient.close();
                asrClient = null;
            }
            sendToRenderer('update-status', 'Transcription error: ' + error.message);
        },
    });

    asrClient.start();
}

async function sendTurn(transcription) {
    localConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    if (localConversationHistory.length > 20) {
        localConversationHistory = localConversationHistory.slice(-20);
    }

    try {
        const messages = [{ role: 'system', content: currentSystemPrompt || '你是一名乐于助人的助手。' }, ...localConversationHistory];

        let isFirst = true;
        const fullText = await requestChat(messages, text => {
            if (isFirst) logTransportEvent('chat.first_token', {});
            sendToRenderer(isFirst ? 'new-response' : 'update-response', text);
            isFirst = false;
        });

        if (fullText.trim()) {
            localConversationHistory.push({
                role: 'assistant',
                content: fullText.trim(),
            });
            saveConversationTurn(transcription, fullText);
        }

        logTransportEvent('chat.completed', {});
        console.log('[Pipeline] response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('[Pipeline] error:', error);
        sendToRenderer('update-status', 'Chat error: ' + error.message);
        throw error;
    }
}

function resetAudioState() {
    isSpeaking = false;
    speechBuffers = [];
    silenceFrameCount = 0;
    speechFrameCount = 0;
    resampleRemainder = Buffer.alloc(0);
    localConversationHistory = [];
    transcriptionLanguage = null;
    speechPreRoll = [];
    turnText = '';
    interimText = '';
    streamSilenceMs = 0;
}

function initializeChatSession(profile, customPrompt, selectedLanguage) {
    console.log('[Pipeline] Initializing chat session:', { profile, selectedLanguage });
    sendToRenderer('session-initializing', true);

    closeLocalSession();
    currentSystemPrompt = getSystemPrompt(profile, customPrompt);

    transcriptionLanguage = selectedLanguage;

    const prefs = getPreferences();
    vadSettings = resolveVadSettings(prefs);
    // In 'both' mode the loopback copy is the clean one; the mic only carries an echo of it.
    activeSource = prefs.audioMode === 'mic_only' ? 'mic' : 'system';
    asrMode = getConfig().asrProvider === 'siliconflow' ? 'batch' : 'stream';

    initializeNewSession(profile, customPrompt);
    isLocalActive = true;

    if (asrMode === 'stream') {
        startAsrClient();
    }

    sendToRenderer('session-initializing', false);
    sendToRenderer('update-status', 'Ready - Listening...');
    console.log('[Pipeline] Session initialized');
    return true;
}

function processLocalAudio(monoChunk24k, source = 'system') {
    if (!isLocalActive) return;
    if (source !== activeSource) return;

    const pcm16k = resample24kTo16k(monoChunk24k);
    if (pcm16k.length === 0) return;

    if (asrMode === 'stream' && asrClient) {
        asrClient.sendAudio(pcm16k);
        trackStreamLevel(pcm16k);
        return;
    }

    processVad(pcm16k);
}

function closeLocalSession() {
    isLocalActive = false;

    if (asrClient) {
        asrClient.close();
        asrClient = null;
    }

    queuedTurnText = '';
    isChatInFlight = false;

    resetAudioState();
    currentSystemPrompt = null;
}

function isLocalSessionActive() {
    return isLocalActive;
}

async function sendLocalText(text) {
    if (!isLocalActive) {
        return { success: false, error: 'No active session' };
    }

    try {
        sendToRenderer('transcription-final', { text });
        await sendTurn(text);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function sendLocalImage(base64Data, prompt) {
    if (!isLocalActive) {
        return { success: false, error: 'No active session' };
    }

    const userMessage = {
        role: 'user',
        content: [
            { type: 'text', text: prompt },
            {
                type: 'image_url',
                image_url: {
                    url: `data:image/jpeg;base64,${base64Data}`,
                },
            },
        ],
    };

    localConversationHistory.push({ role: 'user', content: prompt });
    if (localConversationHistory.length > 20) {
        localConversationHistory = localConversationHistory.slice(-20);
    }

    // The screenshot prompt is a page of boilerplate, so the bubble gets a short marker instead.
    sendToRenderer('transcription-final', { text: 'Screenshot' });

    try {
        sendToRenderer('update-status', 'Analyzing image...');
        const messages = [
            { role: 'system', content: currentSystemPrompt || '你是一名乐于助人的助手。' },
            ...localConversationHistory.slice(0, -1),
            userMessage,
        ];

        let isFirst = true;
        const fullText = await requestChat(messages, text => {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', text);
            isFirst = false;
        });

        if (fullText.trim()) {
            localConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveScreenAnalysis(prompt, fullText, getChatModel());
        }

        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: fullText, model: getChatModel() };
    } catch (error) {
        console.error('[Pipeline] Image error:', error);
        sendToRenderer('update-status', 'Image error: ' + error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initializeChatSession,
    processLocalAudio,
    closeLocalSession,
    isLocalSessionActive,
    sendLocalText,
    sendLocalImage,
};
