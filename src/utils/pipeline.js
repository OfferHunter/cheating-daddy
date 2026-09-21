const { getSystemPrompt, getDetailSystemPrompt, getScreenshotSummaryPrompt, getScreenshotAnswerPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn, saveDetailTurn, saveCandidateSpeech } = require('./session');
const { getChatModel, requestChat } = require('./chat');
const {
    KNOWLEDGE_TOOL_NAME,
    KNOWLEDGE_TOOL_SPEC,
    listKnowledgeEntries,
    formatKnowledgeSummary,
    readKnowledgeById,
    executeKnowledgeTool,
} = require('./knowledge');
const { createRealtimeAsr } = require('./bailianAsr');
const { logTransportEvent } = require('./transportLogger');
const {
    getPreferences,
    getMaxSentenceSilenceMs,
    getMicMaxSentenceSilenceMs,
    getMicGateDb,
    getMicGateDwellMs,
    getChatContextTurns,
} = require('../storage');

let currentSystemPrompt = null;
// 详细链自己的提示词与开关，和上面一样在会话开始时快照：每轮现读配置等于在每个回答前插一次磁盘读。
let currentDetailSystemPrompt = null;
// 追问轮用的提示词：就是上面那份去掉知识库规则与索引——到那时模型已经用过了。同样在会话开始时快照。
let currentDetailFollowUpSystemPrompt = null;
let detailModeEnabled = false;
// Whether each chain lets the model think first. The model is a reasoning model whose scratchpad this
// app never shows, so thinking is dead wait in front of the first visible token — worth it in the
// detail pane, which is read in the gap between questions, and not in the brief line that is read aloud.
let briefThinkingEnabled = false;
let detailThinkingEnabled = true;
// The screenshot's own switch. It used to be hard-coded on, whatever the two above said: the chain always
// asked for the scratchpad, and the reasoning it spends before the first visible token runs inside the
// client's own request timeout — on the whole-problem-statement screenshots this chain exists for, that
// budget could go entirely into the scratchpad and the answer arrived as nothing at all.
let screenshotThinkingEnabled = false;
// The entries the session started with, used both for the prompt index and to decide whether the tool is
// worth declaring at all. Only the *index* is a snapshot — the executor reads the directory live, so a
// stale entry here can never turn into a wrong fact, only into a failed lookup.
let detailKnowledgeEntries = [];
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
    return {
        asr: null,
        turnText: '',
        interimText: '',
        silenceMs: 0,
        resampleRemainder: Buffer.alloc(0),
        // How long the server waits for silence before it ends a sentence on this stream. Set per
        // source at session start and handed to that stream's recognizer, so the server's own bound
        // and the client's rescue below can never disagree about it.
        sentenceSilenceMs: 0,
        // Which candidate bubble the sentence in flight belongs to, 0 while there is none. Meaningful
        // on the candidate stream only; see candidateBlockId.
        blockId: 0,
    };
}

const streams = {
    [INTERVIEWER]: createStreamState(),
    [CANDIDATE]: createStreamState(),
};

function speakerFor(source) {
    return source === CANDIDATE ? 'user' : 'interviewer';
}

// What the candidate has said since the last dispatched turn, in the order it was recognized. Fragments
// accumulate here and are committed as a single context entry when the next turn is created: one answer
// must stay one entry, which is what a per-fragment cap destroyed — the server cuts an answer into pieces
// short enough that a handful of them covered only the last few seconds of speech.
let candidateSpeech = [];

// The block candidateSpeech is currently accumulating into, and the only thing that identifies it to
// the renderer. The renderer cannot key the candidate's bubble on "the last row" the way it does for
// the interviewer: a question recognized while the candidate's sentence is still being finalized is
// appended below the bubble, and the final then has to find that same bubble again to rewrite it. A
// question ends the block, so the next thing the candidate says opens a new bubble.
let candidateBlockId = 1;

// Every turn is dispatched the moment its question is recognized, even if earlier answers are
// still streaming: waiting for the previous answer would make the new one arrive too late to be
// useful. Turns therefore run concurrently and finish out of order, so the log below is the single
// source of truth for both the prompt context and the recorded history order. How much of it the
// model is shown is the "Context Turns" setting, snapshotted at session start like the prompts.
const DEFAULT_CHAT_CONTEXT_TURNS = 15;
let chatContextTurns = DEFAULT_CHAT_CONTEXT_TURNS;
// Tokens arrive one IPC message at a time and the renderer re-parses the whole markdown body per
// message, so a per-turn window keeps a burst of tokens to a handful of renders.
const STREAM_SEND_INTERVAL_MS = 40;

