import { html, css } from '../../assets/lit-core-2.7.4.min.js';
import { LocalizedLitElement, t } from '../../utils/i18n.js';
import { scrollbarStyles } from './sharedPageStyles.js';

// 手机端面试开局：麦克风听到的每一句都带着腾讯云分配好的 speaker_id。用户在这里指认哪一个是自己，
// 之后主进程才知道该把哪些话当背景、哪些话当面试官的提问。
// 这一步还没开始分流，所以每个句子都直接进列表：身份没出来时圆标显示「?」，定稿后换成编号。
// 正式会话里那种居中的虚线部分结果属于实时页，不属于这里。
export class VoiceprintView extends LocalizedLitElement {
    static styles = [
        css`
            * {
                box-sizing: border-box;
                font-family: var(--font);
            }

            :host {
                display: block;
                height: 100%;
            }

            .detect {
                height: 100%;
                display: flex;
                flex-direction: column;
                padding: var(--space-lg) var(--space-md) var(--space-md);
                gap: var(--space-md);
            }

            .detect-title {
                flex: none;
                text-align: center;
                font-size: var(--font-size-lg);
                font-weight: var(--font-weight-semibold);
                color: var(--text-primary);
            }

            .detect-title.error {
                color: var(--danger);
            }

            /* 异常时标题下面的一行小字，写识别服务给出的具体错误。 */
            .detect-error {
                flex: none;
                text-align: center;
                font-size: var(--font-size-xs);
                line-height: 1.5;
                color: var(--text-secondary);
                word-break: break-word;
            }

            .detect-scroll {
                flex: 1;
                min-height: 0;
                overflow-y: auto;
            }

            /* 句子少时贴着底部，多了就自然往上滚；横向始终居中。 */
            .bubble-list {
                min-height: 100%;
                display: flex;
                flex-direction: column;
                justify-content: flex-end;
                align-items: center;
                gap: 14px;
                padding: 8px var(--space-sm) var(--space-md);
            }

            .bubble-row {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: var(--space-sm);
                max-width: 100%;
            }

            .bubble {
                position: relative;
                max-width: min(560px, 66vw);
                padding: 10px 14px;
                border: 1px solid var(--border);
                border-radius: 12px;
                background: var(--bg-elevated);
                color: var(--text-primary);
                font-size: var(--font-size-base);
                line-height: 1.55;
                text-align: left;
                word-break: break-word;
                user-select: text;
            }

            /* 气泡左上角的小圆标：数字就是腾讯云给的 speaker_id，还没定出来时是「?」。 */
            .speaker-badge {
                position: absolute;
                top: -10px;
                left: -10px;
                display: flex;
                align-items: center;
                justify-content: center;
                min-width: 22px;
                height: 22px;
                padding: 0 5px;
                border-radius: 11px;
                background: var(--accent);
                color: var(--btn-primary-text);
                font-size: var(--font-size-xs);
                font-weight: var(--font-weight-semibold);
                box-shadow: 0 0 0 2px var(--bg-app);
            }

            .confirm-hint {
                flex: none;
                padding: 6px 10px;
                border: 1px solid var(--border-strong);
                border-radius: var(--radius-sm);
                background: transparent;
                color: var(--link-color);
                font-size: var(--font-size-xs);
                white-space: nowrap;
                cursor: pointer;
                transition: background var(--transition);
            }

            .confirm-hint:hover:not(:disabled) {
                background: var(--bg-hover);
            }

            /* 最新一句还没定稿、或服务端还没认出说话人时，标注先摆着但不吃点击。 */
            .confirm-hint:disabled {
                border-color: var(--border);
                color: var(--text-muted);
                cursor: default;
            }

            .detect-empty {
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 100%;
                color: var(--text-muted);
                font-size: var(--font-size-base);
                text-align: center;
            }
        `,
        scrollbarStyles,
    ];

    static properties = {
        lines: { type: Array },
        // 识别服务彻底失败时的错误文本；非空时标题改成「语音服务异常：」并把这行小字显示在下面。
        error: { type: String },
        onConfirm: { type: Function },
    };

    constructor() {
        super();
        this.lines = [];
        this.error = '';
        this.onConfirm = () => {};
        this._confirming = false;
    }

    connectedCallback() {
        super.connectedCallback();
        // 检测页不是实时视图，窗口此时可聚焦，键盘事件能直接到这里。
        this._onKeyDown = event => {
            if (event.key === 'y' || event.key === 'Y') this._confirm();
        };
        window.addEventListener('keydown', this._onKeyDown);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        window.removeEventListener('keydown', this._onKeyDown);
    }

    updated(changed) {
        super.updated(changed);
        if (!changed.has('lines')) return;
        const list = this.renderRoot.querySelector('.detect-scroll');
        if (list) list.scrollTop = list.scrollHeight;
    }

    // 提示只跟着列表最后一行走：用户要指认的是自己刚说的那句。
    _latestLine() {
        return this.lines.length ? this.lines[this.lines.length - 1] : null;
    }

    // 只认已经定稿、且服务端给出了非负 speaker_id 的句子：中间态的编号还可能被改判。
    async _confirm() {
        if (this._confirming || this.error) return;
        const line = this._latestLine();
        if (!line || !line.final || !(line.speakerId >= 0)) return;

        this._confirming = true;
        try {
            await this.onConfirm(line.speakerId);
        } finally {
            this._confirming = false;
        }
    }

    render() {
        const error = (this.error || '').trim();
        // 准备阶段还没有分流，所有句子都按到达顺序进列表；还没定出身份的圆标显示「?」，定稿后换成编号。
        const latest = this._latestLine();

        return html`
            <div class="detect">
                <div class="detect-title ${error ? 'error' : ''}">
                    ${error ? t('Speech service error:', '语音服务异常：') : t('Detecting your voiceprint...', '正在进行声纹检测...')}
                </div>
                ${error ? html`<div class="detect-error">${error}</div>` : ''}
                <div class="detect-scroll">
                    ${this.lines.length === 0
                        ? error
                            ? ''
                            : html`<div class="detect-empty">
                                  ${t(
                                      'Say a sentence that clearly belongs to you, for example: “Hello, I am the candidate”.',
                                      '请先说一句明显属于你自己的话，例如：「你好，我是候选人」。'
                                  )}
                              </div>`
                        : html`<div class="bubble-list">
                              ${this.lines.map(line => {
                                  const isLatest = line === latest;
                                  // 还没定稿、或服务端还没给出编号时，提示摆着但不吃点击。
                                  const canConfirm = !error && isLatest && line.final && line.speakerId >= 0;
                                  return html`
                                      <div class="bubble-row">
                                          <div class="bubble">
                                              <span class="speaker-badge"
                                                  >${line.speakerId >= 0 ? line.speakerId : '?'}</span
                                              >
                                              ${line.text}
                                          </div>
                                          ${isLatest && !error
                                              ? html`<button
                                                    class="confirm-hint"
                                                    ?disabled=${!canConfirm}
                                                    @click=${() => this._confirm()}
                                                >
                                                    ${t('If this is you, press Y', '如果这是你，请按下Y')}
                                                </button>`
                                              : ''}
                                      </div>
                                  `;
                              })}
                          </div>`}
                </div>
            </div>
        `;
    }
}

customElements.define('voiceprint-view', VoiceprintView);
