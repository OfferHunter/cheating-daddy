// renderer.js
const { ipcRenderer } = require('electron');

let mediaStream = null;
let screenshotInterval = null;
let audioContext = null;
let audioProcessor = null;
let micAudioProcessor = null;
let audioBuffer = [];
const SAMPLE_RATE = 24000;
const AUDIO_CHUNK_DURATION = 0.1; // seconds
const BUFFER_SIZE = 4096; // Increased buffer size for smoother audio

let hiddenVideo = null;
let offscreenCanvas = null;
let offscreenContext = null;
let currentImageQuality = 'medium'; // Store current image quality for manual screenshots

const isLinux = process.platform === 'linux';
const isMacOS = process.platform === 'darwin';

// ============ STORAGE API ============
// Wrapper for IPC-based storage access
const storage = {
    // Config
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

    // Credentials
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

    // Preferences
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

    // Keybinds
    async getKeybinds() {
        const result = await ipcRenderer.invoke('storage:get-keybinds');
        return result.success ? result.data : null;
    },
    async setKeybinds(keybinds) {
        return ipcRenderer.invoke('storage:set-keybinds', keybinds);
    },

    // Sessions (History)
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

    // Clear all
    async clearAll() {
        return ipcRenderer.invoke('storage:clear-all');
    },
};

// Cache for preferences to avoid async calls in hot paths
let preferencesCache = null;

async function loadPreferencesCache() {
    preferencesCache = await storage.getPreferences();
    return preferencesCache;
}

// Initialize preferences cache
loadPreferencesCache();

function convertFloat32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        // Improved scaling to prevent clipping
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

async function initializeChat(profile = 'interview') {
    const prefs = await storage.getPreferences();
    const customPrompt = prefs.customPrompt || '';
    const selectedLanguage = prefs.selectedLanguage || 'cmn-CN';

    const success = await ipcRenderer.invoke('initialize-chat', profile, customPrompt, selectedLanguage);
    if (success) {
        cheatingDaddy.setStatus('Live');
        return true;
    }
    cheatingDaddy.setStatus('error');
    return false;
}

// Listen for status updates
ipcRenderer.on('update-status', (event, status) => {
    console.log('Status update:', status);
    cheatingDaddy.setStatus(status);
});

// 'none' is the user's explicit "don't use a microphone" choice from Settings, so it never reaches
// here. A concrete deviceId is passed as 'ideal' rather than 'exact': if that device has since been
// unplugged we fall back to the system default instead of failing the capture outright.
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
    // Store the image quality for manual screenshots
    currentImageQuality = imageQuality;

    // Refresh preferences cache
    await loadPreferencesCache();
    const micDeviceId = preferencesCache.audioInputDeviceId || 'none';
    // The microphone is the candidate's own channel: it runs alongside the speaker path rather than
    // replacing it, so the only thing that turns it off is an explicit "no microphone" choice.
    const shouldCaptureMic = micDeviceId !== 'none';

    try {
        if (isMacOS) {
            // On macOS, use SystemAudioDump for audio and getDisplayMedia for screen
            console.log('Starting macOS capture with SystemAudioDump...');

            // Start macOS audio capture
            const audioResult = await ipcRenderer.invoke('start-macos-audio');
            if (!audioResult.success) {
                throw new Error('Failed to start macOS audio capture: ' + audioResult.error);
            }

            // Get screen capture for screenshots
            mediaStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    frameRate: 1,
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
                audio: false, // Don't use browser audio on macOS
            });

            console.log('macOS screen capture started - audio handled by SystemAudioDump');

            if (shouldCaptureMic) {
                let micStream = null;
                try {
                    micStream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(micDeviceId));
                    console.log('macOS microphone capture started');
                    setupLinuxMicProcessing(micStream);
                } catch (micError) {
                    console.warn('Failed to get microphone access on macOS:', micError);
                }
            }
        } else if (isLinux) {
            // Linux - use display media for screen capture and try to get system audio
            try {
                // First try to get system audio via getDisplayMedia (works on newer browsers)
                mediaStream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        frameRate: 1,
                        width: { ideal: 1920 },
                        height: { ideal: 1080 },
                    },
                    audio: {
                        sampleRate: SAMPLE_RATE,
                        channelCount: 1,
                        echoCancellation: false, // Don't cancel system audio
                        noiseSuppression: false,
                        autoGainControl: false,
                    },
                });

                console.log('Linux system audio capture via getDisplayMedia succeeded');

                // Setup audio processing for Linux system audio
                setupLinuxSystemAudioProcessing();
            } catch (systemAudioError) {
                console.warn('System audio via getDisplayMedia failed, trying screen-only capture:', systemAudioError);

                // Fallback to screen-only capture
                mediaStream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        frameRate: 1,
                        width: { ideal: 1920 },
                        height: { ideal: 1080 },
                    },
                    audio: false,
                });
            }

            // Additionally get microphone input for Linux based on audio mode
            if (shouldCaptureMic) {
                let micStream = null;
                try {
                    micStream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(micDeviceId));

                    console.log('Linux microphone capture started');

                    // Setup audio processing for microphone on Linux
                    setupLinuxMicProcessing(micStream);
                } catch (micError) {
                    console.warn('Failed to get microphone access on Linux:', micError);
                    // Continue without microphone if permission denied
                }
            }

            console.log('Linux capture started - system audio:', mediaStream.getAudioTracks().length > 0, 'microphone:', shouldCaptureMic);
        } else {
            // Windows - use display media with loopback for system audio
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

            // Setup audio processing for Windows loopback audio only
            setupWindowsLoopbackProcessing();

            if (shouldCaptureMic) {
                let micStream = null;
                try {
                    micStream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(micDeviceId));
                    console.log('Windows microphone capture started');
                    setupLinuxMicProcessing(micStream);
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

        // Manual mode only - screenshots captured on demand via shortcut
        console.log('Manual mode enabled - screenshots will be captured on demand only');
    } catch (err) {
        console.error('Error starting capture:', err);
        cheatingDaddy.setStatus('error');
    }
}

