import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { conversationStyles, renderMarkdown } from './conversationStyles.js';

export class AssistantView extends LitElement {
    // Three parts, in this order, so the rules keep the cascade they had as one template.
    static styles = [
        css`
        :host {
            height: 100%;
            display: flex;
            flex-direction: column;

            /* The transcript's side inset, and the only knob for it: the shell around this view
               contributes a single 3px line, so everything visible on the left is this value. The
               input bar shares it, which is what lines the pill up with the bubbles above it. */
            --chat-gutter: 8px;
        }

        * {
            font-family: var(--font);
            cursor: default;
        }

        /* ── Chat transcript ── */

        /* ── Live split: the transcript and the detailed answers side by side ── */

        .live-split {
            flex: 1;
            min-height: 0;
            display: flex;
        }

        .chat-wrap {
            position: relative;
            flex: 1;
            /* Without this the column refuses to shrink below the width of its own content and pushes the
               pane off the right edge instead of sharing the row with it. */
            min-width: 0;
            min-height: 0;
            display: flex;
        }

        /* No background of its own: the transcript sits directly on the shell that the opacity
           slider already controls, so live mode is exactly as see-through as every other page. */
        .chat-scroll {
            flex: 1;
            overflow-y: auto;
            font-size: var(--response-font-size, 15px);
            line-height: var(--line-height);
            background: transparent;
            scroll-behavior: auto;
            user-select: text;
            cursor: text;
        }

        .chat-scroll * {
            user-select: text;
            cursor: text;
        }

        .chat-scroll a {
            cursor: pointer;
        }

        .chat-scroll::-webkit-scrollbar {
            width: 6px;
        }

        .chat-scroll::-webkit-scrollbar-track {
            background: transparent;
        }

        .chat-scroll::-webkit-scrollbar-thumb {
            background: var(--border-strong);
            border-radius: 3px;
        }

        .chat-scroll::-webkit-scrollbar-thumb:hover {
            background: var(--text-muted);
        }

        .chat-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding: 12px var(--chat-gutter);
        }

        .chat-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            padding: var(--space-md);
            text-align: center;
            color: var(--text-muted);
            font-size: var(--font-size-sm);
        }

        `,
        // The transcript's own look, shared with the History page: it shows a recorded session as the
        // same conversation, so both views take the bubbles and the markdown from one place.
        conversationStyles,
        css`

        /* ── Jump to latest ── */

        .jump-latest {
            position: absolute;
            right: 12px;
            bottom: 12px;
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 10px;
            border-radius: 100px;
            border: 1px solid var(--border);
            background: var(--bg-elevated);
            color: var(--text-primary);
            font-size: var(--font-size-xs);
            cursor: pointer;
            box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
        }

        .jump-latest[hidden] {
            display: none;
        }

        .jump-latest svg {
            width: 12px;
            height: 12px;
        }

        /* ── Bottom input bar ── */

        .input-bar {
            display: flex;
            align-items: center;
            gap: var(--space-sm);
            padding: var(--space-md) var(--chat-gutter);
            background: transparent;
        }

        .input-bar-inner {
            display: flex;
            align-items: center;
            flex: 1;
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            border-radius: 100px;
            padding: 0 var(--space-md);
            height: 32px;
            transition: border-color var(--transition);
        }

        .input-bar-inner:focus-within {
            border-color: var(--accent);
        }

        .input-bar-inner input {
            flex: 1;
            background: none;
            color: var(--text-primary);
            border: none;
            padding: 0;
            font-size: var(--font-size-sm);
            font-family: var(--font);
            height: 100%;
            outline: none;
        }

        .input-bar-inner input::placeholder {
            color: var(--text-muted);
        }

        .analyze-btn {
            position: relative;
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            color: var(--text-primary);
            cursor: pointer;
            font-size: var(--font-size-xs);
            font-family: var(--font-mono);
            white-space: nowrap;
            padding: var(--space-xs) var(--space-md);
            border-radius: 100px;
            height: 32px;
            display: flex;
            align-items: center;
            gap: 4px;
            transition: border-color 0.4s ease, background var(--transition);
            flex-shrink: 0;
            overflow: hidden;
        }

        .analyze-btn:hover:not(.analyzing) {
            border-color: var(--accent);
            background: var(--bg-surface);
        }

        .analyze-btn.analyzing {
            cursor: default;
            border-color: transparent;
        }

        .analyze-btn-content {
            display: flex;
            align-items: center;
            gap: 4px;
            transition: opacity 0.4s ease;
            z-index: 1;
            position: relative;
        }

        .analyze-btn.analyzing .analyze-btn-content {
            opacity: 0;
        }

        .analyze-canvas {
            position: absolute;
            inset: -1px;
            width: calc(100% + 2px);
            height: calc(100% + 2px);
            pointer-events: none;
        }

        /* ── Detailed answer pane ── */

        .detail-pane {
            flex: none;
            width: 38%;
            min-width: 0;
            display: flex;
            flex-direction: column;
            border-left: 1px solid var(--border);
            padding: 12px var(--chat-gutter);
        }

        .detail-pane[hidden] {
            display: none;
        }

        .detail-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: var(--space-sm);
            padding-bottom: var(--space-xs);
            color: var(--text-muted);
            font-size: var(--font-size-xs);
        }

        /* Quoted, not repeated as a heading: it is there to say which question the answer belongs to when
           the user has paged back, not to compete with the answer itself. */
        .detail-question {
            margin-bottom: var(--space-sm);
            padding-left: var(--space-sm);
            border-left: 2px solid var(--border);
            color: var(--text-muted);
            font-size: var(--font-size-xs);
            word-break: break-word;
        }

        .detail-scroll {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            font-size: var(--response-font-size, 15px);
            line-height: var(--line-height);
            user-select: text;
            cursor: text;
        }

        .detail-scroll::-webkit-scrollbar {
            width: 6px;
        }

        .detail-scroll::-webkit-scrollbar-track {
            background: transparent;
        }

        .detail-scroll::-webkit-scrollbar-thumb {
            background: var(--border-strong);
            border-radius: 3px;
        }

        /* The pane body carries the transcript's markdown class so there is exactly one set of markdown
           rules to keep in step; only the bubble chrome is undone, a panel not being a bubble. */
        .detail-body.message-body {
            max-width: none;
            padding: 0;
            border-radius: 0;
            background: transparent;
            box-shadow: none;
        }

        .detail-body.streaming::after {
            content: '▍';
            margin-left: 1px;
            animation: caret-blink 1s step-end infinite;
        }

        .detail-note {
            margin-top: var(--space-sm);
            color: var(--text-muted);
            font-size: var(--font-size-xs);
        }

        .detail-note.danger {
            color: var(--danger);
        }

        .detail-nav {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: var(--space-xs);
            padding-top: var(--space-sm);
        }

        .detail-nav button {
            width: 26px;
            height: 26px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: var(--radius-sm);
            border: 1px solid var(--border);
            background: var(--bg-elevated);
            color: var(--text-primary);
            font-size: var(--font-size-sm);
            cursor: pointer;
        }

        .detail-nav button:hover:not(:disabled) {
            border-color: var(--accent);
        }

        .detail-nav button:disabled {
            opacity: 0.45;
            cursor: default;
        }
        `,
    ];

