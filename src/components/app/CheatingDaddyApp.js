import { html, css } from '../../assets/lit-core-2.7.4.min.js';
import { LocalizedLitElement, setUiLanguage } from '../../utils/i18n.js';
import { scrollbarStyles } from '../views/sharedPageStyles.js';
import { MainView } from '../views/MainView.js';
import { CustomizeView } from '../views/CustomizeView.js';
import { HelpView } from '../views/HelpView.js';
import { HistoryView } from '../views/HistoryView.js';
import { AssistantView } from '../views/AssistantView.js';
import { OnboardingView } from '../views/OnboardingView.js';
import { AICustomizeView } from '../views/AICustomizeView.js';

// 组件是 ES module，主进程能力统一经 window.require 取用（nodeIntegration 已开）。
const { ipcRenderer } = window.require('electron');

export class CheatingDaddyApp extends LocalizedLitElement {
    static styles = [
        css`
            * {
                box-sizing: border-box;
                font-family: var(--font);
                margin: 0;
                padding: 0;
                cursor: default;
                user-select: none;
            }

            :host {
                display: block;
                width: 100%;
                height: 100vh;
                overflow: hidden;
                border-radius: 12px;
                background: transparent;
                color: var(--text-primary);
            }

            .app-shell {
                display: flex;
                height: calc(100vh - 2px);
                margin: 1px;
                overflow: hidden;
                border: 2px solid var(--text-primary);
                border-radius: 11px;
            }

            .top-drag-bar {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                z-index: 9999;
                display: flex;
                align-items: center;
                height: 38px;
                padding-right: var(--space-md);
                background: transparent;
            }

            .drag-region {
                flex: 1;
                height: 100%;
                -webkit-app-region: drag;
            }

            .top-drag-bar.hidden {
                display: none;
            }

            /* 隐藏 / 退出，固定在每页右上角；它们前面的那片空白归拖拽区。 */
            .window-controls {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
                height: 100%;
                -webkit-app-region: no-drag;
            }

            /* 顶栏里唯一的按钮形状：圆形，不悬停时几乎看不见。直播栏左侧的会话按钮和右侧的窗口按钮都用它。 */
            .icon-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 26px;
                height: 26px;
                padding: 0;
                border: 1px solid transparent;
                border-radius: 50%;
                background: none;
                color: var(--text-muted);
                cursor: pointer;
                transition: var(--transition);
            }

            .icon-btn:hover {
                background: var(--bg-hover);
                border-color: var(--border);
                color: var(--text-primary);
            }

            .icon-btn svg {
                width: 14px;
                height: 14px;
                display: block;
                flex: none;
            }

            .icon-btn.danger:hover {
                background: color-mix(in srgb, var(--danger) 50%, transparent);
                border-color: transparent;
                color: #fff;
            }

            .icon-btn.danger svg {
                width: 13px;
                height: 13px;
            }

            /* 暂停态全靠这圈描边：软暂停时麦克风指示灯仍然亮着，亮着本身不表示还在收音。 */
            .icon-btn.active {
                color: var(--accent);
                border-color: var(--accent);
            }

            .sidebar {
                width: var(--sidebar-width);
                min-width: var(--sidebar-width);
                background: var(--bg-surface);
                border-right: 1px solid var(--border);
                display: flex;
                flex-direction: column;
                padding: 42px 0 var(--space-md) 0;
                transition:
                    width var(--transition),
                    min-width var(--transition),
                    opacity var(--transition);
            }

            .sidebar.hidden {
                width: 0;
                min-width: 0;
                padding: 0;
                overflow: hidden;
                border-right: none;
                opacity: 0;
            }

            .sidebar-brand {
                padding: var(--space-sm) var(--space-lg);
                padding-top: var(--space-md);
                margin-bottom: var(--space-lg);
            }

            .sidebar-brand h1 {
                font-size: var(--font-size-sm);
                font-weight: var(--font-weight-semibold);
                color: var(--text-primary);
                letter-spacing: -0.01em;
            }

            .sidebar-nav {
                flex: 1;
                display: flex;
                flex-direction: column;
                gap: var(--space-xs);
                padding: 0 var(--space-sm);
                -webkit-app-region: no-drag;
            }

            .nav-item {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
                padding: var(--space-sm) var(--space-md);
                border-radius: var(--radius-md);
                color: var(--text-secondary);
                font-size: var(--font-size-sm);
                font-weight: var(--font-weight-medium);
                cursor: pointer;
                transition:
                    color var(--transition),
                    background var(--transition);
                border: none;
                background: none;
                width: 100%;
                text-align: left;
            }

            .nav-item:hover {
                color: var(--text-primary);
                background: var(--bg-hover);
            }

            .nav-item.active {
                color: var(--text-primary);
                background: var(--bg-elevated);
            }

            .nav-item svg {
                width: 20px;
                height: 20px;
                flex-shrink: 0;
            }

            .sidebar-footer {
                padding: var(--space-sm);
                margin-top: var(--space-sm);
                -webkit-app-region: no-drag;
            }

            .update-btn {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
                width: 100%;
                padding: var(--space-sm) var(--space-md);
                border-radius: var(--radius-md);
                border: 1px solid rgba(239, 68, 68, 0.2);
                background: rgba(239, 68, 68, 0.08);
                color: var(--danger);
                font-size: var(--font-size-sm);
                font-weight: var(--font-weight-medium);
                cursor: pointer;
                text-align: left;
                transition:
                    background var(--transition),
                    border-color var(--transition);
                animation: update-wobble 5s ease-in-out infinite;
            }

            .update-btn:hover {
                background: rgba(239, 68, 68, 0.14);
                border-color: rgba(239, 68, 68, 0.35);
            }

            @keyframes update-wobble {
                0%,
                90%,
                100% {
                    transform: rotate(0deg);
                }
                92% {
                    transform: rotate(-2deg);
                }
                94% {
                    transform: rotate(2deg);
                }
                96% {
                    transform: rotate(-1.5deg);
                }
                98% {
                    transform: rotate(1.5deg);
                }
            }

            .update-btn svg {
                width: 20px;
                height: 20px;
                flex-shrink: 0;
            }

            .version-text {
                font-size: var(--font-size-xs);
                color: var(--text-muted);
                padding: var(--space-xs) var(--space-md);
            }

            .content {
                flex: 1;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                background: var(--bg-app);
            }

            .live-bar {
                position: relative;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 var(--space-md);
                background: var(--bg-surface);
                border-bottom: 1px solid var(--border);
                height: 36px;
                -webkit-app-region: drag;
            }

            .live-bar-left {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
                -webkit-app-region: no-drag;
                z-index: 1;
            }

            .live-bar-center {
                position: absolute;
                left: 50%;
                transform: translateX(-50%);
                font-size: var(--font-size-xs);
                color: var(--text-muted);
                font-weight: var(--font-weight-medium);
                white-space: nowrap;
                pointer-events: none;
            }

            .live-bar-right {
                display: flex;
                align-items: center;
                gap: var(--space-md);
                -webkit-app-region: no-drag;
                z-index: 1;
            }

            .live-bar-text {
                font-size: var(--font-size-xs);
                color: var(--text-muted);
                font-family: var(--font-mono);
                white-space: nowrap;
            }

            .live-bar-text.clickable {
                cursor: pointer;
                transition: color var(--transition);
            }

            .live-bar-text.clickable:hover {
                color: var(--text-primary);
            }

            .content-inner {
                flex: 1;
                overflow-y: auto;
                overflow-x: hidden;
            }

            .content-inner.live {
                overflow: hidden;
                display: flex;
                flex-direction: column;
            }

            .fullscreen {
                position: fixed;
                inset: 0;
                z-index: 100;
                background: var(--bg-app);
            }
        `,
        scrollbarStyles,
    ];

