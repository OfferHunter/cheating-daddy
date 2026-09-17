import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

const DEFAULT_CHAT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_CHAT_MODEL = 'deepseek-flash';
const DEFAULT_SILICONFLOW_MODEL = 'FunAudioLLM/SenseVoiceSmall';
const DEFAULT_BAILIAN_MODEL = 'paraformer-realtime-v2';

export class MainView extends LitElement {
    static styles = css`
        * {
            font-family: var(--font);
            cursor: default;
            user-select: none;
            box-sizing: border-box;
        }

        :host {
            height: 100%;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: var(--space-xl) var(--space-lg);
        }

        .form-wrapper {
            width: 100%;
            max-width: 420px;
            display: flex;
            flex-direction: column;
            gap: var(--space-md);
        }

        .page-title {
            font-size: var(--font-size-xl);
            font-weight: var(--font-weight-semibold);
            color: var(--text-primary);
            margin-bottom: var(--space-xs);
        }

        .page-subtitle {
            font-size: var(--font-size-sm);
            color: var(--text-muted);
            margin-bottom: var(--space-md);
        }

        /* ── Form controls ── */

        .form-group {
            display: flex;
            flex-direction: column;
            gap: var(--space-xs);
        }

        .config-section {
            border: 1px solid var(--border);
            border-radius: var(--radius-md);
            background: var(--bg-surface);
            overflow: hidden;
        }

        .config-summary {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: var(--space-md);
            padding: 12px 14px;
            cursor: pointer;
            list-style: none;
        }

        .config-summary::-webkit-details-marker {
            display: none;
        }

        .config-summary-text {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .config-summary-title {
            font-size: var(--font-size-sm);
            font-weight: var(--font-weight-medium);
            color: var(--text-primary);
        }

        .config-summary-description {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
        }

        .config-chevron {
            width: 16px;
            height: 16px;
            color: var(--text-muted);
            transition: transform var(--transition);
        }

        .config-section[open] .config-chevron {
            transform: rotate(180deg);
        }

        .config-content {
            display: flex;
            flex-direction: column;
            gap: var(--space-md);
            padding: 14px;
            border-top: 1px solid var(--border);
        }

        .form-label {
            font-size: var(--font-size-xs);
            font-weight: var(--font-weight-medium);
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        input,
        select {
            background: var(--bg-elevated);
            color: var(--text-primary);
            border: 1px solid var(--border);
            padding: 10px 12px;
            width: 100%;
            border-radius: var(--radius-sm);
            font-size: var(--font-size-sm);
            font-family: var(--font);
            transition:
                border-color var(--transition),
                box-shadow var(--transition);
        }

        input:hover:not(:focus),
        select:hover:not(:focus) {
            border-color: var(--text-muted);
        }

        input:focus,
        select:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 0 1px var(--accent);
        }

        input::placeholder {
            color: var(--text-muted);
        }

        input.error,
        select.error {
            border-color: var(--danger, #ef4444);
        }

        .form-hint {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
        }

        .form-hint a,
        .form-hint span.link {
            color: var(--accent);
            text-decoration: none;
            cursor: pointer;
        }

        .form-hint span.link:hover {
            text-decoration: underline;
        }

        /* ── Start button ── */

        .start-button {
            background: #e8e8e8;
            color: #111111;
            border: none;
            padding: 12px var(--space-md);
            border-radius: var(--radius-sm);
            font-size: var(--font-size-base);
            font-weight: var(--font-weight-semibold);
            cursor: pointer;
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: var(--space-sm);
        }

        .start-button .btn-label {
            display: flex;
            align-items: center;
            gap: var(--space-sm);
        }

        .start-button:hover {
            opacity: 0.9;
        }

        .start-button.disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .start-button.disabled:hover {
            opacity: 0.5;
        }

        .shortcut-hint {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            opacity: 0.5;
            font-family: var(--font-mono);
        }
    `;

    static properties = {
        onStart: { type: Function },
        onExternalLink: { type: Function },
        isInitializing: { type: Boolean },
        // Internal state
        _chatBaseUrl: { state: true },
        _chatKey: { state: true },
        _chatModel: { state: true },
        _siliconflowKey: { state: true },
        _siliconflowModel: { state: true },
        _asrProvider: { state: true },
        _bailianKey: { state: true },
        _bailianModel: { state: true },
        _keyError: { state: true },
    };

    constructor() {
        super();
        this.onStart = () => {};
        this.onExternalLink = () => {};
        this.isInitializing = false;

        this._chatBaseUrl = DEFAULT_CHAT_BASE_URL;
        this._chatKey = '';
        this._chatModel = DEFAULT_CHAT_MODEL;
        this._siliconflowKey = '';
        this._siliconflowModel = DEFAULT_SILICONFLOW_MODEL;
        this._asrProvider = 'bailian';
        this._bailianKey = '';
        this._bailianModel = DEFAULT_BAILIAN_MODEL;
        this._keyError = false;

        this.boundKeydownHandler = this._handleKeydown.bind(this);
        this._loadFromStorage();
    }

