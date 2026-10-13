const { DEFAULT_CONFIG } = window.require('./defaults');
import { html, css } from '../../assets/lit-core-2.7.4.min.js';
import { LocalizedLitElement, t, getUiLanguage } from '../../utils/i18n.js';
import { scrollbarStyles, unifiedPageStyles } from './sharedPageStyles.js';

// 组件是 ES module，主进程能力统一经 window.require 取用（nodeIntegration 已开）。
const { ipcRenderer } = window.require('electron');

const DEFAULT_CHAT_BASE_URL = DEFAULT_CONFIG.chatBaseUrl;
const DEFAULT_CHAT_MODEL = DEFAULT_CONFIG.deepseekModel;
const DEFAULT_BAILIAN_MODEL = DEFAULT_CONFIG.bailianModel;
const DEFAULT_BAILIAN_WS_URL = DEFAULT_CONFIG.bailianWsUrl;
const DEFAULT_TENCENT_ENGINE = DEFAULT_CONFIG.tencentEngineModel;

// 语音识别服务按页翻：两家支持的语种不同，各自一份配置，翻到哪页就编／试哪一家。
const ASR_PAGES = ['bailian', 'tencent'];

// 百炼识别端点要的是 ISO-639-1。这里给的是全集，模型对不上的语种由服务端报错——比在本地硬编码每个模型
// 支持哪些语种更好维护。
const BAILIAN_LANGUAGES = [
    { code: 'zh', zh: '中文', en: 'Chinese' },
    { code: 'en', zh: '英文', en: 'English' },
    { code: 'ja', zh: '日语', en: 'Japanese' },
    { code: 'ko', zh: '韩语', en: 'Korean' },
    { code: 'vi', zh: '越南语', en: 'Vietnamese' },
    { code: 'th', zh: '泰语', en: 'Thai' },
    { code: 'id', zh: '印尼语', en: 'Indonesian' },
    { code: 'ms', zh: '马来语', en: 'Malay' },
    { code: 'tl', zh: '菲律宾语', en: 'Filipino' },
    { code: 'hi', zh: '印地语', en: 'Hindi' },
    { code: 'ar', zh: '阿拉伯语', en: 'Arabic' },
    { code: 'fr', zh: '法语', en: 'French' },
    { code: 'de', zh: '德语', en: 'German' },
    { code: 'es', zh: '西班牙语', en: 'Spanish' },
    { code: 'pt', zh: '葡萄牙语', en: 'Portuguese' },
    { code: 'ru', zh: '俄语', en: 'Russian' },
    { code: 'it', zh: '意大利语', en: 'Italian' },
    { code: 'nl', zh: '荷兰语', en: 'Dutch' },
    { code: 'sv', zh: '瑞典语', en: 'Swedish' },
    { code: 'da', zh: '丹麦语', en: 'Danish' },
    { code: 'fi', zh: '芬兰语', en: 'Finnish' },
    { code: 'no', zh: '挪威语', en: 'Norwegian' },
    { code: 'el', zh: '希腊语', en: 'Greek' },
    { code: 'pl', zh: '波兰语', en: 'Polish' },
    { code: 'cs', zh: '捷克语', en: 'Czech' },
    { code: 'hu', zh: '匈牙利语', en: 'Hungarian' },
    { code: 'ro', zh: '罗马尼亚语', en: 'Romanian' },
    { code: 'bg', zh: '保加利亚语', en: 'Bulgarian' },
    { code: 'hr', zh: '克罗地亚语', en: 'Croatian' },
    { code: 'sk', zh: '斯洛伐克语', en: 'Slovak' },
];

