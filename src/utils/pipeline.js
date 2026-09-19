const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn, saveScreenAnalysis } = require('./session');
const { getChatModel, requestChat } = require('./chat');
const { createRealtimeAsr } = require('./bailianAsr');
const { logTransportEvent } = require('./transportLogger');
const { getPreferences, getMaxSentenceSilenceMs } = require('../storage');

let currentSystemPrompt = null;
let isLocalActive = false;
let transcriptionLanguage = null;

// Two captures, each with its own recognizer: the speaker path transcribes the interviewer and owns
// the turns that get answered, the microphone path transcribes the candidate, whose words are only
// ever context. Same streaming algorithm on both, one socket each.
const INTERVIEWER = 'system';
const CANDIDATE = 'mic';

// Text for the turn currently being assembled from streaming sentences. The server rewrites an
// in-flight sentence as it hears more, so the uncommitted tail is held separately and only folded
// in when it is committed or rescued by the idle flush.
//
// Per stream, not shared: two voices writing one buffer would splice into a single turn. The
// resampler's leftover half-sample belongs to exactly one stream for the same reason.
function createStreamState() {
    return { asr: null, turnText: '', interimText: '', silenceMs: 0, resampleRemainder: Buffer.alloc(0) };
}

const streams = {
    [INTERVIEWER]: createStreamState(),
    [CANDIDATE]: createStreamState(),
};

function speakerFor(source) {
    return source === CANDIDATE ? 'user' : 'interviewer';
}

// What the candidate has said, replayed on the system prompt. The candidate's speech never becomes
// a request of its own, so this is the only way it reaches the model. Bounded because the prompt is
// rebuilt from scratch on every request and only the recent turns matter.
const CANDIDATE_CONTEXT_LIMIT = 6;
let candidateSpeech = [];

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

function resample24kTo16k(inputBuffer, state) {
    const combined = Buffer.concat([state.resampleRemainder, inputBuffer]);
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
    state.resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);

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
function mergeTurnText(state) {
    if (state.turnText && state.interimText) return `${state.turnText} ${state.interimText}`;
    return state.turnText || state.interimText;
}

function handleAsrSentence(text, sentenceEnd, source) {
    if (!isLocalActive || !text) return;

    const sentence = text.trim();
    if (!sentence) return;

    const state = streams[source];

    // Any event means the server is still hearing speech, so the idle flush must not fire. Interims
    // keep arriving while a long question is spoken, which is what stops it being split in two.
    state.silenceMs = 0;

    if (!sentenceEnd) {
        // Provisional: it replaces the previous interim rather than appending to it.
        state.interimText = sentence;
        sendToRenderer('transcription-update', { text: mergeTurnText(state), speaker: speakerFor(source) });
        return;
    }

    state.turnText = state.turnText ? `${state.turnText} ${sentence}` : sentence;
    state.interimText = '';
    console.log(`[Pipeline] ASR sentence (${source}):`, sentence);
    logTransportEvent('asr.sentence_final', { text: sentence, source });
    sendToRenderer('transcription-update', { text: state.turnText, speaker: speakerFor(source) });

    flushTurn(source);
}

function flushTurn(source) {
    const state = streams[source];

    // An uncommitted tail is still better than losing the utterance entirely.
    const text = mergeTurnText(state).trim();
    state.turnText = '';
    state.interimText = '';
    state.silenceMs = 0;

    if (!isLocalActive || text.length < 2) return;

    if (source === CANDIDATE) {
        // The bubble is settled like any other, but nothing is dispatched: what the candidate says
        // is context for the next answer, not a question to answer.
        console.log('[Pipeline] Candidate speech:', text);
        sendToRenderer('transcription-final', { text, speaker: speakerFor(source) });
        candidateSpeech.push(text);
        if (candidateSpeech.length > CANDIDATE_CONTEXT_LIMIT) {
            candidateSpeech = candidateSpeech.slice(-CANDIDATE_CONTEXT_LIMIT);
        }
        return;
    }

    console.log('[Pipeline] Turn dispatched:', text);
    // The question bubble is settled first, then the answer streams into its own.
    sendToRenderer('transcription-final', { text, speaker: speakerFor(source) });
    dispatchTurn(text);
}

