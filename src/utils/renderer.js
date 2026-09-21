const { ipcRenderer } = require('electron');

let mediaStream = null;
let screenshotInterval = null;
let audioContext = null;
let audioProcessor = null;
// 麦克风单独持有：它有自己的拆卸时机，track 和喂它的 context 都比 mediaStream/audioContext 活得久，不显式
// 关掉，设备在会话结束后仍会被系统标记为占用中。
let micAudioProcessor = null;
let micCaptureStream = null;
let micCaptureContext = null;
let audioBuffer = [];
const SAMPLE_RATE = 24000;
const AUDIO_CHUNK_DURATION = 0.1; // 秒，主力侧按同一节奏拼帧
const BUFFER_SIZE = 4096;

let hiddenVideo = null;
let offscreenCanvas = null;
let offscreenContext = null;
let currentImageQuality = 'medium';

// 暂停时采集照旧，每 100ms 仍然送一帧，只是帧里是静音。改成停止发送反而会饿死识别任务——端点静默太久
// 会主动结束它；而送出去的静音帧在到达 socket 前就被丢掉了，音频不会作为语音离开本进程。
let capturePaused = false;

const isMacOS = process.platform === 'darwin';

const storage = {
    async getConfig() {
        const result = await ipcRenderer.invoke('storage:get-config');
        return result.success ? result.data : {};
    },
    async setConfig(config) {
        return ipcRenderer.invoke('storage:set-config', config);
    },
    async updateConfig(key, value) {
        return ipcRenderer.invoke('storage:update-config', key, value);
    },

    async getCredentials() {
        const result = await ipcRenderer.invoke('storage:get-credentials');
        return result.success ? result.data : {};
    },
    async setCredentials(credentials) {
        return ipcRenderer.invoke('storage:set-credentials', credentials);
    },
    async getDeepseekApiKey() {
        const result = await ipcRenderer.invoke('storage:get-deepseek-api-key');
        return result.success ? result.data : '';
    },
    async setDeepseekApiKey(deepseekApiKey) {
        return ipcRenderer.invoke('storage:set-deepseek-api-key', deepseekApiKey);
    },
    async getBailianApiKey() {
        const result = await ipcRenderer.invoke('storage:get-bailian-api-key');
        return result.success ? result.data : '';
    },
    async setBailianApiKey(bailianApiKey) {
        return ipcRenderer.invoke('storage:set-bailian-api-key', bailianApiKey);
    },

    async getPreferences() {
        const result = await ipcRenderer.invoke('storage:get-preferences');
        return result.success ? result.data : {};
    },
    async setPreferences(preferences) {
        return ipcRenderer.invoke('storage:set-preferences', preferences);
    },
    async updatePreference(key, value) {
        return ipcRenderer.invoke('storage:update-preference', key, value);
    },

    async getKeybinds() {
        const result = await ipcRenderer.invoke('storage:get-keybinds');
        return result.success ? result.data : null;
    },
    async setKeybinds(keybinds) {
        return ipcRenderer.invoke('storage:set-keybinds', keybinds);
    },

    async getAllSessions() {
        const result = await ipcRenderer.invoke('storage:get-all-sessions');
        return result.success ? result.data : [];
    },
    async getSession(sessionId) {
        const result = await ipcRenderer.invoke('storage:get-session', sessionId);
        return result.success ? result.data : null;
    },
    async saveSession(sessionId, data) {
        return ipcRenderer.invoke('storage:save-session', sessionId, data);
    },
    async deleteSession(sessionId) {
        return ipcRenderer.invoke('storage:delete-session', sessionId);
    },
    async deleteAllSessions() {
        return ipcRenderer.invoke('storage:delete-all-sessions');
    },
    // 返回原始结果而非补齐过的结构：用户取消导出和写盘失败是两回事，只有原始结果带这个区分。
    async exportSessions(sessionIds) {
        return ipcRenderer.invoke('storage:export-sessions', sessionIds);
    },

    async clearAll() {
        return ipcRenderer.invoke('storage:clear-all');
    },
};

// 知识目录归主进程所有。渲染端只用 id 指认条目，从不持有或传递路径。
const knowledge = {
    async chooseDirectory() {
        return ipcRenderer.invoke('knowledge:choose-directory');
    },
    // 同 exportSessions：原始结果才能区分「没选目录」和「目录已设但里面什么都没读到」。
    async list() {
        return ipcRenderer.invoke('knowledge:get-list');
    },
    async preview(id) {
        return ipcRenderer.invoke('knowledge:preview', id);
    },
    async clearDirectory() {
        return ipcRenderer.invoke('knowledge:clear-directory');
    },
    async reveal(id) {
        return ipcRenderer.invoke('knowledge:reveal', id);
    },
};

// 缓存偏好设置：热路径上不能每次都 await 一次 IPC。
let preferencesCache = null;

