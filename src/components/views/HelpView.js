import { html, css } from '../../assets/lit-core-2.7.4.min.js';
import { LocalizedLitElement } from '../../utils/i18n.js';
import { scrollbarStyles, unifiedPageStyles } from './sharedPageStyles.js';

const PROJECT_URL = 'https://github.com/OfferHunter/cheating-daddy';

export class HelpView extends LocalizedLitElement {
    static styles = [
        unifiedPageStyles,
        scrollbarStyles,
        css`
            .row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--space-md);
            }

            .row-text {
                color: var(--text-secondary);
                font-size: var(--font-size-sm);
            }

            .link-button {
                flex-shrink: 0;
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                padding: 8px 12px;
                background: var(--bg-elevated);
                color: var(--text-primary);
                font-size: var(--font-size-sm);
                cursor: pointer;
                transition:
                    border-color var(--transition),
                    background var(--transition);
            }

            .link-button:hover {
                border-color: var(--accent);
                background: var(--bg-hover);
            }

            .faq-list {
                display: flex;
                flex-direction: column;
                gap: var(--space-sm);
            }

            .faq-item {
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: var(--bg-elevated);
                overflow: hidden;
            }

            .faq-question {
                padding: 10px 12px;
                color: var(--text-primary);
                font-size: var(--font-size-sm);
                cursor: pointer;
            }

            .faq-question::marker {
                color: var(--text-muted);
            }

            .faq-answer {
                padding: 0 12px 12px 28px;
                color: var(--text-secondary);
                font-size: var(--font-size-sm);
                line-height: 1.55;
            }
        `,
    ];

    static properties = {
        onExternalLinkClick: { type: Function },
    };

    constructor() {
        super();
        this.onExternalLinkClick = () => {};
    }

    render() {
        return html`
            <div class="unified-page">
                <div class="unified-wrap">
                    <div class="page-title">Help & Support</div>

                    <section class="surface">
                        <div class="row">
                            <div class="surface-title">Website</div>
                            <button class="link-button" @click=${() => this.onExternalLinkClick(PROJECT_URL)}>GitHub</button>
                        </div>
                    </section>

                    <section class="surface">
                        <div class="surface-title">Contact Us</div>
                        <div class="row-text">QQ Group: To be added</div>
                    </section>

                    <section class="surface">
                        <div class="surface-title">Frequently Asked Questions</div>
                        <div class="faq-list">
                            <details class="faq-item">
                                <summary class="faq-question">How do I start a session?</summary>
                                <div class="faq-answer">Configure the chat and transcription API keys on the Home page, then click Start.</div>
                            </details>
                        </div>
                    </section>
                </div>
            </div>
        `;
    }
}

customElements.define('help-view', HelpView);
