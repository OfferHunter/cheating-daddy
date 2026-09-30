import { html, css } from '../../assets/lit-core-2.7.4.min.js';
import { LocalizedLitElement, getUiLanguage, setUiLanguage } from '../../utils/i18n.js';
import { scrollbarStyles, unifiedPageStyles } from './sharedPageStyles.js';

// 组件是 ES module，主进程能力统一经 window.require 取用（nodeIntegration 已开）。
const { ipcRenderer } = window.require('electron');

// 快得跟得上说话，又不至于让页面一直在重绘。
const METER_POLL_MS = 80;
const METER_BAR_COUNT = [0, 1, 2, 3];

export class CustomizeView extends LocalizedLitElement {
    static styles = [
        unifiedPageStyles,
        scrollbarStyles,
        css`
            .danger-surface {
                border-color: var(--danger);
            }

            .toggle-row {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
                padding: var(--space-sm);
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: var(--bg-elevated);
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
                accent-color: var(--text-primary);
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

            .slider-wrap {
                display: flex;
                flex-direction: column;
                align-items: stretch;
                gap: var(--space-xs);
            }

            .slider-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--space-sm);
            }

            .slider-value {
                font-family: var(--font-mono);
                font-size: var(--font-size-xs);
                color: var(--text-secondary);
                background: var(--bg-elevated);
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                padding: 2px 8px;
            }

            .slider-input {
                -webkit-appearance: none;
                appearance: none;
                width: 100%;
                height: 4px;
                border-radius: 2px;
                background: var(--border);
                outline: none;
                cursor: pointer;
            }

            .slider-input::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 14px;
                height: 14px;
                border-radius: 50%;
                background: var(--text-primary);
                border: none;
            }

            .slider-input::-moz-range-thumb {
                width: 14px;
                height: 14px;
                border-radius: 50%;
                background: var(--text-primary);
                border: none;
            }

            .keybind-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: var(--space-sm) 0;
                border-bottom: 1px solid var(--border);
            }

            .keybind-row:last-of-type {
                border-bottom: none;
            }

            /* 标签和它的电平表捆成左侧一组：否则表会被挤到右边贴着控件，离开它描述的那行字。 */
            .audio-source {
                display: flex;
                align-items: center;
                gap: 10px;
            }

            /* 四根柱子从左往右长，像信号强度那样。 */
            .meter {
                display: flex;
                align-items: flex-end;
                gap: 2px;
                height: 14px;
            }

            .meter-bar {
                width: 3px;
                border-radius: 1px;
                background: var(--text-muted);
                opacity: 0.25;
                transition: opacity 120ms linear;
            }

            .meter-bar:nth-child(1) {
                height: 5px;
            }

            .meter-bar:nth-child(2) {
                height: 8px;
            }

            .meter-bar:nth-child(3) {
                height: 11px;
            }

            .meter-bar:nth-child(4) {
                height: 14px;
            }

            .meter-bar.on {
                background: var(--text-primary);
                opacity: 1;
            }

            .keybind-name {
                color: var(--text-secondary);
                font-size: var(--font-size-sm);
            }

            .keybind-input {
                width: 140px;
                text-align: center;
                font-family: var(--font-mono);
                font-size: var(--font-size-xs);
            }

            .danger-button {
                border: 1px solid var(--danger);
                color: var(--danger);
                background: transparent;
                border-radius: var(--radius-sm);
                padding: 9px 12px;
                font-size: var(--font-size-sm);
                cursor: pointer;
                transition: background var(--transition);
            }

            .danger-button:hover {
                background: rgba(241, 76, 76, 0.11);
            }

            .danger-button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            .status {
                margin-top: var(--space-sm);
                padding: var(--space-sm);
                border-radius: var(--radius-sm);
                border: 1px solid var(--border);
                font-size: var(--font-size-xs);
            }

            .status.success {
                border-color: var(--success);
                color: var(--success);
            }

            .status.error {
                border-color: var(--danger);
                color: var(--danger);
            }
        `,
    ];

    static properties = {
        uiLanguage: { type: String },
        selectedLanguage: { type: String },
        selectedImageQuality: { type: String },
        layoutMode: { type: String },
        keybinds: { type: Object },
        backgroundTransparency: { type: Number },
        textTransparency: { type: Number },
        fontSize: { type: Number },
        theme: { type: String },
        onLanguageChange: { type: Function },
        onImageQualityChange: { type: Function },
        onLayoutModeChange: { type: Function },
        isClearing: { type: Boolean },
        isRestoring: { type: Boolean },
        clearStatusMessage: { type: String },
        clearStatusType: { type: String },
        maxSentenceSilenceMs: { type: Number },
        micMaxSentenceSilenceMs: { type: Number },
        micGateDb: { type: Number },
        micGateDwellMs: { type: Number },
        audioInputDeviceId: { type: String },
        audioInputDevices: { state: true },
        detailMode: { type: Boolean },
        briefThinking: { type: Boolean },
        detailThinking: { type: Boolean },
        screenshotThinking: { type: Boolean },
        chatContextTurns: { type: Number },
        chatMaxTokens: { type: Number },
    };