async function loadPreferencesCache() {
    preferencesCache = await storage.getPreferences();
    return preferencesCache;
}

loadPreferencesCache();

function convertFloat32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array;
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function initializeChat() {
    const prefs = await storage.getPreferences();
    const customPrompt = prefs.customPrompt || '';
    const selectedLanguage = prefs.selectedLanguage || 'cmn-CN';

    const success = await ipcRenderer.invoke('initialize-chat', customPrompt, selectedLanguage);
    if (success) {
        cheatingDaddy.setStatus('Live');
        return true;
    }
    cheatingDaddy.setStatus('error');
    return false;
}

ipcRenderer.on('update-status', (event, status) => {
    console.log('Status update:', status);
    cheatingDaddy.setStatus(status);
});

// 真正把设备交回去的是 stop 掉 track：processor 的 disconnect() 只是停掉回调，系统仍会显示麦克风占用中
// （Windows 上就是托盘那个指示），必须连 track 和它的 context 一起关。
function releaseMicCapture() {
    if (micAudioProcessor) {
        micAudioProcessor.disconnect();
        micAudioProcessor = null;
    }

    if (micCaptureStream) {
        micCaptureStream.getTracks().forEach(track => track.stop());
        micCaptureStream = null;
    }

    if (micCaptureContext) {
        micCaptureContext.close().catch(() => {});
        micCaptureContext = null;
    }
}

// 'none' 是设置页里「不用麦克风」的显式选择，不会走到这里。具体 deviceId 用 'ideal' 而不是 'exact'：那个
// 设备要是被拔了，退回系统默认设备，而不是整个采集直接失败。
function buildMicConstraints(micDeviceId) {
    const audio = {
        sampleRate: SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
    };
    if (micDeviceId && micDeviceId !== 'none') {
        audio.deviceId = { ideal: micDeviceId };
    }
    return { audio, video: false };
}

async function startCapture(screenshotIntervalSeconds = 5, imageQuality = 'medium') {
    currentImageQuality = imageQuality;

    await loadPreferencesCache();
    const micDeviceId = preferencesCache.audioInputDeviceId || 'none';
    // 麦克风是候选人自己那一路：与扬声器那一路并行，而不是取代它，所以只有「明确不用麦克风」才会关掉它。
    const shouldCaptureMic = micDeviceId !== 'none';

    // 在开始任何采集之前先释放：这一路开不开由本次会话自己的选择决定，上一次会话留下的东西两种情况下都
    // 不该继续活着。
    releaseMicCapture();

    try {
        if (isMacOS) {
            console.log('Starting macOS capture with SystemAudioDump...');

            const audioResult = await ipcRenderer.invoke('start-macos-audio');
            if (!audioResult.success) {
                throw new Error('Failed to start macOS audio capture: ' + audioResult.error);
            }

            mediaStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    frameRate: 1,
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
                audio: false, // 系统声音走 SystemAudioDump，不走浏览器
            });

            console.log('macOS screen capture started - audio handled by SystemAudioDump');

            if (shouldCaptureMic) {
                try {
                    micCaptureStream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(micDeviceId));
                    console.log('macOS microphone capture started');
                    setupMicProcessing(micCaptureStream);
                } catch (micError) {
                    console.warn('Failed to get microphone access on macOS:', micError);
                }
            }
        } else {
            mediaStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    frameRate: 1,
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
                audio: {
                    sampleRate: SAMPLE_RATE,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

            console.log('Windows capture started with loopback audio');

            setupWindowsLoopbackProcessing();

            if (shouldCaptureMic) {
                try {
                    micCaptureStream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(micDeviceId));
                    console.log('Windows microphone capture started');
                    setupMicProcessing(micCaptureStream);
                } catch (micError) {
                    console.warn('Failed to get microphone access on Windows:', micError);
                }
            }
        }

        console.log('MediaStream obtained:', {
            hasVideo: mediaStream.getVideoTracks().length > 0,
            hasAudio: mediaStream.getAudioTracks().length > 0,
            videoTrack: mediaStream.getVideoTracks()[0]?.getSettings(),
        });

        console.log('Manual mode enabled - screenshots will be captured on demand only');
    } catch (err) {
        console.error('Error starting capture:', err);
        cheatingDaddy.setStatus('error');
    }
}

// 麦克风与系统声音两条泵只差一个 IPC 频道：一个是候选人自己的话，一个是面试官的声音，主力侧按频道分。
// context/processor 必须交回调用方去赋给对应的模块级变量——releaseMicCapture 与 stopCapture 就是靠
// 它们来关的，漏掉一个就会留下没关掉的音频上下文和没断开的设备。
function startAudioPump(stream, channel) {
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1);

    let audioBuffer = [];
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;

    processor.onaudioprocess = async e => {
        audioBuffer.push(...e.inputBuffer.getChannelData(0));

        while (audioBuffer.length >= samplesPerChunk) {
            const chunk = audioBuffer.splice(0, samplesPerChunk);
            const pcmData16 = capturePaused ? new Int16Array(chunk.length) : convertFloat32ToInt16(chunk);
            const base64Data = arrayBufferToBase64(pcmData16.buffer);

            await ipcRenderer.invoke(channel, {
                data: base64Data,
                mimeType: 'audio/pcm;rate=24000',
            });
        }
    };

    source.connect(processor);
    processor.connect(context.destination);
    return { context, processor };
}

