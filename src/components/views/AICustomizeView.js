import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { unifiedPageStyles } from './sharedPageStyles.js';

export class AICustomizeView extends LitElement {
    static styles = [
        unifiedPageStyles,
        css`
            /* The wrap keeps the shared 'min-height: 100%' and is never pinned to it: with two surfaces
               a long entry list has to make the page grow and scroll, and a wrap clamped at 100% would
               instead take the extra height out of the instructions box above it.
               The knowledge surface is likewise sized by its own content — give it flex:1 too and the
               two would split the leftover height, squeezing the instructions box to nothing. */
            section.surface {
                flex: 1;
                display: flex;
                flex-direction: column;
            }
            section.surface.auto {
                flex: 0 0 auto;
            }
            .form-grid {
                flex: 1;
                display: flex;
                flex-direction: column;
            }
            .form-group.vertical {
                flex: 1;
                display: flex;
                flex-direction: column;
            }
            /* A floor, not 'min-height: 0': when the entry list is long this is the height the box holds
               while the page scrolls, instead of collapsing to a sliver. */
            textarea.control {
                flex: 1;
                resize: none;
                overflow-y: auto;
                min-height: 160px;
            }

            .dir-row {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
                flex-wrap: wrap;
            }

            .dir-path {
                flex: 1;
                min-width: 0;
                font-family: var(--font-mono);
                font-size: var(--font-size-xs);
                color: var(--text-secondary);
                word-break: break-all;
            }

            .btn-inline {
                width: auto;
                padding: 8px 10px;
                flex-shrink: 0;
            }

            .btn-inline:disabled {
                opacity: 0.55;
                cursor: default;
            }

            .entry-block {
                border-bottom: 1px solid var(--border);
            }

            .entry-block:last-of-type {
                border-bottom: none;
            }

            .entry-row {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
                padding: var(--space-sm) 0;
            }

            .entry-text {
                flex: 1;
                min-width: 0;
            }

            .entry-name {
                color: var(--text-primary);
                font-size: var(--font-size-sm);
            }

            /* One line always: the whole point of the list is that a hundred entries stay scannable. */
            .entry-desc {
                color: var(--text-muted);
                font-size: var(--font-size-xs);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .entry-id {
                font-family: var(--font-mono);
            }

            .preview {
                max-height: 240px;
                overflow-y: auto;
                white-space: pre-wrap;
                word-break: break-word;
                background: var(--bg-elevated);
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                padding: var(--space-sm);
                margin: 0 0 var(--space-sm);
                color: var(--text-secondary);
                font-size: var(--font-size-xs);
                line-height: 1.5;
            }
        `,
    ];

    static properties = {
        _context: { state: true },
        _knowledgeDir: { state: true },
        _knowledgeEntries: { state: true },
        _knowledgeError: { state: true },
        _knowledgeBusy: { state: true },
        _openPreview: { state: true },
        _previewBody: { state: true },
    };

    constructor() {
        super();
        this._context = '';
        this._knowledgeDir = '';
        this._knowledgeEntries = [];
        this._knowledgeError = '';
        this._knowledgeBusy = false;
        this._openPreview = '';
        this._previewBody = '';
        this._loadFromStorage();
        this._loadKnowledge();
    }

    async _loadFromStorage() {
        try {
            const prefs = await cheatingDaddy.storage.getPreferences();
            this._context = prefs.customPrompt || '';
            this.requestUpdate();
        } catch (error) {
            console.error('Error loading AI customize storage:', error);
        }
    }

    async _saveContext(val) {
        this._context = val;
        await cheatingDaddy.storage.updatePreference('customPrompt', val);
    }

    async _loadKnowledge() {
        try {
            const result = await cheatingDaddy.knowledge.list();
            this._knowledgeDir = result.success ? result.dir : '';
            this._knowledgeEntries = result.success ? result.entries : [];
            this._knowledgeError = result.success ? '' : result.error || '读取知识目录失败';
        } catch (error) {
            this._knowledgeError = error.message;
        }

        this._openPreview = '';
        this._previewBody = '';
        this.requestUpdate();
    }