    static properties = {
        currentView: { type: String },
        statusText: { type: String },
        startTime: { type: Number },
        sessionActive: { type: Boolean },
        selectedLanguage: { type: String },
        messages: { type: Array },
        // 放在这里而不是实时视图里：那个视图每次导航都会被重建，详细回答必须像转录一样熬过一次页面切换。
        detailMessages: { type: Array },
        detailCurrent: { type: Number },
        selectedScreenshotInterval: { type: String },
        selectedImageQuality: { type: String },
        layoutMode: { type: String },
        _isClickThrough: { state: true },
        _storageLoaded: { state: true },
        _updateAvailable: { state: true },
    };

    constructor() {
        super();
        this.currentView = 'main';
        this.statusText = '';
        this.startTime = null;
        this.sessionActive = false;
        this.selectedLanguage = 'cmn-CN';
        this.selectedScreenshotInterval = '5';
        this.selectedImageQuality = 'medium';
        this.layoutMode = 'normal';
        this.messages = [];
        this._msgSeq = 0;
        // 软暂停：主进程持续给识别器喂静音，所以恢复是瞬时的，什么都不用重连。
        this._paused = false;
        // 低于该序号的轮次主进程已经忘了。只用来拒绝为「清空之前派发的轮次」开新气泡——已存在的气泡照旧更新，
        // 因为它可能正在流式，冻住它恰恰就是那个必须避免的截断。
        this._turnFloorId = 0;
        this._detailFloorId = 0;
        this.detailMessages = [];
        this.detailCurrent = null;
        // 一直跟随最新的详细回答，直到用户翻回旧的一条——此后新回答不能再把面板从正在读的那条上拽走。
        this._detailFollowing = true;
        this._isClickThrough = false;
        this._storageLoaded = false;
        this._timerInterval = null;
        this._updateAvailable = false;
        this._localVersion = '';

        this._loadFromStorage();
        this._checkForUpdates();
    }