function setupMicProcessing(micStream) {
    const { context, processor } = startAudioPump(micStream, 'send-mic-audio-content');
    micCaptureContext = context;
    micAudioProcessor = processor;
}

function setupWindowsLoopbackProcessing() {
    const { context, processor } = startAudioPump(mediaStream, 'send-audio-content');
    audioContext = context;
    audioProcessor = processor;
}

async function captureScreenshot(imageQuality = 'medium', isManual = false) {
    console.log(`Capturing ${isManual ? 'manual' : 'automated'} screenshot...`);
    if (!mediaStream) return;

    if (!hiddenVideo) {
        hiddenVideo = document.createElement('video');
        hiddenVideo.srcObject = mediaStream;
        hiddenVideo.muted = true;
        hiddenVideo.playsInline = true;
        await hiddenVideo.play();

        await new Promise(resolve => {
            if (hiddenVideo.readyState >= 2) return resolve();
            hiddenVideo.onloadedmetadata = () => resolve();
        });

        offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = hiddenVideo.videoWidth;
        offscreenCanvas.height = hiddenVideo.videoHeight;
        offscreenContext = offscreenCanvas.getContext('2d');
    }

    if (hiddenVideo.readyState < 2) {
        console.warn('Video not ready yet, skipping screenshot');
        return;
    }

    offscreenContext.drawImage(hiddenVideo, 0, 0, offscreenCanvas.width, offscreenCanvas.height);

    // 只采样一个像素（四个分量里的 alpha 跳过）：全黑或全透明就当成空画面。
    const imageData = offscreenContext.getImageData(0, 0, 1, 1);
    const isBlank = imageData.data.every((value, index) => {
        return index === 3 ? true : value === 0;
    });

    if (isBlank) {
        console.warn('Screenshot appears to be blank/black');
    }

    let qualityValue;
    switch (imageQuality) {
        case 'high':
            qualityValue = 0.9;
            break;
        case 'medium':
            qualityValue = 0.7;
            break;
        case 'low':
            qualityValue = 0.5;
            break;
        default:
            qualityValue = 0.7;
    }

    offscreenCanvas.toBlob(
        async blob => {
            if (!blob) {
                console.error('Failed to create blob from canvas');
                return;
            }

            const reader = new FileReader();
            reader.onloadend = async () => {
                const base64data = reader.result.split(',')[1];

                if (!base64data || base64data.length < 100) {
                    console.error('Invalid base64 data generated');
                    return;
                }

                const result = await ipcRenderer.invoke('send-image-content', {
                    data: base64data,
                });

                if (result.success) {
                    console.log(`Image sent successfully (${offscreenCanvas.width}x${offscreenCanvas.height})`);
                } else {
                    console.error('Failed to send image:', result.error);
                }
            };
            reader.readAsDataURL(blob);
        },
        'image/jpeg',
        qualityValue
    );
}