    constructor() {
        super();
        this.uiLanguage = getUiLanguage();
        this.selectedLanguage = 'cmn-CN';
        this.selectedImageQuality = 'medium';
        this.layoutMode = 'normal';
        this.keybinds = cheatingDaddy.getDefaultKeybinds();
        this.onLanguageChange = () => {};
        this.onImageQualityChange = () => {};
        this.onLayoutModeChange = () => {};
        this.isClearing = false;
        this.isRestoring = false;
        this.clearStatusMessage = '';
        this.clearStatusType = '';
        this.backgroundTransparency = 0.48;
        this.textTransparency = 0.83;
        this.fontSize = 16;
        // 读到存过的选择之前先填 'none'：电平表在 connectedCallback 里就启动，早于 _loadFromStorage 落地，
        // 这期间若填 'default' 会把系统麦克风打开——哪怕用户已经关掉了它。真实设备由 _refreshMicMeter 补上。
        this.audioInputDeviceId = 'none';
        this.audioInputDevices = [];
        this.customPrompt = '';
        this.theme = 'gruvbox';
        this.maxSentenceSilenceMs = 1500;
        this.micMaxSentenceSilenceMs = 2000;
        this.micGateDb = -45;
        this.micGateDwellMs = 300;
        this.detailMode = true;
        this.briefThinking = false;
        this.detailThinking = true;
        this.screenshotThinking = false;
        this.chatContextTurns = 15;
        this.chatMaxTokens = 128000;
        this._loadFromStorage();
    }

    // 电平表只在本页可见时运行：预览采集在这里开、在离开时关，所以用户看别的页面时什么都不会被录。
    connectedCallback() {
        super.connectedCallback();
        this._isConnected = true;
        this._startAudioMeters();
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._isConnected = false;
        clearInterval(this._meterTimer);
        this._meterTimer = null;
        if (cheatingDaddy.audioMeter) cheatingDaddy.audioMeter.stop();
    }

    async _startAudioMeters() {
        if (!cheatingDaddy.audioMeter) return;

        // 柱子直接写进 DOM 而不走响应式属性：否则每秒会把整个设置页重渲好几次。
        clearInterval(this._meterTimer);
        this._meterTimer = setInterval(() => this._paintAudioMeters(), METER_POLL_MS);

        await cheatingDaddy.audioMeter.start(this.audioInputDeviceId);
    }

    // 设备列表加载完还要再调一次——它通常晚于页面挂载。
    _refreshMicMeter() {
        if (!this._isConnected || !cheatingDaddy.audioMeter) return;
        cheatingDaddy.audioMeter.setMic(this.audioInputDeviceId);
    }

    _paintAudioMeters() {
        if (!this.renderRoot) return;

        const levels = cheatingDaddy.audioMeter.read();

        for (const kind of ['system', 'mic']) {
            // 下拉框明确关闭麦克风时，界面也必须立即保持全灭。除防止旧的异步采集结果短暂闪回外，
            // 这也保证显示状态永远以用户当前选择为准。
            const activeBars = kind === 'mic' && this.audioInputDeviceId === 'none' ? 0 : levels[kind];
            const bars = this.renderRoot.querySelectorAll(`[data-meter="${kind}"] .meter-bar`);
            bars.forEach((bar, index) => bar.classList.toggle('on', index < activeBars));
        }
    }

    getThemes() {
        return cheatingDaddy.theme.getAll();
    }