    async _checkForUpdates() {
        try {
            this._localVersion = await cheatingDaddy.getVersion();
            this.requestUpdate();

            const res = await fetch('https://raw.githubusercontent.com/sohzm/cheating-daddy/refs/heads/master/package.json');
            if (!res.ok) return;
            const remote = await res.json();
            const remoteVersion = remote.version;

            const toNum = v => v.split('.').map(Number);
            const [rMaj, rMin, rPatch] = toNum(remoteVersion);
            const [lMaj, lMin, lPatch] = toNum(this._localVersion);

            if (rMaj > lMaj || (rMaj === lMaj && rMin > lMin) || (rMaj === lMaj && rMin === lMin && rPatch > lPatch)) {
                this._updateAvailable = true;
                this.requestUpdate();
            }
        } catch (e) {
            // 检查更新失败无所谓，静默。
        }
    }

    async _loadFromStorage() {
        try {
            const [config, prefs] = await Promise.all([cheatingDaddy.storage.getConfig(), cheatingDaddy.storage.getPreferences()]);

            this.currentView = config.onboarded ? 'main' : 'onboarding';
            this.selectedLanguage = prefs.selectedLanguage || 'cmn-CN';
            this.selectedScreenshotInterval = prefs.selectedScreenshotInterval || '5';
            this.selectedImageQuality = prefs.selectedImageQuality || 'medium';
            this.layoutMode = config.layout || 'normal';
            setUiLanguage(prefs.uiLanguage || 'zh-CN');

            this._storageLoaded = true;
            this.requestUpdate();
        } catch (error) {
            console.error('Error loading from storage:', error);
            this._storageLoaded = true;
            this.requestUpdate();
        }
    }

    connectedCallback() {
        super.connectedCallback();

        ipcRenderer.on('new-response', (_, response) => this.addNewResponse(response));
        ipcRenderer.on('update-response', (_, response) => this.updateCurrentResponse(response));
        ipcRenderer.on('response-complete', (_, data) => this.completeResponse(data));
        ipcRenderer.on('transcription-update', (_, data) => this.upsertTranscription(data.text, false, data.speaker, data.blockId));
        ipcRenderer.on('transcription-final', (_, data) => this.upsertTranscription(data.text, true, data.speaker, data.blockId));
        ipcRenderer.on('update-status', (_, status) => this.setStatus(status));
        ipcRenderer.on('click-through-toggled', (_, isEnabled) => {
            this._isClickThrough = isEnabled;
        });
        ipcRenderer.on('reconnect-failed', (_, data) => this.addNewResponse(data.message));
        ipcRenderer.on('new-detail-response', (_, data) => this.addDetailResponse(data));
        ipcRenderer.on('update-detail-response', (_, data) => this.updateDetailResponse(data));
        ipcRenderer.on('detail-response-complete', (_, data) => this.completeDetailResponse(data));
        ipcRenderer.on('detail-tool-used', (_, data) => this.handleDetailToolUsed(data));
        // 挂在 app 元素而不是实时视图上：快捷键在别的页面显示时也要生效，而整个会话里只有 app 元素始终在。
        ipcRenderer.on('detail-prev', () => this.stepDetail(-1));
        ipcRenderer.on('detail-next', () => this.stepDetail(1));
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._stopTimer();
        ipcRenderer.removeAllListeners('new-response');
        ipcRenderer.removeAllListeners('update-response');
        ipcRenderer.removeAllListeners('response-complete');
        ipcRenderer.removeAllListeners('transcription-update');
        ipcRenderer.removeAllListeners('transcription-final');
        ipcRenderer.removeAllListeners('update-status');
        ipcRenderer.removeAllListeners('click-through-toggled');
        ipcRenderer.removeAllListeners('reconnect-failed');
        ipcRenderer.removeAllListeners('new-detail-response');
        ipcRenderer.removeAllListeners('update-detail-response');
        ipcRenderer.removeAllListeners('detail-response-complete');
        ipcRenderer.removeAllListeners('detail-tool-used');
        ipcRenderer.removeAllListeners('detail-prev');
        ipcRenderer.removeAllListeners('detail-next');
    }

