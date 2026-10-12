import { html, css } from '../../assets/lit-core-2.7.4.min.js';
import { LocalizedLitElement, t } from '../../utils/i18n.js';

// 提词方式分页。加一页时：往这个数组里加一个 id，在 _renderPage 里加一个 case，文案用 t() 直接给中英两种。
// 只有一页时两个箭头是禁用态。顺序就是箭头切换的顺序。
const MODE_PAGES = ['desktop', 'desktopPhone'];

const chevronLeft = html`<svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
>
    <path d="M15 18l-6-6 6-6" />
</svg>`;
const chevronRight = html`<svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
>
    <path d="M9 18l6-6-6-6" />
</svg>`;
// 两个提词方式的图标由用户提供（icon_f32vraid3mq/），是 1024 见方的填充路径；填色改成 currentColor
// 以跟随主题，尺寸统一到 20×20 与标题里的文字对齐。
const desktopIcon = html`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 1028 1024" fill="currentColor">
    <path
        d="M581.12 753.28v137.6h206.72a34.56 34.56 0 1 1 0 69.12H305.28a34.56 34.56 0 1 1 0-69.12H512v-137.6H201.6A137.6 137.6 0 0 1 64 615.68V201.6A137.6 137.6 0 0 1 201.6 64h689.28a137.6 137.6 0 0 1 137.6 137.6v414.08a137.6 137.6 0 0 1-137.6 137.6zM201.6 133.12a69.76 69.76 0 0 0-68.48 68.48v414.08a69.76 69.76 0 0 0 69.12 69.12h688.64A69.76 69.76 0 0 0 960 615.68V201.6a69.76 69.76 0 0 0-69.12-69.12z"
    />
</svg>`;
const desktopPhoneIcon = html`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 1024 1024" fill="currentColor">
    <path
        d="M832 128a64 64 0 0 1 64 64v96a16 16 0 0 1-16 16h-32A16 16 0 0 1 832 288V208a16 16 0 0 0-16-16H144a16 16 0 0 0-16 16v416c0 8.832 7.168 16 16 16h416a16 16 0 0 1 16 16v32a16 16 0 0 1-16 16H512v128h48a16 16 0 0 1 16 16v32a16 16 0 0 1-16 16h-320a16 16 0 0 1-16-16v-32a16 16 0 0 1 16-16H448v-128H128a64 64 0 0 1-64-64V192a64 64 0 0 1 64-64h704z m64 240a64 64 0 0 1 64 64V832a64 64 0 0 1-64 64h-192a64 64 0 0 1-64-64V432a64 64 0 0 1 64-64h192z m-16 64h-160A16 16 0 0 0 704 448v368c0 8.832 7.168 16 16 16h160a16 16 0 0 0 16-16V448a16 16 0 0 0-16-16z m-48 320a16 16 0 0 1 16 16v16a16 16 0 0 1-16 16h-64a16 16 0 0 1-16-16V768a16 16 0 0 1 16-16h64z"
    />
</svg>`;

export class MainView extends LocalizedLitElement {
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