// The candidate's speech rides on the system prompt rather than the turn log: as its own messages it
// would read as questions aimed at the model, and it would evict real turns from the context window.
function buildSystemContent() {
    const base = currentSystemPrompt || '你是一名乐于助人的助手。';
    if (!candidateSpeech.length) return base;

    const said = candidateSpeech.map(text => `- ${text}`).join('\n');
    return `${base}\n\n【我在本次对话中已经说过的话，只是背景参考，不是新的提问，不要当成问题回答，也不要重复我已有的说法】\n${said}`;
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
    const messages = [{ role: 'system', content: buildSystemContent() }];

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
function tickStreamWatchdog(source) {
    const state = streams[source];
    state.silenceMs += AUDIO_CHUNK_MS;

    if ((state.turnText || state.interimText) && state.silenceMs >= streamIdleFlushMs) {
        flushTurn(source);
    }
}

// The interviewer's recognizer owns the shared status line, since it is the one the session depends
// on. The candidate's runs alongside it and fails quietly: losing it costs context, not answers.
function startAsrClient(source) {
    const isInterviewer = source === INTERVIEWER;

    const client = createRealtimeAsr({
        language: toAsrLanguage(transcriptionLanguage),
        onSentence: (text, sentenceEnd) => handleAsrSentence(text, sentenceEnd, source),
        onState: state => {
            if (!isInterviewer) return;
            if (state === 'connecting') {
                sendToRenderer('update-status', 'Connecting...');
            } else if (state === 'ready') {
                sendToRenderer('update-status', 'Listening...');
            } else if (state === 'reconnecting') {
                sendToRenderer('update-status', 'Reconnecting transcription...');
            }
        },
        onError: error => {
            // The reconnect backoff inside the ASR client is exhausted, so this stream has no
            // recognizer left. The session stays up and the error is surfaced; audio is dropped
            // rather than sent into a dead socket. The socket is already gone at this point.
            console.error(`[Pipeline] Streaming ASR failed (${source}):`, error.message);
            streams[source].asr = null;

            if (!isInterviewer) return;
            sendToRenderer('update-status', 'Transcription error: ' + error.message);
            sendToRenderer('reconnect-failed', { message: 'Transcription stopped: ' + error.message });
        },
    });

    streams[source].asr = client;
    client.start();
}

function startAsrClients() {
    startAsrClient(INTERVIEWER);

    // 'none' is the user's explicit "don't use a microphone" choice from Settings, and it is the only
    // thing that turns the candidate stream off: the two captures are no longer alternatives, so the
    // speaker stream keeps running whatever the microphone dropdown says.
    const { audioInputDeviceId } = getPreferences();
    if (audioInputDeviceId && audioInputDeviceId !== 'none') {
        startAsrClient(CANDIDATE);
    }
}

function resetAudioState() {
    for (const source of [INTERVIEWER, CANDIDATE]) {
        const state = streams[source];
        state.asr = null;
        state.turnText = '';
        state.interimText = '';
        state.silenceMs = 0;
        state.resampleRemainder = Buffer.alloc(0);
    }
    candidateSpeech = [];
    transcriptionLanguage = null;
    turnLog = [];
    turnSeq = 0;
    sessionGeneration += 1;
}

function initializeChatSession(profile, customPrompt, selectedLanguage) {
    sendToRenderer('session-initializing', true);

    closeLocalSession();
    currentSystemPrompt = getSystemPrompt(profile, customPrompt);

    transcriptionLanguage = selectedLanguage;

    const maxSentenceSilenceMs = getMaxSentenceSilenceMs();
    streamIdleFlushMs = maxSentenceSilenceMs + IDLE_FLUSH_MARGIN_MS;
    console.log('[Pipeline] Initializing chat session:', { profile, selectedLanguage, maxSentenceSilenceMs, streamIdleFlushMs });

    initializeNewSession(profile, customPrompt);
    isLocalActive = true;

    // The ASR client's own state owns the status bar from here: Connecting... then Listening....
    sendToRenderer('session-initializing', false);
    startAsrClients();

    console.log('[Pipeline] Session initialized');
    return true;
}

function processLocalAudio(monoChunk24k, source = 'system') {
    if (!isLocalActive) return;

    // The client is a pipe: audio goes straight to the recognizer. A stream with no client — the
    // candidate stream when no microphone is configured, or any stream whose recognizer gave up —
    // is dropped here, before the resampler, so its half-sample state stays untouched.
    const state = streams[source];
    if (!state || !state.asr) return;

    const pcm16k = resample24kTo16k(monoChunk24k, state);
    if (pcm16k.length === 0) return;

    state.asr.sendAudio(pcm16k);
    tickStreamWatchdog(source);
}

function closeLocalSession() {
    isLocalActive = false;

    for (const source of [INTERVIEWER, CANDIDATE]) {
        const client = streams[source].asr;
        if (client) client.close();
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
