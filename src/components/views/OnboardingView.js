import { html, css } from '../../assets/lit-core-2.7.4.min.js';
import { LocalizedLitElement } from '../../utils/i18n.js';

export class OnboardingView extends LocalizedLitElement {
    static styles = css`
        * {
            font-family: var(--font);
            cursor: default;
            user-select: none;
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :host {
            display: block;
            height: 100%;
            width: 100%;
            position: fixed;
            top: 0;
            left: 0;
            overflow: hidden;
        }

        .onboarding {
            width: 100%;
            height: 100%;
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 12px;
            border: 1px solid rgba(0, 0, 0, 0.08);
            overflow: hidden;
            background: #f0f0f0;
        }

        canvas.aurora {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 0;
        }

        canvas.dither {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 2;
            opacity: 0.12;
            mix-blend-mode: overlay;
            pointer-events: none;
            image-rendering: pixelated;
        }

        /* 像素水豚叠在极光之上、噪点之下：关掉插值放大成块状，边缘径向羽化融进极光。 */
        .pixel-layer {
            position: absolute;
            inset: 0;
            z-index: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            pointer-events: none;
        }

        .pixel-capy {
            width: 100%;
            height: 100%;
            object-fit: cover;
            image-rendering: pixelated;
            opacity: 0.38;
            /* 图铺满整屏，只在四边留窄窄一段过渡；横向、纵向两条渐变取交集，四角不会先糊掉。 */
            -webkit-mask-image: linear-gradient(to right, transparent, #000 4%, #000 96%, transparent),
                linear-gradient(to bottom, transparent, #000 4%, #000 96%, transparent);
            -webkit-mask-composite: source-in;
            mask-image: linear-gradient(to right, transparent, #000 4%, #000 96%, transparent),
                linear-gradient(to bottom, transparent, #000 4%, #000 96%, transparent);
            mask-composite: intersect;
            animation: capy-float 9s ease-in-out infinite;
        }

        @keyframes capy-float {
            0%,
            100% {
                transform: translateY(-6px);
            }
            50% {
                transform: translateY(6px);
            }
        }

        /* 极光/水豚都是中间调，灰色说明文字压上去会糊；在表单后面留一圈浅色光，保住可读性。 */
        .scrim {
            position: absolute;
            inset: 0;
            z-index: 3;
            pointer-events: none;
            background: radial-gradient(ellipse 46% 40% at 50% 50%, rgba(240, 240, 240, 0.72), rgba(240, 240, 240, 0) 72%);
        }

        /* 激活前后是两套控件：都留在 DOM 里，靠 opacity 交叉淡入淡出，避免直接换 DOM 造成跳变。 */
        .slide-layer {
            position: absolute;
            inset: 0;
            z-index: 4;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            visibility: hidden;
            pointer-events: none;
            transition: opacity 0.35s ease, visibility 0.35s ease;
        }

        .slide-layer.active {
            opacity: 1;
            visibility: visible;
            pointer-events: auto;
        }

        .slide {
            position: relative;
            z-index: 4;
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
            /* 32 位机器码（含连字符）要一行放下：400 时内容区只剩 320，扣掉框内边距和复制按钮会折行。 */
            max-width: 460px;
            padding: var(--space-xl);
            gap: var(--space-md);
        }

        .slide-title {
            font-size: 28px;
            font-weight: 600;
            color: #111111;
            line-height: 1.2;
        }

        .slide-text {
            font-size: 13px;
            line-height: 1.5;
            color: #666666;
        }

        .actions {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
            margin-top: 8px;
        }

        .btn-primary {
            background: #111111;
            border: none;
            color: #ffffff;
            padding: 10px 32px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: opacity 0.15s;
        }

        .btn-primary:hover {
            opacity: 0.85;
        }

        .btn-primary:disabled {
            opacity: 0.5;
            cursor: default;
        }

        .machine-box {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
            width: 100%;
            padding: 12px;
            border-radius: 10px;
            background: rgba(0, 0, 0, 0.05);
            border: 1px solid rgba(0, 0, 0, 0.08);
        }

        .machine-label {
            font-size: 11px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: #888888;
        }

        /* 机器码和复制图标同一行，图标固定在右侧；码本身仍居中、允许折行。 */
        .machine-row {
            display: flex;
            align-items: center;
            gap: 6px;
            width: 100%;
        }

        /* 机器码要能被选中、复制，而 .onboarding * 全局禁用了选择，所以这里单独放开。 */
        .machine-code {
            flex: 1;
            font-family: var(--font-mono);
            font-size: 15px;
            font-weight: 600;
            letter-spacing: 0.06em;
            color: #111111;
            word-break: break-all;
            text-align: center;
            user-select: text;
            cursor: text;
        }

        .btn-copy {
            flex-shrink: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 26px;
            height: 26px;
            padding: 0;
            border: none;
            border-radius: 6px;
            background: none;
            color: #555555;
            cursor: pointer;
            transition: background 0.15s, color 0.15s;
        }

        .btn-copy:hover {
            background: rgba(0, 0, 0, 0.06);
            color: #111111;
        }

        .btn-copy svg {
            width: 16px;
            height: 16px;
            display: block;
        }

        .code-input {
            width: 100%;
            padding: 10px 12px;
            border-radius: 8px;
            border: 1px solid rgba(0, 0, 0, 0.15);
            background: #ffffff;
            color: #111111;
            font-family: var(--font-mono);
            font-size: 13px;
            text-align: center;
            outline: none;
        }

        .code-input:focus {
            border-color: rgba(0, 0, 0, 0.4);
        }

        .error-text {
            font-size: 12px;
            color: #c0392b;
            text-align: center;
        }

        .hint {
            font-size: 12px;
            color: #888888;
            text-align: center;
        }
    `;