function setupLinuxMicProcessing(micStream) {
    // Setup microphone audio processing for Linux
    const micAudioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const micSource = micAudioContext.createMediaStreamSource(micStream);
    const micProcessor = micAudioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    let audioBuffer = [];
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;

    micProcessor.onaudioprocess = async e => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioBuffer.push(...inputData);

        // Process audio in chunks
        while (audioBuffer.length >= samplesPerChunk) {
            const chunk = audioBuffer.splice(0, samplesPerChunk);
            const pcmData16 = convertFloat32ToInt16(chunk);
            const base64Data = arrayBufferToBase64(pcmData16.buffer);

            await ipcRenderer.invoke('send-mic-audio-content', {
                data: base64Data,
                mimeType: 'audio/pcm;rate=24000',
            });
        }
    };

    micSource.connect(micProcessor);
    micProcessor.connect(micAudioContext.destination);

    // Store processor reference for cleanup
    micAudioProcessor = micProcessor;
}

function setupLinuxSystemAudioProcessing() {
    // Setup system audio processing for Linux (from getDisplayMedia)
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioContext.createMediaStreamSource(mediaStream);
    audioProcessor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    let audioBuffer = [];
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;

    audioProcessor.onaudioprocess = async e => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioBuffer.push(...inputData);

        // Process audio in chunks
        while (audioBuffer.length >= samplesPerChunk) {
            const chunk = audioBuffer.splice(0, samplesPerChunk);
            const pcmData16 = convertFloat32ToInt16(chunk);
            const base64Data = arrayBufferToBase64(pcmData16.buffer);

            await ipcRenderer.invoke('send-audio-content', {
                data: base64Data,
                mimeType: 'audio/pcm;rate=24000',
            });
        }
    };

    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);
}

function setupWindowsLoopbackProcessing() {
    // Setup audio processing for Windows loopback audio only
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioContext.createMediaStreamSource(mediaStream);
    audioProcessor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    let audioBuffer = [];
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;

    audioProcessor.onaudioprocess = async e => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioBuffer.push(...inputData);

        // Process audio in chunks
        while (audioBuffer.length >= samplesPerChunk) {
            const chunk = audioBuffer.splice(0, samplesPerChunk);
            const pcmData16 = convertFloat32ToInt16(chunk);
            const base64Data = arrayBufferToBase64(pcmData16.buffer);

            await ipcRenderer.invoke('send-audio-content', {
                data: base64Data,
                mimeType: 'audio/pcm;rate=24000',
            });
        }
    };

    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);
}

