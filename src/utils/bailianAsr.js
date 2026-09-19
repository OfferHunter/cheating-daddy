// Streaming ASR over Aliyun Bailian's DashScope websocket API. Transport only: it knows nothing
// about turns or the LLM, it just turns a live PCM stream into sentence events.
//
// The wire format was verified with scripts/asr-smoke.js against a live endpoint. Field names
// here are the ones that probe printed.

const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const { getConfig, getBailianApiKey, getMaxSentenceSilenceMs } = require('../storage');

const ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const DEFAULT_MODEL = 'paraformer-realtime-v2';
const CONNECT_TIMEOUT_MS = 5000;
const TASK_STARTED_TIMEOUT_MS = 4000;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const BUFFER_LIMIT_BYTES = 64000; // 2 s of 16 kHz mono s16
const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 10000;
const FINISH_GRACE_MS = 1000;

function createRealtimeAsr({ language, onSentence, onState, onError } = {}) {
    let socket = null;
    let state = 'idle';
    let taskId = null;
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

    const notifySentence = (text, sentenceEnd) => {
        if (onSentence && text) onSentence(text, sentenceEnd);
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
        try {
            dying.terminate();
        } catch {
            /* already gone */
        }
    }

    function fail(reason) {
        if (state === 'failed' || closing) return;
        console.error('[Bailian] giving up:', reason);
        clearTimers();
        destroySocket();
        audioQueue = [];
        queuedBytes = 0;
        notifyState('failed');
        if (onError) onError(new Error(reason));
    }

    function runTaskMessage() {
        const parameters = {
            format: 'pcm',
            sample_rate: 16000,
            semantic_punctuation_enabled: false,
            max_sentence_silence: getMaxSentenceSilenceMs(),
            punctuation_prediction_enabled: true,
            inverse_text_normalization_enabled: true,
            heartbeat: true,
        };
        if (language) parameters.language_hints = [language];

        return {
            header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
            payload: {
                task_group: 'audio',
                task: 'asr',
                function: 'recognition',
                model: getConfig().bailianModel || DEFAULT_MODEL,
                parameters,
                input: {},
            },
        };
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
                console.error('[Bailian] no pong, dropping the connection');
                destroySocket();
                scheduleReconnect('pong timeout');
            }, PONG_TIMEOUT_MS);
        }, PING_INTERVAL_MS);
    }

    function handleMessage(raw, isBinary) {
        if (isBinary) return;

        let message;
        try {
            message = JSON.parse(raw.toString('utf8'));
        } catch {
            return;
        }

        const event = message.header?.event;

        if (event === 'task-started') {
            if (startedTimer) clearTimeout(startedTimer);
            startedTimer = null;
            reconnectAttempt = 0;
            console.log('[Bailian] task started');
            notifyState('ready');
            flushQueue();
            startPing();
            return;
        }

        if (event === 'result-generated') {
            const sentence = message.payload?.output?.sentence;
            if (sentence?.text) notifySentence(sentence.text, sentence.sentence_end !== false);
            return;
        }

        if (event === 'task-finished') {
            console.log('[Bailian] task finished');
            if (finishTimer) clearTimeout(finishTimer);
            finishTimer = null;
            destroySocket();
            if (!closing) scheduleReconnect('server finished the task');
            return;
        }

        if (event === 'task-failed') {
            console.error('[Bailian] task failed:', message.header?.error_code, message.header?.error_message);
            destroySocket();
            scheduleReconnect('task failed');
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
        console.log(`[Bailian] reconnecting in ${delay} ms (${reason})`);
        notifyState('reconnecting');

        clearTimers();
        reconnectTimer = setTimeout(connect, delay);
    }

    function connect() {
        if (closing || state === 'failed') return;

        const apiKey = (getBailianApiKey() || '').trim();
        if (!apiKey) {
            fail('no Bailian API key configured');
            return;
        }

        taskId = randomUUID();
        notifyState('connecting');

        socket = new WebSocket(ENDPOINT, {
            headers: { Authorization: `Bearer ${apiKey}`, 'user-agent': 'cheating-daddy/1.0' },
        });

        connectTimer = setTimeout(() => {
            console.error('[Bailian] connect timeout');
            destroySocket();
            scheduleReconnect('connect timeout');
        }, CONNECT_TIMEOUT_MS);

        socket.on('open', () => {
            if (connectTimer) clearTimeout(connectTimer);
            connectTimer = null;
            console.log('[Bailian] socket open, sending run-task');
            socket.send(JSON.stringify(runTaskMessage()));

            startedTimer = setTimeout(() => {
                console.error('[Bailian] no task-started');
                destroySocket();
                scheduleReconnect('task-started timeout');
            }, TASK_STARTED_TIMEOUT_MS);
        });

        socket.on('message', handleMessage);

        socket.on('pong', () => {
            if (pongTimer) clearTimeout(pongTimer);
            pongTimer = null;
        });

        socket.on('unexpected-response', (request, response) => {
            let body = '';
            response.on('data', chunk => {
                body += chunk.toString();
            });
            response.on('end', () => {
                console.error(`[Bailian] handshake rejected: HTTP ${response.statusCode} ${body.slice(0, 300)}`);
            });
        });

        socket.on('error', error => {
            console.error('[Bailian] socket error:', error.message);
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

        // Not handshaken yet (or mid-reconnect): hold the frames and replay them once ready.
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
            console.log('[Bailian] sending finish-task');
            socket.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }));

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
    createRealtimeAsr,
};