    _startTimer() {
        this._stopTimer();
        if (this.startTime) {
            this._timerInterval = setInterval(() => this.requestUpdate(), 1000);
        }
    }

    _stopTimer() {
        if (this._timerInterval) {
            clearInterval(this._timerInterval);
            this._timerInterval = null;
        }
    }

    getElapsedTime() {
        if (!this.startTime) return '0:00';
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const h = Math.floor(elapsed / 3600);
        const m = Math.floor((elapsed % 3600) / 60);
        const s = elapsed % 60;
        const pad = n => String(n).padStart(2, '0');
        if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
        return `${m}:${pad(s)}`;
    }

    setStatus(text) {
        this.statusText = text;
    }

    // 转录是以「整轮快照」到达的：要么改写还开着的那条气泡，要么新开一条；已落定的气泡永不再动。两个说话人
    // 同时流式，所以查找从尾部开始并按角色匹配——一个人的开着的某条气泡不会被另一个人改写，气泡也保留在它主人
    // 开始说话时的位置。
    upsertTranscription(text, final, speaker = 'interviewer', blockId = null) {
        const role = speaker === 'user' ? 'user' : 'interviewer';
        // `final` 是给下面那个遍历看的落定标记。它对截图那行问题有意义，对面试者的普通文本没有：下一个片段接
        // 着同一条气泡写，标记在那里没有含义，所以无论事件怎么说都按下不表。
        const settled = role === 'user' ? false : final;

        // 带 block id 到达的行属于那个块，只按 id 原地改写，绝不按位置：块还没关时识别出的一句话会被追加在它
        // 下面，而这个块自己的 final 必须越过那句话再找回自己的行。问题关掉块时流水线会发一个新 id，所以接下
        // 来说的话仍然开一条新气泡。有两类行走这条路——面试者自己的发言，以及截图问题写成的那行；后者因为它显示
        // 成面试官的样子，只能靠 id 而不是靠角色找到。
        if (role === 'user' || blockId !== null) {
            for (let i = this.messages.length - 1; i >= 0; i--) {
                const message = this.messages[i];
                if (message.role === role && message.blockId === blockId) {
                    this._replaceMessage(i, { text, final: settled });
                    return;
                }
            }

            this.messages = [...this.messages, { id: ++this._msgSeq, role, text, ts: Date.now(), final: settled, blockId }];
            this.requestUpdate();
            return;
        }

        for (let i = this.messages.length - 1; i >= 0; i--) {
            const message = this.messages[i];
            if (message.role !== role) continue;
            if (message.final) break;
            // 属于某个块的开着的行不是这个说话人的开口行，跳过而不是改写。已落定的行仍然像以前一样终止遍历。
            if (message.blockId != null) continue;

            const next = [...this.messages];
            next[i] = { ...message, text, final };
            this.messages = next;
            this.requestUpdate();
            return;
        }

        this.messages = [...this.messages, { id: ++this._msgSeq, role, text, ts: Date.now(), final }];
        this.requestUpdate();
    }

    _assistantIndex(turnId) {
        return this.messages.findIndex(m => m.role === 'assistant' && m.turnId === turnId);
    }

    _replaceMessage(index, changes) {
        const next = [...this.messages];
        next[index] = { ...next[index], ...changes };
        this.messages = next;
        this.requestUpdate();
    }

    // 各轮并发流式，所以气泡不能再靠「最后一条」来定位：面试官的气泡会被插在两条同时进行的回答之间。把 token
    // 路由到它自己的气泡靠的是 `turnId`。重连处理函数仍会送来裸字符串——它背后没有轮次。
    addNewResponse(data) {
        const { turnId = null, text = '', final = false } = typeof data === 'string' ? { text: data, final: true } : data;
        // 清空上下文之前派发的轮次不得在清空之后重新出现。只拦创建；已存在的气泡由下面两个调用方继续更新。
        if (turnId !== null && turnId <= this._turnFloorId) return;
        this.messages = [...this.messages, { id: ++this._msgSeq, turnId, role: 'assistant', text, ts: Date.now(), final }];
        this.requestUpdate();
    }