    static properties = {
        messages: { type: Array },
        onSendText: { type: Function },
        isAnalyzing: { type: Boolean, state: true },
        // The detailed answers and which one is showing. Both are owned by the app element rather than
        // this view, because this view is torn down and rebuilt on every navigation while the answers
        // have to survive it — the same reason `messages` lives up there.
        detailMessages: { type: Array },
        detailCurrent: { type: Number },
        onDetailPrev: { type: Function },
        onDetailNext: { type: Function },
    };

    constructor() {
        super();
        this.messages = [];
        this.onSendText = () => {};
        this.isAnalyzing = false;
        this.detailMessages = [];
        this.detailCurrent = null;
        this.onDetailPrev = () => {};
        this.onDetailNext = () => {};
        this._animFrame = null;
        this._pinned = true;
        this._detailAtBottom = true;
        // The turn the screenshot on the button belongs to, while it is being answered. It is what the
        // busy state follows: the answer lands in the pane, keyed by this turn, and nothing else in the
        // view moves when it arrives.
        this._screenTurnId = null;
    }

    // Shared with the History page so both views render an answer identically.
    renderMarkdown(content) {
        return renderMarkdown(content);
    }

    // The screenshot's answer landing in the pane is the only signal that it finished, so the busy state
    // watches that row itself being settled. Counting answers instead would let a first screenshot's
    // completion clear the busy state while a second one was still on its way.
    _screenAnswerSettled() {
        if (this._screenTurnId === null) return false;
        const row = this.detailMessages.find(m => m.turnSeq === this._screenTurnId);
        return Boolean(row && row.final);
    }

    // Only the bubble whose text actually changed is re-parsed, so a streaming answer costs one
    // markdown pass per token instead of one per bubble.
    _syncMarkdown() {
        for (const message of this.messages) {
            if (message.role !== 'assistant') continue;

            const el = this.shadowRoot.querySelector(`[data-msg-id="${message.id}"]`);
            if (!el || el._renderedText === message.text) continue;

            el.innerHTML = this.renderMarkdown(message.text);
            el._renderedText = message.text;
        }
    }

