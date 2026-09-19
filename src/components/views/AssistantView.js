import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

export class AssistantView extends LitElement {
    static styles = css`
        :host {
            height: 100%;
            display: flex;
            flex-direction: column;
        }

        * {
            font-family: var(--font);
            cursor: default;
        }

        /* ── Chat transcript ── */

        .chat-wrap {
            position: relative;
            flex: 1;
            min-height: 0;
            display: flex;
        }

        .chat-scroll {
            flex: 1;
            overflow-y: auto;
            font-size: var(--response-font-size, 15px);
            line-height: var(--line-height);
            background: #ededed;
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
            background: #c4c4c4;
            border-radius: 3px;
        }

        .chat-scroll::-webkit-scrollbar-thumb:hover {
            background: #a8a8a8;
        }

        .chat-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding: 12px;
        }

        .chat-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            padding: var(--space-md);
            text-align: center;
            color: #8a8a8a;
            font-size: var(--font-size-sm);
        }

        /* ── Bubbles ── */

        .message-row {
            display: flex;
        }

        .message-row.interviewer {
            justify-content: flex-start;
        }

        .message-row.assistant {
            justify-content: flex-end;
        }

        .message-body {
            max-width: 78%;
            padding: 8px 12px;
            border-radius: 10px;
            color: #1a1a1a;
            word-break: break-word;
            overflow-wrap: anywhere;
        }

        .message-row.interviewer .message-body {
            background: #ffffff;
            border-top-left-radius: 2px;
        }

        .message-row.assistant .message-body {
            background: #d3e7ff;
            border-top-right-radius: 2px;
        }

        /* ── Markdown (tuned for a light bubble: every colour is inherited or explicit) ── */

        .message-body > :first-child {
            margin-top: 0;
        }

        .message-body > :last-child {
            margin-bottom: 0;
        }

        .message-body h1,
        .message-body h2,
        .message-body h3,
        .message-body h4,
        .message-body h5,
        .message-body h6 {
            margin: 1em 0 0.5em 0;
            color: inherit;
            font-weight: var(--font-weight-semibold);
        }

        .message-body h1 { font-size: 1.5em; }
        .message-body h2 { font-size: 1.3em; }
        .message-body h3 { font-size: 1.15em; }
        .message-body h4 { font-size: 1.05em; }
        .message-body h5,
        .message-body h6 { font-size: 1em; }

        .message-body p {
            margin: 0.6em 0;
            color: inherit;
        }

        .message-body ul,
        .message-body ol {
            margin: 0.6em 0;
            padding-left: 1.5em;
            color: inherit;
        }

        .message-body li {
            margin: 0.3em 0;
        }

        .message-body blockquote {
            margin: 0.8em 0;
            padding: 0.5em 1em;
            border-left: 2px solid #b9b9b9;
            background: rgba(0, 0, 0, 0.04);
            border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
        }

        .message-body code {
            background: #e6e6e6;
            padding: 0.15em 0.4em;
            border-radius: var(--radius-sm);
            font-family: var(--font-mono);
            font-size: 0.85em;
        }

        .message-body pre {
            background: #f6f6f6;
            border: 1px solid #dcdcdc;
            border-radius: var(--radius-md);
            padding: var(--space-md);
            overflow-x: auto;
            margin: 0.8em 0;
        }

        .message-body pre code {
            background: none;
            padding: 0;
        }

        .message-body a {
            color: #1a56db;
            text-decoration: underline;
            text-underline-offset: 2px;
        }

        .message-body strong,
        .message-body b {
            font-weight: var(--font-weight-semibold);
        }

        .message-body hr {
            border: none;
            border-top: 1px solid #d0d0d0;
            margin: 1.5em 0;
        }

        .message-body table {
            border-collapse: collapse;
            width: 100%;
            margin: 0.8em 0;
        }

        .message-body th,
        .message-body td {
            border: 1px solid #d0d0d0;
            padding: var(--space-sm);
            text-align: left;
        }

        .message-body th {
            background: rgba(0, 0, 0, 0.04);
            font-weight: var(--font-weight-semibold);
        }

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
            border: 1px solid #d0d0d0;
            background: #ffffff;
            color: #1a1a1a;
            font-size: var(--font-size-xs);
            cursor: pointer;
            box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
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
            padding: var(--space-md);
            background: var(--bg-app);
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
    `;

    static properties = {
        messages: { type: Array },
        selectedProfile: { type: String },
        onSendText: { type: Function },
        isAnalyzing: { type: Boolean, state: true },
    };

    constructor() {
        super();
        this.messages = [];
        this.selectedProfile = 'interview';
        this.onSendText = () => {};
        this.isAnalyzing = false;
        this._animFrame = null;
        this._pinned = true;
        this._responseCountWhenStarted = 0;
    }

    getProfileNames() {
        return {
            interview: 'Job Interview',
            sales: 'Sales Call',
            meeting: 'Business Meeting',
            presentation: 'Presentation',
            negotiation: 'Negotiation',
            exam: 'Exam Assistant',
        };
    }

    renderMarkdown(content) {
        if (typeof window !== 'undefined' && window.marked) {
            try {
                window.marked.setOptions({
                    breaks: true,
                    gfm: true,
                    sanitize: false,
                });
                return window.marked.parse(content);
            } catch (error) {
                console.warn('Error parsing markdown:', error);
                return content;
            }
        }
        return content;
    }

    _assistantCount() {
        return this.messages.filter(m => m.role === 'assistant').length;
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
        if (this.isAnalyzing) return;
        if (window.captureManualScreenshot) {
            this.isAnalyzing = true;
            this._responseCountWhenStarted = this._assistantCount();
            window.captureManualScreenshot();
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

        // Instant, not smooth: a per-token smooth scroll never catches up and fights itself.
        if (this._pinned) {
            this._scrollToBottom();
        }

        if (changedProperties.has('isAnalyzing')) {
            if (this.isAnalyzing) {
                this._startWaveformAnimation();
            } else {
                this._stopWaveformAnimation();
            }
        }

        // Counted over answers only, so the question bubble that precedes the reply does not
        // clear the busy state before there is anything to show.
        if (changedProperties.has('messages') && this.isAnalyzing) {
            if (this._assistantCount() > this._responseCountWhenStarted) {
                this.isAnalyzing = false;
            }
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

        return html`
            <div class="message-row assistant">
                <div class="message-body markdown" data-msg-id=${message.id}></div>
            </div>
        `;
    }

    render() {
        const profileNames = this.getProfileNames();

        return html`
            <div class="chat-wrap">
                <div class="chat-scroll" @scroll=${this.handleScroll}>
                    ${this.messages.length === 0
                        ? html`<div class="chat-empty">Listening to your ${profileNames[this.selectedProfile] || 'session'}...</div>`
                        : html`<div class="chat-list">${this.messages.map(message => this.renderMessage(message))}</div>`}
                </div>
                <button class="jump-latest" ?hidden=${this._pinned} @click=${this.jumpToLatest} title="Jump to latest">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 5v14M19 12l-7 7-7-7" />
                    </svg>
                    Latest
                </button>
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