    updateCurrentResponse(data) {
        const { turnId = null, text = '' } = typeof data === 'string' ? { text: data } : data || {};
        // 没有 id 就没有可瞄准的气泡，退化成追加一条已完成的。
        if (turnId === null) {
            this.addNewResponse({ text, final: true });
            return;
        }

        const index = this._assistantIndex(turnId);
        if (index === -1) {
            this.addNewResponse({ turnId, text });
            return;
        }

        this._replaceMessage(index, { text });
    }

    completeResponse(data) {
        const { turnId = null } = data || {};
        if (turnId === null) return;

        const index = this._assistantIndex(turnId);
        if (index === -1) return;

        this._replaceMessage(index, { final: true });
    }

    _detailIndex(detailId) {
        return this.detailMessages.findIndex(m => m.detailId === detailId);
    }

    // 详细回答一律按自己的 id 索引，绝不按位置：主进程会丢掉除最后几条以外的全部，而位置在面板眼皮底下变化
    // 会悄无声息地显示错的那条回答。
    _ensureDetailRow(detailId, turnSeq, question) {
        const index = this._detailIndex(detailId);
        if (index !== -1) return index;
        // 和转录同一条规则：清空之前请求的回答不得在清空之后开行。已存在的行上面已经返回，会一直更新到完成。
        if (detailId <= this._detailFloorId) return -1;

        this.detailMessages = [
            ...this.detailMessages,
            {
                detailId,
                turnSeq,
                question: question || '',
                text: '',
                ts: Date.now(),
                final: false,
                usedKnowledge: [],
                truncated: false,
                error: '',
            },
        ];
        if (this._detailFollowing) this.detailCurrent = detailId;
        return this.detailMessages.length - 1;
    }

    _replaceDetail(index, changes) {
        const next = [...this.detailMessages];
        next[index] = { ...next[index], ...changes };
        this.detailMessages = next;
        this.requestUpdate();
    }

    addDetailResponse(data) {
        const { detailId = null, turnSeq = null, question = '', text = '' } = data || {};
        if (detailId === null) return;

        const index = this._ensureDetailRow(detailId, turnSeq, question);
        if (index === -1) return;
        this._replaceDetail(index, { text });
    }

    updateDetailResponse(data) {
        const { detailId = null, text = '' } = data || {};
        const index = this._detailIndex(detailId);
        if (index === -1) return;

        this._replaceDetail(index, { text });
    }

    completeDetailResponse(data) {
        const { detailId = null, turnSeq = null, question = '', ok = true, error = '', usedKnowledge = [], truncated = false } = data || {};
        if (detailId === null) return;

        // 在第一个 token 之前就失败的请求从没开过行，所以得由完成事件把这次失败带进视野，而不是因为没有落点
        // 被丢掉。
        const index = this._ensureDetailRow(detailId, turnSeq, question);
        if (index === -1) return;
        this._replaceDetail(index, { final: true, ok, error, usedKnowledge, truncated });
    }

    handleDetailToolUsed(data) {
        const { detailId = null, id } = data || {};
        const index = this._detailIndex(detailId);
        if (index === -1 || !id) return;

        const row = this.detailMessages[index];
        if (row.usedKnowledge.includes(id)) return;

        this._replaceDetail(index, { usedKnowledge: [...row.usedKnowledge, id] });
    }

    // 面板的 ‹ › 按钮和它们的快捷键都落到这里。每次按一下走一步，两端都夹住。
    stepDetail(delta) {
        if (!this.detailMessages.length) return;

        const ids = this.detailMessages.map(row => row.detailId);
        const current = this.detailCurrent === null ? ids.length - 1 : ids.indexOf(this.detailCurrent);
        const from = current === -1 ? ids.length - 1 : current;
        const next = Math.max(0, Math.min(ids.length - 1, from + delta));

        this.detailCurrent = ids[next];
        // 往回翻就停止跟随新回答；再翻到最新一条则恢复跟随——这跟手动把转录滚回底部是一回事。
        this._detailFollowing = next === ids.length - 1;
        this.requestUpdate();
    }

    navigate(view) {
        this.currentView = view;
        this.requestUpdate();
    }

    async handleClose() {
        if (this.currentView === 'assistant') {
            cheatingDaddy.stopCapture();
            await ipcRenderer.invoke('close-session');
            this._paused = false;
            this.sessionActive = false;
            this._stopTimer();
            this.currentView = 'main';
        } else {
            await ipcRenderer.invoke('quit-application');
        }
    }

    async handleHideToggle() {
        await ipcRenderer.invoke('toggle-window-visibility');
    }