// 返回主进程的答复；什么都没发出去时返回 null。调用方拿这个值来结束自己的忙碌态，所以每条拒绝发送的
// 路径都必须说得出话——静默 return 会让按钮一直转到下一次会话。
async function captureManualScreenshot(imageQuality = null) {
    console.log('Manual screenshot triggered');
    const quality = imageQuality || currentImageQuality;

    if (!mediaStream) {
        console.warn('No media stream available, skipping screenshot');
        return null;
    }

    if (!hiddenVideo) {
        hiddenVideo = document.createElement('video');
        hiddenVideo.srcObject = mediaStream;
        hiddenVideo.muted = true;
        hiddenVideo.playsInline = true;
        // 播放失败时元素没有帧，下面的 readyState 检查会把它归到与「还没有帧」同一种结果：什么都没发。
        await hiddenVideo.play().catch(() => {});

        await new Promise(resolve => {
            if (hiddenVideo.readyState >= 2) return resolve();
            hiddenVideo.onloadedmetadata = () => resolve();
        });

        offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = hiddenVideo.videoWidth;
        offscreenCanvas.height = hiddenVideo.videoHeight;
        offscreenContext = offscreenCanvas.getContext('2d');
    }

    if (hiddenVideo.readyState < 2) {
        console.warn('Video not ready yet, skipping screenshot');
        return null;
    }

    // 缩到最宽 1280px 传得更快：视觉模型不需要 4K。
    const MAX_WIDTH = 1280;
    const srcW = hiddenVideo.videoWidth;
    const srcH = hiddenVideo.videoHeight;
    let destW = srcW;
    let destH = srcH;
    if (srcW > MAX_WIDTH) {
        destW = MAX_WIDTH;
        destH = Math.round(srcH * (MAX_WIDTH / srcW));
    }
    offscreenCanvas.width = destW;
    offscreenCanvas.height = destH;
    offscreenContext.drawImage(hiddenVideo, 0, 0, destW, destH);

    let qualityValue;
    switch (quality) {
        case 'high':
            qualityValue = 0.85;
            break;
        case 'medium':
            qualityValue = 0.6;
            break;
        case 'low':
            qualityValue = 0.4;
            break;
        default:
            qualityValue = 0.6;
    }

    return new Promise(resolve => {
        offscreenCanvas.toBlob(
            async blob => {
                if (!blob) {
                    console.error('Failed to create blob from canvas');
                    resolve(null);
                    return;
                }

                const reader = new FileReader();
                reader.onloadend = async () => {
                    const base64data = reader.result.split(',')[1];

                    if (!base64data || base64data.length < 100) {
                        console.error('Invalid base64 data generated');
                        resolve(null);
                        return;
                    }

                    console.log(`Sending image: ${destW}x${destH}, ~${Math.round(base64data.length / 1024)}KB`);

                    // 回答是通过详情面板事件流回来的；这个返回值只说明请求已发出去了、发给了哪个模型、开的是哪一轮。
                    try {
                        resolve(
                            await ipcRenderer.invoke('send-image-content', { data: base64data })
                        );
                    } catch (error) {
                        console.error('Failed to send screenshot:', error);
                        resolve(null);
                    }
                };
                reader.readAsDataURL(blob);
            },
            'image/jpeg',
            qualityValue
        );
    });
}

// 挂到 window 上供组件直接调用。
window.captureManualScreenshot = captureManualScreenshot;

function stopCapture() {
    capturePaused = false;

    if (screenshotInterval) {
        clearInterval(screenshotInterval);
        screenshotInterval = null;
    }

    if (audioProcessor) {
        audioProcessor.disconnect();
        audioProcessor = null;
    }

    releaseMicCapture();

    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }

    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    if (isMacOS) {
        ipcRenderer.invoke('stop-macos-audio').catch(err => {
            console.error('Error stopping macOS audio:', err);
        });
    }

    if (hiddenVideo) {
        hiddenVideo.pause();
        hiddenVideo.srcObject = null;
        hiddenVideo = null;
    }
    offscreenCanvas = null;
    offscreenContext = null;
}

// 设置页在每个声源旁显示实时电平，为此自己开了预览采集。它们只为测量而存在：音频分析完就丢，从不经 IPC
// 送出去，所以预览永远进不了字幕。离开页面时两条都拆掉。
const METER_BARS = 4;
// 低于这个值一律算 0，免得环境底噪让格子常亮。
const METER_FLOOR_DB = -55;
// 每次读取时衰减掉的电平。页面约每 80ms 读一次，一根柱子约 300ms 落下去：跟得上语速，也看得见一个音节。
const METER_RELEASE = 0.12;

let meterAudioContext = null;
let metersRunning = false;
// 采集被停掉或替换时自增，让之后再 resolve 的那个采集作废，而不是没人读却还开着。每个声源各一个计数器：
// 两者同时启动但可以各自单独重启，共用一个会让麦克风的重启把还在路上的系统声音采集作废掉。
const meterGeneration = { system: 0, mic: 0 };

const meterSources = {
    system: { stream: null, analyser: null, samples: null, nodes: [], display: 0 },
    mic: { stream: null, analyser: null, samples: null, nodes: [], display: 0 },
};

function meterContext() {
    if (!meterAudioContext || meterAudioContext.state === 'closed') {
        meterAudioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    }
    meterAudioContext.resume();
    return meterAudioContext;
}

function attachMeter(kind, stream) {
    const context = meterContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    // analyser 只在有下游时才被拉动，而电平表必须保持静音，所以信号先过一道增益为 0 的节点再接到输出。
    const mute = context.createGain();
    mute.gain.value = 0;
    analyser.connect(mute);
    mute.connect(context.destination);

    const slot = meterSources[kind];
    slot.stream = stream;
    slot.analyser = analyser;
    slot.samples = new Float32Array(analyser.fftSize);
    slot.nodes = [source, analyser, mute];
    slot.display = 0;
}

function releaseMeter(kind) {
    const slot = meterSources[kind];
    if (slot.stream) slot.stream.getTracks().forEach(track => track.stop());
    slot.nodes.forEach(node => node.disconnect());
    slot.stream = null;
    slot.analyser = null;
    slot.samples = null;
    slot.nodes = [];
    slot.display = 0;
}