    async _loadFromStorage() {
        try {
            const [config, creds] = await Promise.all([cheatingDaddy.storage.getConfig(), cheatingDaddy.storage.getCredentials().catch(() => ({}))]);

            this._chatBaseUrl = config.chatBaseUrl || DEFAULT_CHAT_BASE_URL;
            this._chatModel = config.deepseekModel || DEFAULT_CHAT_MODEL;
            this._siliconflowModel = config.siliconflowModel || DEFAULT_SILICONFLOW_MODEL;
            this._asrProvider = config.asrProvider || 'bailian';
            this._bailianModel = config.bailianModel || DEFAULT_BAILIAN_MODEL;
            this._chatKey = creds.deepseekApiKey || '';
            this._siliconflowKey = creds.siliconflowApiKey || '';
            this._bailianKey = creds.bailianApiKey || '';

            this.requestUpdate();
        } catch (e) {
            console.error('Error loading MainView storage:', e);
        }
    }

    connectedCallback() {
        super.connectedCallback();
        document.addEventListener('keydown', this.boundKeydownHandler);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        document.removeEventListener('keydown', this.boundKeydownHandler);
    }

    _handleKeydown(e) {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            this._handleStart();
        }
    }

    // ── Persistence ──

    async _saveChatBaseUrl(val) {
        this._chatBaseUrl = val;
        this._keyError = false;
        await cheatingDaddy.storage.updateConfig('chatBaseUrl', val);
        this.requestUpdate();
    }

    async _saveChatKey(val) {
        this._chatKey = val;
        this._keyError = false;
        await cheatingDaddy.storage.setDeepseekApiKey(val);
        this.requestUpdate();
    }

    async _saveChatModel(val) {
        this._chatModel = val;
        this._keyError = false;
        await cheatingDaddy.storage.updateConfig('deepseekModel', val);
        this.requestUpdate();
    }

    async _saveSiliconflowKey(val) {
        this._siliconflowKey = val;
        this._keyError = false;
        await cheatingDaddy.storage.setSiliconflowApiKey(val);
        this.requestUpdate();
    }

    async _saveSiliconflowModel(val) {
        this._siliconflowModel = val;
        await cheatingDaddy.storage.updateConfig('siliconflowModel', val);
        this.requestUpdate();
    }

    async _saveAsrProvider(val) {
        this._asrProvider = val;
        this._keyError = false;
        await cheatingDaddy.storage.updateConfig('asrProvider', val);
        this.requestUpdate();
    }

    async _saveBailianKey(val) {
        this._bailianKey = val;
        this._keyError = false;
        await cheatingDaddy.storage.setBailianApiKey(val);
        this.requestUpdate();
    }

    async _saveBailianModel(val) {
        this._bailianModel = val;
        this._keyError = false;
        await cheatingDaddy.storage.updateConfig('bailianModel', val);
        this.requestUpdate();
    }

    // ── Start ──

    _handleStart() {
        if (this.isInitializing) return;

        const providerKey = this._asrProvider === 'siliconflow' ? this._siliconflowKey : this._bailianKey;

        if (!this._chatBaseUrl.trim() || !this._chatKey.trim() || !this._chatModel.trim() || !providerKey.trim()) {
            this._keyError = true;
            this.requestUpdate();
            return;
        }

        this.onStart();
    }

    triggerApiKeyError() {
        this._keyError = true;
        this.requestUpdate();
        setTimeout(() => {
            this._keyError = false;
            this.requestUpdate();
        }, 2000);
    }

    // ── Render helpers ──

    _renderStartButton() {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

        const cmdIcon = html`<svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            <path
                d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"
            />
        </svg>`;
        const ctrlIcon = html`<svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            <path d="M6 15l6-6 6 6" />
        </svg>`;
        const enterIcon = html`<svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            <path d="M9 10l-5 5 5 5" />
            <path d="M20 4v7a4 4 0 0 1-4 4H4" />
        </svg>`;

        return html`
            <button
                class="start-button ${this.isInitializing ? 'disabled' : ''}"
                ?disabled=${this.isInitializing}
                @click=${() => this._handleStart()}
            >
                <span class="btn-label">
                    Start Session
                    <span class="shortcut-hint">${isMac ? cmdIcon : ctrlIcon}${enterIcon}</span>
                </span>
            </button>
        `;
    }

    _renderConfigChevron() {
        return html`
            <svg class="config-chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="m5 7.5 5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
        `;
    }

    // ── Chat model ──

    _renderChatMode() {
        const hasError = this._keyError ? 'error' : '';

        return html`
            <details class="config-section" open>
                <summary class="config-summary">
                    <span class="config-summary-text">
                        <span class="config-summary-title">Chat model</span>
                        <span class="config-summary-description">Any OpenAI-compatible API</span>
                    </span>
                    ${this._renderConfigChevron()}
                </summary>
                <div class="config-content">
                    <div class="form-group">
                        <label class="form-label">API Base URL</label>
                        <input
                            type="text"
                            placeholder=${DEFAULT_CHAT_BASE_URL}
                            .value=${this._chatBaseUrl}
                            @input=${e => this._saveChatBaseUrl(e.target.value)}
                            class=${hasError}
                        />
                        <div class="form-hint">Requests go to &lt;base url&gt;/chat/completions.</div>
                    </div>

                    <div class="form-group">
                        <label class="form-label">API Key</label>
                        <input
                            type="password"
                            placeholder="Required"
                            .value=${this._chatKey}
                            @input=${e => this._saveChatKey(e.target.value)}
                            class=${hasError}
                        />
                        <div class="form-hint">
                            <span class="link" @click=${() => this.onExternalLink('https://platform.deepseek.com/api_keys')}>Get DeepSeek key</span>
                        </div>
                    </div>

                    <div class="form-group">
                        <label class="form-label">Model</label>
                        <input
                            type="text"
                            placeholder=${DEFAULT_CHAT_MODEL}
                            .value=${this._chatModel}
                            @input=${e => this._saveChatModel(e.target.value)}
                            class=${hasError}
                        />
                        <div class="form-hint">Write the model name exactly as the endpoint expects it.</div>
                    </div>
                </div>
            </details>
        `;
    }

    // ── Transcription ──

    _renderTranscriptionSection() {
        const hasError = this._keyError ? 'error' : '';
        const isBailian = this._asrProvider !== 'siliconflow';

        return html`
            <details class="config-section">
                <summary class="config-summary">
                    <span class="config-summary-text">
                        <span class="config-summary-title">Transcription</span>
                        <span class="config-summary-description">${isBailian ? 'Aliyun Bailian streaming' : 'SiliconFlow batch upload'}</span>
                    </span>
                    ${this._renderConfigChevron()}
                </summary>
                <div class="config-content">
                    <div class="form-group">
                        <label class="form-label">Speech-to-text Provider</label>
                        <select .value=${this._asrProvider} @change=${e => this._saveAsrProvider(e.target.value)}>
                            <option value="bailian">Aliyun Bailian (streaming)</option>
                            <option value="siliconflow">SiliconFlow (batch upload)</option>
                        </select>
                    </div>

                    ${isBailian
                        ? html`
                              <div class="form-group">
                                  <label class="form-label">Bailian API Key</label>
                                  <input
                                      type="password"
                                      placeholder="Required"
                                      .value=${this._bailianKey}
                                      @input=${e => this._saveBailianKey(e.target.value)}
                                      class=${hasError}
                                  />
                                  <div class="form-hint">
                                      <span class="link" @click=${() => this.onExternalLink('https://bailian.console.aliyun.com/')}
                                          >Get Bailian key</span
                                      >
                                      <span> (Beijing region)</span>
                                  </div>
                              </div>

                              <div class="form-group">
                                  <label class="form-label">Bailian Model</label>
                                  <input
                                      type="text"
                                      placeholder=${DEFAULT_BAILIAN_MODEL}
                                      .value=${this._bailianModel}
                                      @input=${e => this._saveBailianModel(e.target.value)}
                                  />
                                  <div class="form-hint">Speech is streamed live to Aliyun and transcribed as you talk.</div>
                              </div>
                          `
                        : html`
                              <div class="form-group">
                                  <label class="form-label">SiliconFlow API Key</label>
                                  <input
                                      type="password"
                                      placeholder="Required"
                                      .value=${this._siliconflowKey}
                                      @input=${e => this._saveSiliconflowKey(e.target.value)}
                                      class=${hasError}
                                  />
                                  <div class="form-hint">
                                      <span class="link" @click=${() => this.onExternalLink('https://cloud.siliconflow.cn/account/ak')}
                                          >Get SiliconFlow key</span
                                      >
                                  </div>
                              </div>

                              <div class="form-group">
                                  <label class="form-label">SiliconFlow Model</label>
                                  <input
                                      type="text"
                                      placeholder=${DEFAULT_SILICONFLOW_MODEL}
                                      .value=${this._siliconflowModel}
                                      @input=${e => this._saveSiliconflowModel(e.target.value)}
                                  />
                                  <div class="form-hint">Recorded speech is uploaded to SiliconFlow for transcription.</div>
                              </div>
                          `}
                </div>
            </details>
        `;
    }

    // ── Main render ──

    render() {
        return html`
            <div class="form-wrapper">
                <div class="page-title">Cheating Daddy</div>
                <div class="page-subtitle">OpenAI-compatible chat with live transcription</div>
                ${this._renderChatMode()} ${this._renderTranscriptionSection()} ${this._renderStartButton()}
            </div>
        `;
    }
}

customElements.define('main-view', MainView);
