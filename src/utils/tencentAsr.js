const { DEFAULT_CONFIG } = require('../defaults');
// 腾讯云实时语音识别（WebSocket，标准版，非声纹）。与 bailianAsr 对外接口完全一致，只把实时 PCM 流变成
// 一句一句的话：不认识轮次也不认识模型。
//
// 与百炼最大的不同是鉴权与握手：腾讯云把签名放在 URL 的 query 里（HMAC-SHA1 后 Base64 再 URL 编码），
// 没有 Authorization 头，也就没有 run-task/task-started 这一来一回——连上时服务端直接回一条 code 为 0 的
// 确认消息，之后才开始收发音频。
//
// 识别结果用 slice_type 标记进度：0 一句的开始、1 中间态、2 稳定定稿。0/1 交给调用方当临时文本，2 当定稿。

const { randomUUID, createHmac } = require('crypto');
const WebSocket = require('ws');
const { getConfig, getTencentCredentials } = require('../storage');

const ENDPOINT_HOST = 'asr.cloud.tencent.com';
const CONNECT_TIMEOUT_MS = 10000;
// 连上到服务端回第一条确认消息之间等多久。腾讯云没有 task-started，这一条就是握手成功的凭证。
const STARTED_TIMEOUT_MS = 4000;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const BUFFER_LIMIT_BYTES = 64000; // 16kHz 单声道 s16，约 2 秒
const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 10000;
const FINISH_GRACE_MS = 1000;
// 签名有效期 24 小时，远小于接口要求的 90 天上限。
const SIGNATURE_TTL_SECONDS = 24 * 60 * 60;

// 这些错误码重连也没有意义，直接放弃：参数不合法、鉴权失败、未开通、资源包耗尽、欠费、解码失败、境外调用。
const FATAL_ERROR_CODES = new Set([4001, 4002, 4003, 4004, 4005, 4007, 6001]);

// 语音在 URL query 里签名：把除 signature 外的参数按字典序排好拼成不含协议头的 URL，用 SecretKey 做
// HMAC-SHA1，Base64 后再对整个 signature 值 URL 编码。拼接串里的参数值保持原样、不预先编码。
function buildSignedUrl({
    appId,
    secretId,
    secretKey,
    engineModel,
    voiceId,
    maxSentenceSilenceMs,
    enableSpeakerContext,
    speakerContextId,
}) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const params = {
        secretid: secretId,
        timestamp: nowSeconds,
        // 起点时间戳之后过期，且与它相差小于 90 天。
        expired: nowSeconds + SIGNATURE_TTL_SECONDS,
        nonce: Math.floor(Math.random() * 1e9),
        engine_model_type: engineModel,
        // 一条连接一个全局唯一 id，每次连接都要换新的。
        voice_id: voiceId,
        voice_format: 1, // pcm
        // 长音频建议开 VAD，让服务端按时长切句；切多久由下面的 vad_silence_time 定。
        needvad: 1,
        vad_silence_time: maxSentenceSilenceMs,
    };
    // 说话人分离引擎可以用上下文 id 让重连后的 speaker_id 保持一致；普通引擎不认这两个参数。
    if (enableSpeakerContext) params.enable_speaker_context = 1;
    if (speakerContextId) params.speaker_context_id = speakerContextId;

    const query = Object.keys(params)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('&');
    const origin = `${ENDPOINT_HOST}/asr/v2/${appId}?${query}`;
    const signature = createHmac('sha1', secretKey).update(origin).digest('base64');

    return `wss://${ENDPOINT_HOST}/asr/v2/${appId}?${query}&signature=${encodeURIComponent(signature)}`;
}

function integerOr(value, fallback) {
    if (value === null || value === undefined) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

// 说话人分离引擎把结果放在 `sentences` 里，真实结构是 [{ sentence_list: [{ sentence, sentence_type,
// sentence_id, speaker_id, ... }] }]——文档示例不是合法 JSON，看起来像句子对象数组，实际上还多包了一层
// sentence_list。这里把这一层剥掉，同时兼容直接给句子对象/数组的情况。
function listSpeakerSentences(raw) {
    if (!raw) return [];
    const items = Array.isArray(raw) ? raw : [raw];
    const sentences = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (Array.isArray(item.sentence_list)) sentences.push(...item.sentence_list);
        else if (typeof item.sentence === 'string' || typeof item.text === 'string') sentences.push(item);
    }
    return sentences;
}