    // The pane shows one answer at a time, so this cannot ride on _syncMarkdown above: that one walks
    // this.messages, which holds no detailed answers at all. Keyed on the row id as well as the text,
    // because paging between two answers has to re-render even when their text happens to match.
    _syncDetailMarkdown() {
        const el = this.shadowRoot.querySelector('[data-detail-id]');
        if (!el) return;

        const row = this._currentDetail();
        const key = `${row ? row.detailId : 0}:${row ? row.text : ''}`;
        if (el._renderedKey === key) return;

        el.innerHTML = this.renderMarkdown(row ? row.text : '');
        el._renderedKey = key;
    }

    // The row being shown, or the newest one when the selection is stale — an answer that has been
    // dropped by the cap on retained turns must not blank the pane.
    _currentDetail() {
        if (!this.detailMessages.length) return null;
        return this.detailMessages.find(row => row.detailId === this.detailCurrent) || this.detailMessages[this.detailMessages.length - 1];
    }

    _detailPosition() {
        const row = this._currentDetail();
        return row ? this.detailMessages.indexOf(row) : -1;
    }

    // ── Scrolling ──

    handleScroll() {
        const container = this.shadowRoot.querySelector('.chat-scroll');
        if (!container) return;

        const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
        if (atBottom !== this._pinned) {
            this._pinned = atBottom;
            this.requestUpdate();
        }
    }

    _scrollToBottom() {
        const container = this.shadowRoot.querySelector('.chat-scroll');
        if (container) {
            container.scrollTop = container.scrollHeight;
        }
    }

    jumpToLatest() {
        this._pinned = true;
        this._scrollToBottom();
        this.requestUpdate();
    }

    // The pane has no jump button — a single answer is nothing to lose your place in — so this only
    // decides whether streaming text should drag the view down with it.
    handleDetailScroll() {
        const container = this.shadowRoot.querySelector('.detail-scroll');
        if (!container) return;
        this._detailAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
    }

    _scrollDetailToBottom() {
        const container = this.shadowRoot.querySelector('.detail-scroll');
        if (container) container.scrollTop = container.scrollHeight;
    }

    scrollResponseUp() {
        const container = this.shadowRoot.querySelector('.chat-scroll');
        if (container) {
            const scrollAmount = container.clientHeight * 0.3;
            container.scrollTop = Math.max(0, container.scrollTop - scrollAmount);
        }
    }