// 腾讯云用引擎型号同时决定语言/方言，所以这一栏就是「语言」。按计费分档列出。
const TENCENT_ENGINE_GROUPS = [
    {
        zh: '大模型2.0版',
        en: 'LLM 2.0',
        engines: [{ value: 'Hy-ASR-3.0-preview', zh: '中英+20种方言', en: 'Chinese/English + 20 dialects' }],
    },
    {
        zh: '大模型1.0版',
        en: 'LLM 1.0',
        engines: [
            { value: '8k_zh_large', zh: '中文电话场景', en: 'Chinese (phone)' },
            { value: '16k_zh_en', zh: '中英+31种方言', en: 'Chinese/English + 31 dialects' },
            { value: '16k_multi_lang', zh: '多语种（15种）', en: 'Multilingual (15)' },
            { value: '16k_en_large', zh: '英文', en: 'English' },
        ],
    },
    {
        zh: '通用引擎',
        en: 'General',
        engines: [
            { value: '8k_zh', zh: '中文电话通用', en: 'Chinese (phone)' },
            { value: '8k_en', zh: '英文电话通用', en: 'English (phone)' },
            { value: '16k_zh', zh: '中文通用', en: 'Chinese' },
            { value: '16k_zh-TW', zh: '中文繁体', en: 'Chinese (traditional)' },
            { value: '16k_zh_edu', zh: '中文教育', en: 'Chinese (education)' },
            { value: '16k_zh_medical', zh: '中文医疗', en: 'Chinese (medical)' },
            { value: '16k_zh_court', zh: '中文法庭', en: 'Chinese (court)' },
            { value: '16k_yue', zh: '粤语', en: 'Cantonese' },
            { value: '16k_en', zh: '英文通用', en: 'English' },
            { value: '16k_en_game', zh: '英文游戏', en: 'English (gaming)' },
            { value: '16k_en_edu', zh: '英文教育', en: 'English (education)' },
            { value: '16k_ko', zh: '韩语', en: 'Korean' },
            { value: '16k_ja', zh: '日语', en: 'Japanese' },
            { value: '16k_th', zh: '泰语', en: 'Thai' },
            { value: '16k_id', zh: '印度尼西亚语', en: 'Indonesian' },
            { value: '16k_vi', zh: '越南语', en: 'Vietnamese' },
            { value: '16k_ms', zh: '马来语', en: 'Malay' },
            { value: '16k_fil', zh: '菲律宾语', en: 'Filipino' },
            { value: '16k_pt', zh: '葡萄牙语', en: 'Portuguese' },
            { value: '16k_tr', zh: '土耳其语', en: 'Turkish' },
            { value: '16k_ar', zh: '阿拉伯语', en: 'Arabic' },
            { value: '16k_es', zh: '西班牙语', en: 'Spanish' },
            { value: '16k_hi', zh: '印地语', en: 'Hindi' },
            { value: '16k_fr', zh: '法语', en: 'French' },
            { value: '16k_de', zh: '德语', en: 'German' },
        ],
    },
];

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

            /* 标签行右侧并排的多个外链（百炼模型：模型列表 + 模型广场）。 */
            .link-group {
                display: flex;
                align-items: baseline;
                gap: var(--space-md);
            }

            /* 小标题与外链同一行：标题靠左，外链贴右，基线对齐好容忍两边字号不同。 */
            .label-row {
                display: flex;
                align-items: baseline;
                justify-content: space-between;
                gap: var(--space-sm);
            }

            /* 两个竖向字段并排、各占一半：SecretId / SecretKey 用。min-width:0 让输入框能跟着列收缩。 */
            .field-pair {
                display: flex;
                gap: var(--space-sm);
            }

            .field-pair > .form-group {
                flex: 1;
                min-width: 0;
            }

            /* 服务翻页头：两侧箭头、中间标题与「使用」开关。标题组吃掉剩余宽度并居中，箭头固定尺寸不被挤扁。
               开关放在标题文本右侧、紧贴标题，而不是被 flex 推到右边的翻页按钮旁边。 */
            .asr-header {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
                margin-bottom: var(--space-sm);
            }

            .asr-title {
                flex: 1;
                min-width: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: var(--space-sm);
            }

            .asr-title-text {
                font-size: var(--font-size-md);
                font-weight: var(--font-weight-semibold);
                color: var(--text-primary);
            }

            /* 服务标题下的一句话说明：整行居中，弱化成小字。 */
            .asr-subtitle {
                margin: 0 0 var(--space-sm);
                color: var(--text-muted);
                font-size: var(--font-size-xs);
                line-height: 1.5;
                text-align: center;
            }

            .asr-nav {
                width: 32px;
                height: 32px;
                flex: none;
                display: grid;
                place-content: center;
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: var(--bg-elevated);
                color: var(--text-primary);
                font-size: var(--font-size-md);
                cursor: pointer;
            }

            .asr-nav:hover {
                border-color: var(--border-strong);
            }

            /* 与设置页同样的圆形单选样式：这里用来选「会话用哪家服务」，两个页面互相排斥。紧贴标题文本右侧，
               做成不带边框的行内控件，免得和两侧的翻页按钮抢视觉。 */
            .toggle-row {
                display: flex;
                align-items: center;
                gap: var(--space-xs);
                flex: none;
                cursor: pointer;
            }

            .toggle-input {
                width: 14px;
                height: 14px;
                margin: 0;
                appearance: none;
                display: grid;
                place-content: center;
                flex-shrink: 0;
                border: 1px solid var(--border-strong);
                border-radius: 50%;
                background: var(--bg-surface);
                cursor: pointer;
            }

            .toggle-input::after {
                content: '';
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: var(--text-primary);
                transform: scale(0);
                transition: transform var(--transition);
            }

            .toggle-input:checked {
                border-color: var(--text-primary);
            }

            .toggle-input:checked::after {
                transform: scale(1);
            }

            .toggle-label {
                color: var(--text-primary);
                font-size: var(--font-size-sm);
                cursor: pointer;
                user-select: none;
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
        _asrPage: { state: true },
        _asrProvider: { state: true },
        _bailianKey: { state: true },
        _bailianWsUrl: { state: true },
        _bailianModel: { state: true },
        _bailianLanguage: { state: true },
        _tencentAppId: { state: true },
        _tencentSecretId: { state: true },
        _tencentSecretKey: { state: true },
        _tencentEngine: { state: true },
        _testSource: { state: true },
        _testMicDevices: { state: true },
        _testing: { state: true },
        _opening: { state: true },
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

        // 翻页只是查看/编辑，不改变选择；会话用哪家由 _asrProvider 决定。默认先停在第一页（百炼）。
        this._asrPage = ASR_PAGES[0];
        this._asrProvider = 'bailian';
        this._bailianKey = '';
        this._bailianWsUrl = DEFAULT_BAILIAN_WS_URL;
        this._bailianModel = DEFAULT_BAILIAN_MODEL;
        this._bailianLanguage = DEFAULT_CONFIG.bailianLanguage;
        this._tencentAppId = '';
        this._tencentSecretId = '';
        this._tencentSecretKey = '';
        this._tencentEngine = DEFAULT_TENCENT_ENGINE;

        this._testSource = 'default';
        this._testMicDevices = [];
        this._testing = false;
        // 打开采集（权限弹窗、设备启动）是异步的，这期间 _testing 还是 false：没有这个忙标志，第二次点击会再
        // 走进 _startTest，把第一条 MediaStream 覆盖丢失。_connected 则用来发现「打开期间页面已被切走」。
        this._opening = false;
        // 每次开始/停止都自增，给在途的 _startTest 打上代次；采集打开后若代次已被后来的动作改掉，就说明这次
        // 启动已被取消（切源、翻页、离开页面），自己放掉刚拿到的采集即可，别再改状态。仅仅靠 _opening 判断
        // 不够：切源会紧接着再启动一次，两个启动会互相覆盖标志与采集。
        this._testGen = 0;
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

    _isEnUi() {
        return getUiLanguage().toLowerCase().startsWith('en');
    }

    async _loadFromStorage() {
        try {
            const [config, creds, tencent] = await Promise.all([
                offerHunter.storage.getConfig(),
                offerHunter.storage.getCredentials().catch(() => ({})),
                offerHunter.storage.getTencentCredentials().catch(() => ({})),
            ]);

            this._chatBaseUrl = config.chatBaseUrl || DEFAULT_CHAT_BASE_URL;
            this._chatModel = config.deepseekModel || DEFAULT_CHAT_MODEL;
            this._asrProvider = config.asrProvider || 'bailian';
            this._bailianWsUrl = config.bailianWsUrl || DEFAULT_BAILIAN_WS_URL;
            this._bailianModel = config.bailianModel || DEFAULT_BAILIAN_MODEL;
            this._bailianLanguage = config.bailianLanguage || DEFAULT_CONFIG.bailianLanguage;
            this._tencentEngine = config.tencentEngineModel || DEFAULT_TENCENT_ENGINE;
            this._chatKey = creds.deepseekApiKey || '';
            this._bailianKey = creds.bailianApiKey || '';
            this._tencentAppId = tencent.appId || '';
            this._tencentSecretId = tencent.secretId || '';
            this._tencentSecretKey = tencent.secretKey || '';

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

    async _saveBailianLanguage(val) {
        this._bailianLanguage = val;
        await offerHunter.storage.updateConfig('bailianLanguage', val);
        this.requestUpdate();
    }

    async _saveTencentAppId(val) {
        this._tencentAppId = val;
        await offerHunter.storage.setTencentCredentials({ appId: val });
        this.requestUpdate();
    }

    async _saveTencentSecretId(val) {
        this._tencentSecretId = val;
        await offerHunter.storage.setTencentCredentials({ secretId: val });
        this.requestUpdate();
    }

    async _saveTencentSecretKey(val) {
        this._tencentSecretKey = val;
        await offerHunter.storage.setTencentCredentials({ secretKey: val });
        this.requestUpdate();
    }

    async _saveTencentEngine(val) {
        this._tencentEngine = val;
        await offerHunter.storage.updateConfig('tencentEngineModel', val);
        this.requestUpdate();
    }

    _isChatConfigured() {
        return Boolean(this._chatBaseUrl.trim() && this._chatKey.trim() && this._chatModel.trim());
    }

    _isBailianConfigured() {
        return Boolean(this._bailianKey.trim() && this._bailianWsUrl.trim() && this._bailianModel.trim() && this._bailianLanguage.trim());
    }

    _isTencentConfigured() {
        return Boolean(
            this._tencentAppId.trim() && this._tencentSecretId.trim() && this._tencentSecretKey.trim() && this._tencentEngine.trim()
        );
    }

    // 会话只认选中的那一家，所以这里按 _asrProvider 判，而不是「两家任一配好」。
    _isAsrConfigured() {
        return this._asrProvider === 'tencent' ? this._isTencentConfigured() : this._isBailianConfigured();
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

    _pageAsr(delta) {
        // 翻页时正在试听的是上一家的连接，先停掉，免得它继续往新页面的输出框里灌字。
        this._stopTest();
        const index = ASR_PAGES.indexOf(this._asrPage);
        this._asrPage = ASR_PAGES[(index + delta + ASR_PAGES.length) % ASR_PAGES.length];
        this.requestUpdate();
    }

    // 勾选即把会话切到这一家。取消勾选被忽略——总得有一家在用，另一页的勾才会随之落下。
    async _setActiveProvider(provider, checked) {
        if (!checked || provider === this._asrProvider) {
            this.requestUpdate();
            return;
        }
        this._asrProvider = provider;
        await offerHunter.storage.updateConfig('asrProvider', provider);
        this.requestUpdate();
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

    // 正在试听，或采集仍在打开中（权限弹窗、设备启动）。两者都算「占用中」，UI 与切换都要据此判断。
    _testActive() {
        return this._testing || this._opening;
    }

    _toggleTest() {
        if (this._testActive()) {
            this._stopTest();
            return;
        }
        this._startTest();
    }

    // 切换音源：测试进行中就用新源重新开始（旧采集停掉，不让它继续跑），否则只记下选择，下次测试生效。
    _onTestSourceChange(value) {
        if (value === this._testSource) return;
        const wasActive = this._testActive();
        this._testSource = value;
        if (!wasActive) {
            this.requestUpdate();
            return;
        }
        this._stopTest();
        this._startTest();
    }

    async _startTest() {
        const gen = ++this._testGen;
        this._opening = true;

        this._committed = '';
        this._interim = '';
        this._testText = '';
        this._testState = '';
        this._testError = '';
        this.requestUpdate();

        // 先开采集：拿不到麦克风/扬声器就直接放弃，不必白开一条识别连接。
        let capture;
        try {
            capture = this._testSource === 'system' ? await this._openSpeaker() : await this._openMic(this._testSource);
        } catch (error) {
            // 已被后来的动作作废时不再改状态，否则会把新流程的提示/标志踩掉。
            if (gen !== this._testGen) return;
            console.error('Error opening test capture:', error);
            this._opening = false;
            this._testError = error.message || String(error);
            this.requestUpdate();
            return;
        }

        // 打开期间已被停掉（切源、翻页）或页面被切走：这条刚拿到的采集自己放掉，状态交给仍在跑的流程。
        if (gen !== this._testGen || !this._connected) {
            this._releaseCapture(capture);
            return;
        }

        this._capture = capture;
        this._opening = false;
        this._testing = true;
        this.requestUpdate();

        // 试听的是当前这一页的那家，与 _asrProvider 无关——在腾讯页试听就该连腾讯。
        await ipcRenderer.invoke('asr-test:start', this._asrPage);
        // 麦克风一旦拿到权限，设备label 才有值。
        this._loadMicDevices();
    }

    _stopTest() {
        // 代次自增，作废仍在打开中的那一次启动（它会自己放掉刚拿到的采集）。
        this._testGen++;
        this._opening = false;
        const hadCapture = Boolean(this._capture);
        this._releaseCapture();
        if (hadCapture || this._testing) ipcRenderer.invoke('asr-test:stop');

        this._testing = false;
        this._testState = '';
        this.requestUpdate();
    }

    _releaseCapture(capture = this._capture) {
        // 传入的是「在途、尚未登记」的采集时不要动 this._capture：那个字段此刻属于别的流程。
        if (capture === this._capture) this._capture = null;
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
                <div class="asr-header">
                    <button class="asr-nav" @click=${() => this._pageAsr(-1)} aria-label="Previous">&lt;</button>
                    <div class="asr-title">
                        <span class="asr-title-text">
                            ${this._asrPage === 'tencent'
                                ? t('Speech Recognition - Tencent Cloud', '语音识别 - 腾讯云')
                                : t('Speech Recognition - Aliyun Bailian', '语音识别 - 阿里云百炼')}
                        </span>
                        <label class="toggle-row">
                            <span class="toggle-label">${t('Use', '使用')}</span>
                            <input
                                class="toggle-input"
                                type="checkbox"
                                .checked=${this._asrProvider === this._asrPage}
                                @change=${e => this._setActiveProvider(this._asrPage, e.target.checked)}
                            />
                        </label>
                    </div>
                    <button class="asr-nav" @click=${() => this._pageAsr(1)} aria-label="Next">&gt;</button>
                </div>
                <p class="asr-subtitle">
                    ${this._asrPage === 'tencent'
                        ? t(
                              'Tencent Cloud serves both China and overseas and includes a monthly free tier, but gets relatively expensive once the free quota runs out.',
                              '腾讯云支持国内外服务，每个月有免费额度，但用完后价格较昂贵'
                          )
                        : t(
                              'Aliyun Bailian bills by usage and is very cheap, but its available regions are limited.',
                              '阿里云百炼按量计费，价格非常便宜，但适用地区有限'
                          )}
                </p>

                <div class="form-grid">
                    ${this._asrPage === 'tencent' ? this._renderTencentFields() : this._renderBailianFields()} ${this._renderTestRow()}
                </div>
            </section>
        `;
    }

    _renderBailianFields() {
        const zh = !this._isEnUi();
        return html`
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
                    <span
                        >${t(
                            'Aliyun speech recognition is available only in China North (covers most of mainland China) and Singapore. If you are in mainland China, keep the default; if you are in Singapore, open the WebSocket documentation and enter the matching URL.',
                            '阿里云语音识别仅支持中国华北（覆盖中国大陆大部分地区）和新加坡，如果您在中国大陆就不用修改默认值，如果您在新加坡请访问WebSocket文档填入相应链接。'
                        )}</span
                    >
                </div>
            </div>

            <div class="form-group vertical">
                <div class="label-row">
                    <label class="form-label">Bailian Model</label>
                    <span class="link-group">
                        <span
                            class="link"
                            @click=${() =>
                                this.onExternalLink('https://docs.bailian.console.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide#%E6%94%AF%E6%8C%81%E7%9A%84%E6%A8%A1%E5%9E%8B%E4%B8%8E%E5%9C%B0%E5%9F%9F')}
                            >${t('Real-time Speech Model List', '实时语音模型列表')}</span
                        >
                        <span
                            class="link"
                            @click=${() => this.onExternalLink('https://bailian.console.aliyun.com/cn-beijing/model/market?search=ASR')}
                            >${t('Model Marketplace', '模型广场')}</span
                        >
                    </span>
                </div>
                <input
                    class="control wide"
                    type="text"
                    placeholder=${DEFAULT_BAILIAN_MODEL}
                    .value=${this._bailianModel}
                    @input=${e => this._saveBailianModel(e.target.value)}
                />
                <div class="form-help">
                    <span
                        >${t(
                            'Some available models: qwen-audio-3.1-asr-flash-streaming, fun-asr-realtime-2026-02-28, paraformer-realtime-v2. Click the model list and model marketplace on the right to see all available models.',
                            '部分可用模型有：qwen-audio-3.1-asr-flash-streaming，fun-asr-realtime-2026-02-28，paraformer-realtime-v2，请点击右侧模型列表和模型广场查看可用模型。'
                        )}</span
                    >
                </div>
            </div>

            <div class="form-group vertical">
                <label class="form-label">${t('Speech Language', '语音语言')}</label>
                <select class="control wide" .value=${this._bailianLanguage} @change=${e => this._saveBailianLanguage(e.target.value)}>
                    ${BAILIAN_LANGUAGES.map(
                        lang =>
                            html`<option value=${lang.code} .selected=${this._bailianLanguage === lang.code}>
                                ${zh ? lang.zh : lang.en} (${lang.code})
                            </option>`
                    )}
                </select>
                <div class="form-help">
                    ${t(
                        'Lists every supported language code; a model that does not support the chosen one reports an error.',
                        '这里列出的是全部语言代码；模型不支持所选语言时由服务端报错。'
                    )}
                </div>
            </div>
        `;
    }

    _renderTencentFields() {
        const zh = !this._isEnUi();
        return html`
            <div class="form-group vertical">
                <div class="label-row">
                    <label class="form-label">AppID</label>
                    <span class="link" @click=${() => this.onExternalLink('https://console.cloud.tencent.com/developer')}
                        >${t('Get AppID', '获取AppID')}</span
                    >
                </div>
                <input
                    class="control wide"
                    type="text"
                    placeholder="Required"
                    .value=${this._tencentAppId}
                    @input=${e => this._saveTencentAppId(e.target.value)}
                />
                <div class="form-help">
                    <span>${t('Find your AppID on your account information page.', 'AppID在您的账号信息页面查看')}</span>
                </div>
            </div>

            <div class="field-pair">
                <div class="form-group vertical">
                    <label class="form-label">SecretId</label>
                    <input
                        class="control wide"
                        type="password"
                        placeholder="Required"
                        .value=${this._tencentSecretId}
                        @input=${e => this._saveTencentSecretId(e.target.value)}
                    />
                </div>

                <div class="form-group vertical">
                    <div class="label-row">
                        <label class="form-label">SecretKey</label>
                        <span class="link" @click=${() => this.onExternalLink('https://console.cloud.tencent.com/cam/capi')}
                            >${t('Get SecretId & SecretKey', '获取密钥ID与密钥')}</span
                        >
                    </div>
                    <input
                        class="control wide"
                        type="password"
                        placeholder="Required"
                        .value=${this._tencentSecretKey}
                        @input=${e => this._saveTencentSecretKey(e.target.value)}
                    />
                </div>
            </div>

            <div class="form-group vertical">
                <div class="label-row">
                    <label class="form-label">${t('Speech Language', '语音语言')}</label>
                    <span class="link" @click=${() => this.onExternalLink('https://cloud.tencent.com/document/api/1093/48982')}
                        >${t('WebSocket & Supported Languages', 'WebSocket 与支持语言文档')}</span
                    >
                </div>
                <select class="control wide" .value=${this._tencentEngine} @change=${e => this._saveTencentEngine(e.target.value)}>
                    ${TENCENT_ENGINE_GROUPS.map(
                        group =>
                            html`<optgroup label=${zh ? group.zh : group.en}>
                                ${group.engines.map(
                                    engine =>
                                        html`<option value=${engine.value} .selected=${this._tencentEngine === engine.value}>
                                            ${engine.value} · ${zh ? engine.zh : engine.en}
                                        </option>`
                                )}
                            </optgroup>`
                    )}
                </select>
                <div class="form-help">
                    ${t('Tencent Cloud selects the language and dialects from the engine model.', '腾讯云用引擎型号同时决定语言与方言。')}
                </div>
            </div>
        `;
    }

    _renderTestRow() {
        return html`
            <div class="form-group vertical">
                <label class="form-label">Test recognition</label>
                <div class="test-row">
                    <div class="test-output ${this._testText ? '' : 'empty'}" data-no-localize>${this._testText ||
                        t('Click "Test recognition" to start', '点击「测试识别」开始')}</div>
                    <select class="control test-source" .value=${this._testSource} @change=${e => this._onTestSourceChange(e.target.value)}>
                        <option value="default" .selected=${this._testSource === 'default'}>System default microphone</option>
                        ${this._testMicDevices.map(
                            d => html`<option value=${d.deviceId} .selected=${this._testSource === d.deviceId} data-no-localize>
                                ${d.label || 'Microphone'}
                            </option>`
                        )}
                        <option value="system" .selected=${this._testSource === 'system'}>Speaker (interviewer)</option>
                    </select>
                    <button class="control btn-test" @click=${this._toggleTest}>
                        ${this._testActive() ? 'Stop test' : 'Test recognition'}
                    </button>
                </div>
                <div class="form-help ${this._testError ? 'danger' : ''}">${this._testHint()}</div>
            </div>
        `;
    }

    _testHint() {
        if (this._testError) return this._testError;
        // 采集还在打开（权限弹窗、设备启动）时主进程尚未回 connecting，这里先替它顶上。
        if (this._opening) return t('Connecting...', '正在连接…');

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
