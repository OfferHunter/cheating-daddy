import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { MainView } from '../views/MainView.js';
import { CustomizeView } from '../views/CustomizeView.js';
import { HelpView } from '../views/HelpView.js';
import { HistoryView } from '../views/HistoryView.js';
import { AssistantView } from '../views/AssistantView.js';
import { OnboardingView } from '../views/OnboardingView.js';
import { AICustomizeView } from '../views/AICustomizeView.js';
import { FeedbackView } from '../views/FeedbackView.js';

export class CheatingDaddyApp extends LitElement {
    static styles = css`
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
            background: var(--bg-app);
            color: var(--text-primary);
        }

        /* ── Full app shell: top bar + sidebar/content ── */

        .app-shell {
            display: flex;
            height: calc(100vh - 2px);
            margin: 1px;
            overflow: hidden;
            border: 2px solid rgba(255, 255, 255, 0.18);
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

        /* Hide / quit, at the top right of every page. The drag region takes the space in front of them. */
        .window-controls {
            display: flex;
            align-items: center;
            gap: var(--space-sm);
            height: 100%;
            -webkit-app-region: no-drag;
        }

        /* The one button shape in the header: circular, quiet until hovered. Used for the session
           controls on the left of the live bar and the window controls on the right. */
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
        }

        .icon-btn.danger:hover {
            background: var(--danger);
            border-color: transparent;
            color: #fff;
        }

        /* Paused: the ring is the whole indicator, since the mic light stays on through a soft pause. */
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

        /* ── Main content area ── */

        .content {
            flex: 1;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            background: var(--bg-app);
        }

        /* Live mode top bar */
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

        /* Content inner */
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

        /* Onboarding fills everything */
        .fullscreen {
            position: fixed;
            inset: 0;
            z-index: 100;
            background: var(--bg-app);
        }

        ::-webkit-scrollbar {
            width: 6px;
            height: 6px;
        }

        ::-webkit-scrollbar-track {
            background: transparent;
        }

        ::-webkit-scrollbar-thumb {
            background: var(--border-strong);
            border-radius: 3px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: #444444;
        }
    `;

    static properties = {
        currentView: { type: String },
        statusText: { type: String },
        startTime: { type: Number },
        isRecording: { type: Boolean },
        sessionActive: { type: Boolean },
        selectedLanguage: { type: String },
        messages: { type: Array },
        // Held here rather than in the assistant view, which is rebuilt on every navigation: the
        // detailed answers have to outlive a trip to another page, exactly like the transcript does.
        detailMessages: { type: Array },
        detailCurrent: { type: Number },
        selectedScreenshotInterval: { type: String },
        selectedImageQuality: { type: String },
        layoutMode: { type: String },
        _viewInstances: { type: Object, state: true },
        _isClickThrough: { state: true },
        _storageLoaded: { state: true },
        _updateAvailable: { state: true },
    };