function createTencentAsr({ maxSentenceSilenceMs, onSentence, onState, onError, engineModel: engineModelOverride = '' } = {}) {
    let socket = null;
    let state = 'idle';
    let voiceId = null;
    let handshakeDone = false;
    // 说话人分离引擎在握手后的消息里可能带回上下文 id，重连时带上它，speaker_id 才不会重新编号。
    let speakerContextId = null;
    let reconnectAttempt = 0;
    let closing = false;

    let audioQueue = [];
    let queuedBytes = 0;

    let connectTimer = null;
    let startedTimer = null;
    let reconnectTimer = null;
    let pingTimer = null;
    let pongTimer = null;
    let finishTimer = null;

    const notifyState = next => {
        state = next;
        if (onState) onState(next);
    };

    const notifySentence = (text, sentenceEnd, meta) => {
        if (onSentence && text) onSentence(text, sentenceEnd, meta);
    };

    function clearTimers() {
        for (const timer of [connectTimer, startedTimer, reconnectTimer, finishTimer]) {
            if (timer) clearTimeout(timer);
        }
        if (pingTimer) clearInterval(pingTimer);
        if (pongTimer) clearTimeout(pongTimer);
        connectTimer = startedTimer = reconnectTimer = pingTimer = pongTimer = finishTimer = null;
    }

    function destroySocket() {
        if (!socket) return;
        const dying = socket;
        socket = null;
        dying.removeAllListeners();
        // 与 bailianAsr 同样的理由：CONNECTING 阶段的 terminate 会在下一个 tick emit('error')，监听器已清空，
        // 没人接就会升级成主进程未捕获异常、弹出 Electron 错误框。补一个空监听器接住。
        dying.on('error', () => {});
        try {
            dying.terminate();
        } catch {
            /* 已经断了 */
        }
    }

    function fail(reason) {
        if (state === 'failed' || closing) return;
        console.error('[Tencent] giving up:', reason);
        clearTimers();
        destroySocket();
        audioQueue = [];
        queuedBytes = 0;
        notifyState('failed');
        if (onError) onError(new Error(reason));
    }

    function flushQueue() {
        if (state !== 'ready' || !socket) return;
        for (const frame of audioQueue) {
            socket.send(frame);
        }
        audioQueue = [];
        queuedBytes = 0;
    }

    function startPing() {
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
            if (!socket || state !== 'ready') return;
            socket.ping();
            if (pongTimer) clearTimeout(pongTimer);
            pongTimer = setTimeout(() => {
                console.error('[Tencent] no pong, dropping the connection');
                destroySocket();
                scheduleReconnect('pong timeout');
            }, PONG_TIMEOUT_MS);
        }, PING_INTERVAL_MS);
    }

    // 中途出错：这些码重连也没用（鉴权、资源、参数），其余（负载抖动、发太快、连接断开）退避重连。
    function handleStreamError(code, message) {
        console.error('[Tencent] stream error:', code, message);
        if (FATAL_ERROR_CODES.has(code)) {
            destroySocket();
            fail(`stream error ${code}: ${message}`);
            return;
        }
        destroySocket();
        scheduleReconnect(`stream error ${code}`);
    }

    function handleMessage(raw, isBinary) {
        if (isBinary) return;

        let message;
        try {
            message = JSON.parse(raw.toString('utf8'));
        } catch {
            return;
        }

        // 服务端的第一条消息就是握手确认：code 为 0 表示签名通过，非 0 表示鉴权失败，连接作废。
        if (!handshakeDone) {
            handshakeDone = true;
            if (message.code !== 0) {
                console.error('[Tencent] handshake rejected:', message.code, message.message);
                destroySocket();
                fail(`handshake rejected ${message.code}: ${message.message}`);
                return;
            }
            if (startedTimer) clearTimeout(startedTimer);
            startedTimer = null;
            reconnectAttempt = 0;
            console.log('[Tencent] handshake ok');
            notifyState('ready');
            flushQueue();
            startPing();
            return;
        }

        if (message.code !== 0) {
            handleStreamError(message.code, message.message);
            return;
        }

        // 普通引擎把结果放在 result 里；说话人分离引擎的 sentences 可能在顶层的 result 或直接在消息上。
        const result = message.result && typeof message.result === 'object' ? message.result : message;

        const contextId = message.speaker_context_id || result.speaker_context_id;
        if (contextId) speakerContextId = contextId;

        const speakerSentences = listSpeakerSentences(result.sentences);
        if (speakerSentences.length) {
            for (const item of speakerSentences) {
                if (!item || typeof item !== 'object') continue;
                const text = typeof item.sentence === 'string' ? item.sentence : item.text;
                if (typeof text !== 'string' || !text) continue;
                // sentence_type: 0 未定稿、1 定稿；speaker_id 在可靠之前是 -1。
                notifySentence(text, integerOr(item.sentence_type, 0) === 1, {
                    speakerId: integerOr(item.speaker_id, -1),
                    sentenceId: integerOr(item.sentence_id, undefined),
                });
            }
        } else if (typeof result.voice_text_str === 'string' && result.voice_text_str) {
            // voice_text_str 是本句到目前为止的累计文本：slice_type 为 2 时才是这一句的定稿。空文本（例如纯静音帧
            // 的切片）不提交。
            notifySentence(result.voice_text_str, result.slice_type === 2);
        }

        if (message.final === 1) {
            console.log('[Tencent] stream finished');
            destroySocket();
            if (!closing) scheduleReconnect('server finished the stream');
        }
    }

    function scheduleReconnect(reason) {
        if (closing || state === 'failed') return;

        if (reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
            fail(`reconnect budget exhausted (${reason})`);
            return;
        }

        const base = RECONNECT_DELAYS_MS[reconnectAttempt];
        reconnectAttempt += 1;
        const delay = Math.round(base * (0.8 + Math.random() * 0.4));
        console.log(`[Tencent] reconnecting in ${delay} ms (${reason})`);
        notifyState('reconnecting');

        clearTimers();
        reconnectTimer = setTimeout(connect, delay);
    }

    function connect() {
        if (closing || state === 'failed') return;

        const { appId, secretId, secretKey } = getTencentCredentials();
        if (!appId || !secretId || !secretKey) {
            fail('no Tencent Cloud credentials configured');
            return;
        }

        const engineModel = (engineModelOverride || getConfig().tencentEngineModel || DEFAULT_CONFIG.tencentEngineModel).trim();
        // 每次连接都要新的 voice_id，上一条连接结束后即作废。
        voiceId = randomUUID();
        handshakeDone = false;
        notifyState('connecting');

        let endpoint;
        try {
            endpoint = buildSignedUrl({
                appId,
                secretId,
                secretKey,
                engineModel,
                voiceId,
                maxSentenceSilenceMs,
                enableSpeakerContext: engineModel.includes('_speaker_'),
                speakerContextId,
            });
        } catch (error) {
            fail(`failed to sign Tencent request: ${error.message}`);
            return;
        }

        socket = new WebSocket(endpoint);

        connectTimer = setTimeout(() => {
            console.error('[Tencent] connect timeout');
            destroySocket();
            scheduleReconnect('connect timeout');
        }, CONNECT_TIMEOUT_MS);

        socket.on('open', () => {
            if (connectTimer) clearTimeout(connectTimer);
            connectTimer = null;
            console.log('[Tencent] socket open, waiting for handshake');
            // 鉴权在 URL 里，open 之后不用发任何消息，只等确认。等太久说明服务端没回。
            startedTimer = setTimeout(() => {
                console.error('[Tencent] no handshake confirmation');
                destroySocket();
                scheduleReconnect('handshake timeout');
            }, STARTED_TIMEOUT_MS);
        });

        socket.on('message', handleMessage);

        socket.on('pong', () => {
            if (pongTimer) clearTimeout(pongTimer);
            pongTimer = null;
        });

        socket.on('error', error => {
            console.error('[Tencent] socket error:', error);
        });

        socket.on('close', () => {
            socket = null;
            if (closing || state === 'failed') return;
            scheduleReconnect('socket closed');
        });
    }

    function start() {
        if (state === 'ready' || state === 'connecting' || closing) return;
        connect();
    }

    function sendAudio(pcm16k) {
        if (!pcm16k || !pcm16k.length) return;
        if (state === 'failed' || state === 'closed' || closing) return;

        if (state === 'ready' && socket) {
            socket.send(pcm16k);
            return;
        }

        // 还没握手完（或正在重连）：先把帧存住，ready 之后补发。
        audioQueue.push(Buffer.from(pcm16k));
        queuedBytes += pcm16k.length;
        while (queuedBytes > BUFFER_LIMIT_BYTES && audioQueue.length > 1) {
            queuedBytes -= audioQueue.shift().length;
        }
    }

    function finish() {
        closing = true;
        clearTimers();

        if (state === 'ready' && socket) {
            console.log('[Tencent] sending end');
            socket.send(JSON.stringify({ type: 'end' }));

            const pending = socket;
            finishTimer = setTimeout(() => {
                if (socket === pending) destroySocket();
            }, FINISH_GRACE_MS);
            pending.once('close', () => {
                if (finishTimer) clearTimeout(finishTimer);
                finishTimer = null;
            });
        } else {
            destroySocket();
        }

        audioQueue = [];
        queuedBytes = 0;
        notifyState('closed');
    }

    return { start, sendAudio, finish, close: finish };
}

module.exports = {
    createTencentAsr,
};