    scrollResponseDown() {
        const container = this.shadowRoot.querySelector('.chat-scroll');
        if (container) {
            const scrollAmount = container.clientHeight * 0.3;
            container.scrollTop = Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + scrollAmount);
        }
    }

    connectedCallback() {
        super.connectedCallback();

        if (window.require) {
            const { ipcRenderer } = window.require('electron');

            this.handleScrollUp = () => this.scrollResponseUp();
            this.handleScrollDown = () => this.scrollResponseDown();

            ipcRenderer.on('scroll-response-up', this.handleScrollUp);
            ipcRenderer.on('scroll-response-down', this.handleScrollDown);
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._stopWaveformAnimation();

        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            if (this.handleScrollUp) ipcRenderer.removeListener('scroll-response-up', this.handleScrollUp);
            if (this.handleScrollDown) ipcRenderer.removeListener('scroll-response-down', this.handleScrollDown);
        }
    }

    async handleSendText() {
        const textInput = this.shadowRoot.querySelector('#textInput');
        if (textInput && textInput.value.trim()) {
            const message = textInput.value.trim();
            textInput.value = '';
            await this.onSendText(message);
        }
    }

    handleTextKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.handleSendText();
        }
    }

    async handleScreenAnswer() {
        if (this.isAnalyzing || !window.captureManualScreenshot) return;

        this.isAnalyzing = true;
        // Awaited because the capture can decline to send anything at all — no stream, or a video that
        // has not produced a frame yet. Those paths return no turn, which means no answer is coming and
        // the busy state has to end here rather than wait for a completion that will never arrive.
        const result = await window.captureManualScreenshot();
        if (!result?.success) {
            this.isAnalyzing = false;
            return;
        }

        this._screenTurnId = result.turnId;
        // The answer may have landed before this promise resolved.
        if (this._screenAnswerSettled()) {
            this.isAnalyzing = false;
            this._screenTurnId = null;
        }
    }

    _startWaveformAnimation() {
        const canvas = this.shadowRoot.querySelector('.analyze-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;

        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        const dangerColor = getComputedStyle(this).getPropertyValue('--danger').trim() || '#EF4444';
        const startTime = performance.now();
        const FADE_IN = 0.5; // seconds
        const PARTICLE_SPREAD = 4; // px inward from border
        const PARTICLE_COUNT = 250;

        // Pill perimeter helpers
        const w = rect.width;
        const h = rect.height;
        const r = h / 2; // pill radius = half height
        const straightLen = w - 2 * r;
        const arcLen = Math.PI * r;
        const perimeter = 2 * straightLen + 2 * arcLen;

        // Given a distance along the perimeter, return {x, y, nx, ny} (position + inward normal)
        const pointOnPerimeter = (d) => {
            d = ((d % perimeter) + perimeter) % perimeter;
            // Top straight: left to right
            if (d < straightLen) {
                return { x: r + d, y: 0, nx: 0, ny: 1 };
            }
            d -= straightLen;
            // Right arc
            if (d < arcLen) {
                const angle = -Math.PI / 2 + (d / arcLen) * Math.PI;
                return {
                    x: w - r + Math.cos(angle) * r,
                    y: r + Math.sin(angle) * r,
                    nx: -Math.cos(angle),
                    ny: -Math.sin(angle),
                };
            }
            d -= arcLen;
            // Bottom straight: right to left
            if (d < straightLen) {
                return { x: w - r - d, y: h, nx: 0, ny: -1 };
            }
            d -= straightLen;
            // Left arc
            const angle = Math.PI / 2 + (d / arcLen) * Math.PI;
            return {
                x: r + Math.cos(angle) * r,
                y: r + Math.sin(angle) * r,
                nx: -Math.cos(angle),
                ny: -Math.sin(angle),
            };
        };

        // Pre-seed random offsets for stable particles
        const seeds = [];
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            seeds.push({ pos: Math.random(), drift: Math.random(), depthSeed: Math.random() });
        }

        const draw = (now) => {
            const elapsed = (now - startTime) / 1000;
            const fade = Math.min(1, elapsed / FADE_IN);

            ctx.clearRect(0, 0, w, h);

            // ── Particle border ──
            ctx.fillStyle = dangerColor;
            for (let i = 0; i < PARTICLE_COUNT; i++) {
                const s = seeds[i];
                const along = (s.pos + s.drift * elapsed * 0.03) * perimeter;
                const depth = s.depthSeed * PARTICLE_SPREAD;
                const density = 1 - depth / PARTICLE_SPREAD;

                if (Math.random() > density) continue;

                const p = pointOnPerimeter(along);
                const px = p.x + p.nx * depth;
                const py = p.y + p.ny * depth;
                const size = 0.8 + density * 0.6;

                ctx.globalAlpha = fade * density * 0.85;
                ctx.beginPath();
                ctx.arc(px, py, size, 0, Math.PI * 2);
                ctx.fill();
            }

            // ── Waveform ──
            const midY = h / 2;
            const waves = [
                { freq: 3, amp: 0.35, speed: 2.5, opacity: 0.9, width: 1.8 },
                { freq: 5, amp: 0.2, speed: 3.5, opacity: 0.5, width: 1.2 },
                { freq: 7, amp: 0.12, speed: 5, opacity: 0.3, width: 0.8 },
            ];

            for (const wave of waves) {
                ctx.beginPath();
                ctx.strokeStyle = dangerColor;
                ctx.globalAlpha = wave.opacity * fade;
                ctx.lineWidth = wave.width;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';

                for (let x = 0; x <= w; x++) {
                    const norm = x / w;
                    const envelope = Math.sin(norm * Math.PI);
                    const y = midY + Math.sin(norm * Math.PI * 2 * wave.freq + elapsed * wave.speed) * (midY * wave.amp) * envelope;
                    if (x === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }

            ctx.globalAlpha = 1;
            this._animFrame = requestAnimationFrame(draw);
        };

        this._animFrame = requestAnimationFrame(draw);
    }

    _stopWaveformAnimation() {
        if (this._animFrame) {
            cancelAnimationFrame(this._animFrame);
            this._animFrame = null;
        }
        const canvas = this.shadowRoot.querySelector('.analyze-canvas');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    updated(changedProperties) {
        super.updated(changedProperties);

        this._syncMarkdown();
        this._syncDetailMarkdown();

        // Instant, not smooth: a per-token smooth scroll never catches up and fights itself.
        if (this._pinned) {
            this._scrollToBottom();
        }

        const detail = this._currentDetail();
        if (detail) {
            if (this._lastDetailId !== detail.detailId) {
                // Landing on a different answer starts from one end of it: the bottom while it is still
                // arriving, the top once it is finished and there is something to read in order.
                this._lastDetailId = detail.detailId;
                this._detailAtBottom = !detail.final;
                const container = this.shadowRoot.querySelector('.detail-scroll');
                if (container) container.scrollTop = detail.final ? 0 : container.scrollHeight;
            } else if (!detail.final && this._detailAtBottom) {
                // Only a growing answer drags the view down with it, and only while the user has not
                // scrolled away from the end of it.
                this._scrollDetailToBottom();
            }
        }

        if (changedProperties.has('isAnalyzing')) {
            if (this.isAnalyzing) {
                this._startWaveformAnimation();
            } else {
                this._stopWaveformAnimation();
            }
        }

        // The pane's own row is what ends the busy state, and only for the turn this view started:
        // another answer finishing alongside it says nothing about the screenshot. A failed request
        // arrives as a settled row too, so an error ends the wait rather than leaving it turning.
        if (changedProperties.has('detailMessages') && this.isAnalyzing && this._screenAnswerSettled()) {
            this.isAnalyzing = false;
            this._screenTurnId = null;
        }
    }

    renderMessage(message) {
        if (message.role === 'interviewer') {
            return html`
                <div class="message-row interviewer">
                    <div class="message-body plain">${message.text || '…'}</div>
                </div>
            `;
        }

        // Plain text like the interviewer's rows: markdown rendering is only wired for the answers.
        if (message.role === 'user') {
            return html`
                <div class="message-row user">
                    <div class="message-body plain">${message.text || '…'}</div>
                </div>
            `;
        }

        return html`
            <div class="message-row assistant ${message.final ? '' : 'streaming'}">
                <div class="message-body markdown" data-msg-id=${message.id}></div>
            </div>
        `;
    }

    renderDetailPane() {
        const detail = this._currentDetail();
        if (!detail) return html``;

        const position = this._detailPosition();
        const notes = [];
        if (detail.usedKnowledge && detail.usedKnowledge.length) {
            notes.push(html`<div class="detail-note">Reference: ${detail.usedKnowledge.join(', ')}</div>`);
        }
        if (detail.truncated) {
            notes.push(html`<div class="detail-note">Answer cut off at the length limit</div>`);
        }
        if (detail.error) {
            notes.push(html`<div class="detail-note danger">${detail.error}</div>`);
        }

        return html`
            <div class="detail-head">
                <span>Detailed</span>
                <span>${position + 1} / ${this.detailMessages.length}</span>
            </div>

            <div class="detail-scroll" @scroll=${this.handleDetailScroll}>
                ${detail.question ? html`<div class="detail-question">${detail.question}</div>` : ''}
                <div
                    class="detail-body message-body markdown ${detail.final ? '' : 'streaming'}"
                    data-detail-id=${detail.detailId}
                ></div>
                ${notes}
            </div>

            <div class="detail-nav">
                <button ?disabled=${position <= 0} @click=${() => this.onDetailPrev()} title="Previous detailed answer">‹</button>
                <button
                    ?disabled=${position >= this.detailMessages.length - 1}
                    @click=${() => this.onDetailNext()}
                    title="Next detailed answer"
                >›</button>
            </div>
        `;
    }

    render() {
        return html`
            <div class="live-split">
                <div class="chat-wrap">
                    <div class="chat-scroll" @scroll=${this.handleScroll}>
                        ${this.messages.length === 0
                            ? html`<div class="chat-empty">Listening to the interview...</div>`
                            : html`<div class="chat-list">${this.messages.map(message => this.renderMessage(message))}</div>`}
                    </div>
                    <button class="jump-latest" ?hidden=${this._pinned} @click=${this.jumpToLatest} title="Jump to latest">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 5v14M19 12l-7 7-7-7" />
                        </svg>
                        Latest
                    </button>
                </div>

                <div class="detail-pane" ?hidden=${this.detailMessages.length === 0}>${this.renderDetailPane()}</div>
            </div>

            <div class="input-bar">
                <div class="input-bar-inner">
                    <input
                        type="text"
                        id="textInput"
                        placeholder="Type a message..."
                        @keydown=${this.handleTextKeydown}
                    />
                </div>
                <button class="analyze-btn ${this.isAnalyzing ? 'analyzing' : ''}" @click=${this.handleScreenAnswer}>
                    <canvas class="analyze-canvas"></canvas>
                    <span class="analyze-btn-content">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
                            <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 3v7h6l-8 11v-7H5z" />
                        </svg>
                        Analyze Screen
                    </span>
                </button>
            </div>
        `;
    }
}

customElements.define('assistant-view', AssistantView);