    constructor() {
        super();
        this.currentView = 'main';
        this.statusText = '';
        this.startTime = null;
        this.isRecording = false;
        this.sessionActive = false;
        this.selectedLanguage = 'cmn-CN';
        this.selectedScreenshotInterval = '5';
        this.selectedImageQuality = 'medium';
        this.layoutMode = 'normal';
        this.messages = [];
        this._msgSeq = 0;
        // Soft pause: the main process keeps feeding the recognizer silence, so resuming is instant and
        // nothing has to be reconnected.
        this._paused = false;
        // Sequence numbers below which the main process has forgotten. Only ever used to refuse opening a
        // new bubble for a turn dispatched before the clear — a bubble that already exists keeps updating,
        // because it may be mid-stream and freezing it is exactly the truncation to avoid.
        this._turnFloorId = 0;
        this._detailFloorId = 0;
        this.detailMessages = [];
        this.detailCurrent = null;
        // Follow the newest detailed answer until the user pages back to an older one, at which point a
        // new one must not yank the pane away from what they are reading.
        this._detailFollowing = true;
        this._viewInstances = new Map();
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
            // silently ignore
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

        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            ipcRenderer.on('new-response', (_, response) => this.addNewResponse(response));
            ipcRenderer.on('update-response', (_, response) => this.updateCurrentResponse(response));
            ipcRenderer.on('response-complete', (_, data) => this.completeResponse(data));
            ipcRenderer.on('transcription-update', (_, data) => this.upsertTranscription(data.text, false, data.speaker, data.blockId));
            ipcRenderer.on('transcription-final', (_, data) => {
                this.upsertTranscription(data.text, true, data.speaker, data.blockId);
                // A screenshot's line is the written-up question of the pane row opened by the same turn,
                // which was created with a placeholder: this is where the two halves are joined.
                if (data.speaker === 'screen') this._setDetailQuestion(data.blockId, data.text);
            });
            ipcRenderer.on('update-status', (_, status) => this.setStatus(status));
            ipcRenderer.on('click-through-toggled', (_, isEnabled) => {
                this._isClickThrough = isEnabled;
            });
            ipcRenderer.on('reconnect-failed', (_, data) => this.addNewResponse(data.message));
            ipcRenderer.on('new-detail-response', (_, data) => this.addDetailResponse(data));
            ipcRenderer.on('update-detail-response', (_, data) => this.updateDetailResponse(data));
            ipcRenderer.on('detail-response-complete', (_, data) => this.completeDetailResponse(data));
            ipcRenderer.on('detail-tool-used', (_, data) => this.handleDetailToolUsed(data));
            // Registered here rather than in the assistant view: the shortcuts have to be caught while
            // another page is showing too, and only the app element is around for the whole session.
            ipcRenderer.on('detail-prev', () => this.stepDetail(-1));
            ipcRenderer.on('detail-next', () => this.stepDetail(1));
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._stopTimer();
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
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
    }

    // ── Timer ──

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

    // ── Status & Responses ──

    setStatus(text) {
        this.statusText = text;
    }

