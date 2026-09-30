const { DEFAULT_PREFERENCES } = window.require('./defaults');
import { html, css } from '../../assets/lit-core-2.7.4.min.js';
import { LocalizedLitElement } from '../../utils/i18n.js';
import { conversationStyles, syncMarkdownInto } from './conversationStyles.js';
import { scrollbarStyles } from './sharedPageStyles.js';

// 组件是 ES module，主进程能力统一经 window.require 取用（nodeIntegration 已开）。
const { ipcRenderer } = window.require('electron');

// 详细回答面板占整条分栏的比例，以及拖拽的钳制上下限。面板是紧挨着弹性项的定宽 flex 项，所以两个边界都是真的：
// 低于下限面板会变成一列单个字符，高于上限转录就没有地方了。
const PANE_DEFAULT_FRACTION = DEFAULT_PREFERENCES.detailPaneWidth;
const PANE_MIN_FRACTION = 0.18;
const PANE_MAX_FRACTION = 0.72;

// 每次运行只读一次，而不是每次挂载都读：这个视图每次导航都会被重建，按挂载读会让读取结果落地前的那一帧显示
// 默认宽度。超出钳制范围的值按「没有存过」处理而不是夹到边界，这样手改过的配置文件也无法把面板钉在一个拖不出来
// 的尺寸上。
let paneFraction = PANE_DEFAULT_FRACTION;
let paneFractionLoading = null;

function loadPaneFraction() {
    if (!paneFractionLoading) {
        paneFractionLoading = (async () => {
            try {
                const prefs = await offerHunter.storage.getPreferences();
                const stored = Number(prefs.detailPaneWidth);
                if (Number.isFinite(stored) && stored >= PANE_MIN_FRACTION && stored <= PANE_MAX_FRACTION) {
                    paneFraction = stored;
                }
            } catch (error) {
                console.warn('Could not read the detail pane width:', error);
            }
        })();
    }
    return paneFractionLoading;
}

const clampPaneFraction = value => Math.min(PANE_MAX_FRACTION, Math.max(PANE_MIN_FRACTION, value));