    // 真正的关闭按钮：像返回箭头那样把实时会话拆掉——停止采集、关闭会话让转录落盘——然后退出。少了这一步
    // 直接退出，会话会在磁盘上被截断，因为没有别的东西会告诉主进程会话已经结束。
    async handleQuit() {
        if (this.currentView === 'assistant' && this.sessionActive) {
            cheatingDaddy.stopCapture();
            await ipcRenderer.invoke('close-session');
            this.sessionActive = false;
            this._stopTimer();
        }
        await ipcRenderer.invoke('quit-application');
    }

    async togglePause() {
        this._paused = !this._paused;
        const res = await cheatingDaddy.setPaused(this._paused);
        // 真正说了算的是主进程；被拒（没有实时会话）就把按钮恢复原状，而不是停在一个从未进入过的状态上。
        if (!res?.success) this._paused = false;
        this.requestUpdate();
    }

    // 既丢掉模型看过的内容，也丢掉显示这些内容的已落定气泡。还在飞行中的一律留着跑完：把半句识别结果或半截
    // 流式回答冻在原地就是截断，而这是唯一绝不能做的事。上面那两个 floor 则拦住被丢掉的轮次在回答最终落地时
    // 重新冒出来。
    async handleClearContext() {
        const res = await cheatingDaddy.clearContext();
        if (!res?.success) return;

        this._turnFloorId = res.turnSeq;
        this._detailFloorId = res.detailSeq;

        // 面试者的行是一个不断变长的块，从不带落定标记，所以唯一能留的就是那个还开着的块——id 最大的那个。
        const openBlockId = Math.max(0, ...this.messages.filter(m => m.role === 'user').map(m => m.blockId));
        this.messages = this.messages.filter(m => (m.role === 'user' ? m.blockId === openBlockId : m.final !== true));
        this.detailMessages = this.detailMessages.filter(m => m.final !== true);
        if (this._detailIndex(this.detailCurrent) === -1) this.detailCurrent = null;
        this._detailFollowing = true;
        this.requestUpdate();
    }

    async handleStart() {
        // 只要求有所选识别器的那把 key；对话那把永远是 DeepSeek 的。
        const [chatKey, asrKey] = await Promise.all([cheatingDaddy.storage.getDeepseekApiKey(), cheatingDaddy.storage.getBailianApiKey()]);

        if (!chatKey || chatKey.trim() === '' || !asrKey || asrKey.trim() === '') {
            const mainView = this.shadowRoot.querySelector('main-view');
            if (mainView && mainView.triggerApiKeyError) {
                mainView.triggerApiKeyError();
            }
            return;
        }

        const success = await cheatingDaddy.initializeChat();
        if (!success) {
            const mainView = this.shadowRoot.querySelector('main-view');
            if (mainView && mainView.triggerApiKeyError) {
                mainView.triggerApiKeyError();
            }
            return;
        }

        cheatingDaddy.startCapture(this.selectedScreenshotInterval, this.selectedImageQuality);
        this.messages = [];
        this._paused = false;
        // floor 跟随的是主进程自己的计数器，而 resetAudioState 会把它们归零，所以沿用旧值会让新会话的每个
        // id 都落在旧 floor 之下，被静默压制。
        this._turnFloorId = 0;
        this._detailFloorId = 0;
        // 跟着转录一起清空：主进程重启会话时会丢掉自己的详细回答日志，留着这些会翻到已经不存在的回答。
        this.detailMessages = [];
        this.detailCurrent = null;
        this._detailFollowing = true;
        this.startTime = Date.now();
        this.sessionActive = true;
        this.currentView = 'assistant';
        this._startTimer();
    }

    async handleLanguageChange(language) {
        this.selectedLanguage = language;
        await cheatingDaddy.storage.updatePreference('selectedLanguage', language);
    }

    async handleScreenshotIntervalChange(interval) {
        this.selectedScreenshotInterval = interval;
        await cheatingDaddy.storage.updatePreference('selectedScreenshotInterval', interval);
    }

    async handleImageQualityChange(quality) {
        this.selectedImageQuality = quality;
        await cheatingDaddy.storage.updatePreference('selectedImageQuality', quality);
    }

    async handleLayoutModeChange(layoutMode) {
        this.layoutMode = layoutMode;
        await cheatingDaddy.storage.updateConfig('layout', layoutMode);
        this.requestUpdate();
    }

    async handleExternalLinkClick(url) {
        await ipcRenderer.invoke('open-external', url);
    }