        .mode-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: var(--space-sm);
            width: 100%;
            margin-bottom: var(--space-sm);
        }

        .mode-title {
            flex: 1;
            text-align: center;
            font-size: var(--font-size-lg);
            font-weight: var(--font-weight-semibold);
            color: var(--text-primary);
        }

        .mode-arrow {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            padding: 0;
            flex-shrink: 0;
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            background: var(--bg-elevated);
            color: var(--text-secondary);
            cursor: pointer;
            transition: all var(--transition);
        }

        .mode-arrow:hover:not(:disabled) {
            color: var(--text-primary);
            border-color: var(--border-strong);
        }

        .mode-arrow:disabled {
            opacity: 0.3;
            cursor: default;
        }

        .page-title {
            display: flex;
            align-items: center;
            gap: var(--space-sm);
            font-size: var(--font-size-xl);
            font-weight: var(--font-weight-semibold);
            color: var(--text-primary);
            margin-bottom: var(--space-xs);
        }

        .page-title svg {
            flex-shrink: 0;
        }

        .page-note {
            font-size: var(--font-size-base);
            color: var(--text-secondary);
            line-height: 1.6;
            margin-bottom: var(--space-xs);
        }

        .config-hint {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
            text-align: center;
        }

        .config-hint .link {
            color: var(--link-color);
            text-decoration: none;
            cursor: pointer;
        }

        .config-hint .link:hover {
            text-decoration: underline;
        }

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

        .pair-box {
            display: flex;
            flex-direction: column;
            gap: var(--space-sm);
            padding: var(--space-md);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            background: var(--bg-elevated);
        }

        .pair-field {
            display: flex;
            flex-direction: column;
            gap: var(--space-xs);
        }

        .pair-label {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
        }

        .pair-row {
            display: flex;
            align-items: center;
            gap: var(--space-sm);
        }

        .pair-value {
            flex: 1;
            min-width: 0;
            font-family: var(--font-mono);
            font-size: var(--font-size-base);
            color: var(--text-primary);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            user-select: text;
        }

        .pair-code {
            flex: 1;
            min-width: 0;
            font-family: var(--font-mono);
            font-size: var(--font-size-xl);
            letter-spacing: 0.32em;
            color: var(--text-primary);
            user-select: text;
        }

        .pair-btn {
            flex: none;
            padding: 6px 10px;
            font-size: var(--font-size-xs);
            color: var(--text-secondary);
            background: transparent;
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            cursor: pointer;
            transition: all var(--transition);
        }

        .pair-btn:hover {
            color: var(--text-primary);
            border-color: var(--border-strong);
        }

        .pair-status {
            display: flex;
            align-items: center;
            gap: var(--space-sm);
            font-size: var(--font-size-xs);
            color: var(--text-muted);
        }

        .pair-status::before {
            content: '';
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: var(--text-muted);
        }

        .pair-status.ok {
            color: var(--text-secondary);
        }

        .pair-status.ok::before {
            background: #22c55e;
        }

        .pair-hint {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
            line-height: 1.5;
        }

        .pair-error {
            font-size: var(--font-size-xs);
            color: var(--danger);
        }
    `;

    static properties = {
        onStart: { type: Function },
        onOpenConfig: { type: Function },
        isInitializing: { type: Boolean },
        pageIndex: { type: Number },
        teleprompterUrl: { type: String },
        teleprompterCode: { type: String },
        teleprompterRunning: { type: Boolean },
        teleprompterPaired: { type: Boolean },
        teleprompterCopied: { type: Boolean },
    };

    constructor() {
        super();
        this.onStart = () => {};
        this.onOpenConfig = () => {};
        this.isInitializing = false;
        this.pageIndex = 0;
        this.teleprompterUrl = '';
        this.teleprompterCode = '';
        this.teleprompterRunning = false;
        this.teleprompterPaired = false;
        this.teleprompterCopied = false;

        this.boundKeydownHandler = this._handleKeydown.bind(this);
    }

    connectedCallback() {
        super.connectedCallback();
        document.addEventListener('keydown', this.boundKeydownHandler);
        // 配对是主进程那边的状态,渲染端没有事件可听,轮询最省事:主页在会话开始前才挂着,这点开销可忽略。
        this._refreshTeleprompter();
        this._teleprompterTimer = setInterval(() => this._refreshTeleprompter(), 1500);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        document.removeEventListener('keydown', this.boundKeydownHandler);
        clearInterval(this._teleprompterTimer);
        clearTimeout(this._copiedTimer);
    }

    async _refreshTeleprompter() {
        if (!window.offerHunter?.teleprompter) return;
        const status = await window.offerHunter.teleprompter.getStatus();
        if (!status) return;
        this.teleprompterRunning = Boolean(status.running);
        this.teleprompterUrl = status.url || '';
        this.teleprompterCode = status.code || '';
        this.teleprompterPaired = Boolean(status.paired);
    }

    async _copyTeleprompterUrl() {
        if (!this.teleprompterUrl) return;
        try {
            await navigator.clipboard.writeText(this.teleprompterUrl);
        } catch {
            // 剪贴板不可用也不至于卡住流程:地址本来就印在屏幕上,手抄一份即可。
        }
        this.teleprompterCopied = true;
        clearTimeout(this._copiedTimer);
        this._copiedTimer = setTimeout(() => {
            this.teleprompterCopied = false;
        }, 1500);
    }

    async _regenerateTeleprompterCode() {
        const status = await window.offerHunter?.teleprompter?.regenerateCode();
        if (!status) return;
        this.teleprompterCode = status.code || '';
        this.teleprompterPaired = Boolean(status.paired);
    }

    _handleKeydown(e) {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 'Enter' && this._canStartSession()) {
            e.preventDefault();
            this._handleStart();
        }
    }

    // 电脑+手机端这一模式里手机才是显示端,没配对就开会话等于对着没人看的窗口说话,所以必须先连上手机。
    _canStartSession() {
        const page = MODE_PAGES[this.pageIndex];
        if (page === 'desktopPhone') return this.teleprompterPaired;
        return page === 'desktop';
    }

    _handleStart() {
        if (this.isInitializing || !this._canStartSession()) return;
        this.onStart();
    }

    // 环形切换：到两端再点就回到另一头。
    _stepPage(delta) {
        const count = MODE_PAGES.length;
        if (count < 2) return;
        this.pageIndex = (this.pageIndex + delta + count) % count;
    }

    _renderModeBar() {
        const multi = MODE_PAGES.length > 1;

        return html`
            <div class="mode-bar">
                <button
                    class="mode-arrow"
                    ?disabled=${!multi}
                    aria-label=${t('Previous prompting mode', '上一种提词方式')}
                    @click=${() => this._stepPage(-1)}
                >
                    ${chevronLeft}
                </button>
                <div class="mode-title">${t('Choose how you want to be prompted', '请选择您的提词方式')}</div>
                <button
                    class="mode-arrow"
                    ?disabled=${!multi}
                    aria-label=${t('Next prompting mode', '下一种提词方式')}
                    @click=${() => this._stepPage(1)}
                >
                    ${chevronRight}
                </button>
            </div>
        `;
    }

    _renderStartButton(enabled = true) {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const disabled = this.isInitializing || !enabled;

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
                class="start-button ${disabled ? 'disabled' : ''}"
                ?disabled=${disabled}
                @click=${() => this._handleStart()}
            >
                <span class="btn-label">
                    Start Session
                    <span class="shortcut-hint">${isMac ? cmdIcon : ctrlIcon}${enterIcon}</span>
                </span>
            </button>
        `;
    }

    // 纯电脑端提词：一切靠本机采集，代价是网页/会议软件仍可能从快捷键、失焦事件、失焦频率上察觉这个窗口。
    _renderDesktopPage() {
        return html`
            <div class="page-title">${desktopIcon}${t('Desktop-only prompting', '纯电脑端提词')}</div>
            <div class="page-note">
                ${t(
                    'Even though this app stays hidden, some websites may still pick up shortcuts, blur events or how often you leave the page — use this mode with care. Turning on “Session window cannot be focused” keeps the meeting app or web page focused at all times, but then you cannot type in the input box below (rarely needed) and moving the mouse into the app area still registers blur events. Turning on “click-through” makes the app fully transparent (moving the mouse over it triggers no blur events), but then its controls cannot be clicked either.',
                    '虽然本应用隐身，但部分网站可能会捕捉快捷键、离屏事件、离屏率等，请你谨慎使用此模式。\n设置中开启「会话界面不可聚焦」可以让会议软件/网页始终保持聚焦，但无法使用下方输入框打字（一般情况下用不上），且鼠标移进应用区域仍会被捕捉离屏事件；\n开启「鼠标穿透」可以彻底让本应用透明化（鼠标移动到本应用上不触发离屏事件），但也会让您无法点击本应用的控件；\n建议将快捷键设置为常用单键如空格、回车和字母键，这样即使被捕捉到也无所谓，但可能会触发其他应用的其他控件。'
                )}
            </div>
            ${this._renderStartButton()}
            <div class="config-hint">
                <span class="link" @click=${() => this.onOpenConfig()}
                    >${t('Configure chat and speech models', '配置对话与语音模型')}</span
                >
            </div>
        `;
    }

    // 配对区就放在「电脑+手机端」这一页:这一模式的显示端是手机,地址和配对码必须在选它、开会话之前就看得到。
    // 只此一处渲染,不做第二份——配对码可重新生成,两份很容易显示不同的码。
    _renderPairingBox() {
        if (!this.teleprompterRunning) {
            return html`<div class="pair-box">
                <div class="pair-error">${t('Teleprompter is not running', '提词服务未运行')}</div>
            </div>`;
        }

        return html`
            <div class="pair-box">
                <div class="pair-field">
                    <span class="pair-label">${t('Address', '地址')}</span>
                    <div class="pair-row">
                        <span class="pair-value">${this.teleprompterUrl}</span>
                        <button class="pair-btn" @click=${this._copyTeleprompterUrl}>
                            ${this.teleprompterCopied ? t('Copied', '已复制') : t('Copy link', '复制链接')}
                        </button>
                    </div>
                </div>
                <div class="pair-field">
                    <span class="pair-label">${t('Pairing code', '配对码')}</span>
                    <div class="pair-row">
                        <span class="pair-code">${this.teleprompterCode}</span>
                        <button class="pair-btn" @click=${this._regenerateTeleprompterCode}>
                            ${t('New pairing code', '重新生成配对码')}
                        </button>
                    </div>
                </div>
                <div class="pair-status ${this.teleprompterPaired ? 'ok' : ''}">
                    ${this.teleprompterPaired
                        ? t('Phone connected', '手机已连接')
                        : t('Waiting for a phone to connect…', '等待手机连接…')}
                </div>
                <div class="pair-hint">
                    ${t(
                        'Open this address in a phone browser on the same Wi-Fi, then enter the code.',
                        '用同一 Wi-Fi 下的手机浏览器打开上面的地址，再输入配对码。'
                    )}
                </div>
            </div>
        `;
    }

    // 电脑+手机端提词：手机负责显示，先在下面配对，连上之后「开始会话」才放行。
    _renderDesktopPhonePage() {
        return html`
            <div class="page-title">${desktopPhoneIcon}${t('Desktop + phone prompting', '电脑+手机端提词')}</div>
            <div class="page-note">
                ${t(
                    'Showing and operating everything on your phone lowers the risk of being caught: it fully avoids screen capture, shortcut logging, and blur-event or blur-rate detection. The only remaining risk is your own line of sight, plus the cases where the interview software needs to control one of your phones.',
                    '通过手机显示和操作降低被捕获风险，能完美规避屏幕捕捉、快捷键记录、离屏事件检测、离屏率检测等手段。唯一的风险来自你的视线，以及有的情况下面试软件需要控制您的一部手机。'
                )}
            </div>
            ${this._renderPairingBox()} ${this._renderStartButton(this.teleprompterPaired)}
            <div class="config-hint">
                <span class="link" @click=${() => this.onOpenConfig()}
                    >${t('Configure chat and speech models', '配置对话与语音模型')}</span
                >
            </div>
        `;
    }

    // 加页时在这里加 case；默认回落到第一页，免得 pageIndex 与 MODE_PAGES 不同步时白屏。
    _renderPage() {
        switch (MODE_PAGES[this.pageIndex]) {
            case 'desktopPhone':
                return this._renderDesktopPhonePage();
            case 'desktop':
            default:
                return this._renderDesktopPage();
        }
    }

    render() {
        return html` <div class="form-wrapper">${this._renderModeBar()}${this._renderPage()}</div> `;
    }
}

customElements.define('main-view', MainView);