export class AssistantView extends LocalizedLitElement {
    // 按这个顺序分成几段，是为了让层叠顺序和它们原本在同一份模板里时保持一致。
    static styles = [
        css`
            :host {
                height: 100%;
                display: flex;
                flex-direction: column;

                /* 转录的左右内缩，也是唯一的旋钮：外层壳只贡献一条 3px 的线，所以左边看得见的都是这个值。输入栏
               共用它，这就是输入胶囊和上方气泡对齐的原因。 */
                --chat-gutter: 8px;
            }

            * {
                font-family: var(--font);
                cursor: default;
            }

            .live-split {
                flex: 1;
                min-height: 0;
                display: flex;
            }

            .chat-wrap {
                position: relative;
                flex: 1;
                /* 没有它，这一列不肯缩到自身内容宽度以下，会把面板挤出右边缘，而不是和它分这一行。 */
                min-width: 0;
                min-height: 0;
                display: flex;
            }

            /* 自己没有背景：转录直接坐在外层壳上，而透明度滑块管的就是那层壳，这样实时模式和别的页面一样透。 */
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
        // 转录的外观与历史页共用：历史页把录下来的会话显示成同一场对话，所以两边从同一处取气泡和 markdown。
        conversationStyles,
        scrollbarStyles,
        css`
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
                transition:
                    border-color 0.4s ease,
                    background var(--transition);
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

            /* 转录与面板之间的分隔条，也是调整两者宽度的抓手。6px 的命中区，可见的线画在里面——眼睛看到的线就是指针
           必须落上去的线；这条线从面板边框挪到了这里，否则会画成两条。touch-action 防止拖拽被当成滚动，按下时
           捕获指针，拖拽离开这 6px 条也还能继续。 */
            .split-handle {
                flex: none;
                width: 6px;
                cursor: col-resize;
                position: relative;
                touch-action: none;
            }

            .split-handle::before {
                content: '';
                position: absolute;
                top: 0;
                bottom: 0;
                left: 2px;
                width: 2px;
                border-radius: 1px;
                background: var(--border);
                transition: background var(--transition);
            }

            .split-handle:hover::before,
            .split-handle.dragging::before {
                background: var(--accent);
            }

            .split-handle[hidden] {
                display: none;
            }

            .detail-pane {
                flex: none;
                /* 用 border-box 是因为宽度也会被拖拽直接写入，而拖拽会用 getBoundingClientRect 把面板的盒子读回来：
               默认的 content box 下，内边距只在这次往返的一侧被算进去，每拖一次分隔条都会多跑出内边距那么远。 */
                box-sizing: border-box;
                width: 38%;
                /* 两个边界都吃重：面板是定宽 flex 项，没有下限时往左拖到底就剩一条读不了的窄栏；没有上限时在宽窗口上
               拖能把转录连同气泡顶出视图左边。写成 CSS 而不是 JS 钳制，是为了窗口缩放时不用监听 resize 也仍然有效。 */
                min-width: 180px;
                max-width: 72%;
                display: flex;
                flex-direction: column;
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

            /* 做成引用而不是重复一遍标题：它的作用是用户翻回去时说明这个回答属于哪个问题，不跟回答本身抢注意力。 */
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

            /* 面板正文带着转录的 markdown class，这样只需要维护一套 markdown 规则；这里只撤掉气泡的外观——这是面板，
           不是气泡。 */
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
        // 详细回答以及当前显示哪一条：两者都由 app 元素持有而不是本视图，因为每次导航本视图都会被拆掉重建，而
        // 回答必须活下来——`messages` 放在上层也是同一个原因。
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
        // 按钮上那张截图所属的轮次，在它被回答期间有效。忙碌态就跟它走：答案以这个轮次为 key 落进面板，它到达时
        // 视图里没有别的东西会动。
        this._screenTurnId = null;
    }

    // 截图回答落进面板是它完成的唯一信号，所以忙碌态盯的就是那一行自己落定。改成数回答个数的话，第一张截图的
    // 完成会在第二张还在路上时就把忙碌态清掉。
    _screenAnswerSettled() {
        if (this._screenTurnId === null) return false;
        const row = this.detailMessages.find(m => m.turnSeq === this._screenTurnId);
        return Boolean(row && row.final);
    }

    // 只有文字真的变了的那个气泡会重新解析：流式回答的开销因此是每个 token 一次 markdown，而不是每个气泡一次。
    _syncMarkdown() {
        for (const message of this.messages) {
            if (message.role !== 'assistant') continue;

            syncMarkdownInto(this.shadowRoot.querySelector(`[data-msg-id="${message.id}"]`), message.text, message.text);
        }
    }

    // 面板一次只显示一条回答，所以不能搭上面那个 _syncMarkdown 的便车：它遍历的 this.messages 里根本没有详细
    // 回答。
    _syncDetailMarkdown() {
        const row = this._currentDetail();
        const id = row ? row.detailId : 0;
        const text = row ? row.text : '';
        syncMarkdownInto(this.shadowRoot.querySelector('[data-detail-id]'), `${id}:${text}`, text);
    }

    // 当前显示的那条；选中项过期时退回最新的一条——被保留轮次上限丢掉的那条回答不能把面板清空。
    _currentDetail() {
        if (!this.detailMessages.length) return null;
        return this.detailMessages.find(row => row.detailId === this.detailCurrent) || this.detailMessages[this.detailMessages.length - 1];
    }

    _detailPosition() {
        const row = this._currentDetail();
        return row ? this.detailMessages.indexOf(row) : -1;
    }

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

    // 面板没有「回到最新」按钮——一条回答没什么可迷路的——所以这里只决定流式文字要不要把视图一起往下带。
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

        this.handleScrollUp = () => this.scrollResponseUp();
        this.handleScrollDown = () => this.scrollResponseDown();

        ipcRenderer.on('scroll-response-up', this.handleScrollUp);
        ipcRenderer.on('scroll-response-down', this.handleScrollDown);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._stopWaveformAnimation();

        if (this.handleScrollUp) ipcRenderer.removeListener('scroll-response-up', this.handleScrollUp);
        if (this.handleScrollDown) ipcRenderer.removeListener('scroll-response-down', this.handleScrollDown);
    }

    // 无条件读，不判断面板是否可见：让面板出现的是本场第一条回答，那时存的宽度必须已经在内存里，否则面板会以默认
    // 宽度打开并一直停在那里。
    async firstUpdated() {
        await loadPaneFraction();
        this.requestUpdate();
    }

