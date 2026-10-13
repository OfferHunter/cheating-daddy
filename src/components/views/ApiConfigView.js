const { DEFAULT_CONFIG } = window.require('./defaults');
import { html, css } from '../../assets/lit-core-2.7.4.min.js';
import { LocalizedLitElement, t } from '../../utils/i18n.js';
import { scrollbarStyles, unifiedPageStyles } from './sharedPageStyles.js';

// 组件是 ES module，主进程能力统一经 window.require 取用（nodeIntegration 已开）。
const { ipcRenderer } = window.require('electron');

const DEFAULT_CHAT_BASE_URL = DEFAULT_CONFIG.chatBaseUrl;
const DEFAULT_CHAT_MODEL = DEFAULT_CONFIG.deepseekModel;
const DEFAULT_BAILIAN_MODEL = DEFAULT_CONFIG.bailianModel;
const DEFAULT_BAILIAN_WS_URL = DEFAULT_CONFIG.bailianWsUrl;

// 试听采集统一按 16kHz 起 AudioContext，出来就是识别端点要的采样率，主进程不必再重采样。
const TEST_SAMPLE_RATE = 16000;
// 与主进程音频泵同一节奏：100ms 一帧。
const TEST_CHUNK_SECONDS = 0.1;

function floatToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const sample = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return int16Array;
}

function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

export class ApiConfigView extends LocalizedLitElement {
    static styles = [
        unifiedPageStyles,
        scrollbarStyles,
        css`
            .control.wide {
                width: 100%;
            }

            /* 帮助文案里的外链：没有这条会被 * 的 cursor:default 盖成普通灰字，看不出能点。
               固定 xs 是为了搬到 label 行后仍与原先 .form-help 里的字号一致。 */
            .link {
                color: var(--link-color);
                text-decoration: none;
                cursor: pointer;
                font-size: var(--font-size-xs);
            }

            .link:hover {
                text-decoration: underline;
            }

            /* 小标题与外链同一行：标题靠左，外链贴右，基线对齐好容忍两边字号不同。 */
            .label-row {
                display: flex;
                align-items: baseline;
                justify-content: space-between;
                gap: var(--space-sm);
            }

            .test-row {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
            }

            /* 单行滚动：超出就横向滚，永远停在末尾，于是看到的总是刚说出来的那几个字。 */
            .test-output {
                flex: 1;
                min-width: 0;
                height: 38px;
                line-height: 36px;
                padding: 0 12px;
                background: var(--bg-elevated);
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                color: var(--text-primary);
                font-size: var(--font-size-sm);
                white-space: nowrap;
                overflow: hidden;
            }

            .test-output.empty {
                color: var(--text-muted);
            }

            .test-source {
                width: 200px;
                flex: none;
                cursor: pointer;
            }

            .btn-test {
                width: auto;
                flex: none;
                padding: 9px 14px;
                color: var(--text-primary);
                cursor: pointer;
            }

            .btn-test:hover {
                border-color: var(--border-strong);
            }
        `,
    ];

    static properties = {
        onExternalLink: { type: Function },
        _chatBaseUrl: { state: true },
        _chatKey: { state: true },
        _chatModel: { state: true },
        _bailianKey: { state: true },
        _bailianWsUrl: { state: true },
        _bailianModel: { state: true },
        _testSource: { state: true },
        _testMicDevices: { state: true },
        _testing: { state: true },
        _testText: { state: true },
        _testState: { state: true },
        _testError: { state: true },
    };

    constructor() {
        super();
        this.onExternalLink = () => {};

        this._chatBaseUrl = DEFAULT_CHAT_BASE_URL;
        this._chatKey = '';
        this._chatModel = DEFAULT_CHAT_MODEL;
        this._bailianKey = '';
        this._bailianWsUrl = DEFAULT_BAILIAN_WS_URL;
        this._bailianModel = DEFAULT_BAILIAN_MODEL;

        this._testSource = 'default';
        this._testMicDevices = [];
        this._testing = false;
        // 打开采集（权限弹窗、设备启动）是异步的，这期间 _testing 还是 false：没有这个忙标志，第二次点击会再
        // 走进 _startTest，把第一条 MediaStream 覆盖丢失。_connected 则用来发现「打开期间页面已被切走」。
        this._opening = false;
        this._connected = false;
        this._testText = '';
        this._testState = '';
        this._testError = '';

        // 试听这条采集与它的连接，只在页面活着时存在。
        this._capture = null;
        this._committed = '';
        this._interim = '';

        this._onSentence = (_, data) => this._handleSentence(data);
        this._onState = (_, state) => this._handleState(state);
        this._onError = (_, message) => this._handleError(message);

        this._loadFromStorage();
    }