    // The transcript arrives as a whole-turn snapshot: rewrite the bubble that is still open, or
    // start a new one. A settled bubble is never touched again. Both speakers stream at once, so the
    // search runs from the end for the matching role — an open bubble of one speaker is never
    // rewritten by the other, and a bubble keeps the position where its speaker started talking.
    upsertTranscription(text, final, speaker = 'interviewer', blockId = null) {
        const role = speaker === 'user' ? 'user' : 'interviewer';
        // `final` settles a row for the walk below. It means that for a screenshot's question line, but
        // not for the candidate's plain text: the next fragment continues the same bubble, so the flag
        // has no meaning there and is held down whatever the event says.
        const settled = role === 'user' ? false : final;

        // A row that arrived with a block id belongs to that block and is rewritten in place, never by
        // position: a question recognized while the block was still open is appended below it, and the
        // block's own final has to find its row again, above that question. The pipeline hands out a new
        // id when a question closes the block, so the next thing said still starts a new bubble. Two
        // kinds of row work this way — the candidate's own speech, and the line a screenshot's question
        // is written up as, which is found by its id rather than by role since it is shown as the
        // interviewer's.
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
            // An open row that belongs to a block is not this speaker's open row, so it is stepped over
            // rather than rewritten. A settled one still stops the walk above, exactly as before.
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

    // Turns stream concurrently, so a bubble can no longer be located by being the last one: an
    // interviewer bubble is appended between two live answers. `turnId` is what routes a token to
    // its own bubble. A bare string still arrives from the reconnect handler, which has no turn behind it.
    addNewResponse(data) {
        const { turnId = null, text = '', final = false } = typeof data === 'string' ? { text: data, final: true } : data;
        // A turn dispatched before the context was cleared must not reappear after it. Only creation is
        // blocked; a bubble that already exists is still updated by the two callers below.
        if (turnId !== null && turnId <= this._turnFloorId) return;
        this.messages = [...this.messages, { id: ++this._msgSeq, turnId, role: 'assistant', text, ts: Date.now(), final }];
        this.requestUpdate();
    }

    updateCurrentResponse(data) {
        const { turnId = null, text = '' } = typeof data === 'string' ? { text: data } : data || {};
        // Without an id there is no bubble to target, so fall back to appending a finished one.
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

    // ── Detailed answers ──

    _detailIndex(detailId) {
        return this.detailMessages.findIndex(m => m.detailId === detailId);
    }

    // Detailed answers are keyed by their own id, never by position: the main process drops all but the
    // last few, and a position that shifts under the pane would silently show the wrong answer.
    _ensureDetailRow(detailId, turnSeq, question) {
        const index = this._detailIndex(detailId);
        if (index !== -1) return index;
        // Same rule as the transcript: an answer that was requested before the clear may not open a row
        // afterwards. A row that already exists was checked above and keeps updating to completion.
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

        // A request that failed before its first token never opened a row, so the completion is what has
        // to bring the failure into view rather than being dropped for want of somewhere to land.
        const index = this._ensureDetailRow(detailId, turnSeq, question);
        if (index === -1) return;
        this._replaceDetail(index, { final: true, ok, error, usedKnowledge, truncated });
    }

    // A screenshot's pane row is opened the moment the image is sent, because thinking can hold its first
    // token back for half a minute and the row must exist before a clear-context can raise the floor
    // above it. Its question is the image summary, which arrives seconds later, so the row starts with a
    // placeholder and is corrected here. Ordinary rows carry the question they were created with.
    _setDetailQuestion(turnSeq, question) {
        const index = this.detailMessages.findIndex(m => m.turnSeq === turnSeq);
        if (index === -1) return;
        this._replaceDetail(index, { question });
    }

    handleDetailToolUsed(data) {
        const { detailId = null, id } = data || {};
        const index = this._detailIndex(detailId);
        if (index === -1 || !id) return;

        const row = this.detailMessages[index];
        if (row.usedKnowledge.includes(id)) return;

        this._replaceDetail(index, { usedKnowledge: [...row.usedKnowledge, id] });
    }

    // The pane's ‹ › buttons and their shortcuts land here. One step per press, clamped at both ends.
    stepDetail(delta) {
        if (!this.detailMessages.length) return;

        const ids = this.detailMessages.map(row => row.detailId);
        const current = this.detailCurrent === null ? ids.length - 1 : ids.indexOf(this.detailCurrent);
        const from = current === -1 ? ids.length - 1 : current;
        const next = Math.max(0, Math.min(ids.length - 1, from + delta));

        this.detailCurrent = ids[next];
        // Stepping back stops the pane following new answers; stepping forward to the newest resumes it,
        // since that is the same bargain as scrolling the transcript back to its bottom by hand.
        this._detailFollowing = next === ids.length - 1;
        this.requestUpdate();
    }

    // ── Navigation ──

    navigate(view) {
        this.currentView = view;
        this.requestUpdate();
    }

    async handleClose() {
        if (this.currentView === 'assistant') {
            cheatingDaddy.stopCapture();
            if (window.require) {
                const { ipcRenderer } = window.require('electron');
                await ipcRenderer.invoke('close-session');
            }
            this._paused = false;
            this.sessionActive = false;
            this._stopTimer();
            this.currentView = 'main';
        } else {
            if (window.require) {
                const { ipcRenderer } = window.require('electron');
                await ipcRenderer.invoke('quit-application');
            }
        }
    }

    async handleHideToggle() {
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('toggle-window-visibility');
        }
    }

    // The close button proper: tear the live session down the way the back arrow does — stop capturing,
    // close the session so the transcript is flushed — and then quit. Quitting without it would cut the
    // session short on disk, since nothing else would tell the main process the session had ended.
    async handleQuit() {
        if (this.currentView === 'assistant' && this.sessionActive) {
            cheatingDaddy.stopCapture();
            if (window.require) {
                const { ipcRenderer } = window.require('electron');
                await ipcRenderer.invoke('close-session');
            }
            this.sessionActive = false;
            this._stopTimer();
        }
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('quit-application');
        }
    }

    async togglePause() {
        this._paused = !this._paused;
        const res = await cheatingDaddy.setPaused(this._paused);
        // The main process is the one that actually decides; a refusal (no live session) puts the button
        // back rather than leaving it showing a state that was never entered.
        if (!res?.success) this._paused = false;
        this.requestUpdate();
    }