// A screenshot is a question the interviewer asked on screen, so it enters the context under a label of
// its own: the model reads the transcript as a run of user messages and cannot tell an image from a
// spoken question otherwise. The text itself is the summary request's answer, and it is the only trace
// of the picture any later prompt can see — the answer to it is shown once and never replayed, and the
// base64 never enters the context at all.
//
// The label it is written under and the label it is *replayed* under are deliberately different. In the
// transcript the short one is what the row shows; in the prompt the long one is what keeps a full problem
// statement from reading as an outstanding task. Every other turn carries a speaker tag and sits before
// an answer the model wrote, but an answer is never replayed: a screenshot turn is the one user message
// that arrives with nothing after it, so untagged it reads as "the user has just asked this" and the
// model answers *it* instead of the question that was actually asked next.
const SCREEN_PREFIX = '[屏幕截图]';
// The label the turn being answered carries. Without it the current image is the one message in the
// prompt with no label at all — it is a request addressed to the assistant rather than something anyone
// said, so it never gets a speaker tag — and the context rule, which used to name the last [面试官:]
// message as the only thing to answer, pointed past it at whatever had been asked out loud before. The
// two labels are named together in CONTEXT_RULE, as are the interviewer's two.
const SCREEN_CONTEXT_PREFIX = '[屏幕共享的题目（已回答，仅参考）]';
const SCREEN_PENDING_LINE = `${SCREEN_PREFIX} （识别中…）`;
const SCREEN_FAILED_LINE = `${SCREEN_PREFIX} （图片内容识别失败）`;
// 拍题在详情面板里的固定标题。摘要只走对话记录，面板用它自己的这行标题，两者不再互相改写。
const SCREENSHOT_ANSWER_QUESTION = '对屏幕截图的作答';
// 会话还没开始时（比如手动发消息）没有系统提示词可用，兜底一行。
const DEFAULT_SYSTEM_PROMPT = '你是一名乐于助人的助手。';

let turnLog = [];
let turnSeq = 0;
// Bumped whenever the session resets. A turn that outlives its session must not write into the
// next one, and requests are never aborted.
let sessionGeneration = 0;

// What the model is shown is the part of turnLog after this seq. Clearing the context moves the
// floor up to the current turnSeq, which empties the prompt without touching the log itself: the log
// is still what pruneTurnLog, the pending count and persistTurn read, and persistTurn is what writes
// the history file. Only the prompt starts over.
let contextFloorSeq = 0;

// The user's pause switch, and one more gate in the chain processLocalAudio applies. Set, it makes
// the frame silence and drops the server's sentence events, so nothing said after the pause can
// reach the transcript or a turn — while the sockets stay open and warm behind it.
let paused = false;

// The detailed answers, tracked completely apart from turnLog. Every later feature reads one of these
// two logs and they must not see each other's entries: a detail entry in turnLog would be replayed into
// the chat context, counted by the status line as another pending answer, cropped early by pruneTurnLog,
// and given a bubble of its own by the renderer. Kept only so the pane can page back through the session.
let detailLog = [];
let detailSeq = 0;
const MAX_DETAIL_TURNS = 30;

function getKnowledgeDir() {
    return getPreferences().knowledgeDir || '';
}

// Turns are assembled from the server's sentence events; the client analyses no audio. A final
// sentence ends the turn on the spot, so there is no client-side settle window — a window armed on
// the last final expires while the speaker is still talking.
//
// Every sentence event resets this countdown (see handleAsrSentence). If the socket stays quiet
// this long with text still pending, no final sentence is coming and the turn is flushed anyway.
// It is derived from the stream's own max_sentence_silence so it always outlasts it.
const AUDIO_CHUNK_MS = 100; // must match AUDIO_CHUNK_DURATION in renderer.js
const IDLE_FLUSH_MARGIN_MS = 1000;

// Speaker gate. The user does not wear headphones, so the interviewer's voice reaches the microphone
// and the candidate column echoes it. While the loopback level is above micGateDb the microphone is
// muted. The level must stay on one side of the threshold for micGateDwellMs before the gate flips,
// so neither a single spike nor the gap between two words can chop the microphone on and off inside
// a sentence. Both come from Settings; the values here are only the fallbacks before a session.
//
// The level gate has holes the level cannot see: the dwell has to elapse before it closes at the
// start of a question, and it opens again on any pause longer than the dwell inside one. Both let the
// microphone through while the interviewer is still talking, which lands the interviewer's own words
// — or the tail of an interrupted answer — in the candidate column as a fragment. So the gate is also
// held shut whenever the speaker's recognizer has text it has not finalized yet: an interim sentence
// means the speaker is mid-utterance, whatever the level happens to be doing.
let micGateDb = -45;
let micGateDwellMs = 300;
let micLevelGated = false;
let micGated = false;
let micGateSideLoud = false;
let micGateSideSinceMs = 0;

// dBFS of a little-endian int16 chunk, using the same 20*log10(rms) convention as the Settings level
// meter, so the threshold the user types in Settings means the same thing here.
function pcmRmsDb(buffer) {
    const samples = Math.floor(buffer.length / 2);
    if (samples === 0) return -Infinity;

    let sum = 0;
    for (let i = 0; i < samples; i++) {
        const sample = buffer.readInt16LE(i * 2) / 32768;
        sum += sample * sample;
    }
    return 20 * Math.log10(Math.sqrt(sum / samples) + 1e-8);
}

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

// What one stream's bubble shows right now. For the candidate that is the whole open block, not just
// the utterance in flight: stumbling over a word then grows the one paragraph on screen instead of
// opening a second bubble, and the text the block will be committed with is exactly what is shown.
function bubbleText(source) {
    const text = mergeTurnText(streams[source]);
    return source === CANDIDATE ? candidateSpeech.join('') + text : text;
}

// Anything the candidate says this short is dropped rather than merged: a couple of characters is
// what a leaked word through the gate, a cough or a stray "嗯" looks like after recognition, and a
// one-word bubble is pure clutter. It never enters the block, so it reaches neither the screen nor
// the prompt. Interviewer lines are exempt — a short question is still a question.
const MIN_CANDIDATE_CHARS = 4;