async function captureScreenshot(imageQuality = 'medium', isManual = false) {
    console.log(`Capturing ${isManual ? 'manual' : 'automated'} screenshot...`);
    if (!mediaStream) return;

    // Lazy init of video element
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

        // Lazy init of canvas based on video dimensions
        offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = hiddenVideo.videoWidth;
        offscreenCanvas.height = hiddenVideo.videoHeight;
        offscreenContext = offscreenCanvas.getContext('2d');
    }

    // Check if video is ready
    if (hiddenVideo.readyState < 2) {
        console.warn('Video not ready yet, skipping screenshot');
        return;
    }

    offscreenContext.drawImage(hiddenVideo, 0, 0, offscreenCanvas.width, offscreenCanvas.height);

    // Check if image was drawn properly by sampling a pixel
    const imageData = offscreenContext.getImageData(0, 0, 1, 1);
    const isBlank = imageData.data.every((value, index) => {
        // Check if all pixels are black (0,0,0) or transparent
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
            qualityValue = 0.7; // Default to medium
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

                // Validate base64 data
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

const MANUAL_SCREENSHOT_PROMPT = `帮我看下这个页面，直接给答案，别说废话，要完整。
如果是代码题，先用几个要点讲思路，再给出完整代码；如果有别的需要我知道的，也一并说明。
如果是关于这个网站的问题，直接给答案，别说废话，要完整。
如果是选择题，直接给答案，别说废话，要完整。
使用页面/题目所用的语言作答：中文内容就用简体中文，英文内容就用英文。专业术语（如 React、Kubernetes、ROI）保留英文原词。`;

async function captureManualScreenshot(imageQuality = null) {
    console.log('Manual screenshot triggered');
    const quality = imageQuality || currentImageQuality;

    if (!mediaStream) {
        console.error('No media stream available');
        return;
    }

    // Lazy init of video element
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

        // Lazy init of canvas based on video dimensions
        offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = hiddenVideo.videoWidth;
        offscreenCanvas.height = hiddenVideo.videoHeight;
        offscreenContext = offscreenCanvas.getContext('2d');
    }

    // Check if video is ready
    if (hiddenVideo.readyState < 2) {
        console.warn('Video not ready yet, skipping screenshot');
        return;
    }

    // Downscale to max 1280px wide for faster transfer — vision models don't need 4K
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

                console.log(`Sending image: ${destW}x${destH}, ~${Math.round(base64data.length / 1024)}KB`);

                // Send image with prompt to HTTP API (response streams via IPC events)
                const result = await ipcRenderer.invoke('send-image-content', {
                    data: base64data,
                    prompt: MANUAL_SCREENSHOT_PROMPT,
                });

                if (result.success) {
                    console.log(`Image response completed from ${result.model}`);
                    // Response already displayed via streaming events (new-response/update-response)
                } else {
                    console.error('Failed to get image response:', result.error);
                    cheatingDaddy.addNewResponse(`Error: ${result.error}`);
                }
            };
            reader.readAsDataURL(blob);
        },
        'image/jpeg',
        qualityValue
    );
}

// Expose functions to global scope for external access
window.captureManualScreenshot = captureManualScreenshot;

function stopCapture() {
    if (screenshotInterval) {
        clearInterval(screenshotInterval);
        screenshotInterval = null;
    }

    if (audioProcessor) {
        audioProcessor.disconnect();
        audioProcessor = null;
    }

    // Clean up microphone audio processor (Linux only)
    if (micAudioProcessor) {
        micAudioProcessor.disconnect();
        micAudioProcessor = null;
    }

    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }

    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    // Stop macOS audio capture if running
    if (isMacOS) {
        ipcRenderer.invoke('stop-macos-audio').catch(err => {
            console.error('Error stopping macOS audio:', err);
        });
    }

    // Clean up hidden elements
    if (hiddenVideo) {
        hiddenVideo.pause();
        hiddenVideo.srcObject = null;
        hiddenVideo = null;
    }
    offscreenCanvas = null;
    offscreenContext = null;
}

// ── Settings level meters ──
// The Settings page shows a live level next to each source, so it opens preview captures of its
// own. They exist only to be measured: the audio is analysed and dropped, never sent over IPC, so
// a preview can never reach the transcript. Both are torn down when the page is left.
const METER_BARS = 4;
// Everything below this reads as zero, so room tone does not keep a bar lit.
const METER_FLOOR_DB = -55;
// Level lost per read while falling. The page reads every ~80 ms, so a bar takes about 300 ms to
// go out: short enough to follow speech, long enough for a syllable to be seen.
const METER_RELEASE = 0.12;