    async _loadFromStorage() {
        try {
            const [prefs, keybinds] = await Promise.all([cheatingDaddy.storage.getPreferences(), cheatingDaddy.storage.getKeybinds()]);
            this.backgroundTransparency = prefs.backgroundTransparency ?? 0.48;
            this.textTransparency = prefs.textTransparency ?? 0.83;
            this.fontSize = prefs.fontSize ?? 16;
            this.audioInputDeviceId = prefs.audioInputDeviceId ?? 'default';
            this.customPrompt = prefs.customPrompt ?? '';
            this.theme = prefs.theme ?? 'gruvbox';
            this.maxSentenceSilenceMs = prefs.maxSentenceSilenceMs ?? 1500;
            this.micMaxSentenceSilenceMs = prefs.micMaxSentenceSilenceMs ?? 2000;
            this.micGateDb = prefs.micGateDb ?? -45;
            this.micGateDwellMs = prefs.micGateDwellMs ?? 300;
            this.detailMode = prefs.detailMode !== false;
            this.briefThinking = prefs.briefThinking === true;
            this.detailThinking = prefs.detailThinking !== false;
            this.screenshotThinking = prefs.screenshotThinking === true;
            this.chatContextTurns = prefs.chatContextTurns ?? 15;
            this.chatMaxTokens = prefs.chatMaxTokens ?? 128000;
            this.uiLanguage = prefs.uiLanguage || 'zh-CN';
            setUiLanguage(this.uiLanguage);
            if (keybinds) {
                this.keybinds = { ...cheatingDaddy.getDefaultKeybinds(), ...keybinds };
            }
            this.updateAppearance();
            this.updateFontSize();
            this.loadAudioDevices();
            this._refreshMicMeter();
            this.requestUpdate();
        } catch (error) {
            console.error('Error loading settings:', error);
        }
    }

    getLanguages() {
        return [
            { value: 'en-US', name: 'English (US)' },
            { value: 'en-GB', name: 'English (UK)' },
            { value: 'en-AU', name: 'English (Australia)' },
            { value: 'en-IN', name: 'English (India)' },
            { value: 'de-DE', name: 'German (Germany)' },
            { value: 'es-US', name: 'Spanish (US)' },
            { value: 'es-ES', name: 'Spanish (Spain)' },
            { value: 'fr-FR', name: 'French (France)' },
            { value: 'fr-CA', name: 'French (Canada)' },
            { value: 'hi-IN', name: 'Hindi (India)' },
            { value: 'pt-BR', name: 'Portuguese (Brazil)' },
            { value: 'ar-XA', name: 'Arabic (Generic)' },
            { value: 'id-ID', name: 'Indonesian (Indonesia)' },
            { value: 'it-IT', name: 'Italian (Italy)' },
            { value: 'ja-JP', name: 'Japanese (Japan)' },
            { value: 'tr-TR', name: 'Turkish (Turkey)' },
            { value: 'vi-VN', name: 'Vietnamese (Vietnam)' },
            { value: 'bn-IN', name: 'Bengali (India)' },
            { value: 'gu-IN', name: 'Gujarati (India)' },
            { value: 'kn-IN', name: 'Kannada (India)' },
            { value: 'ml-IN', name: 'Malayalam (India)' },
            { value: 'mr-IN', name: 'Marathi (India)' },
            { value: 'ta-IN', name: 'Tamil (India)' },
            { value: 'te-IN', name: 'Telugu (India)' },
            { value: 'nl-NL', name: 'Dutch (Netherlands)' },
            { value: 'ko-KR', name: 'Korean (South Korea)' },
            { value: 'cmn-CN', name: 'Mandarin Chinese (China)' },
            { value: 'pl-PL', name: 'Polish (Poland)' },
            { value: 'ru-RU', name: 'Russian (Russia)' },
            { value: 'th-TH', name: 'Thai (Thailand)' },
        ];
    }

    getKeybindActions() {
        return [
            { key: 'moveUp', name: 'Move Window Up', description: 'Move the app window up' },
            { key: 'moveDown', name: 'Move Window Down', description: 'Move the app window down' },
            { key: 'moveLeft', name: 'Move Window Left', description: 'Move the app window left' },
            { key: 'moveRight', name: 'Move Window Right', description: 'Move the app window right' },
            { key: 'toggleVisibility', name: 'Toggle Visibility', description: 'Show or hide the app window' },
            { key: 'toggleClickThrough', name: 'Toggle Click-through', description: 'Enable or disable click-through mode' },
            { key: 'nextStep', name: 'Ask Next Step', description: 'Take screenshot and ask for next step' },
            { key: 'scrollUp', name: 'Scroll Response Up', description: 'Scroll response content upward' },
            { key: 'scrollDown', name: 'Scroll Response Down', description: 'Scroll response content downward' },
            {
                key: 'detailPrev',
                name: 'Previous Detailed Answer',
                description: 'Show the previous detailed answer in the side pane',
            },
            {
                key: 'detailNext',
                name: 'Next Detailed Answer',
                description: 'Show the next detailed answer in the side pane',
            },
            {
                key: 'toggleTheme',
                name: 'Toggle Light/Dark Theme',
                description: 'Switch between the light and dark colour schemes',
            },
            { key: 'emergencyErase', name: 'Emergency Erase', description: 'Hide the window, clear all data and quit' },
            { key: 'quit', name: 'Quit', description: 'Exit the app without clearing any data' },
        ];
    }