    async handleSendText(message) {
        const result = await window.cheatingDaddy.sendTextMessage(message);
        if (!result.success) {
            this.setStatus('Error sending message: ' + result.error);
        } else {
            this.setStatus('Message sent...');
        }
    }

    handleOnboardingComplete() {
        this.currentView = 'main';
    }

    updated(changedProperties) {
        super.updated(changedProperties);

        if (changedProperties.has('currentView')) {
            ipcRenderer.send('view-changed', this.currentView);
        }
    }

    _isLiveMode() {
        return this.currentView === 'assistant';
    }

    renderCurrentView() {
        switch (this.currentView) {
            case 'onboarding':
                return html`
                    <onboarding-view .onComplete=${() => this.handleOnboardingComplete()} .onClose=${() => this.handleClose()}></onboarding-view>
                `;

            case 'main':
                return html`
                    <main-view .onStart=${() => this.handleStart()} .onExternalLink=${url => this.handleExternalLinkClick(url)}></main-view>
                `;

            case 'ai-customize':
                return html`<ai-customize-view></ai-customize-view>`;

            case 'customize':
                return html`
                    <customize-view
                        .selectedLanguage=${this.selectedLanguage}
                        .selectedScreenshotInterval=${this.selectedScreenshotInterval}
                        .selectedImageQuality=${this.selectedImageQuality}
                        .layoutMode=${this.layoutMode}
                        .onLanguageChange=${l => this.handleLanguageChange(l)}
                        .onScreenshotIntervalChange=${i => this.handleScreenshotIntervalChange(i)}
                        .onImageQualityChange=${q => this.handleImageQualityChange(q)}
                        .onLayoutModeChange=${lm => this.handleLayoutModeChange(lm)}
                    ></customize-view>
                `;

            case 'help':
                return html`<help-view .onExternalLinkClick=${url => this.handleExternalLinkClick(url)}></help-view>`;

            case 'history':
                return html`<history-view></history-view>`;

            case 'assistant':
                return html`
                    <assistant-view
                        .messages=${this.messages}
                        .detailMessages=${this.detailMessages}
                        .detailCurrent=${this.detailCurrent}
                        .onSendText=${msg => this.handleSendText(msg)}
                        .onDetailPrev=${() => this.stepDetail(-1)}
                        .onDetailNext=${() => this.stepDetail(1)}
                    ></assistant-view>
                `;

            default:
                return html`<div>Unknown view: ${this.currentView}</div>`;
        }
    }