let meterAudioContext = null;
let metersRunning = false;
// Bumped whenever a capture is stopped, so a capture that resolves afterwards is thrown away
// instead of being left running with nobody reading it.
let metersGeneration = 0;

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

    // An analyser is only pulled while it leads somewhere, and the meter has to stay silent, so
    // the signal is routed into a zero gain before the destination.
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

// RMS in dB, mapped so full scale is 1 and the floor is 0. Loudness is perceived logarithmically,
// so a linear mapping would leave the bars near the bottom through the whole useful range.
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
        // Instant attack, slow release.
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

    if (generation !== metersGeneration) {
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

    if (generation !== metersGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return false;
    }

    // The main process answers every request with a whole desktop stream; only the loopback audio
    // is wanted here, so the screen track is dropped straight away.
    stream.getVideoTracks().forEach(track => track.stop());
    attachMeter('system', stream);
    return true;
}

async function startAudioMeters(micDeviceId) {
    metersRunning = true;
    const generation = ++metersGeneration;
    return Promise.all([startSystemMeter(generation), startMicMeter(micDeviceId, generation)]);
}

async function restartMicMeter(micDeviceId) {
    if (!metersRunning) return false;
    return startMicMeter(micDeviceId, metersGeneration);
}

function stopAudioMeters() {
    metersRunning = false;
    metersGeneration += 1;
    releaseMeter('system');
    releaseMeter('mic');
}

const audioMeter = {
    start: startAudioMeters,
    setMic: restartMicMeter,
    stop: stopAudioMeters,
    read: readMeterLevels,
};

// Send text message to the chat endpoint
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

// Listen for conversation data from main process and save to storage
ipcRenderer.on('save-conversation-turn', async (event, data) => {
    try {
        await storage.saveSession(data.sessionId, { conversationHistory: data.fullHistory });
        console.log('Conversation session saved:', data.sessionId);
    } catch (error) {
        console.error('Error saving conversation session:', error);
    }
});

// Listen for session context (profile info) when session starts
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

// Listen for screen analysis responses (from ctrl+enter)
ipcRenderer.on('save-screen-analysis', async (event, data) => {
    try {
        await storage.saveSession(data.sessionId, {
            screenAnalysisHistory: data.fullHistory,
            profile: data.profile,
            customPrompt: data.customPrompt,
        });
        console.log('Screen analysis saved:', data.sessionId);
    } catch (error) {
        console.error('Error saving screen analysis:', error);
    }
});

// Listen for emergency erase command from main process
ipcRenderer.on('clear-sensitive-data', async () => {
    console.log('Clearing all data...');
    await storage.clearAll();
});

// Handle shortcuts based on current view
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

// Create reference to the main app element
const cheatingDaddyApp = document.querySelector('cheating-daddy-app');

