import { html, css } from '../../assets/lit-core-2.7.4.min.js';
import { LocalizedLitElement, isChinese, t } from '../../utils/i18n.js';
import { scrollbarStyles, unifiedPageStyles } from './sharedPageStyles.js';

// 与主进程同一份默认分段文案：面板按它预填各文本框，某段没有覆盖就显示默认值。
const { DEFAULT_PROMPT_SEGMENTS } = window.require('./utils/prompts');

// 系统提示词编辑面板的分组。[段键, 英文标签, 中文标签]；段键对应 prompts.js 的 DEFAULT_PROMPT_SEGMENTS。
const PROMPT_GROUPS = [
    {
        title: 'Brief answer',
        titleZh: '简短回答',
        fields: [
            ['briefIntro', 'Opening persona', '开场人设'],
            ['briefFormat', 'Answer format', '回答格式要求'],
            ['briefContent', 'Content requirements', '内容要求'],
            ['briefOutput', 'Output requirements', '输出要求'],
        ],
    },
    {
        title: 'Detailed answer',
        titleZh: '详细回答',
        fields: [
            ['detailIntro', 'Opening persona', '开场人设'],
            ['detailFormat', 'Answer format', '回答格式要求'],
            ['detailContent', 'Content requirements', '内容要求'],
            ['detailKnowledgeRule', 'Knowledge rule', '知识库规则'],
            ['detailOutput', 'Output requirements', '输出要求'],
        ],
    },
    {
        title: 'Shared rules',
        titleZh: '通用规则',
        fields: [
            ['languageRule', 'Language rule', '语言要求'],
            ['contextRule', 'Context rule', '上下文约定'],
        ],
    },
];

export class AICustomizeView extends LocalizedLitElement {
    static styles = [
        unifiedPageStyles,
        scrollbarStyles,
        css`
            /* wrap 保留共用的 min-height: 100% 而不锁死在它上面：条目一多，页面必须长高并滚动；锁死则多出来的
               高度会从上面的说明框里扣。知识区同理按内容自撑——给它也加 flex:1，两块就会分掉剩余高度，把说明框
               挤没。 */
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
            /* 是下限而不是 min-height: 0：条目长时这句话框在页面滚动过程中保持这个高度，不会被压成一条缝。 */
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

            /* 永远一行：这个列表的意义就是上百条也能一眼扫完。 */
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

            /* 提示词编辑面板：整块默认折叠，标题行点击展开。 */
            .prompt-toggle {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--space-sm);
                cursor: pointer;
            }

            .prompt-toggle .surface-title {
                margin: 0;
            }

            .prompt-caret {
                width: 16px;
                height: 16px;
                flex-shrink: 0;
                color: var(--text-muted);
                transition: transform var(--transition);
            }

            .prompt-caret.open {
                transform: rotate(90deg);
            }

            .prompt-body {
                margin-top: var(--space-md);
            }

            .prompt-warn {
                color: var(--warning);
                margin-bottom: var(--space-sm);
            }

            .prompt-actions {
                margin-bottom: var(--space-md);
            }

            .prompt-group {
                margin-top: var(--space-md);
                padding-top: var(--space-md);
                border-top: 1px solid var(--border);
            }

            .prompt-group-title {
                color: var(--text-secondary);
                font-size: var(--font-size-sm);
                font-weight: var(--font-weight-medium);
                margin-bottom: var(--space-sm);
            }

            .seg-field {
                display: flex;
                flex-direction: column;
                gap: 4px;
                margin-bottom: var(--space-sm);
            }

            .seg-label {
                color: var(--text-muted);
                font-size: var(--font-size-xs);
            }

            /* 覆盖组件里 textarea.control 的 min-height：这些段是短文本块，不必撑到 160px。
               resize 保持 none，去掉右下角那个原生缩放手柄——它和这套主题不搭，而且手动拉高会和上面的弹性布局打架。 */
            textarea.seg-input {
                min-height: 84px;
                resize: none;
                user-select: text;
            }
        `,
    ];