    renderSidebar() {
        const items = [
            {
                id: 'main',
                label: 'Home',
                icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                        <path
                            d="m19 8.71l-5.333-4.148a2.666 2.666 0 0 0-3.274 0L5.059 8.71a2.67 2.67 0 0 0-1.029 2.105v7.2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.2c0-.823-.38-1.6-1.03-2.105"
                        />
                        <path d="M16 15c-2.21 1.333-5.792 1.333-8 0" />
                    </g>
                </svg>`,
            },
            {
                id: 'ai-customize',
                label: 'AI Customization',
                icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                    <path
                        fill="none"
                        stroke="currentColor"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M13 3v7h6l-8 11v-7H5z"
                    />
                </svg>`,
            },
            {
                id: 'history',
                label: 'History',
                icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                        <path
                            d="M10 20.777a9 9 0 0 1-2.48-.969M14 3.223a9.003 9.003 0 0 1 0 17.554m-9.421-3.684a9 9 0 0 1-1.227-2.592M3.124 10.5c.16-.95.468-1.85.9-2.675l.169-.305m2.714-2.941A9 9 0 0 1 10 3.223"
                        />
                        <path d="M12 8v4l3 3" />
                    </g>
                </svg>`,
            },
            {
                id: 'customize',
                label: 'Settings',
                icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                        <path
                            d="M19.875 6.27A2.23 2.23 0 0 1 21 8.218v7.284c0 .809-.443 1.555-1.158 1.948l-6.75 4.27a2.27 2.27 0 0 1-2.184 0l-6.75-4.27A2.23 2.23 0 0 1 3 15.502V8.217c0-.809.443-1.554 1.158-1.947l6.75-3.98a2.33 2.33 0 0 1 2.25 0l6.75 3.98z"
                        />
                        <path d="M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0" />
                    </g>
                </svg>`,
            },
            {
                id: 'help',
                label: 'Help & Support',
                icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                        <path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5l-5 3v-3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM9.5 9h.01m4.99 0h.01" />
                        <path d="M9.5 13a3.5 3.5 0 0 0 5 0" />
                    </g>
                </svg>`,
            },
        ];

        return html`
            <div class="sidebar ${this._isLiveMode() ? 'hidden' : ''}">
                <div class="sidebar-brand">
                    <h1>Cheating Daddy</h1>
                </div>
                <nav class="sidebar-nav">
                    ${items.map(
                        item => html`
                            <button
                                class="nav-item ${this.currentView === item.id ? 'active' : ''}"
                                @click=${() => this.navigate(item.id)}
                                title=${item.label}
                            >
                                ${item.icon} ${item.label}
                            </button>
                        `
                    )}
                </nav>
                <div class="sidebar-footer">
                    ${
                        this._updateAvailable
                            ? html`
                                  <button class="update-btn" @click=${() => this.handleExternalLinkClick('https://cheatingdaddy.com/download')}>
                                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                                          <path
                                              fill="none"
                                              stroke="currentColor"
                                              stroke-linecap="round"
                                              stroke-linejoin="round"
                                              stroke-width="2"
                                              d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 11l5 5l5-5m-5-7v12"
                                          />
                                      </svg>
                                      Update available
                                  </button>
                              `
                            : html` <div class="version-text">v${this._localVersion}</div> `
                    }
                </div>
            </div>
        `;
    }

    // 每页右上角都是这两个形状：一条横杠隐藏窗口（Ctrl+\ 唤回），一个叉退出。Windows 用户一眼就认，这正是
    // 弃用 macOS 那三个圆点的原因——也是它们出现在直播页的原因，那里没有拖拽栏。
    renderWindowButtons() {
        return html`
            <div class="window-controls">
                <button class="icon-btn" @click=${() => this.handleHideToggle()} title="Hide window">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <path d="M5 12h14" />
                    </svg>
                </button>
                <button class="icon-btn danger" @click=${() => this.handleQuit()} title="Quit">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                </button>
            </div>
        `;
    }

    renderLiveBar() {
        if (!this._isLiveMode()) return '';

        return html`
            <div class="live-bar">
                <div class="live-bar-left">
                    <button class="icon-btn" @click=${() => this.handleClose()} title="End session">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                            <path
                                fill-rule="evenodd"
                                d="M12.79 5.23a.75.75 0 0 1-.02 1.06L8.832 10l3.938 3.71a.75.75 0 1 1-1.04 1.08l-4.5-4.25a.75.75 0 0 1 0-1.08l4.5-4.25a.75.75 0 0 1 1.06.02Z"
                                clip-rule="evenodd"
                            />
                        </svg>
                    </button>
                    <button
                        class="icon-btn ${this._paused ? 'active' : ''}"
                        @click=${() => this.togglePause()}
                        title=${this._paused ? 'Resume' : 'Pause'}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="7" y="5" width="3.4" height="14" rx="1" />
                            <rect x="13.6" y="5" width="3.4" height="14" rx="1" />
                        </svg>
                    </button>
                    <button class="icon-btn" @click=${() => this.handleClearContext()} title="Clear context">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <polyline points="23 4 23 10 17 10" />
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                        </svg>
                    </button>
                </div>
                <div class="live-bar-center">Interview</div>
                <div class="live-bar-right">
                    ${this.statusText ? html`<span class="live-bar-text">${this.statusText}</span>` : ''}
                    <span class="live-bar-text">${this.getElapsedTime()}</span>
                    ${this._isClickThrough ? html`<span class="live-bar-text">[click through]</span>` : ''} ${this.renderWindowButtons()}
                </div>
            </div>
        `;
    }

    render() {
        // 引导页是全屏、没有侧栏的，但仍然给它拖拽栏：否则离开一个全屏页面只能靠用户未必知道的全局快捷键。
        if (this.currentView === 'onboarding') {
            return html`
                <div class="top-drag-bar">
                    <div class="drag-region"></div>
                    ${this.renderWindowButtons()}
                </div>
                <div class="fullscreen">${this.renderCurrentView()}</div>
            `;
        }

        const isLive = this._isLiveMode();

        return html`
            <div class="app-shell">
                <div class="top-drag-bar ${isLive ? 'hidden' : ''}">
                    <div class="drag-region"></div>
                    ${this.renderWindowButtons()}
                </div>
                ${this.renderSidebar()}
                <div class="content">
                    ${isLive ? this.renderLiveBar() : ''}
                    <div class="content-inner ${isLive ? 'live' : ''}">${this.renderCurrentView()}</div>
                </div>
            </div>
        `;
    }
}

customElements.define('cheating-daddy-app', CheatingDaddyApp);