// ============ THEME SYSTEM ============
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

    // Same luminance test applyBackgrounds uses, so a theme counts as "light" for the toggle exactly
    // when it is light enough to have its surfaces darkened. Computed rather than a hardcoded list of
    // theme names, so themes added later are classified without touching this.
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

    // Every surface token carries the alpha as a var() instead of a baked number, so dragging the
    // opacity slider only has to rewrite --ui-alpha and the whole app re-resolves in one frame.
    applyBackgrounds(backgroundColor) {
        const root = document.documentElement;
        const baseRgb = this.hexToRgb(backgroundColor);

        // For light themes, darken; for dark themes, lighten
        const isLight = (baseRgb.r + baseRgb.g + baseRgb.b) / 3 > 128;
        const adjust = isLight ? this.darkenColor.bind(this) : this.lightenColor.bind(this);

        const secondary = adjust(baseRgb, 10);
        const tertiary = adjust(baseRgb, 22);
        const hover = adjust(baseRgb, 28);

        const bgBase = `rgba(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b}, var(--ui-alpha))`;
        const bgSurface = `rgba(${secondary.r}, ${secondary.g}, ${secondary.b}, var(--ui-alpha))`;
        const bgElevated = `rgba(${tertiary.r}, ${tertiary.g}, ${tertiary.b}, var(--ui-alpha))`;
        const bgHover = `rgba(${hover.r}, ${hover.g}, ${hover.b}, var(--ui-alpha))`;

        // New design tokens (used by components)
        root.style.setProperty('--bg-app', bgBase);
        root.style.setProperty('--bg-surface', bgSurface);
        root.style.setProperty('--bg-elevated', bgElevated);
        root.style.setProperty('--bg-hover', bgHover);

        // Legacy aliases
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

    // The only two numbers that change at runtime. Tokens reference them, so a slider drag is a pair
    // of setProperty calls rather than a rebuild of every colour string.
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

        // Text follows the font alpha; borders follow the component alpha. --border-strong is left
        // opaque on purpose: it is the accent colour and doubles as a focus/highlight outline.
        const textPrimary = rgba(colors.text, 'var(--text-alpha)');
        const textSecondary = rgba(colors.textSecondary, 'var(--text-alpha)');
        const textMuted = rgba(colors.textMuted, 'var(--text-alpha)');
        const border = rgba(colors.border, 'var(--ui-alpha)');

        // New design tokens (used by components)
        root.style.setProperty('--text-primary', textPrimary);
        root.style.setProperty('--text-secondary', textSecondary);
        root.style.setProperty('--text-muted', textMuted);
        root.style.setProperty('--border', border);
        root.style.setProperty('--border-strong', colors.accent);
        root.style.setProperty('--accent', colors.btnPrimaryBg);
        root.style.setProperty('--accent-hover', colors.btnPrimaryHover);
        // Links are text, so unlike --accent they have to follow the font alpha.
        root.style.setProperty('--link-color', rgba(colors.btnPrimaryBg, 'var(--text-alpha)'));

        // Legacy aliases
        root.style.setProperty('--text-color', textPrimary);
        root.style.setProperty('--border-color', border);
        root.style.setProperty('--border-default', colors.accent);
        root.style.setProperty('--placeholder-color', textMuted);
        root.style.setProperty('--scrollbar-thumb', border);
        root.style.setProperty('--scrollbar-thumb-hover', textMuted);
        root.style.setProperty('--key-background', colors.keyBg);
        // Primary button
        root.style.setProperty('--btn-primary-bg', colors.btnPrimaryBg);
        root.style.setProperty('--btn-primary-text', colors.btnPrimaryText);
        root.style.setProperty('--btn-primary-hover', colors.btnPrimaryHover);
        // Start button (same as primary)
        root.style.setProperty('--start-button-background', colors.btnPrimaryBg);
        root.style.setProperty('--start-button-color', colors.btnPrimaryText);
        root.style.setProperty('--start-button-hover-background', colors.btnPrimaryHover);
        // Tooltip
        root.style.setProperty('--tooltip-bg', colors.tooltipBg);
        root.style.setProperty('--tooltip-text', colors.tooltipText);
        // Error color (stays constant)
        root.style.setProperty('--error-color', '#f14c4c');
        root.style.setProperty('--success-color', '#4caf50');

        // Also apply background colors from theme
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

    // Both alphas are passed in: applying a theme must not silently reset the user's opacity.
    async save(themeName, uiAlpha, textAlpha) {
        await storage.updatePreference('theme', themeName);
        this.apply(themeName, uiAlpha, textAlpha);
    },

    // Flips to the other half of the palette so the overlay stays readable whatever is behind it.
    // The last theme of each polarity is remembered in memory, so toggling back returns to the
    // user's real theme instead of a fixed default.
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

// Consolidated cheatingDaddy object - all functions in one place
const cheatingDaddy = {
    // App version
    getVersion: async () => ipcRenderer.invoke('get-app-version'),

    // Element access
    element: () => cheatingDaddyApp,
    e: () => cheatingDaddyApp,

    // App state functions - access properties directly from the app element
    getCurrentView: () => cheatingDaddyApp.currentView,
    getLayoutMode: () => cheatingDaddyApp.layoutMode,

    // Status and response functions
    setStatus: text => cheatingDaddyApp.setStatus(text),
    addNewResponse: response => cheatingDaddyApp.addNewResponse(response),
    updateCurrentResponse: response => cheatingDaddyApp.updateCurrentResponse(response),

    // Core functionality
    initializeChat,
    startCapture,
    stopCapture,
    sendTextMessage,
    handleShortcut,

    // Storage API
    storage,

    // Theme API
    theme,

    // Settings level meters
    audioMeter,

    // Refresh preferences cache (call after updating preferences)
    refreshPreferencesCache: loadPreferencesCache,

    // Platform detection
    isLinux: isLinux,
    isMacOS: isMacOS,
};

// Make it globally available
window.cheatingDaddy = cheatingDaddy;

// Load theme after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => theme.load());
} else {
    theme.load();
}
