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
// 两条链各自是否让模型先思考。本应用从不显示推理过程，思考就是第一个可见 token 前的纯等待：详细面板读的
// 是两次提问之间的空档，值得；马上要照读的精简那句不值得。
let briefThinkingEnabled = false;
let detailThinkingEnabled = true;
// 截图自己的开关。它一度被硬编码成开：推理耗时算在客户端 120s 总超时里，而这条链专治的一整道题截图能把
// 预算全烧在推理上，最后一个字都回不来。
let screenshotThinkingEnabled = false;
// 会话开始时那份条目，既用来生成提示词里的索引，也用来决定值不值得声明工具。只有**索引**是快照——执行器
// 是现读目录的，所以这里过期最坏只是查不到，不会变成错误的事实。
let detailKnowledgeEntries = [];
let isLocalActive = false;
let transcriptionLanguage = null;

// 两路采集各有自己的识别器：扬声器那路转录面试官，并且只有它会产生要作答的轮次；麦克风那路转录候选人，
// 说的话永远只是背景。两边算法相同，各一个 socket。
const INTERVIEWER = 'system';
const CANDIDATE = 'mic';

// 正在从流式句子拼装的那一轮文本。服务端会随听到的更多而改写未定稿的句子，所以未提交的尾巴单独存，只在
// 定稿或被空闲兜底救回时并进去。
//
// 按流独立而非共用：两路写同一个缓冲会把两句话拼成一整轮；重采样剩下的半个采样点同理只属于一路。
function createStreamState() {
    return {
        asr: null,
        turnText: '',
        interimText: '',
        silenceMs: 0,
        resampleRemainder: Buffer.alloc(0),
        // 服务端在这路音频上等多久静音才结束一句。会话开始时按声源各自设定并交给该路的识别器，这样服务端
        // 自己的界限和下面的客户端兜底不会对不上。
        sentenceSilenceMs: 0,
        // 在途句子属于哪个候选人气泡，没有时为 0。只在候选人那路有意义，见 candidateBlockId。
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

// 上一次派发轮次之后候选人说过的话，按识别顺序。碎片在这里累积，下一个轮次创建时整块提交为一条背景记录：
// 一个回答必须保持是一条记录——服务端会把一个回答切成很多片段，逐片段记下来最后只剩最近几秒。
let candidateSpeech = [];

// candidateSpeech 正在累积的那个块，也是它在渲染端唯一的身份。渲染端没法像面试官那样用「最后一行」来认
// 候选人气泡：候选人句子还没定稿时识别出的一句提问会插在气泡下面，而定稿时还要找回同一个气泡改写。一句提
// 问就结束这个块，所以候选人接下来说的话会开一个新气泡。
let candidateBlockId = 1;

// 每个轮次在提问被识别的瞬间就派发，哪怕前面的回答还在流：等上一个回答落地会让新回答晚到没用。于是轮次
// 并发运行、乱序完成，下面的日志就是提示词上下文与历史顺序唯一的真相来源。给模型看多少由「上下文轮数」
// 设置决定，和提示词一样在会话开始时快照。
const DEFAULT_CHAT_CONTEXT_TURNS = 15;
let chatContextTurns = DEFAULT_CHAT_CONTEXT_TURNS;
// token 一次一个 IPC 消息到达，而渲染端每收一条都要重新解析整段 markdown，所以按轮限流把一阵 token 压成
// 几次重绘。
const STREAM_SEND_INTERVAL_MS = 40;

// 截图是面试官写在屏幕上的一道题，所以它带着自己的标签进上下文：模型看到的是一串 user 消息，否则分不清
// 一张图和一个口头提问。文本本身是摘要请求的结果，也是这张图在后续任何提示词里唯一的痕迹——它的回答只
// 显示一次、从不回放，base64 根本不进上下文。
//
// 写入用的标签和**回放**用的标签故意不同：对话记录里用短的那个（行上显示的就是它），提示词里用长的那个，
// 免得一整道题干被读成一件待办的事。其他轮次都带说话人标签、且后面跟着模型写过的回答；而回答从不回放，
// 截图轮就是唯一一条后面什么都没有的 user 消息，不带标签就会被读成「用户刚问了这个」，模型转而去答它，
// 而不是真正接着问的那个问题。
const SCREEN_PREFIX = '[屏幕截图]';
// 正在作答的那一轮带的标签。没有它就只剩当前这张图在提示词里毫无标签——它是发给助手的一个请求而不是谁
// 说的话，本来就拿不到说话人标签——上下文规则就会越过它，去答之前口头问过的那句。两个标签在 CONTEXT_RULE
// 里一起被点名，面试官的两个也是。
const SCREEN_CONTEXT_PREFIX = '[屏幕共享的题目（已回答，仅参考）]';
const SCREEN_PENDING_LINE = `${SCREEN_PREFIX} （识别中…）`;
const SCREEN_FAILED_LINE = `${SCREEN_PREFIX} （图片内容识别失败）`;
// 拍题在详情面板里的固定标题。摘要只走对话记录，面板用它自己的这行标题，两者不再互相改写。
const SCREENSHOT_ANSWER_QUESTION = '对屏幕截图的作答';
// 会话还没开始时（比如手动发消息）没有系统提示词可用，兜底一行。
const DEFAULT_SYSTEM_PROMPT = '你是一名乐于助人的助手。';

let turnLog = [];
let turnSeq = 0;
// 会话重置时自增。比会话活得久的轮次不许写进下一个会话，而请求从不中断。
let sessionGeneration = 0;

// 给模型看的是 turnLog 里这个 seq 之后的部分。清空上下文把下限抬到当前 turnSeq，于是提示词空了而日志
// 本身没动：pruneTurnLog、待处理计数和 persistTurn 读的仍然是日志，写历史文件的也是 persistTurn。只有
// 提示词重来。
let contextFloorSeq = 0;

// 用户的暂停开关，也是 processLocalAudio 那串门槛里的又一道。置上后帧变成静音、服务端的句子事件被丢弃，
// 所以暂停后说的话既进不了字幕也进不了轮次——而 socket 在后面照旧开着保温。
let paused = false;

// 详细回答，与 turnLog 完全分开记。后续每个功能只读其中一份日志，两边绝不能看到对方的记录：详细记录混进
// turnLog 会被回放进对话上下文、被状态行算成又一个待处理回答、被 pruneTurnLog 提前截掉、被渲染端多开一
// 个气泡。留着它只为让面板能往回翻看整场会话。
let detailLog = [];
let detailSeq = 0;
const MAX_DETAIL_TURNS = 30;

function getKnowledgeDir() {
    return getPreferences().knowledgeDir || '';
}

// 轮次由服务端的句子事件拼成，客户端不分析音频。定稿的句子当场结束一轮，所以没有客户端静置窗——在最后一
// 个定稿上开的窗会在说话人还在说时就过期。
//
// 每个句子事件都会重置这个倒计时（见 handleAsrSentence）。socket 静了这么久而文本还挂着，说明那一句定稿
// 不会来了，这轮照样冲掉。它由该流自己的 max_sentence_silence 推出，所以一定比后者长。
const AUDIO_CHUNK_MS = 100; // 必须与 renderer.js 的 AUDIO_CHUNK_DURATION 一致
const IDLE_FLUSH_MARGIN_MS = 1000;

// 说话人闸门。用户不戴耳机，面试官的声音会进麦克风，候选人的那一栏就会跟着复读。回环电平高于 micGateDb
// 期间麦克风被静音。电平必须在阈值同侧保持 micGateDwellMs 才翻，这样单个尖峰或两个词之间的停顿都不会在
// 一句话中间把麦克风切来切去。两个值都来自设置页，这里的数字只是会话开始前的兜底。
//
// 电平闸门有它看不见的洞：提问开始时得等停顿攒够才关上，而话里的任何一段长停顿又会把它重新打开。这两处
// 都会在面试官还在说话时放麦克风过去，把面试官自己的话（或被截断回答的尾巴）作为碎片落进候选人那一栏。
// 所以只要扬声器那路的识别器还有没定稿的文本，闸门就一并关着：有在途句子就说明说话人正说到一半，不管电
// 平怎样。
let micGateDb = -45;
let micGateDwellMs = 300;
let micLevelGated = false;
let micGated = false;
let micGateSideLoud = false;
let micGateSideSinceMs = 0;

// 小端 int16 块的 dBFS，用与设置页电平表相同的 20*log10(rms) 口径，这样用户在设置里填的阈值在这里意思
// 一样。
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

// ASR 端点要的是裸 ISO-639-1 代码，而偏好里存的是 BCP-47 地区码。
function toAsrLanguage(locale) {
    if (!locale) {
        return null;
    }

    const primary = String(locale).split('-')[0].toLowerCase();
    return primary === 'cmn' ? 'zh' : primary;
}

function mergeTurnText(state) {
    if (state.turnText && state.interimText) return `${state.turnText} ${state.interimText}`;
    return state.turnText || state.interimText;
}

// 某一路的气泡此刻该显示什么。候选人显示的是整个未关闭的块，而不只是在途那一句：磕绊一下会让屏幕上那段
// 继续变长，而不是另开一个气泡；这个块被提交时的文本也正好就是显示出来的这段。
function bubbleText(source) {
    const text = mergeTurnText(streams[source]);
    return source === CANDIDATE ? candidateSpeech.join('') + text : text;
}

// 候选人说的话短到这个程度就丢弃而不是并入：识别后，从闸门漏过去的词、一声咳嗽、一个走神的「嗯」都长得
// 这样，而一个词的气泡纯属噪音。它从不进块，所以既不上屏也进不了提示词。面试官那路不受此限——再短的提
// 问也是提问。
const MIN_CANDIDATE_CHARS = 4;

// 所有气泡唯一的出口，所以上面那个下限只在一个地方生效。开着的块本身一定够长，所以只有背后没有块的短行
// 才会被压掉——而且每次更新都要压，不只是定稿那次，否则中间态会留下一个再也无人替换的气泡。
function sendBubble(channel, source) {
    const text = bubbleText(source);
    if (source === CANDIDATE && text.length < MIN_CANDIDATE_CHARS) return;
    const payload = { text, speaker: speakerFor(source) };
    if (source === CANDIDATE) payload.blockId = streams[CANDIDATE].blockId;
    sendToRenderer(channel, payload);
}

function handleAsrSentence(text, sentenceEnd, source) {
    // 服务端为暂停之前收到的音频定稿的句子，不是用户想留下的。在这里丢而不是在 flushTurn 里，顺带也就
    // 不会派发任何轮次。
    if (!isLocalActive || paused || !text) return;

    const sentence = text.trim();
    if (!sentence) return;

    const state = streams[source];

    // 有事件就说明服务端还听得见人声，空闲兜底不能触发。长提问期间中间态文本会持续到达，这正是它不被切成
    // 两半的原因。
    state.silenceMs = 0;

    // 句子钉在它开始时的那个块上，而不是结束时当前的那个：提问可能落在句子中间，而定稿后的文本仍然属于它
    // 的中间态文本已经开好的那个气泡。同一块里后面的句子钉的是同一个 id，因为只有提问会推进计数器。
    if (source === CANDIDATE && !state.turnText && !state.interimText) state.blockId = candidateBlockId;

    if (!sentenceEnd) {
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

// 闸门刚关上，候选人正说到一半被切断。把现有的显示出来，但不定稿：服务端手里还有已经收到的音频，会为这
// 句话自己发来定稿，那次会改写同一个开着的行，文本刚好只被记录一次。
function interruptCandidate() {
    const text = bubbleText(CANDIDATE).trim();
    if (text.length < MIN_CANDIDATE_CHARS) return;

    console.log('[Pipeline] Candidate interrupted:', text);
    sendBubble('transcription-update', CANDIDATE);
}

// 每个回环音频块调一次。`loud` 是量出来的而不是推出来的：电平必须在阈值同侧保持够整个 dwell 才改变判定，
// 这样阈值附近的抖动才不会把一句话切成碎片。
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

// 闸门本体，也是它唯一会动的地方。关着的理由有两个：电平说扬声器正响，或者扬声器那路的识别器还握着没定
// 稿的句子——只看电平会在提问内部的停顿里放麦克风过去，未定稿的句子不会。两者都为假之后的下一个音频块
// 重新打开。
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

    // 没定稿的尾巴也比整句丢掉强。
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

        // 什么都不派发：候选人说的话是下一个回答的背景，而不是要回答的问题。它并入开着的块，这里不给块
        // 设上限——块由下一个轮次整体关闭（见 commitCandidateSpeech）。
        console.log('[Pipeline] Candidate speech:', text);
        candidateSpeech.push(text);
        // 整体重发而不是只发这段碎片：气泡就是这个块，只发片段会让用户已经读到的文字可见地缩回去。块只
        // 由上面 push 的碎片构成，从不从气泡反向拼，所以那个长度下限在这里咬不到。
        sendBubble('transcription-final', source);
        return;
    }

    console.log('[Pipeline] Turn dispatched:', text);
    sendToRenderer('transcription-final', { text, speaker: speakerFor(source) });
    dispatchTurn(text);
}

// 已定稿的轮次只剩下提示词上下文的作用，所以长过 buildMessages 会读到的部分就可以丢掉。待处理的留着：
// 闭包还在引用它们。
function pruneTurnLog() {
    if (turnLog.length <= chatContextTurns * 3) return;

    const settled = turnLog.filter(entry => entry.status !== 'pending').slice(-chatContextTurns * 2);
    const pending = turnLog.filter(entry => entry.status === 'pending');
    turnLog = [...settled, ...pending].sort((a, b) => a.seq - b.seq);
}

// `speaker` 决定 buildMessages 在文本前贴哪个标签。默认面试官，因为手动输入的问题也按面试官回放——API
// 只认 system/user/assistant 三种角色、会丢掉 OpenAI 风格的 `name` 字段，所以谁说的必须写进正文里。
function createTurn(requestContent, contextText, persistKind, speaker = 'interviewer') {
    const entry = {
        seq: ++turnSeq,
        generation: sessionGeneration,
        // 截图轮发的是多模态数组；之后每一轮只需要它的提示词文本。
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

// 把候选人开着的那个块整体关闭成一轮。它在进入下一个轮次时提交，而不是在请求时现读，所以位置和 seq 是固定
// 的：打断候选人的那个轮次的提示词看到的是已完成的历史，同时还在流的别的回答也没法把它挪位。
function commitCandidateSpeech() {
    // 即使没东西可提交，块也算结束了：被这句提问截断的句子可能还在路上，而候选人接下来的话无论如何都属
    // 于新气泡。在途的句子保留它当时钉下的 id，所以它的定稿仍能找到自己的气泡。
    candidateBlockId += 1;

    if (!candidateSpeech.length) return;

    const text = candidateSpeech.join('');
    candidateSpeech = [];

    // 它一产生就是已定稿的：背后没有请求，也永远不会有东西流进来，所以不能算待处理，否则状态行会一直声称
    // 有回答在路上。
    const entry = createTurn(text, text, null, 'candidate');
    entry.status = 'done';

    // 只为了历史页而写。与提问不同，这一轮永远得不到回答，所以它没有别的持久化：没有它，存下来的会话就
    // 还原不出候选人这半边对话，而那是实时字幕显示的一半内容。
    saveCandidateSpeech(text, entry.seq);
}

// 谁说的这句话——每一行都是 `user` 消息，不标就分不清两个说话人。加方括号并放在行首，读起来才是标签而
// 不是正文。
//
// 面试官的话带两种标签，因为只有其中一句还在等回答：正在请求的这一轮，和之前问过的全部。两个都点名，与
// 下面截图那两个标签是同一个守卫，理由也一样——已经答过的问题在提示词里没有任何说明时会被读成一件待办
// 的事，模型于是再答一遍。候选人的话从不带「当前」标签：他说的话没有一句是给这个助手的提问，都是他已经
// 说过的内容，所以无论排在哪里都是背景。
const SPEAKER_TAG = { interviewer: '[面试官（已回答，仅参考）:]', candidate: '[面试者:]' };
const CURRENT_QUESTION_TAG = '[面试官（当前问题，请作答）:]';

// 历史把一轮还原成文本——截图轮的提示词文本代替它的图片，createTurn 本来就把这份存在 contextText 里——
// 只有正在请求的那一轮保留创建它的全部内容。截图轮是发给助手的请求而不是谁说的话，所以不带说话人标签：
// 回放的那些用 SCREEN_CONTEXT_PREFIX，两个标签在 CONTEXT_RULE 里一起点名。
function userContent(entry, isCurrent = false) {
    const content = isCurrent ? entry.requestContent : entry.contextText || entry.requestContent;

    if (entry.persistKind === 'screen') {
        // 正在作答的那一轮带的是图本身，所以标签加在它旁边的文本段上而不是替代它：图才是问题，标签负责
        // 说明这一点。
        if (isCurrent) {
            let tagged = false;
            return content.map(part => {
                if (tagged || part.type !== 'text') return part;
                tagged = true;
                return { ...part, text: `${part.text}` };
            });
        }
        // 回放的轮次带的是转录文本而不是图，并改标成一条历史记录。
        if (typeof content !== 'string' || !content.startsWith(SCREEN_PREFIX)) return content;
        return `${SCREEN_CONTEXT_PREFIX} ${content.slice(SCREEN_PREFIX.length).trim()}`;
    }
    // 只有正在请求的这一轮可能是此刻要回答的问题：日志里其他每一条要么是更早的提问，要么是候选人说过
    // 的话，到这时都只是背景。
    const tag = isCurrent && entry.speaker === 'interviewer' ? CURRENT_QUESTION_TAG : SPEAKER_TAG[entry.speaker];
    return `${tag} ${content}`;
}

// 只拼对话里用户的那一侧：面试官的提问和候选人自己的话，按顺序。过去的回答故意不放进来。模型已经看得见
// 自己被问过什么，而回放它自己以前的回答会把后面每一个都往上一句的措辞上带——追问时最明显，回来的成了
// 上一个回答的改写。
//
// 结果是一串连续的 `user` 消息，API 接受这种形式；最后一条永远是此刻正在作答的问题。
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

// 模型要的 id，没有可用的就返回 ''。与 executeKnowledgeTool 分开是因为下面成功那条路必须知道读的是**哪
// 一条**，才能在面板上点名。
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

// 状态行只有一条，所以它必须反映所有还在跑的轮次，否则最先结束的那个会在别人还在流的时候就宣布会话空闲。
function updateStreamingStatus() {
    // 暂停期间状态行归暂停所有：后面还在流的回答不许把它改回 Listening。
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
    // 同步快照：这一轮流式期间派发的其他轮次不能改动它的提示词。
    const messages = buildMessages(currentSystemPrompt, entry);
    // 只记角色不记文本：字幕本来就能从同一份日志里的 ASR 事件重建，而这行说明的正是实际发给模型的东西。
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

        // 最后几个 token 可能被限流窗口吞掉了。
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

        // 在第一个 token 之前就失败的请求没有气泡可以报告。
        if (!entry.lastSentText) {
            sendToRenderer('new-response', { turnId: entry.seq, text: `Error: ${error.message}` });
        }
        sendToRenderer('response-complete', { turnId: entry.seq });
        sendToRenderer('update-status', 'Chat error: ' + error.message);
        return;
    }

    updateStreamingStatus();
}

// 流进侧面板而不是气泡的那个回答，精简链完全看不到它：它只报告自己完成，所以状态行仍旧只声称那一个回答。
// 面板里的两种回答都走这里——提问得到的第二个回答，以及截图唯一得到的那个——所以流式、限流、知识库工具
// 和落盘上的改动同时作用于两者。
//
// 故意不是 async 函数：提示词必须在调用方返回前建好，与 runTurn 一样，这样背靠背派发的两个轮次看到的都是
// 还不包含对方回答的字幕。写成 async 也一样，但这里没有任何东西可以 await。
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
                    // 没有目录就完全不声明工具，这个请求与从前那个普通请求一模一样——不支持工具的服务端
                    // 根本察觉不到。
                    tools: hasKnowledge ? [KNOWLEDGE_TOOL_SPEC] : null,
                    maxToolRounds: hasKnowledge ? 1 : 0,
                    // 只与工具配套使用：没有目录就没有第二轮。
                    followUpSystem: hasKnowledge ? currentDetailFollowUpSystemPrompt : null,
                    thinking,
                    executeTool: (name, argsJson) => {
                        const dir = getKnowledgeDir();

                        if (name === KNOWLEDGE_TOOL_NAME) {
                            const requested = parseKnowledgeId(argsJson);
                            if (requested) {
                                // 在这里直接读而不是走 executeKnowledgeTool，是为了只有真正查到的条目才会
                                // 在面板里被标成这条回答所依据的知识；失败的情况走的是和非法调用同样的
                                // 错误文本。
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
            // 这段流式期间会话可能被重启或被另一个会话取代。它仍然必须安静地结束：sendToRenderer 总是发
            // 给第一个窗口，不管那窗口在显示哪个会话，所以没有守卫的完成事件会落进下一个会话的面板。
            if (entry.generation !== sessionGeneration) return;

            logTransportEvent('chat.completed', { turnId: entry.turnSeq, detail: true, rounds, finishReason });
            console.log('[Pipeline] detail response completed:', entry.turnSeq);

            // 最后几个 token 可能被限流窗口吞掉了。
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
                // 长回答比短回答更容易撞上 token 上限，而面板必须说得出来：悄悄被截断的文本比承认自己
                // 被截断的文本更糟。
                truncated: finishReason === 'length',
            });

            // 落库用 entry.question 而不是 turnEntry.contextText：截图那一轮的 contextText 稍后会被摘要
            // 覆盖，而面板标题是固定的「对屏幕截图的作答」，两者从这一刻起就是两回事。
            if (entry.assistant) saveDetailTurn(entry.question, entry.assistant, entry.turnSeq, entry.usedKnowledge);
        } catch (error) {
            entry.status = 'failed';
            console.error('[Pipeline] detail error:', error);
            if (entry.generation !== sessionGeneration) return;

            // 也带上问题：在第一个 token 前就失败的请求从没在面板里开出过一行，所以这个完成事件才是把失
            // 败带进视野的东西。
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

// 常规的第二个回答：精简链刚答过的同一个问题，在面板里展开。截图从不走这里——它的回答是那一轮唯一的
// 回答，所以由下面的 startScreenshotAnswer 启动，而不是硬配一个它并不存在的精简回答。
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
        // 流本身不显示：完成后这行整块替换掉占位符。提示词只要一到三句话且关掉了思考，所以这里沿用其他
        // 请求一样的上限，不去按摘要该花多少再收窄一次。
        const { text } = await requestChat(messages, () => {}, { thinking: false });
        if (text.trim()) {
            line = `${SCREEN_PREFIX} ${text.trim()}`;
        }
    } catch (error) {
        console.error('[Pipeline] screenshot summary error:', error);
    }

    // 这期间会话可能已被替换，那这一行和上下文文本都属于一份没人在看的字幕了。
    if (entry.generation !== sessionGeneration) return;

    // 从这一刻起，之后每个提示词都用这行文字代替那张图，所以这轮的 contextText 一开始就非空、也永远不为空。
    entry.contextText = line;
    sendToRenderer('transcription-final', { text: line, speaker: 'screen', blockId: entry.seq });
    // 摘要就作为一条普通对话记录落盘（没有精简回答，ai_response 为空）。详情面板那行是拍题自己的固定标题，
    // 两边从此不再互相改写。
    saveConversationTurn(line, '', entry.seq);
    logTransportEvent('chat.completed', { turnId: entry.seq, summary: true });

    // 截图轮在 turnLog 里没有任何待处理的东西，不调这一下状态行会卡在「Analyzing image...」直到会话结束。
    updateStreamingStatus();
}

// 从不 await、从不排队：调用方是 ASR 回调，必须保持响应。
function dispatchTurn(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length < 2) return null;

    logTransportEvent('asr.turn_dispatched', { text: trimmed });
    // 候选人说过的话在这里关闭，排在这个打断它的提问之前，所以这一轮的提示词已经知道它了。块不会在更早
    // 的地方被截断。
    commitCandidateSpeech();
    const entry = createTurn(trimmed, trimmed, 'conversation');
    runTurn(entry);
    // 与 runTurn 平级而不是它内部的一步：runTurn 同步建好提示词，所以走到这行时两条链已经快照了同一份
    // 字幕。
    runDetailTurn(entry);
    updateStreamingStatus();
    return entry;
}

// 只是兜底：轮次边界归服务端的 VAD 管。音频到达本身说明不了什么——只有句子事件算数，而它会重置
// handleAsrSentence 里的倒计时。socket 静下来而文本还挂着，说明它在等的那句定稿不会来了。
function tickStreamWatchdog(source) {
    const state = streams[source];
    state.silenceMs += AUDIO_CHUNK_MS;

    if ((state.turnText || state.interimText) && state.silenceMs >= state.sentenceSilenceMs + IDLE_FLUSH_MARGIN_MS) {
        flushTurn(source);
    }
}

// 共用的状态行归面试官那路的识别器，因为会话依赖的是它。候选人那路并行运行且安静地失败：丢了它损失的
// 是背景，不是回答。
function startAsrClient(source) {
    const isInterviewer = source === INTERVIEWER;

    const client = createRealtimeAsr({
        language: toAsrLanguage(transcriptionLanguage),
        maxSentenceSilenceMs: streams[source].sentenceSilenceMs,
        onSentence: (text, sentenceEnd) => handleAsrSentence(text, sentenceEnd, source),
        onState: state => {
            if (!isInterviewer) return;
            // 用户暂停音频期间，socket 做什么都不值得播报。
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
            // ASR 客户端内部的重连退避已经用尽，这一路没有识别器了。会话继续，错误照报；音频被丢弃而不
            // 是送进一个死 socket。此时 socket 已经不在了。
            console.error(`[Pipeline] Streaming ASR failed (${source}):`, error.message);
            streams[source].asr = null;
            // 这一路挂着的文本再也不会有人来定稿，而说话人闸门会读它。留着的话，一个死掉的面试官 socket
            // 会把麦克风关到会话结束。
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

    // 'none' 是设置页里「不用麦克风」的显式选择，也是唯一会关掉候选人那路的东西：两条采集不再是二选一，
    // 所以不管麦克风下拉框选了什么，扬声器那路都照跑。
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
    // 跟着 turnSeq 一起从头开始：渲染端在会话音频流入之前会清空字幕，没有留下任何行会跟 id 撞上。
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
    // 与轮次日志一起清掉，否则之后新开的会话一上来还能在面板里翻到上一个会话的详细回答。
    detailLog = [];
    detailSeq = 0;
    sessionGeneration += 1;
}

function initializeChatSession(customPrompt, selectedLanguage) {
    sendToRenderer('session-initializing', true);

    closeLocalSession();
    currentSystemPrompt = getSystemPrompt(customPrompt);

    // 开关和知识库索引都在这里一次性读好。索引故意是快照而不是每轮重建：那会给每个回答前面加一次目录
    // 遍历，而实际上没有过期窗口——能改动这两者的设置页在会话进行中到不了。就算 id 过期也答不错，下面
    // 的执行器会按调用时刻的目录校验。
    const prefs = getPreferences();
    detailModeEnabled = prefs.detailMode !== false;
    detailKnowledgeEntries = detailModeEnabled ? listKnowledgeEntries(getKnowledgeDir()) : [];
    currentDetailSystemPrompt = getDetailSystemPrompt(customPrompt, formatKnowledgeSummary(detailKnowledgeEntries));
    // 传空摘要就是追问用的那份提示词：知识库规则和索引都以此为前提，所以这就是两样都没有的同一份提示词。
    currentDetailFollowUpSystemPrompt = getDetailSystemPrompt(customPrompt, '');
    briefThinkingEnabled = prefs.briefThinking === true;
    detailThinkingEnabled = prefs.detailThinking !== false;
    screenshotThinkingEnabled = prefs.screenshotThinking === true;
    chatContextTurns = getChatContextTurns();

    transcriptionLanguage = selectedLanguage;

    // 两个识别器各自等不同的静音时长才结束一句。麦克风那路等得更久，因为候选人会磕绊：等太短会把一个
    // 回答切成好几段。
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

    // 从这里起状态栏归 ASR 客户端自己的状态管：先是 Connecting... 然后 Listening...。
    sendToRenderer('session-initializing', false);
    startAsrClients();

    console.log('[Pipeline] Session initialized');
    return true;
}

function processLocalAudio(monoChunk24k, source = 'system') {
    if (!isLocalActive) return;

    // 暂停时帧照旧转发，只是内容是静音。端点在听不到声音足够久之后会结束任务，而一个死掉的 socket 得在
    // 恢复后的第一个问题前面重连——所以这些流量让会话保持热着，而用户的音频从不作为语音到达它。闸门和
    // 看门狗是跳过而不是喂给它们：静音量出来是 -inf dBFS，会把闸门打开，而且已经没有文本需要兜底冲掉。
    if (paused) {
        const state = streams[source];
        if (!state || !state.asr) return;

        const pcm16k = resample24kTo16k(Buffer.alloc(monoChunk24k.length), state);
        if (pcm16k.length === 0) return;

        state.asr.sendAudio(pcm16k);
        return;
    }

    // 在下面那道客户端检查之前先量：回环采集即使识别器已经放弃也照旧送块，而一个从没见过安静块的闸门
    // 会永远开着。
    if (source === INTERVIEWER) tickMicGate(pcmRmsDb(monoChunk24k));

    // 客户端是根管子：音频直接进识别器。没有客户端的流——没配麦克风时的候选人那路，或者任何识别器已放
    // 弃的流——在这里就丢掉，赶在重采样之前，好让它那半个采样点的状态保持不动。
    const state = streams[source];
    if (!state || !state.asr) return;

    // 被闸门拦下的麦克风音频变成真正的静音而不是直接丢块：服务端的 VAD 需要帧才能关掉面试官打断的这句
    // 话。丢掉的话这半句会一直挂着，等闸门抬起后和用户接下来说的话并到一起。
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

// 在途的那句比暂停更早、且已经在屏幕上，所以定稿它而不是丢掉：开着不管的话，恢复后说的话会被并到它前
// 面那半句上，挤在同一个气泡里。不为它派发任何轮次——它不是一个问完的问题。
function suspendPendingText() {
    for (const source of [INTERVIEWER, CANDIDATE]) {
        const state = streams[source];
        if (!state.turnText && !state.interimText) continue;

        state.turnText = '';
        state.interimText = '';
        state.silenceMs = 0;
        sendBubble('transcription-final', source);
    }

    // 无论如何都关闭，这样候选人接下来说的话会开一个新气泡，而不是继续长暂停开始时那个开着的。
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

// 模型看到的会话从这里重新开始。受影响的只有提示词：turnLog 保留每一条记录，所以待处理计数、裁剪和
// （经由 persistTurn 的）历史文件都不受影响。在途音频故意不碰：清掉某一路挂着的文本会让用户正看着的气泡
// 在下一次更新时缩短，而这正是这里要避免的截断。
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

    // 发完就返回：手动输入的问题不该等一个还在流的回答，而失败会经由 runTurn 变成错误气泡，而不是返回值。
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

    // 截图不是面试官在说话，但它仍然是一个新轮次：块也得在这里关闭，否则这个提示词会漏掉最后一个提问
    // 之后候选人说过的所有话。
    commitCandidateSpeech();
    // 先用占位符开行而不是用提示词：截图轮的 contextText 为空时 userContent 会退回 requestContent，而
    // 对截图来说那个退路就是整张 base64 图，会被回放进之后每一个提示词。从这里起，截图轮的 contextText
    // 永不为空。
    const entry = createTurn(requestContent, SCREEN_PENDING_LINE, 'screen');
    // 这一轮永远不会有东西流进来：它本该装着的回答在面板里，而它等的摘要是另一个独立请求。留在待处理状态
    // 会永远声称有回答在路上。
    entry.status = 'done';

    // 字幕要用文字说出图里问的是什么：行在图到达时就开好，摘要回来时原地改写——在面试官还在说话时拍的图，
    // 它的那行不能被挤到后面那个提问的下面。
    sendToRenderer('transcription-update', { text: SCREEN_PENDING_LINE, speaker: 'screen', blockId: entry.seq });
    sendToRenderer('update-status', 'Analyzing image...');

    startScreenshotAnswer(entry);
    // 不 await，而且先于回答启动，让两个请求重叠：摘要是关掉思考的一个小请求，回答是开着思考的一个长请求。
    runScreenshotSummary(entry, base64Data);

    return { success: true, model: getChatModel(), turnId: entry.seq };
}

module.exports = {
    initializeChatSession,
    processLocalAudio,
    closeLocalSession,
    setPaused,
    clearContext,
    sendLocalText,
    sendLocalImage,
};