    async saveKeybinds() {
        await cheatingDaddy.storage.setKeybinds(this.keybinds);
        ipcRenderer.send('update-keybinds', this.keybinds);
    }

    handleLanguageSelect(e) {
        this.selectedLanguage = e.target.value;
        this.onLanguageChange(this.selectedLanguage);
    }

    async handleUiLanguageSelect(e) {
        this.uiLanguage = e.target.value;
        await cheatingDaddy.storage.updatePreference('uiLanguage', this.uiLanguage);
        setUiLanguage(this.uiLanguage);
    }

    handleImageQualitySelect(e) {
        this.selectedImageQuality = e.target.value;
        this.onImageQualityChange(this.selectedImageQuality);
    }

    handleLayoutModeSelect(e) {
        this.layoutMode = e.target.value;
        this.onLayoutModeChange(this.layoutMode);
    }

    async handleCustomPromptInput(e) {
        this.customPrompt = e.target.value;
        await cheatingDaddy.storage.updatePreference('customPrompt', this.customPrompt);
    }

    async handleDetailModeChange(checked) {
        this.detailMode = checked;
        await cheatingDaddy.storage.updatePreference('detailMode', checked);
    }

    async handleBriefThinkingChange(checked) {
        this.briefThinking = checked;
        await cheatingDaddy.storage.updatePreference('briefThinking', checked);
    }

    async handleDetailThinkingChange(checked) {
        this.detailThinking = checked;
        await cheatingDaddy.storage.updatePreference('detailThinking', checked);
    }

    async handleScreenshotThinkingChange(checked) {
        this.screenshotThinking = checked;
        await cheatingDaddy.storage.updatePreference('screenshotThinking', checked);
    }