// The one funnel every bubble goes through, so the floor above is applied in exactly one place. An
// open block is always long enough on its own, so only a short line with no block behind it is
// suppressed — and it is suppressed on every update, not just the final one, or the provisional
// update would leave a bubble behind that nothing ever replaces.
function sendBubble(channel, source) {
    const text = bubbleText(source);
    if (source === CANDIDATE && text.length < MIN_CANDIDATE_CHARS) return;
    const payload = { text, speaker: speakerFor(source) };
    if (source === CANDIDATE) payload.blockId = streams[CANDIDATE].blockId;
    sendToRenderer(channel, payload);
}

function handleAsrSentence(text, sentenceEnd, source) {
    // A sentence the server finalized for audio it received before the pause is not one the user
    // asked to keep. Dropped here rather than in flushTurn, so nothing is dispatched either.
    if (!isLocalActive || paused || !text) return;

    const sentence = text.trim();
    if (!sentence) return;

    const state = streams[source];

    // Any event means the server is still hearing speech, so the idle flush must not fire. Interims
    // keep arriving while a long question is spoken, which is what stops it being split in two.
    state.silenceMs = 0;

    // A sentence is pinned to the block that was current when it began, not the one current when it
    // ends: a question can land in the middle of it, and the finalized text still belongs to the
    // bubble its provisional text already opened. Later sentences of the same block pin the same id,
    // because only a question moves the counter.
    if (source === CANDIDATE && !state.turnText && !state.interimText) state.blockId = candidateBlockId;

    if (!sentenceEnd) {
        // Provisional: it replaces the previous interim rather than appending to it.
        state.interimText = sentence;
        sendBubble('transcription-update', source);
        return;
    }

    state.turnText = state.turnText ? `${state.turnText} ${sentence}` : sentence;
    state.interimText = '';
    console.log(`[Pipeline] ASR sentence (${source}):`, sentence);
    logTransportEvent('asr.sentence_final', { text: sentence, source });
    sendBubble('transcription-update', source);

    flushTurn(source);
}

// The gate flipped on, so the candidate is being cut off mid-sentence. Show what is there now, but
// do not settle it: the server still holds the audio it already received and will send its own final
// for this utterance, which rewrites this same open row and records the text exactly once.
function interruptCandidate() {
    const text = bubbleText(CANDIDATE).trim();
    if (text.length < MIN_CANDIDATE_CHARS) return;

    console.log('[Pipeline] Candidate interrupted:', text);
    sendBubble('transcription-update', CANDIDATE);
}

// Called once per loopback chunk. `loud` is measured, not inferred: the level must hold on one side
// of the threshold for the whole dwell before the level verdict moves, which is what keeps a sentence
// from being chopped into fragments by jitter around the threshold.
function tickMicGate(levelDb) {
    const loud = levelDb > micGateDb;
    const now = Date.now();

    if (loud !== micGateSideLoud) {
        micGateSideLoud = loud;
        micGateSideSinceMs = now;
    }

    if (now - micGateSideSinceMs >= micGateDwellMs) micLevelGated = loud;
    applyMicGate(levelDb);
}

// The gate itself, and the only place it moves. It is shut either because the level says the speaker
// is loud, or because the speaker's recognizer is holding a sentence it has not finalized — the level
// verdict alone lets the microphone through in the pauses inside a question, an unfinished sentence
// does not. It reopens on the next chunk after both are false.
function applyMicGate(levelDb) {
    const speakerPending = Boolean(streams[INTERVIEWER].turnText || streams[INTERVIEWER].interimText);
    const gated = micLevelGated || speakerPending;
    if (gated === micGated) return;

    micGated = gated;
    if (micGated) {
        console.log('[Pipeline] Mic gate on:', speakerPending ? 'speaker mid-sentence' : `${levelDb.toFixed(1)} dBFS`);
        interruptCandidate();
    } else {
        console.log('[Pipeline] Mic gate off');
    }
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
        if (text.length < MIN_CANDIDATE_CHARS) {
            console.log('[Pipeline] Candidate fragment dropped:', text);
            return;
        }

        // Nothing is dispatched: what the candidate says is context for the next answer, not a
        // question to answer. It joins the open block, which is not bounded here — the block is
        // closed whole by the next turn (see commitCandidateSpeech).
        console.log('[Pipeline] Candidate speech:', text);
        candidateSpeech.push(text);
        // Re-sent in full rather than as this fragment alone: the bubble is the block, so a shrinking
        // update would visibly undo text the user has already read. The block is only ever built from
        // the fragment pushed above, never from the bubble, so the floor cannot bite here.
        sendBubble('transcription-final', source);
        return;
    }

    console.log('[Pipeline] Turn dispatched:', text);
    // The question bubble is settled first, then the answer streams into its own.
    sendToRenderer('transcription-final', { text, speaker: speakerFor(source) });
    dispatchTurn(text);
}

// Settled turns are kept only as prompt context, so the tail can be dropped once it is longer than
// anything buildChatMessages will read. Pending turns stay: they are still referenced by closures.
function pruneTurnLog() {
    if (turnLog.length <= chatContextTurns * 3) return;

    const settled = turnLog.filter(entry => entry.status !== 'pending').slice(-chatContextTurns * 2);
    const pending = turnLog.filter(entry => entry.status === 'pending');
    turnLog = [...settled, ...pending].sort((a, b) => a.seq - b.seq);
}

