#!/usr/bin/env node
// Standalone probe for the Aliyun Bailian (DashScope) realtime ASR handshake.
//
// The wire format of this API is not documented in a machine-readable way, so run this before
// trusting src/utils/bailianAsr.js and correct the field names there to match whatever this
// prints.
//
//   DASHSCOPE_API_KEY=xxx node scripts/asr-smoke.js [path/to.wav]
//
// Without a wav it streams 3 s of silence followed by a 2 s tone, which only proves that the
// socket accepts audio frames — not that transcription works. Prefer passing a real recording.
// The key is read from the environment first, then from the app's saved credentials.

const fs = require('fs');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');

const ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const MODEL = process.env.DASHSCOPE_MODEL || 'paraformer-realtime-v2';
const LANGUAGE = process.env.DASHSCOPE_LANGUAGE || 'zh';
const SAMPLE_RATE = 16000;
const FRAME_BYTES = 3200; // 100 ms of 16 kHz mono s16
const FRAME_MS = 100;
const TASK_STARTED_TIMEOUT_MS = 8000;
const TASK_FINISHED_TIMEOUT_MS = 8000;

function resolveApiKey() {
    const fromEnv = (process.env.DASHSCOPE_API_KEY || '').trim();
    if (fromEnv) return fromEnv;
    try {
        return require('../src/storage').getBailianApiKey();
    } catch {
        return '';
    }
}

function runTaskMessage(taskId) {
    return {
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model: MODEL,
            parameters: {
                format: 'pcm',
                sample_rate: SAMPLE_RATE,
                language_hints: [LANGUAGE],
                semantic_punctuation_enabled: false,
                max_sentence_silence: 600,
                punctuation_prediction_enabled: true,
                inverse_text_normalization_enabled: true,
                heartbeat: true,
            },
            input: {},
        },
    };
}

function finishTaskMessage(taskId) {
    return {
        header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
        payload: { input: {} },
    };
}

function readWavAsMono16k(file) {
    const buf = fs.readFileSync(file);
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error(`${file} is not a RIFF/WAVE file`);
    }

    let offset = 12;
    let fmt = null;
    let dataStart = -1;
    let dataLength = 0;

    while (offset + 8 <= buf.length) {
        const id = buf.toString('ascii', offset, offset + 4);
        const size = buf.readUInt32LE(offset + 4);
        const body = offset + 8;

        if (id === 'fmt ') {
            fmt = {
                channels: buf.readUInt16LE(body + 2),
                sampleRate: buf.readUInt32LE(body + 4),
                bits: buf.readUInt16LE(body + 14),
            };
        } else if (id === 'data') {
            dataStart = body;
            dataLength = Math.min(size, buf.length - body);
            break;
        }

        offset = body + size + (size % 2);
    }

    if (!fmt || dataStart < 0) throw new Error('missing fmt or data chunk');
    if (fmt.bits !== 16) throw new Error(`expected 16-bit PCM, got ${fmt.bits}-bit`);
    if (fmt.channels < 1) throw new Error('no channels in fmt chunk');

    const pcm = buf.slice(dataStart, dataStart + dataLength);
    const frames = Math.floor(pcm.length / (2 * fmt.channels));

    const mono = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
        mono.writeInt16LE(pcm.readInt16LE(i * 2 * fmt.channels), i * 2);
    }

    console.log(`wav: ${fmt.channels}ch ${fmt.sampleRate}Hz ${fmt.bits}bit -> ${(frames / fmt.sampleRate).toFixed(1)}s`);

    if (fmt.sampleRate === SAMPLE_RATE) return mono;

    const ratio = fmt.sampleRate / SAMPLE_RATE;
    const outFrames = Math.floor(frames / ratio);
    const out = Buffer.alloc(outFrames * 2);
    for (let i = 0; i < outFrames; i++) {
        const position = i * ratio;
        const index = Math.floor(position);
        const fraction = position - index;
        const first = mono.readInt16LE(index * 2);
        const second = index + 1 < frames ? mono.readInt16LE((index + 1) * 2) : first;
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(first + fraction * (second - first)))), i * 2);
    }
    console.log(`resampled ${fmt.sampleRate}Hz -> ${SAMPLE_RATE}Hz`);
    return out;
}

function toneFallback() {
    const totalFrames = Math.round(5 * SAMPLE_RATE);
    const toneStart = Math.round(3 * SAMPLE_RATE);
    const out = Buffer.alloc(totalFrames * 2);
    for (let i = toneStart; i < totalFrames; i++) {
        const value = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (i - toneStart)) / SAMPLE_RATE));
        out.writeInt16LE(value, i * 2);
    }
    console.log('no wav given: streaming 3s silence + 2s 440Hz tone');
    return out;
}