    static properties = {
        onComplete: { type: Function },
        _activated: { state: true },
        _machineCode: { state: true },
        _input: { state: true },
        _error: { state: true },
        _busy: { state: true },
        _copied: { state: true },
    };

    constructor() {
        super();
        this.onComplete = () => {};
        this._animId = null;
        this._time = 0;
        this._activated = false;
        this._machineCode = '';
        this._input = '';
        this._error = '';
        this._busy = false;
        this._copied = false;
    }

    firstUpdated() {
        this._startAurora();
        this._drawDither();
        this._initLicense();
    }

    // 已激活的机器直接看到欢迎页（引导流程本身还要走完）；未激活的停在这里，机器码是该机唯一能激活它的凭据。
    async _initLicense() {
        try {
            const [status, machineCode] = await Promise.all([offerHunter.license.getStatus(), offerHunter.license.getMachineCode()]);
            this._activated = Boolean(status.activated);
            this._machineCode = machineCode;
        } catch (error) {
            this._error = 'Activation is unavailable on this system.';
        }
        this.requestUpdate();
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        if (this._animId) cancelAnimationFrame(this._animId);
    }

    _drawDither() {
        const canvas = this.shadowRoot.querySelector('canvas.dither');
        if (!canvas) return;
        const blockSize = 5;
        const cols = Math.ceil(canvas.offsetWidth / blockSize);
        const rows = Math.ceil(canvas.offsetHeight / blockSize);
        canvas.width = cols;
        canvas.height = rows;
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(cols, rows);
        for (let i = 0; i < img.data.length; i += 4) {
            const v = Math.random() > 0.5 ? 255 : 0;
            img.data[i] = v;
            img.data[i + 1] = v;
            img.data[i + 2] = v;
            img.data[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
    }

    _startAurora() {
        const canvas = this.shadowRoot.querySelector('canvas.aurora');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        const scale = 0.35;
        const resize = () => {
            canvas.width = Math.floor(canvas.offsetWidth * scale);
            canvas.height = Math.floor(canvas.offsetHeight * scale);
        };
        resize();

        const blobs = [
            {
                parts: [
                    { ox: 0, oy: 0, r: 1.0 },
                    { ox: 0.22, oy: 0.1, r: 0.85 },
                    { ox: 0.11, oy: 0.05, r: 0.5 },
                ],
                color: [180, 200, 230],
                x: 0.15,
                y: 0.2,
                vx: 0.35,
                vy: 0.25,
                phase: 0,
            },

            {
                parts: [
                    { ox: 0, oy: 0, r: 0.95 },
                    { ox: 0.18, oy: -0.08, r: 0.75 },
                    { ox: 0.09, oy: -0.04, r: 0.4 },
                ],
                color: [190, 180, 220],
                x: 0.75,
                y: 0.2,
                vx: -0.3,
                vy: 0.35,
                phase: 1.2,
            },

            {
                parts: [
                    { ox: 0, oy: 0, r: 0.9 },
                    { ox: 0.24, oy: 0.12, r: 0.9 },
                    { ox: 0.12, oy: 0.06, r: 0.35 },
                ],
                color: [210, 195, 215],
                x: 0.5,
                y: 0.65,
                vx: 0.25,
                vy: -0.3,
                phase: 2.4,
            },

            {
                parts: [
                    { ox: 0, oy: 0, r: 0.8 },
                    { ox: -0.15, oy: 0.18, r: 0.7 },
                    { ox: -0.07, oy: 0.09, r: 0.45 },
                ],
                color: [175, 210, 210],
                x: 0.1,
                y: 0.75,
                vx: 0.4,
                vy: 0.2,
                phase: 3.6,
            },

            {
                parts: [
                    { ox: 0, oy: 0, r: 0.75 },
                    { ox: 0.12, oy: -0.15, r: 0.65 },
                    { ox: 0.06, oy: -0.07, r: 0.35 },
                ],
                color: [220, 210, 195],
                x: 0.85,
                y: 0.55,
                vx: -0.28,
                vy: -0.32,
                phase: 4.8,
            },

            {
                parts: [
                    { ox: 0, oy: 0, r: 0.95 },
                    { ox: -0.2, oy: -0.12, r: 0.75 },
                    { ox: -0.1, oy: -0.06, r: 0.4 },
                ],
                color: [170, 190, 225],
                x: 0.6,
                y: 0.1,
                vx: -0.2,
                vy: 0.38,
                phase: 6.0,
            },

            {
                parts: [
                    { ox: 0, oy: 0, r: 0.85 },
                    { ox: 0.17, oy: 0.15, r: 0.75 },
                    { ox: 0.08, oy: 0.07, r: 0.35 },
                ],
                color: [200, 190, 220],
                x: 0.35,
                y: 0.4,
                vx: 0.32,
                vy: -0.22,
                phase: 7.2,
            },

            {
                parts: [
                    { ox: 0, oy: 0, r: 0.75 },
                    { ox: -0.13, oy: 0.18, r: 0.65 },
                    { ox: -0.06, oy: 0.1, r: 0.4 },
                ],
                color: [215, 205, 200],
                x: 0.9,
                y: 0.85,
                vx: -0.35,
                vy: -0.25,
                phase: 8.4,
            },

            {
                parts: [
                    { ox: 0, oy: 0, r: 0.7 },
                    { ox: 0.16, oy: -0.1, r: 0.6 },
                    { ox: 0.08, oy: -0.05, r: 0.35 },
                ],
                color: [185, 210, 205],
                x: 0.45,
                y: 0.9,
                vx: 0.22,
                vy: -0.4,
                phase: 9.6,
            },
        ];

        const baseRadius = 0.32;

        const draw = () => {
            this._time += 0.012;
            const w = canvas.width;
            const h = canvas.height;
            const dim = Math.min(w, h);

            ctx.fillStyle = '#f0f0f0';
            ctx.fillRect(0, 0, w, h);

            for (const blob of blobs) {
                const t = this._time;
                const cx = (blob.x + Math.sin(t * blob.vx + blob.phase) * 0.22) * w;
                const cy = (blob.y + Math.cos(t * blob.vy + blob.phase * 0.7) * 0.22) * h;

                for (const part of blob.parts) {
                    const wobble = Math.sin(t * 2.5 + part.ox * 25 + blob.phase) * 0.02;
                    const px = cx + (part.ox + wobble) * dim;
                    const py = cy + (part.oy + wobble * 0.7) * dim;
                    const pr = part.r * baseRadius * dim;

                    const grad = ctx.createRadialGradient(px, py, 0, px, py, pr);
                    grad.addColorStop(0, `rgba(${blob.color[0]}, ${blob.color[1]}, ${blob.color[2]}, 0.55)`);
                    grad.addColorStop(0.4, `rgba(${blob.color[0]}, ${blob.color[1]}, ${blob.color[2]}, 0.3)`);
                    grad.addColorStop(0.7, `rgba(${blob.color[0]}, ${blob.color[1]}, ${blob.color[2]}, 0.1)`);
                    grad.addColorStop(1, `rgba(${blob.color[0]}, ${blob.color[1]}, ${blob.color[2]}, 0)`);

                    ctx.fillStyle = grad;
                    ctx.fillRect(0, 0, w, h);
                }
            }

            this._animId = requestAnimationFrame(draw);
        };

        draw();
    }

    async completeOnboarding() {
        await offerHunter.storage.updateConfig('onboarded', true);
        this.onComplete();
    }

    async copyMachineCode() {
        const text = this._machineCode;
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // file:// 下剪贴板 API 可能被挡，退回到 execCommand。
            const area = document.createElement('textarea');
            area.value = text;
            document.body.appendChild(area);
            area.select();
            try {
                document.execCommand('copy');
            } catch {
                // 复制失败也不影响用户手动选中；无需提示。
            }
            document.body.removeChild(area);
        }
        this._copied = true;
        this.requestUpdate();
        setTimeout(() => {
            this._copied = false;
            this.requestUpdate();
        }, 1500);
    }

    async activate() {
        if (this._busy) return;
        const code = this._input.trim();
        if (!code) return;

        this._busy = true;
        this._error = '';
        this.requestUpdate();

        try {
            const result = await offerHunter.license.activate(code);
            if (result.success) {
                this._activated = true;
                this._input = '';
            } else {
                this._error = this._errorMessage(result.error);
            }
        } catch (error) {
            this._error = 'Activation failed. Please try again.';
        }

        this._busy = false;
        this.requestUpdate();
    }

    _errorMessage(reason) {
        switch (reason) {
            case 'format':
                return 'Invalid activation code format.';
            case 'machine':
                return 'This activation code is for a different computer.';
            case 'signature':
                return 'Invalid activation code. Please check it and try again.';
            case 'expired':
                return 'This activation code has expired. Please ask the seller for a new one.';
            default:
                return 'Activation failed. Please try again.';
        }
    }

    renderActivation() {
        return html`
            <div class="slide">
                <div class="slide-title">Activate your product</div>
                <div class="slide-text">
                    This copy is locked to this computer. Send the machine code below to the seller, then enter the activation code you get back.
                </div>
                <div class="machine-box">
                    <div class="machine-label">Machine Code</div>
                    <div class="machine-row">
                        <div class="machine-code" data-no-localize>${this._machineCode || '...'}</div>
                        <button
                            class="btn-copy"
                            title=${this._copied ? 'Copied' : 'Copy'}
                            aria-label=${this._copied ? 'Copied' : 'Copy'}
                            @click=${this.copyMachineCode}
                        >
                            ${this._copied
                                ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>`
                                : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                  </svg>`}
                        </button>
                    </div>
                </div>
                <input
                    class="code-input"
                    .value=${this._input}
                    @input=${event => {
                        this._input = event.target.value;
                    }}
                    @keydown=${event => {
                        if (event.key === 'Enter') this.activate();
                    }}
                    placeholder="Activation Code"
                    spellcheck="false"
                    autocomplete="off"
                />
                ${this._error ? html`<div class="error-text">${this._error}</div>` : ''}
                <div class="actions">
                    <button class="btn-primary" ?disabled=${this._busy} @click=${this.activate}>${this._busy ? 'Activating...' : 'Activate'}</button>
                </div>
                <div class="hint">Please ask the seller for an activation code.</div>
            </div>
        `;
    }

    renderSlide() {
        return html`
            <div class="slide">
                <div class="slide-title">Activation successful</div>
                <div class="actions">
                    <button class="btn-primary" @click=${this.completeOnboarding}>Continue</button>
                </div>
            </div>
        `;
    }

    render() {
        return html`
            <div class="onboarding">
                <canvas class="aurora"></canvas>
                <div class="pixel-layer"><img class="pixel-capy" src="assets/onboarding/capybara.png" alt="" /></div>
                <canvas class="dither"></canvas>
                <div class="scrim"></div>
                <div class="slide-layer ${this._activated ? '' : 'active'}">${this.renderActivation()}</div>
                <div class="slide-layer ${this._activated ? 'active' : ''}">${this.renderSlide()}</div>
            </div>
        `;
    }
}

customElements.define('onboarding-view', OnboardingView);
