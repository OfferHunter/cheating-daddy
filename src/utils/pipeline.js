const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn, saveScreenAnalysis } = require('./session');
const { getChatModel, requestChat } = require('./chat');
const { transcribe: transcribeWithSiliconFlow } = require('./siliconflow');
const { createRealtimeAsr } = require('./bailianAsr');
const { logTransportEvent } = require('./transportLogger');
const { getConfig, getPreferences } = require('../storage');

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

// Every turn is dispatched the moment its question is recognized, even if earlier answers are
// still streaming: waiting for the previous answer would make the new one arrive too late to be
// useful. Turns therefore run concurrently and finish out of order, so the log below is the single
// source of truth for both the prompt context and the recorded history order.
const CHAT_CONTEXT_TURNS = 10;
// Tokens arrive one IPC message at a time and the renderer re-parses the whole markdown body per
// message, so a per-turn window keeps a burst of tokens to a handful of renders.
const STREAM_SEND_INTERVAL_MS = 40;

let turnLog = [];
let turnSeq = 0;
// Bumped whenever the session resets. A turn that outlives its session must not write into the
// next one, and requests are never aborted.
let sessionGeneration = 0;

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

// Settled turns are kept only as prompt context, so the tail can be dropped once it is longer than
// anything buildChatMessages will read. Pending turns stay: they are still referenced by closures.
function pruneTurnLog() {
    if (turnLog.length <= CHAT_CONTEXT_TURNS * 3) return;

    const settled = turnLog.filter(entry => entry.status !== 'pending').slice(-CHAT_CONTEXT_TURNS * 2);
    const pending = turnLog.filter(entry => entry.status === 'pending');
    turnLog = [...settled, ...pending].sort((a, b) => a.seq - b.seq);
}

function createTurn(requestContent, contextText, persistKind) {
    const entry = {
        seq: ++turnSeq,
        generation: sessionGeneration,
        // A screenshot turn sends a multimodal array; every later turn only needs its prompt text.
        requestContent,
        contextText: contextText || (typeof requestContent === 'string' ? requestContent : ''),
        assistant: null,
        partial: '',
        status: 'pending',
        persistKind,
        lastSentAt: 0,
        lastSentText: '',
    };

    turnLog.push(entry);
    pruneTurnLog();
    return entry;
}

function buildChatMessages(currentEntry) {
    const history = turnLog.filter(entry => entry !== currentEntry).slice(-CHAT_CONTEXT_TURNS);
    const messages = [{ role: 'system', content: currentSystemPrompt || '你是一名乐于助人的助手。' }];

    for (const entry of history) {
        messages.push({ role: 'user', content: entry.contextText || entry.requestContent });

        if (entry.status === 'done') {
            // An empty answer is dropped rather than sent as a blank assistant turn.
            if (entry.assistant) messages.push({ role: 'assistant', content: entry.assistant });
            continue;
        }

        // Still streaming, or failed part way: show what the model actually produced and mark it
        // truncated, so the new answer knows the previous one was cut off mid-sentence.
        messages.push({
            role: 'assistant',
            content: entry.partial.trim() ? `${entry.partial.trim()} (...)` : '(...)',
        });
    }

    messages.push({ role: 'user', content: currentEntry.requestContent });
    return messages;
}

function pendingTurnCount() {
    return turnLog.filter(entry => entry.status === 'pending').length;
}

// A single shared status line, so it has to reflect every turn still running or the first one to
// finish would claim the session is idle while others are still streaming.
function updateStreamingStatus() {
    const pending = pendingTurnCount();
    if (pending === 0) {
        sendToRenderer('update-status', 'Listening...');
    } else if (pending === 1) {
        sendToRenderer('update-status', 'Generating response...');
    } else {
        sendToRenderer('update-status', `Generating ${pending} responses...`);
    }
}

function persistTurn(entry) {
    if (entry.persistKind === 'screen') {
        saveScreenAnalysis(entry.contextText, entry.assistant, getChatModel(), entry.seq);
    } else {
        saveConversationTurn(entry.contextText, entry.assistant, entry.seq);
    }
}

