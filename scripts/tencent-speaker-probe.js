// 诊断脚本：用本机已保存的腾讯云凭据，把同一段 16k PCM 分别喂给普通引擎和说话人分离引擎，
// 打印原始返回消息（只打印结果结构/文本，绝不打印 secretid/secretkey/signature）。
// 用法: node scripts/tencent-speaker-probe.js <16k-pcm文件> [引擎...]
const fs = require('node:fs');
const path = require('node:path');
const { createHmac, randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { getTencentCredentials, getConfig } = require('../src/storage');

const HOST = 'asr.cloud.tencent.com';
const CHUNK_BYTES = 6400; // 200ms @16k s16 mono
const CHUNK_MS = 200;

function signedUrl({ appId, secretId, secretKey, engineModel, maxSentenceSilenceMs, enableSpeakerContext }) {
    const now = Math.floor(Date.now() / 1000);
    const params = {
        secretid: secretId,
        timestamp: now,
        expired: now + 24 * 60 * 60,
        nonce: Math.floor(Math.random() * 1e9),
        engine_model_type: engineModel,
        voice_id: randomUUID(),
        voice_format: 1,
        needvad: 1,
        vad_silence_time: maxSentenceSilenceMs,
    };
    if (enableSpeakerContext) params.enable_speaker_context = 1;
    const query = Object.keys(params)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('&');
    const origin = `${HOST}/asr/v2/${appId}?${query}`;
    const signature = createHmac('sha1', secretKey).update(origin).digest('base64');
    return `wss://${HOST}/asr/v2/${appId}?${query}&signature=${encodeURIComponent(signature)}`;
}

function summarize(message) {
    const out = { keys: Object.keys(message), code: message.code, final: message.final };
    if (typeof message.message === 'string' && message.message) out.message = message.message;
    const result = message.result && typeof message.result === 'object' ? message.result : message;
    if (result.sentences !== undefined) {
        const list = Array.isArray(result.sentences)
            ? result.sentences
            : result.sentences && Array.isArray(result.sentences.sentences)
              ? result.sentences.sentences
              : [result.sentences];
        out.sentences = list.map(item => {
            if (item && Array.isArray(item.sentence_list)) {
                return { keys: Object.keys(item), sentence_list: item.sentence_list };
            }
            return {
                keys: item && typeof item === 'object' ? Object.keys(item) : typeof item,
                sentence: item && item.sentence,
                sentence_type: item && item.sentence_type,
                sentence_id: item && item.sentence_id,
                speaker_id: item && item.speaker_id,
            };
        });
    }
    if (typeof result.voice_text_str === 'string') out.voice_text_str = result.voice_text_str;
    if (result.slice_type !== undefined) out.slice_type = result.slice_type;
    if (message.speaker_context_id) out.speaker_context_id = '(present)';
    return out;
}

function run(pcm, label, { engineModel, enableSpeakerContext }) {
    return new Promise(resolve => {
        const { appId, secretId, secretKey } = getTencentCredentials();
        console.log(`\n=== ${label} (engine=${engineModel}, speaker_context=${enableSpeakerContext ? 1 : 0}) ===`);
        const socket = new WebSocket(signedUrl({ appId, secretId, secretKey, engineModel, maxSentenceSilenceMs: 500, enableSpeakerContext }));
        let handshake = false;
        let sentences = 0;
        let offset = 0;
        let timer = null;
        let finished = false;

        const stop = reason => {
            if (finished) return;
            finished = true;
            if (timer) clearInterval(timer);
            console.log(`${reason}; sentences=${sentences}, sent=${offset}/${pcm.length} bytes`);
            try {
                socket.terminate();
            } catch {}
            resolve();
        };

        socket.on('open', () => {
            console.log('socket open');
        });
        socket.on('message', raw => {
            let message;
            try {
                message = JSON.parse(raw.toString('utf8'));
            } catch {
                console.log('unparsable message:', raw.toString('utf8').slice(0, 200));
                return;
            }
            if (!handshake) {
                handshake = true;
                console.log('handshake:', message.code, message.message);
                if (message.code !== 0) return stop('handshake rejected');
                timer = setInterval(() => {
                    if (offset >= pcm.length) {
                        clearInterval(timer);
                        timer = null;
                        console.log('audio done, sending end');
                        socket.send(JSON.stringify({ type: 'end' }));
                        setTimeout(() => stop('timeout after end'), 5000);
                        return;
                    }
                    socket.send(pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length)));
                    offset += CHUNK_BYTES;
                }, CHUNK_MS);
                return;
            }
            const summary = summarize(message);
            if (summary.sentences) sentences += summary.sentences.length;
            console.log('<-', JSON.stringify(summary).slice(0, 600));
            if (message.final === 1) stop('server final');
        });
        socket.on('error', error => console.log('socket error:', error.message));
        socket.on('close', code => {
            if (!finished) stop(`socket closed (${code})`);
        });
        setTimeout(() => stop('hard timeout'), 30000);
    });
}

(async () => {
    const file = process.argv[2];
    if (!file) {
        console.error('usage: node scripts/tencent-speaker-probe.js <16k-mono-s16le.pcm> [engine...]');
        process.exit(1);
    }
    const pcm = fs.readFileSync(path.resolve(file));
    const cfg = getConfig();
    const engines = process.argv.slice(3);
    if (engines.length === 0) engines.push(cfg.tencentEngineModel || '16k_zh', '16k_zh_en_speaker_2.0');
    for (const engine of engines) {
        await run(pcm, engine, { engineModel: engine, enableSpeakerContext: engine.includes('_speaker_') });
    }
})();