    // 拖拽直接把宽度写到元素上，只在松手时才提交到响应式状态。让每帧的 pointermove 走 render()，会为了挪一条分隔
    // 条把整份转录（气泡、markdown、滚动位置）重渲一遍。
    _onSplitPointerDown(event) {
        if (event.button !== 0) return;
        const live = this.renderRoot.querySelector('.live-split');
        const pane = this.renderRoot.querySelector('.detail-pane');
        if (!live || !pane) return;

        // 由抓手捕获指针，拖拽离开这 6px 条后仍然有效；没有它，拖快一点就会在超过分隔条的瞬间丢掉指针。
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.classList.add('dragging');
        event.preventDefault();
        this._splitDrag = {
            live,
            pane,
            handle: event.currentTarget,
            startX: event.clientX,
            startFraction: pane.getBoundingClientRect().width / live.getBoundingClientRect().width,
            // 指针真的动过之前保持 null，所以单纯点一下分隔条什么都不会发生。
            fraction: null,
        };
    }

    _onSplitPointerMove(event) {
        const drag = this._splitDrag;
        if (!drag) return;

        const width = drag.live.getBoundingClientRect().width;
        if (!width) return;
        // 面板在右侧，所以往左拖是加宽。宽度同时写到元素和拖拽记录上：拖到一半有回答流式到达会重渲分栏，那次渲染
        // 必须把分隔条画在指针离开的位置，而不是起始位置。
        drag.fraction = clampPaneFraction(drag.startFraction - (event.clientX - drag.startX) / width);
        drag.pane.style.width = `${drag.fraction * 100}%`;
    }

    _onSplitPointerUp(event) {
        const drag = this._splitDrag;
        if (!drag) return;
        this._splitDrag = null;
        drag.handle.classList.remove('dragging');
        if (drag.handle.hasPointerCapture(event.pointerId)) drag.handle.releasePointerCapture(event.pointerId);

        // 没有移动的点击是无操作：既不能改写偏好，也不能让面板留下一个内联宽度，逼下一次渲染跟着它走。
        if (drag.fraction === null) return;

        paneFraction = drag.fraction;
        // 保留三位小数：这个比例只需要经得起配置文件的一次往返，原始比值会往文件里写一堆没有意义的位数。
        offerHunter.storage.updatePreference('detailPaneWidth', Math.round(paneFraction * 1000) / 1000).catch(error => {
            console.warn('Could not save the detail pane width:', error);
        });
        this.requestUpdate();
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
        // 必须 await：截图可能压根没发出去——没有采集流，或者视频还没出过一帧。这些路径不返回轮次，也就是不会
        // 有回答，忙碌态要在这里结束，而不是等一个永远不会到的完成信号。
        const result = await window.captureManualScreenshot();
        if (!result?.success) {
            this.isAnalyzing = false;
            return;
        }

        this._screenTurnId = result.turnId;
        // 回答有可能在这个 promise 落地前就已经到了。
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
        const FADE_IN = 0.5; // 秒
        const PARTICLE_SPREAD = 4; // 距边框向内多少像素
        const PARTICLE_COUNT = 250;

        // 胶囊形周长的换算
        const w = rect.width;
        const h = rect.height;
        const r = h / 2; // 胶囊圆角 = 高度的一半
        const straightLen = w - 2 * r;
        const arcLen = Math.PI * r;
        const perimeter = 2 * straightLen + 2 * arcLen;

        // 给定沿周长走过的距离，返回 {x, y, nx, ny}（位置 + 指向内侧的法线）
        const pointOnPerimeter = d => {
            d = ((d % perimeter) + perimeter) % perimeter;
            // 上直边：从左到右
            if (d < straightLen) {
                return { x: r + d, y: 0, nx: 0, ny: 1 };
            }
            d -= straightLen;
            // 右半圆
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
            // 下直边：从右到左
            if (d < straightLen) {
                return { x: w - r - d, y: h, nx: 0, ny: -1 };
            }
            d -= straightLen;
            // 左半圆
            const angle = Math.PI / 2 + (d / arcLen) * Math.PI;
            return {
                x: r + Math.cos(angle) * r,
                y: r + Math.sin(angle) * r,
                nx: -Math.cos(angle),
                ny: -Math.sin(angle),
            };
        };

        // 预先播下随机种子，粒子才会稳定而不是每帧乱跳。
        const seeds = [];
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            seeds.push({ pos: Math.random(), drift: Math.random(), depthSeed: Math.random() });
        }