async function runTurn(entry) {
    // Snapshot synchronously: turns dispatched while this one streams must not mutate its prompt.
    const messages = buildChatMessages(entry);

    try {
        let isFirst = true;
        const fullText = await requestChat(messages, text => {
            entry.partial = text;

            if (isFirst) {
                logTransportEvent('chat.first_token', { turnId: entry.seq });
                entry.lastSentText = text;
                entry.lastSentAt = Date.now();
                sendToRenderer('new-response', { turnId: entry.seq, text });
                isFirst = false;
                return;
            }

            const now = Date.now();
            if (now - entry.lastSentAt < STREAM_SEND_INTERVAL_MS) return;
            entry.lastSentText = text;
            entry.lastSentAt = now;
            sendToRenderer('update-response', { turnId: entry.seq, text });
        });

        entry.assistant = fullText.trim();
        entry.status = 'done';
        if (entry.generation !== sessionGeneration) return;

        // The last tokens may have been swallowed by the throttle window.
        if (fullText !== entry.lastSentText) {
            sendToRenderer('update-response', { turnId: entry.seq, text: fullText });
        }
        sendToRenderer('response-complete', { turnId: entry.seq });
        logTransportEvent('chat.completed', { turnId: entry.seq });
        console.log('[Pipeline] response completed:', entry.seq);

        if (entry.assistant) persistTurn(entry);
    } catch (error) {
        entry.status = 'failed';
        console.error('[Pipeline] error:', error);
        if (entry.generation !== sessionGeneration) return;

        // A request that failed before its first token has no bubble to report into.
        if (!entry.lastSentText) {
            sendToRenderer('new-response', { turnId: entry.seq, text: `Error: ${error.message}` });
        }
        sendToRenderer('response-complete', { turnId: entry.seq });
        sendToRenderer('update-status', 'Chat error: ' + error.message);
        return;
    }

    updateStreamingStatus();
}

// Never awaited and never queued: the caller is the ASR callback and must stay responsive.
function dispatchTurn(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length < 2) return null;

    logTransportEvent('asr.turn_dispatched', { mode: asrMode, text: trimmed });
    const entry = createTurn(trimmed, trimmed, 'conversation');
    runTurn(entry);
    updateStreamingStatus();
    return entry;
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

function resetAudioState() {
    isSpeaking = false;
    speechBuffers = [];
    silenceFrameCount = 0;
    speechFrameCount = 0;
    resampleRemainder = Buffer.alloc(0);
    transcriptionLanguage = null;
    speechPreRoll = [];
    turnText = '';
    interimText = '';
    streamSilenceMs = 0;
    turnLog = [];
    turnSeq = 0;
    sessionGeneration += 1;
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

    const trimmed = (text || '').trim();
    if (trimmed.length < 2) {
        return { success: false, error: 'Empty message' };
    }

    // Fire and forget: a typed question must not block on an answer still streaming, and a failure
    // surfaces as an error bubble through runTurn rather than as a return value.
    sendToRenderer('transcription-final', { text: trimmed });
    const entry = dispatchTurn(trimmed);
    return { success: true, turnId: entry ? entry.seq : null };
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

    // The screenshot prompt is a page of boilerplate, so the bubble gets a short marker instead.
    sendToRenderer('transcription-final', { text: 'Screenshot' });
    sendToRenderer('update-status', 'Analyzing image...');

    // Runs like any other turn, so a screenshot taken mid-answer streams alongside it instead of
    // displacing it. Only the prompt text is kept for later context; the image itself is not.
    const entry = createTurn(userMessage, prompt, 'screen');
    runTurn(entry);

    return { success: true, model: getChatModel(), turnId: entry.seq };
}

module.exports = {
    initializeChatSession,
    processLocalAudio,
    closeLocalSession,
    isLocalSessionActive,
    sendLocalText,
    sendLocalImage,
};