    connectedCallback() {
        super.connectedCallback();
        this._connected = true;
        ipcRenderer.on('asr-test:sentence', this._onSentence);
        ipcRenderer.on('asr-test:state', this._onState);
        ipcRenderer.on('asr-test:error', this._onError);
        this._loadMicDevices();
    }

    // 离开页面 = 关掉连接、释放麦克风。事件监听也在这里摘掉，否则回到别的页面还会被识别结果打扰。
    disconnectedCallback() {
        super.disconnectedCallback();
        this._connected = false;
        this._stopTest();
        ipcRenderer.removeListener('asr-test:sentence', this._onSentence);
        ipcRenderer.removeListener('asr-test:state', this._onState);
        ipcRenderer.removeListener('asr-test:error', this._onError);
    }

    updated() {
        super.updated();
        // 每条识别结果都把输出框滚到最右，让刚说出来的字留在视野里。
        const output = this.renderRoot?.querySelector('.test-output');
        if (output) output.scrollLeft = output.scrollWidth;
    }

    async _loadFromStorage() {
        try {
            const [config, creds] = await Promise.all([offerHunter.storage.getConfig(), offerHunter.storage.getCredentials().catch(() => ({}))]);

            this._chatBaseUrl = config.chatBaseUrl || DEFAULT_CHAT_BASE_URL;
            this._chatModel = config.deepseekModel || DEFAULT_CHAT_MODEL;
            this._bailianWsUrl = config.bailianWsUrl || DEFAULT_BAILIAN_WS_URL;
            this._bailianModel = config.bailianModel || DEFAULT_BAILIAN_MODEL;
            this._chatKey = creds.deepseekApiKey || '';
            this._bailianKey = creds.bailianApiKey || '';

            this.requestUpdate();
        } catch (error) {
            console.error('Error loading API config storage:', error);
        }
    }