    static properties = {
        _context: { state: true },
        _promptOpen: { state: true },
        _promptOverrides: { state: true },
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
        this._promptOpen = false;
        this._promptOverrides = {};
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
            const prefs = await offerHunter.storage.getPreferences();
            this._context = prefs.customPrompt || '';
            this._promptOverrides = { ...(prefs.promptOverrides || {}) };
            this.requestUpdate();
        } catch (error) {
            console.error('Error loading AI customize storage:', error);
        }
    }

    async _saveContext(val) {
        this._context = val;
        await offerHunter.storage.updatePreference('customPrompt', val);
    }

    _togglePromptPanel() {
        this._promptOpen = !this._promptOpen;
        this.requestUpdate();
    }

    // 某段的显示值：有覆盖用覆盖，否则用内置默认。
    _segmentValue(key) {
        return Object.prototype.hasOwnProperty.call(this._promptOverrides, key) ? this._promptOverrides[key] : DEFAULT_PROMPT_SEGMENTS[key];
    }

    async _setSegment(key, value) {
        this._promptOverrides = { ...this._promptOverrides, [key]: value };
        await offerHunter.storage.updatePreference('promptOverrides', this._promptOverrides);
    }

    // 清空全部覆盖，各段回退到内置默认。
    async _restorePromptDefaults() {
        this._promptOverrides = {};
        await offerHunter.storage.updatePreference('promptOverrides', {});
        this.requestUpdate();
    }

    async _loadKnowledge() {
        try {
            const result = await offerHunter.knowledge.list();
            this._knowledgeDir = result.success ? result.dir : '';
            this._knowledgeEntries = result.success ? result.entries : [];
            this._knowledgeError = result.success ? '' : result.error || t('Could not read the knowledge folder', '读取知识目录失败');
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
            const result = await offerHunter.knowledge.chooseDirectory();

            if (result.success) {
                await this._loadKnowledge();
                return;
            }
            if (!result.canceled) this._knowledgeError = result.error || t('Could not select the folder', '选择目录失败');
        } catch (error) {
            this._knowledgeError = error.message;
        } finally {
            this._knowledgeBusy = false;
            this.requestUpdate();
        }
    }

    async _clearKnowledgeDir() {
        await offerHunter.knowledge.clearDirectory();
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

        const result = await offerHunter.knowledge.preview(id);
        // 读得慢：结果不能落进一个已经关掉或切走的预览里。
        if (this._openPreview !== id) return;

        this._previewBody = result.success
            ? result.body
            : isChinese()
              ? `读取失败：${result.error || ''}`
              : `Could not read the file: ${result.error || ''}`;
        this.requestUpdate();
    }

    _revealKnowledgeFile(id) {
        offerHunter.knowledge.reveal(id);
    }

    render() {
        return html`
            <div class="unified-page">
                <div class="unified-wrap">
                    <div>
                        <div class="page-title">AI Context</div>
                    </div>

                    <section class="surface auto">
                        <div class="prompt-toggle" @click=${this._togglePromptPanel}>
                            <div class="surface-title">${t('System Prompt', '系统提示词')}</div>
                            <svg
                                class="prompt-caret ${this._promptOpen ? 'open' : ''}"
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            >
                                <path d="M9 6l6 6-6 6" />
                            </svg>
                        </div>
                        ${this._promptOpen ? this._renderPromptEditor() : ''}
                    </section>

                    <section class="surface">
                        <div class="form-grid">
                            <div class="form-group vertical">
                                <label class="form-label">User Information Context</label>
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
                            ${
                                isChinese()
                                    ? html`知识库目录中的每个 <code>.md</code> 文件代表一个条目。文件头的 <code>name</code> 和
                                          <code>description</code> 会作为模型可见的摘要；只有详细回答需要时才会读取正文。`
                                    : html`A folder of <code>.md</code> files, one entry each. Its frontmatter (<code>name</code> /
                                          <code>description</code>) becomes the summary the model sees; the body is loaded only when the detailed
                                          answer asks for it.`
                            }
                        </div>

                        <div class="dir-row">
                            <span class="dir-path" data-no-localize>
                                ${this._knowledgeDir || t('No Knowledge Directories Selected', '尚未选择知识库目录')}
                            </span>
                            <button class="control btn-inline" ?disabled=${this._knowledgeBusy} @click=${this._chooseKnowledgeDir}>
                                ${this._knowledgeDir ? 'Change folder' : 'Choose folder'}
                            </button>
                            ${
                                this._knowledgeDir
                                    ? html`
                                          <button class="control btn-inline" @click=${this._loadKnowledge}>Refresh</button>
                                          <button class="control btn-inline" @click=${this._clearKnowledgeDir}>Remove</button>
                                      `
                                    : ''
                            }
                        </div>

                        ${this._knowledgeError ? html`<div class="form-help danger">${this._knowledgeError}</div>` : ''} ${this._renderEntries()}
                    </section>
                </div>
            </div>
        `;
    }

    _renderPromptEditor() {
        return html`
            <div class="prompt-body">
                <div class="form-help prompt-warn">
                    ${
                        t(
                            'Edit with care — these are the model\'s core instructions. A careless change affects every answer.',
                            '谨慎修改：以下是模型的核心指令，会直接影响每一次回答，改错可能让回答质量下降。'
                        )
                    }
                </div>
                <div class="prompt-actions">
                    <button class="control btn-inline" @click=${this._restorePromptDefaults}>${t('Restore default', '恢复默认')}</button>
                </div>
                ${PROMPT_GROUPS.map(group => this._renderPromptGroup(group))}
            </div>
        `;
    }

    _renderPromptGroup(group) {
        return html`
            <div class="prompt-group">
                <div class="prompt-group-title">${t(group.title, group.titleZh)}</div>
                ${group.fields.map(([key, en, zh]) => this._renderSegment(key, en, zh))}
            </div>
        `;
    }

    _renderSegment(key, en, zh) {
        return html`
            <label class="seg-field">
                <span class="seg-label">${t(en, zh)}</span>
                <textarea class="control seg-input" .value=${this._segmentValue(key)} @input=${e => this._setSegment(key, e.target.value)}></textarea>
            </label>
        `;
    }

    _renderEntries() {
        if (!this._knowledgeDir) return '';

        if (!this._knowledgeEntries.length) {
            return html`
                <div class="entry-row">
                    <span class="entry-desc" data-no-localize>
                        ${t(
                            'There are no readable .md files in this folder (the folder may have been moved or renamed).',
                            '目录里没有可读的 .md 文件（目录可能已被移动或改名）。'
                        )}
                    </span>
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
                                <div class="entry-desc" data-no-localize>
                                    <span class="entry-id">${entry.id}</span> · ${entry.description || t('(No summary)', '（无摘要）')}
                                </div>
                            </div>
                            <button class="control btn-inline" @click=${() => this._togglePreview(entry.id)}>
                                ${this._openPreview === entry.id ? 'Close' : 'Preview'}
                            </button>
                            <button class="control btn-inline" @click=${() => this._revealKnowledgeFile(entry.id)}>Show file</button>
                        </div>
                        ${this._openPreview === entry.id ? html`<pre class="preview">${this._previewBody || t('Loading…', '读取中…')}</pre>` : ''}
                    </div>
                `
            )}
        `;
    }
}

customElements.define('ai-customize-view', AICustomizeView);