        const draw = now => {
            const elapsed = (now - startTime) / 1000;
            const fade = Math.min(1, elapsed / FADE_IN);

            ctx.clearRect(0, 0, w, h);

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

        // 用瞬移而不是平滑滚动：每个 token 触发一次平滑滚动永远追不上自己，还会和上一次动画互相打断。
        if (this._pinned) {
            this._scrollToBottom();
        }

        const detail = this._currentDetail();
        if (detail) {
            if (this._lastDetailId !== detail.detailId) {
                // 换到另一条回答时总是从它的一头开始：还在流式就停在底部，已完成就回到顶部按顺序读。
                this._lastDetailId = detail.detailId;
                this._detailAtBottom = !detail.final;
                const container = this.shadowRoot.querySelector('.detail-scroll');
                if (container) container.scrollTop = detail.final ? 0 : container.scrollHeight;
            } else if (!detail.final && this._detailAtBottom) {
                // 只有正在变长的回答把视图一起往下带，而且只在这条回答仍然贴底时——用户往回翻过就不该被拽回底部。
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

        // 只有本视图发起的那个轮次落定才算数：旁边同时完成的另一条回答和截图无关。失败的请求也是以「已落定」的
        // 行到达的，所以报错同样结束等待，而不是让它一直转下去。
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

        // 和面试官那几行一样按纯文本处理：markdown 只给回答接上了。
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
                <div class="detail-body message-body markdown ${detail.final ? '' : 'streaming'}" data-detail-id=${detail.detailId}></div>
                ${notes}
            </div>

            <div class="detail-nav">
                <button ?disabled=${position <= 0} @click=${() => this.onDetailPrev()} title="Previous detailed answer">‹</button>
                <button ?disabled=${position >= this.detailMessages.length - 1} @click=${() => this.onDetailNext()} title="Next detailed answer">
                    ›
                </button>
            </div>
        `;
    }

    render() {
        // 拖拽未松手时宽度归指针管：否则流式回答引发的那次重渲会把分隔条弹回原位，和指针打架。
        const paneWidth = `${((this._splitDrag?.fraction ?? paneFraction) * 100).toFixed(1)}%`;

        return html`
            <div class="live-split">
                <div class="chat-wrap">
                    <div class="chat-scroll" @scroll=${this.handleScroll}>
                        ${
                            this.messages.length === 0
                                ? html`<div class="chat-empty">Listening to the interview...</div>`
                                : html`<div class="chat-list">${this.messages.map(message => this.renderMessage(message))}</div>`
                        }
                    </div>
                    <button class="jump-latest" ?hidden=${this._pinned} @click=${this.jumpToLatest} title="Jump to latest">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <path d="M12 5v14M19 12l-7 7-7-7" />
                        </svg>
                        Latest
                    </button>
                </div>

                <div
                    class="split-handle"
                    ?hidden=${this.detailMessages.length === 0}
                    role="separator"
                    aria-orientation="vertical"
                    title="Drag to resize the detailed answers"
                    @pointerdown=${this._onSplitPointerDown}
                    @pointermove=${this._onSplitPointerMove}
                    @pointerup=${this._onSplitPointerUp}
                    @pointercancel=${this._onSplitPointerUp}
                ></div>

                <div class="detail-pane" style="width:${paneWidth}" ?hidden=${this.detailMessages.length === 0}>${this.renderDetailPane()}</div>
            </div>

            <div class="input-bar">
                <div class="input-bar-inner">
                    <input type="text" id="textInput" placeholder="Type a message..." @keydown=${this.handleTextKeydown} />
                </div>
                <button class="analyze-btn ${this.isAnalyzing ? 'analyzing' : ''}" @click=${this.handleScreenAnswer}>
                    <canvas class="analyze-canvas"></canvas>
                    <span class="analyze-btn-content">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
                            <path
                                fill="none"
                                stroke="currentColor"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M13 3v7h6l-8 11v-7H5z"
                            />
                        </svg>
                        Analyze Screen
                    </span>
                </button>
            </div>
        `;
    }
}

customElements.define('assistant-view', AssistantView);