// RMS 转 dB 再映射：满量程为 1、地板为 0。响度感知是对数的，线性映射会让整个有用区间里柱子都贴着底。
function meterLevel(slot) {
    if (!slot.analyser) return 0;

    slot.analyser.getFloatTimeDomainData(slot.samples);

    let sum = 0;
    for (let i = 0; i < slot.samples.length; i++) sum += slot.samples[i] * slot.samples[i];
    const db = 20 * Math.log10(Math.sqrt(sum / slot.samples.length) + 1e-8);

    return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

function readMeterLevels() {
    const levels = {};

    for (const kind of ['system', 'mic']) {
        const slot = meterSources[kind];
        const level = meterLevel(slot);
        // 立刻上升，缓慢回落。
        slot.display = level > slot.display ? level : Math.max(level, slot.display - METER_RELEASE);
        levels[kind] = slot.analyser ? Math.ceil(slot.display * METER_BARS) : 0;
    }

    return levels;
}

async function startMicMeter(deviceId, generation) {
    releaseMeter('mic');
    if (!deviceId || deviceId === 'none') return false;

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(deviceId));
    } catch (error) {
        console.warn('Microphone level meter unavailable:', error.message);
        return false;
    }

    if (generation !== meterGeneration.mic) {
        stream.getTracks().forEach(track => track.stop());
        return false;
    }

    attachMeter('mic', stream);
    return true;
}

async function startSystemMeter(generation) {
    releaseMeter('system');

    let stream;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: 1, width: { ideal: 320 }, height: { ideal: 180 } },
            audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
    } catch (error) {
        console.warn('Speaker level meter unavailable:', error.message);
        return false;
    }

    if (generation !== meterGeneration.system) {
        stream.getTracks().forEach(track => track.stop());
        return false;
    }

    // 主进程对每个请求都回一整条桌面流；这里只要回环音频，视频轨立刻停掉。
    stream.getVideoTracks().forEach(track => track.stop());
    attachMeter('system', stream);
    return true;
}

async function startAudioMeters(micDeviceId) {
    metersRunning = true;
    return Promise.all([startSystemMeter(++meterGeneration.system), startMicMeter(micDeviceId, ++meterGeneration.mic)]);
}

// 先自增才能作废上一次选择遗留的在途采集：页面一连接就启动电平表，那时还没读到存下来的偏好，所以真实
// 设备（或 'none'）到达时可能仍有一个 getUserMedia 在解析中；不自增的话它会通过 startMicMeter 里的检查，
// 挂上一个没人要的麦克风。
async function restartMicMeter(micDeviceId) {
    if (!metersRunning) return false;
    return startMicMeter(micDeviceId, ++meterGeneration.mic);
}

function stopAudioMeters() {
    metersRunning = false;
    meterGeneration.system += 1;
    meterGeneration.mic += 1;
    releaseMeter('system');
    releaseMeter('mic');
}

const audioMeter = {
    start: startAudioMeters,
    setMic: restartMicMeter,
    stop: stopAudioMeters,
    read: readMeterLevels,
};

async function sendTextMessage(text) {
    if (!text || text.trim().length === 0) {
        console.warn('Cannot send empty text message');
        return { success: false, error: 'Empty message' };
    }

    try {
        const result = await ipcRenderer.invoke('send-text-message', text);
        if (result.success) {
            console.log('Text message sent successfully');
        } else {
            console.error('Failed to send text message:', result.error);
        }
        return result;
    } catch (error) {
        console.error('Error sending text message:', error);
        return { success: false, error: error.message };
    }
}

ipcRenderer.on('save-conversation-turn', async (event, data) => {
    try {
        await storage.saveSession(data.sessionId, { conversationHistory: data.fullHistory });
        console.log('Conversation session saved:', data.sessionId);
    } catch (error) {
        console.error('Error saving conversation session:', error);
    }
});

ipcRenderer.on('save-session-context', async (event, data) => {
    try {
        await storage.saveSession(data.sessionId, {
            profile: data.profile,
            customPrompt: data.customPrompt,
        });
        console.log('Session context saved:', data.sessionId, 'profile:', data.profile);
    } catch (error) {
        console.error('Error saving session context:', error);
    }
});

ipcRenderer.on('save-detail-turn', async (event, data) => {
    try {
        await storage.saveSession(data.sessionId, { detailHistory: data.fullHistory });
        console.log('Detail turn saved:', data.sessionId);
    } catch (error) {
        console.error('Error saving detail turn:', error);
    }
});

ipcRenderer.on('save-candidate-speech', async (event, data) => {
    try {
        await storage.saveSession(data.sessionId, { candidateHistory: data.fullHistory });
        console.log('Candidate speech saved:', data.sessionId);
    } catch (error) {
        console.error('Error saving candidate speech:', error);
    }
});

ipcRenderer.on('clear-sensitive-data', async () => {
    console.log('Clearing all data...');
    await storage.clearAll();
});