function main() {
    const apiKey = resolveApiKey();
    if (!apiKey) {
        console.error('No API key. Set DASHSCOPE_API_KEY, or save a Bailian key in the app first.');
        process.exit(2);
    }

    const wavPath = process.argv[2];
    const pcm = wavPath ? readWavAsMono16k(wavPath) : toneFallback();
    const taskId = randomUUID();
    const started = Date.now();
    const elapsed = () => `${((Date.now() - started) / 1000).toFixed(2)}s`;

    const sentences = [];
    let firstInboundLogged = false;
    let streamTimer = null;
    let finishedTimer = null;
    let startedTimer = null;

    console.log(`[${elapsed()}] connecting to ${ENDPOINT} (model=${MODEL}, lang=${LANGUAGE})`);
    console.log(`key: ...${apiKey.slice(-6)} (len ${apiKey.length})`);

    const ws = new WebSocket(ENDPOINT, {
        headers: { Authorization: `Bearer ${apiKey}`, 'user-agent': 'cheating-daddy-asr-smoke/1.0' },
    });

    const done = code => {
        clearTimeout(startedTimer);
        clearTimeout(finishedTimer);
        if (streamTimer) clearInterval(streamTimer);
        try {
            ws.close();
        } catch {
            /* already closing */
        }
        console.log(`\nfinal text: ${sentences.join('') || '(empty)'}`);
        console.log(`total: ${elapsed()}`);
        process.exit(code);
    };

    ws.on('open', () => {
        console.log(`[${elapsed()}] ws open, sending run-task`);
        ws.send(JSON.stringify(runTaskMessage(taskId)));
        startedTimer = setTimeout(() => {
            console.error(`\nno task-started within ${TASK_STARTED_TIMEOUT_MS} ms — run-task was rejected or the envelope is wrong`);
            done(1);
        }, TASK_STARTED_TIMEOUT_MS);
    });

    ws.on('unexpected-response', (request, response) => {
        let body = '';
        response.on('data', chunk => {
            body += chunk.toString();
        });
        response.on('end', () => {
            console.error(`handshake rejected: HTTP ${response.statusCode} ${body.slice(0, 500)}`);
            done(1);
        });
    });

    ws.on('message', (raw, isBinary) => {
        const text = isBinary ? `<binary ${raw.length} bytes>` : raw.toString('utf8');

        if (!firstInboundLogged) {
            firstInboundLogged = true;
            console.log(`[${elapsed()}] FIRST INBOUND FRAME (use this to fix field names):\n${text}\n`);
        }

        let message;
        try {
            message = JSON.parse(text);
        } catch {
            console.log(`[${elapsed()}] non-JSON frame: ${text.slice(0, 300)}`);
            return;
        }

        const event = message.header?.event;
        console.log(`[${elapsed()}] event=${event}`);

        if (event === 'task-started') {
            clearTimeout(startedTimer);
            console.log(`[${elapsed()}] task started, streaming ${(pcm.length / (SAMPLE_RATE * 2)).toFixed(1)}s of audio`);

            let offset = 0;
            streamTimer = setInterval(() => {
                if (offset >= pcm.length) {
                    clearInterval(streamTimer);
                    streamTimer = null;
                    console.log(`[${elapsed()}] audio sent, sending finish-task`);
                    ws.send(JSON.stringify(finishTaskMessage(taskId)));
                    finishedTimer = setTimeout(() => {
                        console.error(`\nno task-finished within ${TASK_FINISHED_TIMEOUT_MS} ms of finish-task`);
                        done(1);
                    }, TASK_FINISHED_TIMEOUT_MS);
                    return;
                }
                ws.send(pcm.slice(offset, offset + FRAME_BYTES));
                offset += FRAME_BYTES;
            }, FRAME_MS);
        } else if (event === 'result-generated') {
            const sentence = message.payload?.output?.sentence;
            if (!sentence) {
                console.log('  result has unexpected shape:', JSON.stringify(message.payload));
                return;
            }
            console.log(`  text=${JSON.stringify(sentence.text)} sentence_end=${sentence.sentence_end} begin=${sentence.begin_time} end=${sentence.end_time}`);
            if (sentence.sentence_end !== false && sentence.text) sentences.push(sentence.text);
        } else if (event === 'task-finished') {
            console.log(`[${elapsed()}] task finished`);
            done(0);
        } else if (event === 'task-failed') {
            console.error(`task failed: ${message.header?.error_code} ${message.header?.error_message}`);
            done(1);
        } else {
            console.log('  full frame:', text.slice(0, 500));
        }
    });

    ws.on('error', error => {
        console.error(`ws error: ${error.message}`);
    });

    ws.on('close', (code, reason) => {
        if (code !== 1000 && code !== 1005) {
            console.error(`ws closed unexpectedly: code=${code} reason=${reason.toString() || '(none)'}`);
            done(1);
        }
    });

    setTimeout(() => {
        console.error(`\noverall timeout after ${elapsed()}`);
        done(1);
    }, 60000);
}

main();