    // Drops both what the model has seen and the settled bubbles that show it. Anything still in flight is
    // kept and left to finish: freezing a half-recognized sentence or a half-streamed answer where it
    // stands is a truncation, and that is the one thing this must not do. The floors above then stop the
    // dropped turns from reappearing when their replies finally land.
    async handleClearContext() {
        const res = await cheatingDaddy.clearContext();
        if (!res?.success) return;

        this._turnFloorId = res.turnSeq;
        this._detailFloorId = res.detailSeq;

        // A candidate row is written as one growing block and never carries a settled flag, so the block
        // that is still open — the highest id among them — is the only one there is to keep.
        const openBlockId = Math.max(0, ...this.messages.filter(m => m.role === 'user').map(m => m.blockId));
        this.messages = this.messages.filter(m => (m.role === 'user' ? m.blockId === openBlockId : m.final !== true));
        this.detailMessages = this.detailMessages.filter(m => m.final !== true);
        if (this._detailIndex(this.detailCurrent) === -1) this.detailCurrent = null;
        this._detailFollowing = true;
        this.requestUpdate();
    }

    // ── Session start ──

    async handleStart() {
        // Only the key for the selected recognizer is required; the chat key is always DeepSeek's.
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
        // The floors track the main process's own counters, which resetAudioState takes back to zero, so
        // carrying them over would put every id of the new session under the old floor and silently
        // suppress it.
        this._turnFloorId = 0;
        this._detailFloorId = 0;
        // Cleared with the transcript: the main process drops its own detail log when the session
        // restarts, so keeping these would page into answers that no longer exist.
        this.detailMessages = [];
        this.detailCurrent = null;
        this._detailFollowing = true;
        this.startTime = Date.now();
        this.sessionActive = true;
        this.currentView = 'assistant';
        this._startTimer();
    }

    // ── Settings handlers ──

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
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('open-external', url);
        }
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

        if (changedProperties.has('currentView') && window.require) {
            const { ipcRenderer } = window.require('electron');
            ipcRenderer.send('view-changed', this.currentView);
        }
    }

    // ── Helpers ──

    _isLiveMode() {
        return this.currentView === 'assistant';
    }

    // ── Render ──

    renderCurrentView() {
        switch (this.currentView) {
            case 'onboarding':
                return html`
                    <onboarding-view .onComplete=${() => this.handleOnboardingComplete()} .onClose=${() => this.handleClose()}></onboarding-view>
                `;

            case 'main':
                return html`
                    <main-view
                        .onStart=${() => this.handleStart()}
                        .onExternalLink=${url => this.handleExternalLinkClick(url)}
                    ></main-view>
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

            case 'feedback':
                return html`<feedback-view></feedback-view>`;

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
                id: 'feedback',
                label: 'Feedback',
                icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                        <path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5l-5 3v-3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM9.5 9h.01m4.99 0h.01" />
                        <path d="M9.5 13a3.5 3.5 0 0 0 5 0" />
                    </g>
                </svg>`,
            },
            {
                id: 'help',
                label: 'Help',
                icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                        <path d="M12 3c7.2 0 9 1.8 9 9s-1.8 9-9 9s-9-1.8-9-9s1.8-9 9-9m0 13v.01" />
                        <path d="M12 13a2 2 0 0 0 .914-3.782a1.98 1.98 0 0 0-2.414.483" />
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

    // The same two shapes at the top right of every page: a dash that hides the window (Ctrl+\ brings
    // it back) and an x that quits. Windows users read those instantly, which is the point of dropping
    // the macOS dots — and it is why they sit on the live page too, where the drag bar is hidden.
    renderWindowButtons() {
        return html`
            <div class="window-controls">
                <button class="icon-btn" @click=${() => this.handleHideToggle()} title="Hide window">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M5 12h14" />
                    </svg>
                </button>
                <button class="icon-btn danger" @click=${() => this.handleQuit()} title="Quit">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="23 4 23 10 17 10" />
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                        </svg>
                    </button>
                </div>
                <div class="live-bar-center">Interview</div>
                <div class="live-bar-right">
                    ${this.statusText ? html`<span class="live-bar-text">${this.statusText}</span>` : ''}
                    <span class="live-bar-text">${this.getElapsedTime()}</span>
                    ${this._isClickThrough ? html`<span class="live-bar-text">[click through]</span>` : ''}
                    ${this.renderWindowButtons()}
                </div>
            </div>
        `;
    }

    render() {
        // Onboarding is fullscreen, no sidebar. It gets the drag bar anyway: without it there is no way
        // out of a fullscreen page but a global shortcut the user may not know.
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