    async _chooseKnowledgeDir() {
        this._knowledgeBusy = true;
        this.requestUpdate();

        try {
            const result = await cheatingDaddy.knowledge.chooseDirectory();

            if (result.success) {
                await this._loadKnowledge();
                return;
            }
            if (!result.canceled) this._knowledgeError = result.error || '选择目录失败';
        } catch (error) {
            this._knowledgeError = error.message;
        } finally {
            this._knowledgeBusy = false;
            this.requestUpdate();
        }
    }

    async _clearKnowledgeDir() {
        await cheatingDaddy.knowledge.clearDirectory();
        await this._loadKnowledge();
    }

    async _togglePreview(id) {
        if (this._openPreview === id) {
            this._openPreview = '';
            this._previewBody = '';
            this.requestUpdate();
            return;
        }

        this._openPreview = id;
        this._previewBody = '';
        this.requestUpdate();

        const result = await cheatingDaddy.knowledge.preview(id);
        // A slow read must not land in a preview that has already been closed or switched away from.
        if (this._openPreview !== id) return;

        this._previewBody = result.success ? result.body : `读取失败：${result.error || ''}`;
        this.requestUpdate();
    }

    _revealKnowledgeFile(id) {
        cheatingDaddy.knowledge.reveal(id);
    }

    render() {
        return html`
            <div class="unified-page">
                <div class="unified-wrap">
                    <div>
                        <div class="page-title">AI Context</div>
                    </div>

                    <section class="surface">
                        <div class="form-grid">
                            <div class="form-group vertical">
                                <label class="form-label">Custom Instructions</label>
                                <textarea
                                    class="control"
                                    placeholder="Resume details, role requirements, constraints..."
                                    .value=${this._context}
                                    @input=${e => this._saveContext(e.target.value)}
                                ></textarea>
                                <div class="form-help">Sent as context at session start. Keep it short.</div>
                            </div>
                        </div>
                    </section>

                    <section class="surface auto">
                        <div class="surface-title">Knowledge</div>
                        <div class="surface-subtitle">
                            A folder of <code>.md</code> files, one entry each. Its frontmatter
                            (<code>name</code> / <code>description</code>) becomes the summary the model sees; the body is
                            loaded only when the detailed answer asks for it.
                        </div>

                        <div class="dir-row">
                            <span class="dir-path">${this._knowledgeDir || 'No Knowledge Directories Selected'}</span>
                            <button class="control btn-inline" ?disabled=${this._knowledgeBusy} @click=${this._chooseKnowledgeDir}>
                                ${this._knowledgeDir ? 'Change folder' : 'Choose folder'}
                            </button>
                            ${this._knowledgeDir
                                ? html`
                                      <button class="control btn-inline" @click=${this._loadKnowledge}>Refresh</button>
                                      <button class="control btn-inline" @click=${this._clearKnowledgeDir}>Remove</button>
                                  `
                                : ''}
                        </div>

                        ${this._knowledgeError ? html`<div class="form-help danger">${this._knowledgeError}</div>` : ''}
                        ${this._renderEntries()}
                    </section>
                </div>
            </div>
        `;
    }

    _renderEntries() {
        if (!this._knowledgeDir) return '';

        if (!this._knowledgeEntries.length) {
            return html`
                <div class="entry-row">
                    <span class="entry-desc">目录里没有可读的 .md 文件（目录可能已被移动或改名）。</span>
                </div>
            `;
        }

        return html`
            ${this._knowledgeEntries.map(
                entry => html`
                    <div class="entry-block">
                        <div class="entry-row">
                            <div class="entry-text">
                                <div class="entry-name">${entry.name}</div>
                                <div class="entry-desc"><span class="entry-id">${entry.id}</span> · ${entry.description || '（无摘要）'}</div>
                            </div>
                            <button class="control btn-inline" @click=${() => this._togglePreview(entry.id)}>
                                ${this._openPreview === entry.id ? 'Close' : 'Preview'}
                            </button>
                            <button class="control btn-inline" @click=${() => this._revealKnowledgeFile(entry.id)}>Show file</button>
                        </div>
                        ${this._openPreview === entry.id ? html`<pre class="preview">${this._previewBody || '读取中…'}</pre>` : ''}
                    </div>
                `
            )}
        `;
    }
}

customElements.define('ai-customize-view', AICustomizeView);