// `speaker` picks the label buildChatMessages puts in front of the text. It defaults to the interviewer
// because a typed question is replayed as one — the API takes only system/user/assistant roles and drops
// the OpenAI-style `name` field, so who spoke has to be carried in the content itself.
function createTurn(requestContent, contextText, persistKind, speaker = 'interviewer') {
    const entry = {
        seq: ++turnSeq,
        generation: sessionGeneration,
        // A screenshot turn sends a multimodal array; every later turn only needs its prompt text.
        requestContent,
        contextText: contextText || (typeof requestContent === 'string' ? requestContent : ''),
        speaker,
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

// Closes the open block of candidate speech as one turn. It is committed on the way into the next turn
// rather than read at request time, so it holds a fixed seq and position: the prompt of the turn that
// interrupted the candidate sees it as finished history, and an answer still streaming alongside cannot
// reorder it.
function commitCandidateSpeech() {
    // The block is over even when there is nothing to commit: a sentence cut off by this question may
    // still be in flight, and the bubble the candidate's next words belong to is a new one either way.
    // The sentence in flight keeps the id it was pinned with, so its final still finds its own bubble.
    candidateBlockId += 1;

    if (!candidateSpeech.length) return;

    const text = candidateSpeech.join('');
    candidateSpeech = [];

    // Settled the moment it exists: no request stands behind it and nothing will ever stream into it, so
    // it must not count as pending or the status line would claim an answer is on the way.
    const entry = createTurn(text, text, null, 'candidate');
    entry.status = 'done';

    // Written out for the History page only. Unlike a question this turn is never answered, so nothing
    // else about it persists: without this the recorded session cannot reproduce the candidate's half of
    // the conversation, which is half of what the live transcript showed.
    saveCandidateSpeech(text, entry.seq);
}

// Who said a line, since every line is a `user` message and the model cannot tell the two speakers
// apart otherwise. Bracketed and on its own line prefix so it reads as a label, not as content.
//
// The interviewer's words carry two labels, because only one of them is still waiting for an answer:
// the turn being requested now, and everything asked before it. Naming both is the same guard as the
// screen labels below and exists for the same reason — a question that has already been answered reads
// as an outstanding task when nothing in the prompt says otherwise, and the model answers it again.
// The candidate's words never take the current label: nothing he says is a question for this assistant,
// it is what he has already said, so they stay context whatever their position.
const SPEAKER_TAG = { interviewer: '[面试官（已回答，仅参考）:]', candidate: '[面试者:]' };
const CURRENT_QUESTION_TAG = '[面试官（当前问题，请作答）:]';

// History replays a turn as text — a screenshot's prompt text stands in for its image, which is what
// createTurn already keeps in contextText — and only the turn being requested keeps everything it was
// created with. Screenshot turns are requests addressed to the assistant rather than speech, so they
// carry no speaker label: the ones being replayed
// SCREEN_CONTEXT_PREFIX, and CONTEXT_RULE names both.
function userContent(entry, isCurrent = false) {
    const content = isCurrent ? entry.requestContent : entry.contextText || entry.requestContent;

    if (entry.persistKind === 'screen') {
        // The turn being answered carries the image itself, so the label goes on the text part beside it
        // rather than replacing it: the picture is what the question is, and the label is what says so.
        if (isCurrent) {
            let tagged = false;
            return content.map(part => {
                if (tagged || part.type !== 'text') return part;
                tagged = true;
                return { ...part, text: `${part.text}` };
            });
        }
        // The ones being replayed carry the transcription instead of the image, and are relabelled as a
        // past record.
        if (typeof content !== 'string' || !content.startsWith(SCREEN_PREFIX)) return content;
        return `${SCREEN_CONTEXT_PREFIX} ${content.slice(SCREEN_PREFIX.length).trim()}`;
    }
    // Only the turn being requested can be a question to answer now: every other entry in the log is
    // either an earlier question or something the candidate said, and both are context by then.
    const tag = isCurrent && entry.speaker === 'interviewer' ? CURRENT_QUESTION_TAG : SPEAKER_TAG[entry.speaker];
    return `${tag} ${content}`;
}

// The user side of the transcript only: the interviewer's questions and the candidate's own words, in
// order. Past answers are deliberately left out. The model can already see what it was asked, and
// replaying its own previous answers pulled every later one toward the phrasing of the last — most
// visibly on a follow-up, which came back as a rewording of the answer above it.
//
// The result is a run of consecutive `user` messages, which the API accepts; the last one is always
// the question being answered now.
function buildUserSideHistory(excludeEntry) {
    return turnLog
        .filter(entry => entry !== excludeEntry && entry.seq > contextFloorSeq)
        .slice(-chatContextTurns)
        .map(entry => ({ role: 'user', content: userContent(entry) }));
}

// 两条链看到的是同一份对话，只差 system 那一行——精简是「照读的话」，详细是「把这道题读透」。
// 都走 buildUserSideHistory，所以两边看到的面试官/面试者轮次永远一致。
function buildMessages(systemPrompt, currentEntry) {
    return [
        { role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT },
        ...buildUserSideHistory(currentEntry),
        { role: 'user', content: userContent(currentEntry, true) },
    ];
}

// The id the model asked for, or '' if there is nothing usable. Kept separate from executeKnowledgeTool
// because the success path below has to know *which* entry was read in order to name it in the pane.
function parseKnowledgeId(argsJson) {
    try {
        const id = JSON.parse(argsJson || '{}')?.id;
        return typeof id === 'string' ? id.trim() : '';
    } catch {
        return '';
    }
}

function pendingTurnCount() {
    return turnLog.filter(entry => entry.status === 'pending').length;
}

// A single shared status line, so it has to reflect every turn still running or the first one to
// finish would claim the session is idle while others are still streaming.
function updateStreamingStatus() {
    // The pause owns the status line while it is on: an answer still streaming behind it must not
    // rewrite it back to Listening.
    if (paused) {
        sendToRenderer('update-status', 'Paused');
        return;
    }

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
    saveConversationTurn(entry.contextText, entry.assistant, entry.seq);
}

async function runTurn(entry) {
    // Snapshot synchronously: turns dispatched while this one streams must not mutate its prompt.
    const messages = buildMessages(currentSystemPrompt, entry);
    // Roles only, never the text: the transcript is already reconstructible from the ASR events in the
    // same log, and this is the one line that says what actually went to the model.
    logTransportEvent('chat.request', { turnId: entry.seq, roles: messages.map(message => message.role) });

    try {
        let isFirst = true;
        const { text: fullText } = await requestChat(messages, text => {
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
        }, { thinking: briefThinkingEnabled });

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

// An answer that streams into the side pane instead of a bubble, and nothing about it is visible to the
// short chain: it reports only its own completion, so the status line keeps claiming the one response it
// always did. Both answers that live in the pane go through here — the second one a question earns, and
// the only one a screenshot gets — so a change to the streaming, the throttling, the knowledge tooling
// or the persistence reaches both.
//
// Deliberately not an async function: the prompt has to be built before the caller returns, exactly as
// in runTurn, so that two turns dispatched back to back both see a transcript that does not yet contain
// the other's answer. Calling an async function would do the same, but nothing here can be awaited.
function startDetailStream(turnEntry, { question, thinking }) {
    const entry = {
        detailId: ++detailSeq,
        turnSeq: turnEntry.seq,
        generation: turnEntry.generation,
        question,
        partial: '',
        assistant: null,
        status: 'pending',
        usedKnowledge: [],
        lastSentAt: 0,
        lastSentText: '',
    };

    const messages = buildMessages(currentDetailSystemPrompt, turnEntry);
    logTransportEvent('chat.request', { turnId: entry.turnSeq, detail: true, roles: messages.map(message => message.role) });

    detailLog.push(entry);
    if (detailLog.length > MAX_DETAIL_TURNS) detailLog = detailLog.slice(-MAX_DETAIL_TURNS);

    const hasKnowledge = detailKnowledgeEntries.length > 0;

    (async () => {
        try {
            let isFirst = true;
            const { text, finishReason, rounds } = await requestChat(
                messages,
                partial => {
                    entry.partial = partial;

                    if (isFirst) {
                        logTransportEvent('chat.first_token', { turnId: entry.turnSeq, detail: true });
                        entry.lastSentText = partial;
                        entry.lastSentAt = Date.now();
                        sendToRenderer('new-detail-response', {
                            detailId: entry.detailId,
                            turnSeq: entry.turnSeq,
                            question: entry.question,
                            text: partial,
                        });
                        isFirst = false;
                        return;
                    }

                    const now = Date.now();
                    if (now - entry.lastSentAt < STREAM_SEND_INTERVAL_MS) return;
                    entry.lastSentText = partial;
                    entry.lastSentAt = now;
                    sendToRenderer('update-detail-response', { detailId: entry.detailId, text: partial });
                },
                {
                    // No directory means no tool is declared at all, so the request is the plain one it
                    // has always been — an endpoint that does not support tools cannot even notice.
                    tools: hasKnowledge ? [KNOWLEDGE_TOOL_SPEC] : null,
                    maxToolRounds: hasKnowledge ? 1 : 0,
                    // Only ever needed alongside the tool: without a directory there is no second round.
                    followUpSystem: hasKnowledge ? currentDetailFollowUpSystemPrompt : null,
                    thinking,
                    executeTool: (name, argsJson) => {
                        const dir = getKnowledgeDir();

                        if (name === KNOWLEDGE_TOOL_NAME) {
                            const requested = parseKnowledgeId(argsJson);
                            if (requested) {
                                // Read here rather than through executeKnowledgeTool so that only a lookup
                                // that actually resolved is named in the pane as knowledge the answer rests
                                // on; the failures fall through to the same error text a bad call gets.
                                const result = readKnowledgeById(dir, requested);
                                if (!result.ok) return result.error;

                                if (!entry.usedKnowledge.includes(requested)) {
                                    entry.usedKnowledge.push(requested);
                                    sendToRenderer('detail-tool-used', { detailId: entry.detailId, id: requested });
                                }
                                return result.body;
                            }
                        }

                        return executeKnowledgeTool(name, argsJson, dir);
                    },
                }
            );

            entry.assistant = text.trim();
            entry.status = 'done';
            // The session may have been restarted, or replaced by another one, while this streamed. It
            // still has to finish quietly: sendToRenderer targets the first window whatever session it is
            // showing, so an unguarded completion would land in the next session's pane.
            if (entry.generation !== sessionGeneration) return;

            logTransportEvent('chat.completed', { turnId: entry.turnSeq, detail: true, rounds, finishReason });
            console.log('[Pipeline] detail response completed:', entry.turnSeq);

            // The last tokens may have been swallowed by the throttle window.
            if (text !== entry.lastSentText) {
                sendToRenderer('update-detail-response', { detailId: entry.detailId, text });
            }

            sendToRenderer('detail-response-complete', {
                detailId: entry.detailId,
                turnSeq: entry.turnSeq,
                question: entry.question,
                ok: true,
                error: '',
                usedKnowledge: entry.usedKnowledge,
                // A long answer is far likelier to reach the token cap than a short one, and the pane has
                // to be able to say so: silently cut-off text is worse than text that admits it was cut.
                truncated: finishReason === 'length',
            });

            // 落库用 entry.question 而不是 turnEntry.contextText：截图那一轮的 contextText 稍后会被摘要
            // 覆盖，而面板标题是固定的「对屏幕截图的作答」，两者从这一刻起就是两回事。
            if (entry.assistant) saveDetailTurn(entry.question, entry.assistant, entry.turnSeq, entry.usedKnowledge);
        } catch (error) {
            entry.status = 'failed';
            console.error('[Pipeline] detail error:', error);
            if (entry.generation !== sessionGeneration) return;

            // Carries the question as well: a request that failed before its first token never opened a
            // row in the pane, so the completion is what brings the failure into view.
            sendToRenderer('detail-response-complete', {
                detailId: entry.detailId,
                turnSeq: entry.turnSeq,
                question: entry.question,
                ok: false,
                error: error.message,
                usedKnowledge: [],
                truncated: false,
            });
        }
    })();

    return entry.detailId;
}

// The ordinary second answer: the same question the short chain just answered, expanded in the pane.
// A screenshot never comes through here — its answer is the only one that turn gets, so it is started
// below by startScreenshotAnswer instead of being paired with a short answer it does not have.
function runDetailTurn(shortEntry) {
    if (!detailModeEnabled) return;

    startDetailStream(shortEntry, { question: shortEntry.contextText, thinking: detailThinkingEnabled });
}

// 拍题的答案只进详情面板：图是一道题，答案是读的不是念的，不进对话记录。
// 同步开行有两个理由：thinking 可能几十秒不出第一个字，面板要立刻说明在等什么；detailId 必须先存在，
// clear-context 才能把下限抬到它之上。
// thinking 用截图自己的开关（默认关），不跟详情面板走：这是唯一带图片的请求，思考耗时算在客户端 120s
// 总超时里，一整道题加一张图能把预算烧完，最后一个字都回不来。
function startScreenshotAnswer(turnEntry) {
    const detailId = startDetailStream(turnEntry, {
        question: SCREENSHOT_ANSWER_QUESTION,
        thinking: screenshotThinkingEnabled,
    });

    sendToRenderer('new-detail-response', {
        detailId,
        turnSeq: turnEntry.seq,
        question: SCREENSHOT_ANSWER_QUESTION,
        text: '',
    });
}

// 与上面那条回答并发的第二个请求，也是对话记录里唯一留下痕迹的那个。它自成一个请求而不是回答的一步：
// 图里问的是什么要在下个问题之前变成文字，等回答就等于把摘要压在几十秒思考后面。
// 不带历史：问题就是图里那张纸上的东西，面试聊了什么不影响它。
async function runScreenshotSummary(entry, base64Data) {
    const messages = [
        { role: 'system', content: getScreenshotSummaryPrompt() },
        {
            role: 'user',
            content: [
                { type: 'text', text: '概括这张图片里的题目。' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } },
            ],
        },
    ];
    logTransportEvent('chat.request', { turnId: entry.seq, summary: true, roles: messages.map(message => message.role) });

    let line = SCREEN_FAILED_LINE;
    try {
        // The stream itself is not shown: this line replaces the placeholder in one piece when it is
        // done. The prompt asks for one to three sentences and thinking is off, so the cap every other
        // request uses is left alone here rather than narrowed to what a summary should cost.
        const { text } = await requestChat(messages, () => {}, { thinking: false });
        if (text.trim()) {
            line = `${SCREEN_PREFIX} ${text.trim()}`;
        }
    } catch (error) {
        console.error('[Pipeline] screenshot summary error:', error);
    }

    // The session may have been replaced while this was in flight, in which case the row and the context
    // text both belong to a transcript nobody is looking at any more.
    if (entry.generation !== sessionGeneration) return;

    // 从这一刻起，之后每个提示词都用这行文字代替那张图，所以这轮的 contextText 一开始就非空、也永远不为空。
    entry.contextText = line;
    sendToRenderer('transcription-final', { text: line, speaker: 'screen', blockId: entry.seq });
    // 摘要就作为一条普通对话记录落盘（没有精简回答，ai_response 为空）。详情面板那行是拍题自己的固定标题，
    // 两边从此不再互相改写。
    saveConversationTurn(line, '', entry.seq);
    logTransportEvent('chat.completed', { turnId: entry.seq, summary: true });

    // Nothing of the screenshot is pending in turnLog, so without this the status line would sit on
    // "Analyzing image..." for the rest of the session.
    updateStreamingStatus();
}

// Never awaited and never queued: the caller is the ASR callback and must stay responsive.
function dispatchTurn(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length < 2) return null;

    logTransportEvent('asr.turn_dispatched', { text: trimmed });
    // Whatever the candidate has said closes here, ahead of the question that interrupted it, so this
    // turn's prompt already knows it. The block is not cut short at any earlier point.
    commitCandidateSpeech();
    const entry = createTurn(trimmed, trimmed, 'conversation');
    runTurn(entry);
    // A sibling of runTurn, not a step inside it: runTurn builds its prompt synchronously, so by the time
    // this line runs both chains have snapshotted the same transcript.
    runDetailTurn(entry);
    updateStreamingStatus();
    return entry;
}

// A safety flush only: the server's VAD owns turn boundaries. Audio arriving proves nothing on its
// own — only a sentence event does, and those reset the countdown in handleAsrSentence. If the
// socket goes quiet with text pending, the final sentence it was waiting for is never coming.
function tickStreamWatchdog(source) {
    const state = streams[source];
    state.silenceMs += AUDIO_CHUNK_MS;

    if ((state.turnText || state.interimText) && state.silenceMs >= state.sentenceSilenceMs + IDLE_FLUSH_MARGIN_MS) {
        flushTurn(source);
    }
}

// The interviewer's recognizer owns the shared status line, since it is the one the session depends
// on. The candidate's runs alongside it and fails quietly: losing it costs context, not answers.
function startAsrClient(source) {
    const isInterviewer = source === INTERVIEWER;

    const client = createRealtimeAsr({
        language: toAsrLanguage(transcriptionLanguage),
        maxSentenceSilenceMs: streams[source].sentenceSilenceMs,
        onSentence: (text, sentenceEnd) => handleAsrSentence(text, sentenceEnd, source),
        onState: state => {
            if (!isInterviewer) return;
            // Nothing the socket does is worth announcing while the user has the audio paused.
            if (paused) return;
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
            // Nothing will ever finalize the text this stream was holding, and the speaker gate reads
            // it. Left behind, a dead interviewer socket would hold the microphone shut for the rest
            // of the session.
            streams[source].turnText = '';
            streams[source].interimText = '';

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
        state.blockId = 0;
        state.silenceMs = 0;
        state.resampleRemainder = Buffer.alloc(0);
    }
    candidateSpeech = [];
    // Starts over with turnSeq: the renderer empties its transcript before a session's audio flows,
    // so there is no row left for an id to collide with.
    candidateBlockId = 1;
    micGated = false;
    micLevelGated = false;
    micGateSideLoud = false;
    micGateSideSinceMs = 0;
    transcriptionLanguage = null;
    turnLog = [];
    turnSeq = 0;
    contextFloorSeq = 0;
    paused = false;
    // Cleared with the turn log, or a session opened after this one would start with the previous
    // session's detailed answers still pageable in the pane.
    detailLog = [];
    detailSeq = 0;
    sessionGeneration += 1;
}

function initializeChatSession(customPrompt, selectedLanguage) {
    sendToRenderer('session-initializing', true);

    closeLocalSession();
    currentSystemPrompt = getSystemPrompt(customPrompt);

    // Both the switch and the knowledge index are read once, here. The index is deliberately a snapshot
    // rather than a per-turn rebuild: it would cost a directory walk in front of every answer, and the
    // stale window is nil in practice, because the settings page that changes either one cannot be
    // reached from a live session. A stale id still cannot produce a wrong answer — the executor below
    // validates against the directory as it is at call time.
    const prefs = getPreferences();
    detailModeEnabled = prefs.detailMode !== false;
    detailKnowledgeEntries = detailModeEnabled ? listKnowledgeEntries(getKnowledgeDir()) : [];
    currentDetailSystemPrompt = getDetailSystemPrompt(customPrompt, formatKnowledgeSummary(detailKnowledgeEntries));
    // Passing an empty summary is what makes this the follow-up prompt: both the knowledge rule and the
    // index are conditioned on it, so this is the same prompt with neither.
    currentDetailFollowUpSystemPrompt = getDetailSystemPrompt(customPrompt, '');
    briefThinkingEnabled = prefs.briefThinking === true;
    detailThinkingEnabled = prefs.detailThinking !== false;
    screenshotThinkingEnabled = prefs.screenshotThinking === true;
    chatContextTurns = getChatContextTurns();

    transcriptionLanguage = selectedLanguage;

    // Each recognizer waits its own amount of silence before ending a sentence. The microphone gets a
    // longer one because the candidate stutters: a short wait would cut one answer into fragments.
    const maxSentenceSilenceMs = getMaxSentenceSilenceMs();
    const micMaxSentenceSilenceMs = getMicMaxSentenceSilenceMs();
    streams[INTERVIEWER].sentenceSilenceMs = maxSentenceSilenceMs;
    streams[CANDIDATE].sentenceSilenceMs = micMaxSentenceSilenceMs;

    micGateDb = getMicGateDb();
    micGateDwellMs = getMicGateDwellMs();
    console.log('[Pipeline] Initializing chat session:', {
        selectedLanguage,
        maxSentenceSilenceMs,
        micMaxSentenceSilenceMs,
        micGateDb,
        micGateDwellMs,
    });

    initializeNewSession(customPrompt);
    isLocalActive = true;

    // The ASR client's own state owns the status bar from here: Connecting... then Listening....
    sendToRenderer('session-initializing', false);
    startAsrClients();

    console.log('[Pipeline] Session initialized');
    return true;
}

function processLocalAudio(monoChunk24k, source = 'system') {
    if (!isLocalActive) return;

    // Paused: the frame is still forwarded, but as silence. The endpoint ends a task that hears
    // nothing for long enough, and a dead socket would have to reconnect in front of the first
    // question after the resume — so the traffic keeps the session warm and the user's audio never
    // reaches it as speech. The gate and the watchdog are skipped rather than fed: silence measures
    // as -inf dBFS and would open the gate, and there is no longer any text for a flush to rescue.
    if (paused) {
        const state = streams[source];
        if (!state || !state.asr) return;

        const pcm16k = resample24kTo16k(Buffer.alloc(monoChunk24k.length), state);
        if (pcm16k.length === 0) return;

        state.asr.sendAudio(pcm16k);
        return;
    }

    // Measured before the client check below: the loopback capture keeps delivering chunks even
    // after its recognizer gave up, and a gate that never saw a quiet chunk would stay on forever.
    if (source === INTERVIEWER) tickMicGate(pcmRmsDb(monoChunk24k));

    // The client is a pipe: audio goes straight to the recognizer. A stream with no client — the
    // candidate stream when no microphone is configured, or any stream whose recognizer gave up —
    // is dropped here, before the resampler, so its half-sample state stays untouched.
    const state = streams[source];
    if (!state || !state.asr) return;

    // Gated microphone audio becomes real silence rather than a dropped chunk: the server's VAD
    // needs frames to close the utterance the interviewer interrupted. Dropping them would leave
    // that half-sentence pending and merge it with whatever the user says once the gate lifts.
    const chunk = source === CANDIDATE && micGated ? Buffer.alloc(monoChunk24k.length) : monoChunk24k;

    const pcm16k = resample24kTo16k(chunk, state);
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
    currentDetailSystemPrompt = null;
    currentDetailFollowUpSystemPrompt = null;
    detailModeEnabled = false;
    detailKnowledgeEntries = [];
}

function isLocalSessionActive() {
    return isLocalActive;
}

// The sentence in flight is older than the pause and already on screen, so it is settled rather than
// dropped: left open, whatever is said after the resume would be spliced onto the half-sentence that
// preceded it in one bubble. Nothing is dispatched for it — it was not a finished question.
function suspendPendingText() {
    for (const source of [INTERVIEWER, CANDIDATE]) {
        const state = streams[source];
        if (!state.turnText && !state.interimText) continue;

        state.turnText = '';
        state.interimText = '';
        state.silenceMs = 0;
        sendBubble('transcription-final', source);
    }

    // Closed either way, so the next thing the candidate says opens a new bubble instead of growing
    // the one that was open when the pause began.
    candidateBlockId += 1;
}

function setPaused(value) {
    const next = Boolean(value);
    if (next === paused) return;

    paused = next;
    console.log('[Pipeline] Paused:', paused);

    if (paused) {
        suspendPendingText();
        sendToRenderer('update-status', 'Paused');
    } else if (isLocalActive) {
        sendToRenderer('update-status', 'Listening...');
    }
}

// The model's view of the session starts over here. Only the prompt is affected: turnLog keeps every
// entry, so the pending count, the prune and — through persistTurn — the history file are untouched.
// Audio in flight is deliberately left alone. Clearing a stream's pending text would make the bubble
// the user is watching shrink on its next update, which is the truncation this is meant to avoid.
function clearContext() {
    contextFloorSeq = turnSeq;
    console.log('[Pipeline] Context cleared at seq', contextFloorSeq);
    return { turnSeq, detailSeq };
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

async function sendLocalImage(base64Data) {
    if (!isLocalActive) {
        return { success: false, error: 'No active session' };
    }

    const requestContent = [
        { type: 'text', text: getScreenshotAnswerPrompt() },
        {
            type: 'image_url',
            image_url: {
                url: `data:image/jpeg;base64,${base64Data}`,
            },
        },
    ];

    // A screenshot is not the interviewer speaking, but it is still a new turn: the block has to close
    // here too, or this prompt would leave out everything the candidate has said since the last question.
    commitCandidateSpeech();
    // Opened with a placeholder rather than the prompt: userContent falls back to requestContent when a
    // screen turn's contextText is empty, and for a screenshot that fallback is the whole base64 image,
    // replayed into every later prompt. A screenshot turn's contextText is never empty, from here on.
    const entry = createTurn(requestContent, SCREEN_PENDING_LINE, 'screen');
    // Nothing ever streams into this turn: the answer it would hold lives in the pane, and the summary
    // it waits for is a request of its own. Left pending it would claim a response is on the way forever.
    entry.status = 'done';

    // The transcript says what the picture asked, in words: the row is opened now, where the image
    // arrived, and rewritten in place when the summary comes back — an image taken while the interviewer
    // is still talking must not have its line pushed below the question that followed it.
    sendToRenderer('transcription-update', { text: SCREEN_PENDING_LINE, speaker: 'screen', blockId: entry.seq });
    sendToRenderer('update-status', 'Analyzing image...');

    startScreenshotAnswer(entry);
    // Never awaited, and started before the answer so the two requests overlap: the summary is one small
    // request with thinking off, the answer a long one with it on.
    runScreenshotSummary(entry, base64Data);

    return { success: true, model: getChatModel(), turnId: entry.seq };
}

module.exports = {
    initializeChatSession,
    processLocalAudio,
    closeLocalSession,
    isLocalSessionActive,
    setPaused,
    clearContext,
    sendLocalText,
    sendLocalImage,
};
