const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn, saveScreenAnalysis } = require('./session');
const { getChatModel, requestChat } = require('./chat');
const { createRealtimeAsr } = require('./bailianAsr');
const { logTransportEvent } = require('./transportLogger');
const { getPreferences, getMaxSentenceSilenceMs } = require('../storage');

let currentSystemPrompt = null;
let isLocalActive = false;
let transcriptionLanguage = null;

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

// Turns are assembled from the server's sentence events; the client analyses no audio. A final
// sentence ends the turn on the spot, so there is no client-side settle window — a window armed on
// the last final expires while the speaker is still talking.
//
// Every sentence event resets this countdown (see handleAsrSentence). If the socket stays quiet
// this long with text still pending, no final sentence is coming and the turn is flushed anyway.
// It is derived from the server's max_sentence_silence so it always outlasts it.
const AUDIO_CHUNK_MS = 100; // must match AUDIO_CHUNK_DURATION in renderer.js
const IDLE_FLUSH_MARGIN_MS = 1000;
let streamIdleFlushMs = 3000;

let resampleRemainder = Buffer.alloc(0);

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

// The ASR endpoint wants a bare ISO-639-1 code, but preferences store BCP-47 locales.
function toAsrLanguage(locale) {
    if (!locale) {
        return null;
    }

    const primary = String(locale).split('-')[0].toLowerCase();
    return primary === 'cmn' ? 'zh' : primary;
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

    // Any event means the server is still hearing speech, so the idle flush must not fire. Interims
    // keep arriving while a long question is spoken, which is what stops it being split in two.
    streamSilenceMs = 0;

    if (!sentenceEnd) {
        // Provisional: it replaces the previous interim rather than appending to it.
        interimText = sentence;
        sendToRenderer('transcription-update', { text: mergeTurnText() });
        return;
    }

    turnText = turnText ? `${turnText} ${sentence}` : sentence;
    interimText = '';
    console.log('[Pipeline] ASR sentence:', sentence);
    logTransportEvent('asr.sentence_final', { text: sentence });
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

    logTransportEvent('asr.turn_dispatched', { text: trimmed });
    const entry = createTurn(trimmed, trimmed, 'conversation');
    runTurn(entry);
    updateStreamingStatus();
    return entry;
}

// A safety flush only: the server's VAD owns turn boundaries. Audio arriving proves nothing on its
// own — only a sentence event does, and those reset the countdown in handleAsrSentence. If the
// socket goes quiet with text pending, the final sentence it was waiting for is never coming.
function tickStreamWatchdog() {
    streamSilenceMs += AUDIO_CHUNK_MS;

    if ((turnText || interimText) && streamSilenceMs >= streamIdleFlushMs) {
        flushTurn();
    }
}

function startAsrClient() {
    asrClient = createRealtimeAsr({
        language: toAsrLanguage(transcriptionLanguage),
        onSentence: handleAsrSentence,
        onState: state => {
            if (state === 'connecting') {
                sendToRenderer('update-status', 'Connecting...');
            } else if (state === 'ready') {
                sendToRenderer('update-status', 'Listening...');
            } else if (state === 'reconnecting') {
                sendToRenderer('update-status', 'Reconnecting transcription...');
            }
        },
        onError: error => {
            // The reconnect backoff inside the ASR client is exhausted, so this session has no
            // recognizer left. The session stays up and the error is surfaced; audio is dropped
            // rather than sent into a dead socket.
            console.error('[Pipeline] Streaming ASR failed:', error.message);
            if (asrClient) {
                asrClient.close();
                asrClient = null;
            }
            sendToRenderer('update-status', 'Transcription error: ' + error.message);
            sendToRenderer('reconnect-failed', { message: 'Transcription stopped: ' + error.message });
        },
    });

    asrClient.start();
}

function resetAudioState() {
    resampleRemainder = Buffer.alloc(0);
    transcriptionLanguage = null;
    turnText = '';
    interimText = '';
    streamSilenceMs = 0;
    turnLog = [];
    turnSeq = 0;
    sessionGeneration += 1;
}

function initializeChatSession(profile, customPrompt, selectedLanguage) {
    sendToRenderer('session-initializing', true);

    closeLocalSession();
    currentSystemPrompt = getSystemPrompt(profile, customPrompt);

    transcriptionLanguage = selectedLanguage;

    const prefs = getPreferences();
    // In 'both' mode the loopback copy is the clean one; the mic only carries an echo of it.
    activeSource = prefs.audioMode === 'mic_only' ? 'mic' : 'system';
    const maxSentenceSilenceMs = getMaxSentenceSilenceMs();
    streamIdleFlushMs = maxSentenceSilenceMs + IDLE_FLUSH_MARGIN_MS;
    console.log('[Pipeline] Initializing chat session:', { profile, selectedLanguage, maxSentenceSilenceMs, streamIdleFlushMs });

    initializeNewSession(profile, customPrompt);
    isLocalActive = true;

    // The ASR client's own state owns the status bar from here: Connecting... then Listening....
    sendToRenderer('session-initializing', false);
    startAsrClient();

    console.log('[Pipeline] Session initialized');
    return true;
}

function processLocalAudio(monoChunk24k, source = 'system') {
    if (!isLocalActive) return;
    if (source !== activeSource) return;

    const pcm16k = resample24kTo16k(monoChunk24k);
    if (pcm16k.length === 0) return;

    // The client is a pipe: audio goes straight to the recognizer. If it is gone, the audio has
    // nowhere to go, but the session stays up so the user can see why.
    if (!asrClient) return;

    asrClient.sendAudio(pcm16k);
    tickStreamWatchdog();
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

    const requestContent = [
        { type: 'text', text: prompt },
        {
            type: 'image_url',
            image_url: {
                url: `data:image/jpeg;base64,${base64Data}`,
            },
        },
    ];

    // The screenshot prompt is a page of boilerplate, so the bubble gets a short marker instead.
    sendToRenderer('transcription-final', { text: 'Screenshot' });
    sendToRenderer('update-status', 'Analyzing image...');

    // Runs like any other turn, so a screenshot taken mid-answer streams alongside it instead of
    // displacing it. Only the prompt text is kept for later context; the image itself is not.
    const entry = createTurn(requestContent, prompt, 'screen');
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