    // “系统默认”必须始终存在。Chromium 通常会枚举出 deviceId 为 default 的伪设备，但在页面刚重建、
    // 权限状态变化或设备列表尚未稳定时可能暂时缺失。若完全依赖枚举结果，select 找不到已保存的
    // value="default"，浏览器就会在视觉上退回第一项“不使用麦克风”。固定渲染该选项，并从真实列表
    // 过滤同名伪设备以避免重复。
    async loadAudioDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            this.audioInputDevices = devices
                .filter(d => d.kind === 'audioinput' && d.deviceId !== 'default')
                .map(d => ({
                    deviceId: d.deviceId,
                    label: d.label || 'Microphone',
                }));
        } catch (error) {
            console.error('Error enumerating audio devices:', error);
            this.audioInputDevices = [];
        }
        this.requestUpdate();
    }

    async handleAudioInputDeviceChange(e) {
        this.audioInputDeviceId = e.target.value;
        // 这个下拉只管面试者自己那一路：「不使用麦克风」不动扬声器那路，选具体设备则是在它旁边加上麦克风。
        await cheatingDaddy.storage.updatePreference('audioInputDeviceId', this.audioInputDeviceId);
        this._refreshMicMeter();
        this.requestUpdate();
    }

    async handleNumberPreferenceInput(key, rawValue) {
        const value = Number.parseFloat(rawValue);
        if (!Number.isFinite(value)) {
            return;
        }

        this[key] = value;
        await cheatingDaddy.storage.updatePreference(key, value);
        this.requestUpdate();
    }

    async handleThemeChange(e) {
        this.theme = e.target.value;
        await cheatingDaddy.theme.save(this.theme, this.backgroundTransparency, this.textTransparency);
        this.requestUpdate();
    }

    // 拖拽只改写那两个透明度变量；所有颜色 token 都引用它们，所以一帧内就生效，无需重建颜色字符串。
    async handleBackgroundTransparencyChange(e) {
        this.backgroundTransparency = parseFloat(e.target.value);
        await cheatingDaddy.storage.updatePreference('backgroundTransparency', this.backgroundTransparency);
        cheatingDaddy.theme.setAlphas(this.backgroundTransparency, undefined);
        this.requestUpdate();
    }

    async handleTextTransparencyChange(e) {
        this.textTransparency = parseFloat(e.target.value);
        await cheatingDaddy.storage.updatePreference('textTransparency', this.textTransparency);
        cheatingDaddy.theme.setAlphas(undefined, this.textTransparency);
        this.requestUpdate();
    }

    updateAppearance() {
        cheatingDaddy.theme.apply(this.theme, this.backgroundTransparency, this.textTransparency);
    }

    async handleFontSizeChange(e) {
        this.fontSize = parseInt(e.target.value, 10);
        await cheatingDaddy.storage.updatePreference('fontSize', this.fontSize);
        this.updateFontSize();
        this.requestUpdate();
    }

    updateFontSize() {
        document.documentElement.style.setProperty('--response-font-size', `${this.fontSize}px`);
    }

    handleKeybindChange(action, value) {
        this.keybinds = { ...this.keybinds, [action]: value };
        this.saveKeybinds();
        this.requestUpdate();
    }

    handleKeybindFocus(e) {
        e.target.placeholder = 'Press key combination...';
        e.target.select();
    }

    handleKeybindInput(e) {
        e.preventDefault();
        const modifiers = [];
        if (e.ctrlKey) modifiers.push('Ctrl');
        if (e.metaKey) modifiers.push('Cmd');
        if (e.altKey) modifiers.push('Alt');
        if (e.shiftKey) modifiers.push('Shift');
        let mainKey = e.key;

        switch (e.code) {
            case 'ArrowUp':
                mainKey = 'Up';
                break;
            case 'ArrowDown':
                mainKey = 'Down';
                break;
            case 'ArrowLeft':
                mainKey = 'Left';
                break;
            case 'ArrowRight':
                mainKey = 'Right';
                break;
            case 'Enter':
                mainKey = 'Enter';
                break;
            case 'Space':
                mainKey = 'Space';
                break;
            case 'Backslash':
                mainKey = '\\';
                break;
            // 取自 e.code 而不是 e.key：按住 Shift 时它们变成 '{' 和 '}'，与默认的 'Ctrl+Shift+[' 不是同一个
            // 字符串，永远不会注册成功。
            case 'BracketLeft':
                mainKey = '[';
                break;
            case 'BracketRight':
                mainKey = ']';
                break;
            default:
                if (e.key.length === 1) mainKey = e.key.toUpperCase();
                break;
        }

        if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;

        const action = e.target.dataset.action;
        const keybind = [...modifiers, mainKey].join('+');
        this.handleKeybindChange(action, keybind);
        e.target.value = keybind;
        e.target.blur();
    }

    async resetKeybinds() {
        this.keybinds = cheatingDaddy.getDefaultKeybinds();
        await cheatingDaddy.storage.setKeybinds(null);
        ipcRenderer.send('update-keybinds', this.keybinds);
        this.requestUpdate();
    }

    async restoreAllSettings() {
        if (this.isRestoring) return;
        this.isRestoring = true;
        this.clearStatusMessage = '';
        this.clearStatusType = '';
        this.requestUpdate();
        try {
            // 手抄的 src/storage.js 里那份 DEFAULT_PREFERENCES，改一边必须改另一边。customPrompt 和
            // knowledgeDir 故意不在其中：它们装的是用户自己给的内容（指令、以及指向他自己文件的路径）而不是
            // 旋钮，所以「恢复默认」不碰它们；detailMode 和三个 thinking 开关是旋钮，跟着一起重置。
            const defaults = {
                uiLanguage: 'zh-CN',
                selectedLanguage: 'cmn-CN',
                selectedScreenshotInterval: '5',
                selectedImageQuality: 'medium',
                audioInputDeviceId: 'default',
                fontSize: 16,
                backgroundTransparency: 0.48,
                textTransparency: 0.83,
                theme: 'gruvbox',
                maxSentenceSilenceMs: 1500,
                micMaxSentenceSilenceMs: 2000,
                micGateDb: -45,
                micGateDwellMs: 300,
                detailMode: true,
                briefThinking: false,
                detailThinking: true,
                screenshotThinking: false,
                chatContextTurns: 15,
                chatMaxTokens: 128000,
            };
            for (const [key, value] of Object.entries(defaults)) {
                await cheatingDaddy.storage.updatePreference(key, value);
            }

            this.keybinds = cheatingDaddy.getDefaultKeybinds();
            await cheatingDaddy.storage.setKeybinds(null);
            ipcRenderer.send('update-keybinds', this.keybinds);

            this.selectedLanguage = defaults.selectedLanguage;
            this.uiLanguage = defaults.uiLanguage;
            setUiLanguage(defaults.uiLanguage);
            this.selectedImageQuality = defaults.selectedImageQuality;
            this.audioInputDeviceId = defaults.audioInputDeviceId;
            this.fontSize = defaults.fontSize;
            this.backgroundTransparency = defaults.backgroundTransparency;
            this.textTransparency = defaults.textTransparency;
            this.theme = defaults.theme;
            this.maxSentenceSilenceMs = defaults.maxSentenceSilenceMs;
            this.micMaxSentenceSilenceMs = defaults.micMaxSentenceSilenceMs;
            this.micGateDb = defaults.micGateDb;
            this.micGateDwellMs = defaults.micGateDwellMs;
            this.detailMode = defaults.detailMode;
            this.briefThinking = defaults.briefThinking;
            this.detailThinking = defaults.detailThinking;
            this.screenshotThinking = defaults.screenshotThinking;
            this.chatContextTurns = defaults.chatContextTurns;
            this.chatMaxTokens = defaults.chatMaxTokens;

            this.onLanguageChange(defaults.selectedLanguage);
            this.onImageQualityChange(defaults.selectedImageQuality);

            this.updateFontSize();
            await cheatingDaddy.theme.save(defaults.theme, defaults.backgroundTransparency, defaults.textTransparency);

            this.clearStatusMessage = 'All settings restored to defaults';
            this.clearStatusType = 'success';
        } catch (error) {
            console.error('Error restoring settings:', error);
            this.clearStatusMessage = `Error restoring settings: ${error.message}`;
            this.clearStatusType = 'error';
        } finally {
            this.isRestoring = false;
            this.requestUpdate();
        }
    }

    async clearLocalData() {
        if (this.isClearing) return;
        this.isClearing = true;
        this.clearStatusMessage = '';
        this.clearStatusType = '';
        this.requestUpdate();
        try {
            await cheatingDaddy.storage.clearAll();
            this.clearStatusMessage = 'Successfully cleared all local data';
            this.clearStatusType = 'success';
            this.requestUpdate();
            setTimeout(() => {
                this.clearStatusMessage = 'Closing application...';
                this.requestUpdate();
                setTimeout(async () => {
                    await ipcRenderer.invoke('quit-application');
                }, 1000);
            }, 2000);
        } catch (error) {
            console.error('Error clearing data:', error);
            this.clearStatusMessage = `Error clearing data: ${error.message}`;
            this.clearStatusType = 'error';
        } finally {
            this.isClearing = false;
            this.requestUpdate();
        }
    }

    // 柱子靠 class 点亮而不是靠绑定，这样每帧的更新可以完全绕过 Lit。
    renderMeter(kind) {
        return html` <div class="meter" data-meter=${kind}>${METER_BAR_COUNT.map(() => html`<span class="meter-bar"></span>`)}</div> `;
    }

    renderAudioSection() {
        return html`
            <section class="surface">
                <div class="surface-title">Audio Input</div>
                <div class="form-grid">
                    <div class="form-group">
                        <div class="audio-source">
                            <span class="form-label">Speaker (interviewer)</span>
                            ${this.renderMeter('system')}
                        </div>
                    </div>
                    <div class="form-group vertical">
                        <div class="form-group">
                            <div class="audio-source">
                                <label class="form-label">Microphone (Me)</label>
                                ${this.renderMeter('mic')}
                            </div>
                            <select class="control" .value=${this.audioInputDeviceId} @change=${this.handleAudioInputDeviceChange}>
                                <option value="none" .selected=${this.audioInputDeviceId === 'none'}>Don't use Microphone</option>
                                <option value="default" .selected=${this.audioInputDeviceId === 'default'}>System default</option>
                                ${this.audioInputDevices.map(
                                    d => html`<option value=${d.deviceId} .selected=${this.audioInputDeviceId === d.deviceId}>${d.label}</option>`
                                )}
                            </select>
                        </div>
                        <div class="form-help">
                            Speaker audio always follows the Windows default playback device. A microphone here adds your own voice as a second,
                            right-hand column: it never triggers an answer on its own, it only tells the assistant what you have already said.
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Image Quality</label>
                        <select class="control" .value=${this.selectedImageQuality} @change=${this.handleImageQualitySelect}>
                            <option value="high">High Quality</option>
                            <option value="medium">Medium Quality</option>
                            <option value="low">Low Quality</option>
                        </select>
                    </div>
                    <div class="form-group vertical">
                        <label class="form-label">Sentence Silence (ms)</label>
                        <input
                            type="number"
                            step="100"
                            min="200"
                            max="6000"
                            class="control"
                            .value=${this.maxSentenceSilenceMs}
                            @change=${e => this.handleNumberPreferenceInput('maxSentenceSilenceMs', e.target.value)}
                        />
                        <div class="form-help">How much silence ends a question and sends it. Lower is faster but may split it. 200-6000.</div>
                    </div>
                    <div class="form-group vertical">
                        <label class="form-label">My Sentence Silence (ms)</label>
                        <input
                            type="number"
                            step="100"
                            min="200"
                            max="6000"
                            class="control"
                            .value=${this.micMaxSentenceSilenceMs}
                            @change=${e => this.handleNumberPreferenceInput('micMaxSentenceSilenceMs', e.target.value)}
                        />
                        <div class="form-help">
                            The same wait for your own microphone, and usually worth keeping longer: stumbling over a word splits one answer into
                            several fragments on screen. Only affects your column. 200-6000. Takes effect on the next session.
                        </div>
                    </div>
                    <div class="form-group vertical">
                        <label class="form-label">Speaker Gate (dBFS)</label>
                        <input
                            type="number"
                            step="1"
                            min="-80"
                            max="0"
                            class="control"
                            .value=${this.micGateDb}
                            @change=${e => this.handleNumberPreferenceInput('micGateDb', e.target.value)}
                        />
                        <div class="form-help">
                            While the speaker is louder than this the microphone is ignored, so the interviewer's voice cannot leak into your column.
                            Higher (closer to 0) gates more aggressively; -80 effectively turns it off.
                        </div>
                    </div>
                    <div class="form-group vertical">
                        <label class="form-label">Speaker Gate Hold (ms)</label>
                        <input
                            type="number"
                            step="50"
                            min="0"
                            max="2000"
                            class="control"
                            .value=${this.micGateDwellMs}
                            @change=${e => this.handleNumberPreferenceInput('micGateDwellMs', e.target.value)}
                        />
                        <div class="form-help">
                            How long the speaker level must stay on one side of the threshold before the microphone is muted or unmuted. Higher is
                            steadier and less choppy but slower to react. 0-2000. The microphone is also muted while the speaker is still
                            mid-sentence, whatever the level does.
                        </div>
                    </div>
                </div>
            </section>
        `;
    }

    renderLanguageSection() {
        return html`
            <section class="surface">
                <div class="surface-title">Language</div>
                <div class="form-grid">
                    <div class="form-group">
                        <label class="form-label">Interface Language</label>
                        <select class="control" .value=${this.uiLanguage} @change=${this.handleUiLanguageSelect}>
                            <option value="zh-CN">中文</option>
                            <option value="en-US">English</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Speech Language</label>
                        <select class="control" .value=${this.selectedLanguage} @change=${this.handleLanguageSelect}>
                            ${this.getLanguages().map(
                                language =>
                                    html`<option value=${language.value} .selected=${this.selectedLanguage === language.value}>
                                        ${language.name}
                                    </option>`
                            )}
                        </select>
                    </div>
                </div>
            </section>
        `;
    }

    renderAnswerSection() {
        return html`
            <section class="surface">
                <div class="surface-title">Answers</div>
                <div class="form-grid">
                    <label class="toggle-row">
                        <input
                            class="toggle-input"
                            type="checkbox"
                            .checked=${this.detailMode}
                            @change=${e => this.handleDetailModeChange(e.target.checked)}
                        />
                        <span class="toggle-label">Detailed side answer</span>
                    </label>
                    <div class="form-help">
                        Answer each question twice: a short line for the transcript, and a longer one in the side pane that may consult the knowledge
                        folder. Takes effect on the next session.
                    </div>
                    <label class="toggle-row">
                        <input
                            class="toggle-input"
                            type="checkbox"
                            .checked=${this.briefThinking}
                            @change=${e => this.handleBriefThinkingChange(e.target.checked)}
                        />
                        <span class="toggle-label">Thinking in the fast reply</span>
                    </label>
                    <label class="toggle-row">
                        <input
                            class="toggle-input"
                            type="checkbox"
                            .checked=${this.detailThinking}
                            @change=${e => this.handleDetailThinkingChange(e.target.checked)}
                        />
                        <span class="toggle-label">Thinking in the detailed reply</span>
                    </label>
                    <label class="toggle-row">
                        <input
                            class="toggle-input"
                            type="checkbox"
                            .checked=${this.screenshotThinking}
                            @change=${e => this.handleScreenshotThinkingChange(e.target.checked)}
                        />
                        <span class="toggle-label">Thinking in the screenshot reply</span>
                    </label>
                    <div class="form-help">
                        Thinking before answering trades a second of wait for a better answer. Leave it off in the fast reply, which is read out the
                        moment it appears, and on in the detailed one, which is read in the gap afterwards. The screenshot reply has its own switch
                        because it is the one request carrying an image, and its thinking is spent inside the request timeout — a screenshot of a
                        whole problem statement can run out the clock and come back empty. Takes effect on the next session.
                    </div>
                    <div class="form-group vertical">
                        <label class="form-label">Context Turns</label>
                        <input
                            type="number"
                            step="1"
                            min="1"
                            max="100"
                            class="control"
                            .value=${this.chatContextTurns}
                            @change=${e => this.handleNumberPreferenceInput('chatContextTurns', e.target.value)}
                        />
                        <div class="form-help">
                            How many previous turns are replayed to the model, in both the fast and the detailed answer. Higher keeps more of the
                            interview in view but makes every request larger and slower. 1-100. Takes effect on the next session.
                        </div>
                    </div>
                    <div class="form-group vertical">
                        <label class="form-label">Max Tokens</label>
                        <input
                            type="number"
                            step="1"
                            min="1024"
                            class="control"
                            .value=${this.chatMaxTokens}
                            @change=${e => this.handleNumberPreferenceInput('chatMaxTokens', e.target.value)}
                        />
                        <div class="form-help">
                            The ceiling on a single reply, thinking included — a thinking reply is charged for its reasoning from this same number,
                            and a hard question can spend all of a low one before writing anything, which arrives as an empty answer. Leave it high
                            and the model stops on its own. Takes effect on the next turn.
                        </div>
                    </div>
                </div>
            </section>
        `;
    }

    renderAppearanceSection() {
        return html`
            <section class="surface">
                <div class="surface-title">Appearance</div>
                <div class="form-grid">
                    <div class="form-group">
                        <label class="form-label">Theme</label>
                        <select class="control" .value=${this.theme} @change=${this.handleThemeChange}>
                            ${this.getThemes().map(theme => html`<option value=${theme.value}>${theme.name}</option>`)}
                        </select>
                    </div>
                    <div class="form-group slider-wrap">
                        <div class="slider-header">
                            <label class="form-label">Component Transparency</label>
                            <span class="slider-value">${Math.round(this.backgroundTransparency * 100)}%</span>
                        </div>
                        <input
                            class="slider-input"
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            .value=${this.backgroundTransparency}
                            @input=${this.handleBackgroundTransparencyChange}
                        />
                        <div class="form-help">Panels, bubbles, inputs and borders. Lower means more of what is behind the window shows through.</div>
                    </div>
                    <div class="form-group slider-wrap">
                        <div class="slider-header">
                            <label class="form-label">Text Transparency</label>
                            <span class="slider-value">${Math.round(this.textTransparency * 100)}%</span>
                        </div>
                        <input
                            class="slider-input"
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            .value=${this.textTransparency}
                            @input=${this.handleTextTransparencyChange}
                        />
                        <div class="form-help">All text, including the answers in the live transcript. Independent of the panels.</div>
                    </div>
                    <div class="form-group slider-wrap">
                        <div class="slider-header">
                            <label class="form-label">Response Font Size</label>
                            <span class="slider-value">${this.fontSize}px</span>
                        </div>
                        <input
                            class="slider-input"
                            type="range"
                            min="12"
                            max="32"
                            step="1"
                            .value=${this.fontSize}
                            @input=${this.handleFontSizeChange}
                        />
                    </div>
                </div>
            </section>
        `;
    }

    renderKeyboardSection() {
        return html`
            <section class="surface">
                <div class="surface-title">Keyboard Shortcuts</div>
                ${this.getKeybindActions().map(
                    action => html`
                        <div class="keybind-row">
                            <span class="keybind-name">${action.name}</span>
                            <input
                                type="text"
                                class="control keybind-input"
                                .value=${this.keybinds[action.key]}
                                data-action=${action.key}
                                @keydown=${this.handleKeybindInput}
                                @focus=${this.handleKeybindFocus}
                                readonly
                            />
                        </div>
                    `
                )}
                <div style="margin-top: var(--space-sm);">
                    <button class="control" style="width:auto;padding:8px 10px;" @click=${this.resetKeybinds}>Reset to defaults</button>
                </div>
            </section>
        `;
    }

    renderPrivacySection() {
        return html`
            <section class="surface danger-surface">
                <div class="surface-title danger">Privacy and Data</div>
                <div style="display:flex;gap:var(--space-sm);flex-wrap:wrap;">
                    <button class="danger-button" @click=${this.restoreAllSettings} ?disabled=${this.isRestoring}>
                        ${this.isRestoring ? 'Restoring...' : 'Restore all settings'}
                    </button>
                    <button class="danger-button" @click=${this.clearLocalData} ?disabled=${this.isClearing}>
                        ${this.isClearing ? 'Clearing...' : 'Delete all data'}
                    </button>
                </div>
            </section>
        `;
    }

    render() {
        return html`
            <div class="unified-page">
                ${
                    this.clearStatusMessage
                        ? html`<div class="page-toast ${this.clearStatusType === 'success' ? 'success' : 'error'}" role="status">
                              ${this.clearStatusMessage}
                          </div>`
                        : ''
                }
                <div class="unified-wrap">
                    <div class="page-title">Settings</div>
                    ${this.renderAudioSection()} ${this.renderLanguageSection()} ${this.renderAnswerSection()} ${this.renderAppearanceSection()}
                    ${this.renderKeyboardSection()} ${this.renderPrivacySection()}
                </div>
            </div>
        `;
    }
}

customElements.define('customize-view', CustomizeView);