    async _loadMicDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            this._testMicDevices = devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default').map(d => ({ deviceId: d.deviceId, label: d.label }));
        } catch (error) {
            console.error('Error enumerating audio devices:', error);
            this._testMicDevices = [];
        }
        this.requestUpdate();
    }

    async _saveChatBaseUrl(val) {
        this._chatBaseUrl = val;
        await offerHunter.storage.updateConfig('chatBaseUrl', val);
        this.requestUpdate();
    }

    async _saveChatKey(val) {
        this._chatKey = val;
        await offerHunter.storage.setDeepseekApiKey(val);
        this.requestUpdate();
    }

    async _saveChatModel(val) {
        this._chatModel = val;
        await offerHunter.storage.updateConfig('deepseekModel', val);
        this.requestUpdate();
    }

    async _saveBailianKey(val) {
        this._bailianKey = val;
        await offerHunter.storage.setBailianApiKey(val);
        this.requestUpdate();
    }

    async _saveBailianWsUrl(val) {
        this._bailianWsUrl = val;
        await offerHunter.storage.updateConfig('bailianWsUrl', val);
        this.requestUpdate();
    }

    async _saveBailianModel(val) {
        this._bailianModel = val;
        await offerHunter.storage.updateConfig('bailianModel', val);
        this.requestUpdate();
    }

    _isChatConfigured() {
        return Boolean(this._chatBaseUrl.trim() && this._chatKey.trim() && this._chatModel.trim());
    }

    _isAsrConfigured() {
        return Boolean(this._bailianKey.trim() && this._bailianWsUrl.trim() && this._bailianModel.trim());
    }

    // 页面主标题直接充当配置状态的提示，四选一。
    _statusTitle() {
        const chat = this._isChatConfigured();
        const asr = this._isAsrConfigured();

        if (chat && asr) return 'Configuration complete';
        if (chat) return 'Speech model not configured';
        if (asr) return 'Chat model not configured';
        return 'Chat and speech models not configured';
    }

    _handleSentence(data) {
        if (!this._testing || !data) return;

        if (data.sentenceEnd) {
            this._committed += data.text;
            this._interim = '';
        } else {
            this._interim = data.text;
        }
        this._testText = this._committed + this._interim;
        this.requestUpdate();
    }

    _handleState(state) {
        this._testState = state;
        this.requestUpdate();
    }

    _handleError(message) {
        this._testError = message || '';
        this.requestUpdate();
    }

    async _toggleTest() {
        if (this._opening) return;
        if (this._testing) {
            this._stopTest();
            return;
        }
        this._opening = true;
        try {
            await this._startTest();
        } finally {
            this._opening = false;
        }
    }

    async _startTest() {
        this._committed = '';
        this._interim = '';
        this._testText = '';
        this._testState = '';
        this._testError = '';

        // 先开采集：拿不到麦克风/扬声器就直接放弃，不必白开一条识别连接。
        try {
            this._capture = this._testSource === 'system' ? await this._openSpeaker() : await this._openMic(this._testSource);
        } catch (error) {
            console.error('Error opening test capture:', error);
            this._testError = error.message || String(error);
            this.requestUpdate();
            return;
        }

        // 打开期间页面已被切走：_stopTest 早已跑过，这条刚拿到的采集必须自己放掉，否则它会一直活着。
        if (!this._connected) {
            this._releaseCapture();
            return;
        }

        this._testing = true;
        this.requestUpdate();

        await ipcRenderer.invoke('asr-test:start');
        // 麦克风一旦拿到权限，设备label 才有值。
        this._loadMicDevices();
    }

    _stopTest() {
        const hadCapture = Boolean(this._capture);
        this._releaseCapture();
        if (hadCapture || this._testing) ipcRenderer.invoke('asr-test:stop');

        this._testing = false;
        this._testState = '';
        this.requestUpdate();
    }

    _releaseCapture() {
        const capture = this._capture;
        this._capture = null;
        if (!capture) return;

        if (capture.processor) capture.processor.disconnect();
        if (capture.source) {
            try {
                capture.source.disconnect();
            } catch {
                /* 已断开 */
            }
        }
        if (capture.stream) capture.stream.getTracks().forEach(track => track.stop());
        if (capture.context) capture.context.close().catch(() => {});
    }

    async _openMic(deviceId) {
        const audio = {
            sampleRate: TEST_SAMPLE_RATE,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        };
        if (deviceId && deviceId !== 'default' && deviceId !== 'none') {
            audio.deviceId = { ideal: deviceId };
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        return this._pump(stream);
    }

    // 扬声器走与设置页电平表同一条回环采集：getDisplayMedia 拿整条桌面流，视频轨立刻停掉只留音频。
    async _openSpeaker() {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: 1, width: { ideal: 320 }, height: { ideal: 180 } },
            audio: { sampleRate: TEST_SAMPLE_RATE, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        stream.getVideoTracks().forEach(track => track.stop());
        return this._pump(stream);
    }

    // processor 的 onaudioprocess 不写 outputBuffer，输出即静音，所以接到 destination 只为让节点被拉动，
    // 不会把自己的声音放出来。这一点与主进程那两条音频泵完全一致。
    _pump(stream) {
        const context = new AudioContext({ sampleRate: TEST_SAMPLE_RATE });
        const source = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(4096, 1, 1);

        const buffer = [];
        const samplesPerChunk = TEST_SAMPLE_RATE * TEST_CHUNK_SECONDS;

        processor.onaudioprocess = event => {
            const channel = event.inputBuffer.getChannelData(0);
            for (let i = 0; i < channel.length; i++) buffer.push(channel[i]);

            while (buffer.length >= samplesPerChunk) {
                const chunk = buffer.splice(0, samplesPerChunk);
                const pcm16 = floatToInt16(chunk);
                ipcRenderer.send('asr-test:audio', bufferToBase64(pcm16.buffer));
            }
        };

        source.connect(processor);
        processor.connect(context.destination);
        return { stream, context, source, processor };
    }

    _renderChatSection() {
        return html`
            <section class="surface">
                <div class="surface-title">Chat model</div>
                <div class="form-grid">
                    <div class="form-group vertical">
                        <label class="form-label">API Base URL</label>
                        <input
                            class="control wide"
                            type="text"
                            placeholder=${DEFAULT_CHAT_BASE_URL}
                            .value=${this._chatBaseUrl}
                            @input=${e => this._saveChatBaseUrl(e.target.value)}
                        />
                        <div class="form-help">Requests go to &lt;base url&gt;/chat/completions.</div>
                    </div>

                    <div class="form-group vertical">
                        <div class="label-row">
                            <label class="form-label">API Key</label>
                            <span class="link" @click=${() => this.onExternalLink('https://platform.deepseek.com/api_keys')}>Get API Key</span>
                        </div>
                        <input
                            class="control wide"
                            type="password"
                            placeholder="Required"
                            .value=${this._chatKey}
                            @input=${e => this._saveChatKey(e.target.value)}
                        />
                    </div>

                    <div class="form-group vertical">
                        <label class="form-label">Model</label>
                        <input
                            class="control wide"
                            type="text"
                            placeholder=${DEFAULT_CHAT_MODEL}
                            .value=${this._chatModel}
                            @input=${e => this._saveChatModel(e.target.value)}
                        />
                        <div class="form-help">Write the model name exactly as the endpoint expects it.</div>
                    </div>
                </div>
            </section>
        `;
    }

    _renderTranscriptionSection() {
        return html`
            <section class="surface">
                <div class="surface-title">Transcription</div>
                <div class="form-grid">
                    <div class="form-group vertical">
                        <div class="label-row">
                            <label class="form-label">Bailian API Key</label>
                            <span class="link" @click=${() => this.onExternalLink('https://bailian.console.aliyun.com/')}>Get API Key</span>
                        </div>
                        <input
                            class="control wide"
                            type="password"
                            placeholder="Required"
                            .value=${this._bailianKey}
                            @input=${e => this._saveBailianKey(e.target.value)}
                        />
                    </div>

                    <div class="form-group vertical">
                        <div class="label-row">
                            <label class="form-label">WebSocket URL</label>
                            <span
                                class="link"
                                @click=${() =>
                                    this.onExternalLink('https://docs.bailian.console.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide')}
                                >WebSocket Documentation</span
                            >
                        </div>
                        <input
                            class="control wide"
                            type="text"
                            placeholder=${DEFAULT_BAILIAN_WS_URL}
                            .value=${this._bailianWsUrl}
                            @input=${e => this._saveBailianWsUrl(e.target.value)}
                        />
                        <div class="form-help">
                            <span>Use the wss:// API Host for the same region and workspace as the API Key and model.</span>
                        </div>
                    </div>

                    <div class="form-group vertical">
                        <div class="label-row">
                            <label class="form-label">Bailian Model</label>
                            <span
                                class="link"
                                @click=${() =>
                                    this.onExternalLink('https://docs.bailian.console.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide#%E6%94%AF%E6%8C%81%E7%9A%84%E6%A8%A1%E5%9E%8B%E4%B8%8E%E5%9C%B0%E5%9F%9F')}
                                >Speech Model Marketplace</span
                            >
                        </div>
                        <input
                            class="control wide"
                            type="text"
                            placeholder=${DEFAULT_BAILIAN_MODEL}
                            .value=${this._bailianModel}
                            @input=${e => this._saveBailianModel(e.target.value)}
                        />
                        <div class="form-help">
                            <span>Speech is streamed live to Aliyun and transcribed as you talk.</span>
                        </div>
                    </div>

                    <div class="form-group vertical">
                        <label class="form-label">Test recognition</label>
                        <div class="test-row">
                            <div class="test-output ${this._testText ? '' : 'empty'}" data-no-localize>${this._testText ||
                                t('Click "Test recognition" to start', '点击「测试识别」开始')}</div>
                            <select class="control test-source" .value=${this._testSource} @change=${e => (this._testSource = e.target.value)}>
                                <option value="default" .selected=${this._testSource === 'default'}>System default microphone</option>
                                ${this._testMicDevices.map(
                                    d => html`<option value=${d.deviceId} .selected=${this._testSource === d.deviceId} data-no-localize>
                                        ${d.label || 'Microphone'}
                                    </option>`
                                )}
                                <option value="system" .selected=${this._testSource === 'system'}>Speaker (interviewer)</option>
                            </select>
                            <button class="control btn-test" @click=${this._toggleTest}>
                                ${this._testing ? 'Stop test' : 'Test recognition'}
                            </button>
                        </div>
                        <div class="form-help ${this._testError ? 'danger' : ''}">${this._testHint()}</div>
                    </div>
                </div>
            </section>
        `;
    }

    _testHint() {
        if (this._testError) return this._testError;

        switch (this._testState) {
            case 'connecting':
                return t('Connecting...', '正在连接…');
            case 'ready':
                return t('Listening...', '正在聆听…');
            case 'reconnecting':
                return t('Reconnecting...', '正在重新连接…');
            case 'failed':
                return t('Connection failed', '连接失败');
            default:
                return t(
                    'Records from the microphone or the speaker and shows the recognized text here.',
                    '从麦克风或扬声器采集声音，把识别出来的文字显示在这里。'
                );
        }
    }

    render() {
        return html`
            <div class="unified-page">
                <div class="unified-wrap">
                    <div class="page-title">${this._statusTitle()}</div>
                    ${this._renderChatSection()} ${this._renderTranscriptionSection()}
                </div>
            </div>
        `;
    }
}

customElements.define('api-config-view', ApiConfigView);