function handleShortcut(shortcutKey) {
    const currentView = cheatingDaddy.getCurrentView();

    if (shortcutKey === 'ctrl+enter' || shortcutKey === 'cmd+enter') {
        if (currentView === 'main') {
            cheatingDaddy.element().handleStart();
        } else {
            captureManualScreenshot();
        }
    }
}

const cheatingDaddyApp = document.querySelector('cheating-daddy-app');

const theme = {
    themes: {
        dark: {
            background: '#101010',
            text: '#e0e0e0',
            textSecondary: '#a0a0a0',
            textMuted: '#6b6b6b',
            border: '#2a2a2a',
            accent: '#ffffff',
            btnPrimaryBg: '#ffffff',
            btnPrimaryText: '#000000',
            btnPrimaryHover: '#e0e0e0',
            tooltipBg: '#1a1a1a',
            tooltipText: '#ffffff',
            keyBg: 'rgba(255,255,255,0.1)',
        },
        light: {
            background: '#ffffff',
            text: '#1a1a1a',
            textSecondary: '#555555',
            textMuted: '#888888',
            border: '#e0e0e0',
            accent: '#000000',
            btnPrimaryBg: '#1a1a1a',
            btnPrimaryText: '#ffffff',
            btnPrimaryHover: '#333333',
            tooltipBg: '#1a1a1a',
            tooltipText: '#ffffff',
            keyBg: 'rgba(0,0,0,0.1)',
        },
        midnight: {
            background: '#0d1117',
            text: '#c9d1d9',
            textSecondary: '#8b949e',
            textMuted: '#6e7681',
            border: '#30363d',
            accent: '#58a6ff',
            btnPrimaryBg: '#58a6ff',
            btnPrimaryText: '#0d1117',
            btnPrimaryHover: '#79b8ff',
            tooltipBg: '#161b22',
            tooltipText: '#c9d1d9',
            keyBg: 'rgba(88,166,255,0.15)',
        },
        sepia: {
            background: '#f4ecd8',
            text: '#5c4b37',
            textSecondary: '#7a6a56',
            textMuted: '#998875',
            border: '#d4c8b0',
            accent: '#8b4513',
            btnPrimaryBg: '#5c4b37',
            btnPrimaryText: '#f4ecd8',
            btnPrimaryHover: '#7a6a56',
            tooltipBg: '#5c4b37',
            tooltipText: '#f4ecd8',
            keyBg: 'rgba(92,75,55,0.15)',
        },
        catppuccin: {
            background: '#1e1e2e',
            text: '#cdd6f4',
            textSecondary: '#a6adc8',
            textMuted: '#585b70',
            border: '#313244',
            accent: '#cba6f7',
            btnPrimaryBg: '#cba6f7',
            btnPrimaryText: '#1e1e2e',
            btnPrimaryHover: '#b4befe',
            tooltipBg: '#313244',
            tooltipText: '#cdd6f4',
            keyBg: 'rgba(203,166,247,0.12)',
        },
        gruvbox: {
            background: '#1d2021',
            text: '#ebdbb2',
            textSecondary: '#a89984',
            textMuted: '#665c54',
            border: '#3c3836',
            accent: '#fe8019',
            btnPrimaryBg: '#fe8019',
            btnPrimaryText: '#1d2021',
            btnPrimaryHover: '#fabd2f',
            tooltipBg: '#3c3836',
            tooltipText: '#ebdbb2',
            keyBg: 'rgba(254,128,25,0.12)',
        },
        rosepine: {
            background: '#191724',
            text: '#e0def4',
            textSecondary: '#908caa',
            textMuted: '#6e6a86',
            border: '#26233a',
            accent: '#ebbcba',
            btnPrimaryBg: '#ebbcba',
            btnPrimaryText: '#191724',
            btnPrimaryHover: '#f6c177',
            tooltipBg: '#26233a',
            tooltipText: '#e0def4',
            keyBg: 'rgba(235,188,186,0.12)',
        },
        solarized: {
            background: '#002b36',
            text: '#93a1a1',
            textSecondary: '#839496',
            textMuted: '#586e75',
            border: '#073642',
            accent: '#2aa198',
            btnPrimaryBg: '#2aa198',
            btnPrimaryText: '#002b36',
            btnPrimaryHover: '#268bd2',
            tooltipBg: '#073642',
            tooltipText: '#93a1a1',
            keyBg: 'rgba(42,161,152,0.12)',
        },
        tokyonight: {
            background: '#1a1b26',
            text: '#c0caf5',
            textSecondary: '#9aa5ce',
            textMuted: '#565f89',
            border: '#292e42',
            accent: '#7aa2f7',
            btnPrimaryBg: '#7aa2f7',
            btnPrimaryText: '#1a1b26',
            btnPrimaryHover: '#bb9af7',
            tooltipBg: '#292e42',
            tooltipText: '#c0caf5',
            keyBg: 'rgba(122,162,247,0.12)',
        },
    },

    current: 'dark',

    get(name) {
        return this.themes[name] || this.themes.dark;
    },

    getAll() {
        const names = {
            dark: 'Dark',
            light: 'Light',
            midnight: 'Midnight Blue',
            sepia: 'Sepia',
            catppuccin: 'Catppuccin Mocha',
            gruvbox: 'Gruvbox Dark',
            rosepine: 'Ros\u00e9 Pine',
            solarized: 'Solarized Dark',
            tokyonight: 'Tokyo Night',
        };
        return Object.keys(this.themes).map(key => ({
            value: key,
            name: names[key] || key,
            colors: this.themes[key],
        }));
    },

    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result
            ? {
                  r: parseInt(result[1], 16),
                  g: parseInt(result[2], 16),
                  b: parseInt(result[3], 16),
              }
            : { r: 30, g: 30, b: 30 };
    },

    // 与 applyBackgrounds 用同一个亮度判据：一个主题被判为「亮色」当且仅当它亮到需要把表面压暗。算出来
    // 而不是硬编码主题名，以后新增主题不用改这里。
    isLightTheme(name) {
        const { r, g, b } = this.hexToRgb(this.get(name).background);
        return (r + g + b) / 3 > 128;
    },

    lightenColor(rgb, amount) {
        return {
            r: Math.min(255, rgb.r + amount),
            g: Math.min(255, rgb.g + amount),
            b: Math.min(255, rgb.b + amount),
        };
    },

    darkenColor(rgb, amount) {
        return {
            r: Math.max(0, rgb.r - amount),
            g: Math.max(0, rgb.g - amount),
            b: Math.max(0, rgb.b - amount),
        };
    },

    // 每个表面 token 的 alpha 写成 var() 而不是定值：拖动透明度滑块只需要重写 --ui-alpha，整个界面一帧
    // 之内就重新解析完。
    applyBackgrounds(backgroundColor) {
        const root = document.documentElement;
        const baseRgb = this.hexToRgb(backgroundColor);

        const isLight = (baseRgb.r + baseRgb.g + baseRgb.b) / 3 > 128;
        const adjust = isLight ? this.darkenColor.bind(this) : this.lightenColor.bind(this);

        const secondary = adjust(baseRgb, 10);
        const tertiary = adjust(baseRgb, 22);
        const hover = adjust(baseRgb, 28);

        const bgBase = `rgba(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b}, var(--ui-alpha))`;
        const bgSurface = `rgba(${secondary.r}, ${secondary.g}, ${secondary.b}, var(--ui-alpha))`;
        const bgElevated = `rgba(${tertiary.r}, ${tertiary.g}, ${tertiary.b}, var(--ui-alpha))`;
        const bgHover = `rgba(${hover.r}, ${hover.g}, ${hover.b}, var(--ui-alpha))`;

        // 组件读的是这一组
        root.style.setProperty('--bg-app', bgBase);
        root.style.setProperty('--bg-surface', bgSurface);
        root.style.setProperty('--bg-elevated', bgElevated);
        root.style.setProperty('--bg-hover', bgHover);

        // 老样式用的别名，同一批值
        root.style.setProperty('--header-background', bgBase);
        root.style.setProperty('--main-content-background', bgBase);
        root.style.setProperty('--bg-primary', bgBase);
        root.style.setProperty('--bg-secondary', bgSurface);
        root.style.setProperty('--bg-tertiary', bgElevated);
        root.style.setProperty('--input-background', bgElevated);
        root.style.setProperty('--input-focus-background', bgElevated);
        root.style.setProperty('--hover-background', bgHover);
        root.style.setProperty('--scrollbar-background', bgBase);
    },

    // 运行时唯一会变的两个数字。所有 token 都引用它们，所以拖一次滑块只是两次 setProperty，不必重建每
    // 一个颜色字符串。
    setAlphas(uiAlpha, textAlpha) {
        const root = document.documentElement;
        if (uiAlpha !== undefined) {
            this.uiAlpha = uiAlpha;
            root.style.setProperty('--ui-alpha', String(uiAlpha));
        }
        if (textAlpha !== undefined) {
            this.textAlpha = textAlpha;
            root.style.setProperty('--text-alpha', String(textAlpha));
        }
    },

    apply(themeName, uiAlpha = 0.8, textAlpha = 1) {
        const colors = this.get(themeName);
        this.current = themeName;
        const root = document.documentElement;

        this.setAlphas(uiAlpha, textAlpha);

        const rgba = (hex, alphaVar) => {
            const rgb = this.hexToRgb(hex);
            return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alphaVar})`;
        };

        // 文字跟字体透明度，边框跟组件透明度。--border-strong 故意不透明：它就是强调色，同时充当聚焦/
        // 高亮描边。
        const textPrimary = rgba(colors.text, 'var(--text-alpha)');
        const textSecondary = rgba(colors.textSecondary, 'var(--text-alpha)');
        const textMuted = rgba(colors.textMuted, 'var(--text-alpha)');
        const border = rgba(colors.border, 'var(--ui-alpha)');

        // 组件读的是这一组
        root.style.setProperty('--text-primary', textPrimary);
        root.style.setProperty('--text-secondary', textSecondary);
        root.style.setProperty('--text-muted', textMuted);
        root.style.setProperty('--border', border);
        root.style.setProperty('--border-strong', colors.accent);
        root.style.setProperty('--accent', colors.btnPrimaryBg);
        root.style.setProperty('--accent-hover', colors.btnPrimaryHover);
        // 链接是文字，所以与 --accent 不同，它必须跟字体透明度走。
        root.style.setProperty('--link-color', rgba(colors.btnPrimaryBg, 'var(--text-alpha)'));

        // 老样式用的别名，同一批值
        root.style.setProperty('--text-color', textPrimary);
        root.style.setProperty('--border-color', border);
        root.style.setProperty('--border-default', colors.accent);
        root.style.setProperty('--placeholder-color', textMuted);
        root.style.setProperty('--scrollbar-thumb', border);
        root.style.setProperty('--scrollbar-thumb-hover', textMuted);
        root.style.setProperty('--key-background', colors.keyBg);
        root.style.setProperty('--btn-primary-bg', colors.btnPrimaryBg);
        root.style.setProperty('--btn-primary-text', colors.btnPrimaryText);
        root.style.setProperty('--btn-primary-hover', colors.btnPrimaryHover);
        // 开始按钮与主按钮同色，改一处要跟着改另一处。
        root.style.setProperty('--start-button-background', colors.btnPrimaryBg);
        root.style.setProperty('--start-button-color', colors.btnPrimaryText);
        root.style.setProperty('--start-button-hover-background', colors.btnPrimaryHover);
        root.style.setProperty('--tooltip-bg', colors.tooltipBg);
        root.style.setProperty('--tooltip-text', colors.tooltipText);
        root.style.setProperty('--error-color', '#f14c4c');
        root.style.setProperty('--success-color', '#4caf50');

        this.applyBackgrounds(colors.background);
    },

    async load() {
        try {
            const prefs = await storage.getPreferences();
            const themeName = prefs.theme || 'dark';
            const alpha = prefs.backgroundTransparency ?? 0.8;
            const textAlpha = prefs.textTransparency ?? 1;
            this.apply(themeName, alpha, textAlpha);
            return themeName;
        } catch (err) {
            this.apply('dark');
            return 'dark';
        }
    },

    // 两个 alpha 都要传进来：换主题不能顺手把用户调好的透明度重置掉。
    async save(themeName, uiAlpha, textAlpha) {
        await storage.updatePreference('theme', themeName);
        this.apply(themeName, uiAlpha, textAlpha);
    },

    // 翻到调色板的另一半，好让浮层压在什么背景上都读得清。每种极性最后用过的那套主题记在内存里，所以
    // 翻回来能回到用户自己的主题，而不是一个固定默认值。
    async togglePolarity() {
        const current = this.current;
        const isLight = this.isLightTheme(current);

        if (isLight) {
            this.lastLightTheme = current;
        } else {
            this.lastDarkTheme = current;
        }

        const target = isLight ? this.lastDarkTheme || 'dark' : this.lastLightTheme || 'light';
        await this.save(target, this.uiAlpha, this.textAlpha);
    },
};

const cheatingDaddy = {
    getVersion: async () => ipcRenderer.invoke('get-app-version'),

    element: () => cheatingDaddyApp,
    e: () => cheatingDaddyApp,

    getCurrentView: () => cheatingDaddyApp.currentView,
    getLayoutMode: () => cheatingDaddyApp.layoutMode,

    setStatus: text => cheatingDaddyApp.setStatus(text),
    addNewResponse: response => cheatingDaddyApp.addNewResponse(response),
    updateCurrentResponse: response => cheatingDaddyApp.updateCurrentResponse(response),

    initializeChat,
    startCapture,
    stopCapture,
    sendTextMessage,
    handleShortcut,

    // 暂停时两条采集照旧跑，只是不再喂给识别器；清空只重置模型看过的上下文，不动磁盘上的记录。
    setPaused: async value => {
        capturePaused = Boolean(value);
        return ipcRenderer.invoke('set-audio-paused', Boolean(value));
    },
    clearContext: () => ipcRenderer.invoke('clear-context'),

    storage,

    knowledge,

    theme,

    audioMeter,

    // 改完偏好设置要调一次，否则读到的还是旧的缓存值。
    refreshPreferencesCache: loadPreferencesCache,

    isMacOS: isMacOS,
};

window.cheatingDaddy = cheatingDaddy;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => theme.load());
} else {
    theme.load();
}
