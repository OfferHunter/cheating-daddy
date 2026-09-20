import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { unifiedPageStyles } from './sharedPageStyles.js';
import { conversationStyles, renderMarkdown } from './conversationStyles.js';

export class HistoryView extends LitElement {
    static styles = [
        unifiedPageStyles,
        // The transcript's look, shared with the live view: a recorded session is shown as the same
        // conversation, so the two must not be able to drift apart. The local rules below come last.
        conversationStyles,
        css`
            .unified-page {
                overflow-y: hidden;
            }

            .unified-wrap {
                height: 100%;
            }

            .search-wrap {
                position: relative;
                max-width: 280px;
            }

            .search-icon {
                position: absolute;
                left: 10px;
                top: 50%;
                transform: translateY(-50%);
                width: 14px;
                height: 14px;
                color: var(--text-muted);
                pointer-events: none;
            }

            .search-wrap .control {
                padding-left: 30px;
            }

            .list-shell {
                border: 1px solid var(--border);
                border-radius: var(--radius-md);
                background: var(--bg-surface);
                overflow: hidden;
                flex: 1;
                display: flex;
                flex-direction: column;
                min-height: 0;
            }

            .sessions-list {
                overflow-y: auto;
                flex: 1;
            }

            .session-card {
                width: 100%;
                border: none;
                border-bottom: 1px solid var(--border);
                background: transparent;
                text-align: left;
                padding: var(--space-sm) var(--space-md);
                cursor: pointer;
                transition: background var(--transition);
                display: flex;
                align-items: center;
                gap: var(--space-sm);
            }

            .session-card:hover {
                background: var(--bg-hover);
            }

            /* Takes the free space so the label sits next to the checkbox and the badge is pushed to the
               far edge; space-between alone would centre the label between the two. */
            .session-left {
                flex: 1;
                min-width: 0;
                display: flex;
                flex-direction: column;
                gap: 2px;
            }

            .session-profile {
                color: var(--text-primary);
                font-size: var(--font-size-sm);
            }

            .session-date {
                color: var(--text-muted);
                font-size: var(--font-size-xs);
            }

            .session-badge {
                color: var(--text-secondary);
                font-size: var(--font-size-xs);
                background: var(--bg-elevated);
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                padding: 2px 8px;
                white-space: nowrap;
            }

            .detail-top {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
            }

            .back-btn {
                border: none;
                background: none;
                color: var(--text-muted);
                padding: 0;
                font-size: var(--font-size-sm);
                cursor: pointer;
                display: flex;
                align-items: center;
            }

            .back-btn svg {
                cursor: pointer;
            }

            .back-btn:hover {
                color: var(--text-primary);
            }

            .detail-info {
                color: var(--text-secondary);
                font-size: var(--font-size-sm);
            }

            .session-card.selected {
                background: var(--bg-hover);
            }

            .session-check {
                width: 15px;
                height: 15px;
                margin: 0;
                flex-shrink: 0;
                accent-color: var(--accent);
                cursor: pointer;
            }

            .selection-bar {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: var(--space-sm);
                padding: var(--space-sm) var(--space-md);
                border-bottom: 1px solid var(--border);
                background: var(--bg-elevated);
            }

            /* The basis is what keeps the sentence readable. With flex:1 (= basis 0) and a row that does
               not wrap, the buttons below — all nowrap, so unshrinkable past their own text — leave the
               count only its min-content width, and the confirmation sentence stacks one word per line. A
               240px basis the row cannot meet pushes the buttons onto their own line instead, so the
               sentence gets the whole width. */
            .selection-count {
                flex: 1 1 240px;
                min-width: 0;
                color: var(--text-secondary);
                font-size: var(--font-size-sm);
            }

            /* One item, so a wrap moves the whole set down rather than splitting it. */
            .bar-actions {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: var(--space-sm);
                flex-shrink: 0;
            }

            .bar-btn {
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: transparent;
                color: var(--text-secondary);
                padding: 5px 10px;
                font-size: var(--font-size-xs);
                cursor: pointer;
                transition: background var(--transition);
                white-space: nowrap;
                flex-shrink: 0;
            }

            .bar-btn:hover:not(:disabled) {
                background: var(--bg-hover);
                color: var(--text-primary);
            }

            .bar-btn.danger {
                border-color: var(--danger);
                color: var(--danger);
            }

            .bar-btn.danger:hover:not(:disabled) {
                background: rgba(241, 76, 76, 0.11);
                color: var(--danger);
            }

            .selection-note {
                padding: var(--space-sm) var(--space-md);
                border-bottom: 1px solid var(--border);
                font-size: var(--font-size-xs);
                color: var(--text-muted);
            }

            .selection-note.success {
                color: var(--success);
            }

            .selection-note.error {
                color: var(--danger);
            }

            /* Sized and selectable exactly like the live transcript, which carries both on its own scroll
               container rather than on the bubbles: a recorded session then reads at the size and leading
               the same session was read at, and follows the font-size setting. */
            .details-scroll {
                overflow-y: auto;
                flex: 1;
                min-height: 0;
                display: flex;
                flex-direction: column;
                gap: var(--space-sm);
                padding: var(--space-sm) 0;
                font-size: var(--response-font-size, 15px);
                line-height: var(--line-height);
                user-select: text;
                cursor: text;
            }

            .details-scroll * {
                user-select: text;
                cursor: text;
            }

            .details-scroll a {
                cursor: pointer;
            }

            /* One turn: its parts, each of which is a meta line over a bubble. The bubble look itself —
               sides, chrome, markdown — comes from conversationStyles, the same rules the live view uses. */
            .turn {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }

            .part {
                display: flex;
                flex-direction: column;
            }

            /* The label, the time and the references sit above the bubble rather than inside it: an answer
               is markdown, and rendering it replaces the body's contents wholesale, so anything written
               into the body would be lost on the next pass. */
            .meta-row {
                display: flex;
                align-items: baseline;
                gap: 6px;
                padding: 0 4px 2px;
                font-size: 10px;
                color: var(--text-muted);
            }

            .meta-row.left {
                justify-content: flex-start;
            }

            .meta-row.right {
                justify-content: flex-end;
            }

            .message-label {
                letter-spacing: 0.5px;
                text-transform: uppercase;
                opacity: 0.75;
            }

            .message-meta {
                opacity: 0.6;
            }

            .context-strip {
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: var(--bg-elevated);
                /* overflow:hidden drops the automatic content-based minimum, so without flex-shrink:0 this
                   collapses to its 1px border in the timeline's flex column and clips the toggle away. */
                overflow: hidden;
                flex-shrink: 0;
            }

            .context-toggle {
                width: 100%;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--space-sm);
                border: none;
                background: transparent;
                color: var(--text-secondary);
                font-size: var(--font-size-xs);
                padding: 6px var(--space-sm);
                cursor: pointer;
            }

            .context-toggle:hover {
                color: var(--text-primary);
            }

            .context-body {
                display: flex;
                flex-direction: column;
                gap: var(--space-sm);
                padding: var(--space-sm);
                border-top: 1px solid var(--border);
            }

            .context-row {
                display: flex;
                align-items: flex-start;
                gap: var(--space-sm);
                padding: var(--space-sm);
                border: 1px solid var(--border);
                border-radius: var(--radius-sm);
                background: var(--bg-elevated);
            }

            .context-key {
                width: 84px;
                color: var(--text-muted);
                font-size: var(--font-size-xs);
                text-transform: uppercase;
                letter-spacing: 0.4px;
                flex-shrink: 0;
            }

            .context-value {
                color: var(--text-primary);
                font-size: var(--font-size-sm);
                line-height: 1.45;
                white-space: pre-wrap;
                word-break: break-word;
                user-select: text;
                cursor: text;
            }

            .empty {
                color: var(--text-muted);
                font-size: var(--font-size-sm);
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 120px;
                border: 1px dashed var(--border);
                border-radius: var(--radius-sm);
            }
        `,
    ];

    static properties = {
        sessions: { type: Array },
        selectedSession: { type: Object },
        selectedSessionId: { type: String },
        loading: { type: Boolean },
        searchQuery: { type: String },
        selectedIds: { type: Array },
        confirmingDelete: { type: Boolean },
        statusMessage: { type: String },
        statusType: { type: String },
        showContext: { type: Boolean },
    };

    constructor() {
        super();
        this.sessions = [];
        this.selectedSession = null;
        this.selectedSessionId = null;
        this.loading = true;
        this.searchQuery = '';
        this.selectedIds = [];
        this.confirmingDelete = false;
        this.statusMessage = '';
        this.statusType = '';
        this.showContext = false;
        this.loadSessions();
    }

    async loadSessions() {
        try {
            this.loading = true;
            this.sessions = await cheatingDaddy.storage.getAllSessions();
            // A deleted session must not keep counting towards the toolbar, and a selection built before
            // a reload must never refer to an id the list no longer shows.
            this.selectedIds = this.selectedIds.filter(id => this.sessions.some(session => session.sessionId === id));
        } catch (error) {
            console.error('Error loading sessions:', error);
            this.sessions = [];
        } finally {
            this.loading = false;
            this.requestUpdate();
        }
    }

    async openSession(sessionId) {
        try {
            const session = await cheatingDaddy.storage.getSession(sessionId);
            if (session) {
                this.selectedSession = session;
                this.selectedSessionId = sessionId;
                this.showContext = false;
                this.requestUpdate();
            }
        } catch (error) {
            console.error('Error loading session:', error);
        }
    }

    closeSession() {
        this.selectedSession = null;
        this.selectedSessionId = null;
        this.showContext = false;
    }

    handleSearchInput(e) {
        this.searchQuery = e.target.value;
    }

    isSelected(sessionId) {
        return this.selectedIds.includes(sessionId);
    }

    toggleSelect(sessionId) {
        this.selectedIds = this.isSelected(sessionId)
            ? this.selectedIds.filter(id => id !== sessionId)
            : [...this.selectedIds, sessionId];
        this.confirmingDelete = false;
        this.statusMessage = '';
    }

    // Applies to the rows the search is currently showing, so "all" means what the user can see rather
    // than every session on disk.
    toggleSelectAll(visibleSessions) {
        const visibleIds = visibleSessions.map(session => session.sessionId);
        const allSelected = visibleIds.length > 0 && visibleIds.every(id => this.isSelected(id));
        this.selectedIds = allSelected
            ? this.selectedIds.filter(id => !visibleIds.includes(id))
            : [...new Set([...this.selectedIds, ...visibleIds])];
        this.confirmingDelete = false;
        this.statusMessage = '';
    }

    clearSelection() {
        this.selectedIds = [];
        this.confirmingDelete = false;
        this.statusMessage = '';
    }

    // The row body opens the session; the checkbox inside it is the one click that must not.
    handleCardClick(event, sessionId) {
        if (event.target.closest('.session-check')) return;
        this.openSession(sessionId);
    }

    async deleteSelected() {
        if (!this.selectedIds.length) return;
        const count = this.selectedIds.length;
        try {
            const results = await Promise.all(this.selectedIds.map(id => cheatingDaddy.storage.deleteSession(id)));
            const failed = results.filter(result => !result?.success).length;
            await this.loadSessions();
            this.selectedIds = [];
            this.confirmingDelete = false;
            this.statusType = failed ? 'error' : 'success';
            this.statusMessage = failed
                ? `${failed} of ${count} sessions could not be deleted.`
                : `Deleted ${count} session${count === 1 ? '' : 's'}.`;
        } catch (error) {
            console.error('Error deleting sessions:', error);
            this.confirmingDelete = false;
            this.statusType = 'error';
            this.statusMessage = `Error deleting sessions: ${error.message}`;
        } finally {
            this.requestUpdate();
        }
    }

    async exportSelected() {
        if (!this.selectedIds.length) return;
        try {
            const result = await cheatingDaddy.storage.exportSessions(this.selectedIds);
            // A cancelled dialog is not an outcome worth reporting; the selection stays as it was.
            if (result.canceled) return;
            this.statusType = result.success ? 'success' : 'error';
            this.statusMessage = result.success
                ? `Exported ${result.count} session${result.count === 1 ? '' : 's'} to ${result.dir}`
                : `Export failed: ${result.error || 'unknown error'}`;
        } catch (error) {
            console.error('Error exporting sessions:', error);
            this.statusType = 'error';
            this.statusMessage = `Export failed: ${error.message}`;
        } finally {
            this.confirmingDelete = false;
            this.requestUpdate();
        }
    }

    formatDate(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }

    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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

    _getProfileLabel(session) {
        if (session.profile) {
            const names = this.getProfileNames();
            return names[session.profile] || session.profile;
        }
        return 'Session';
    }

    getSessionPreview(session) {
        const parts = [];
        if (session.messageCount > 0) parts.push(`${session.messageCount} messages`);
        if (session.detailCount > 0) parts.push(`${session.detailCount} detailed`);
        if (session.screenAnalysisCount > 0) parts.push(`${session.screenAnalysisCount} screen`);
        if (session.profile) {
            const profileNames = this.getProfileNames();
            parts.push(profileNames[session.profile] || session.profile);
        }
        return parts.length > 0 ? parts.join(' · ') : 'Empty session';
    }

    getFilteredSessions() {
        if (!this.searchQuery.trim()) return this.sessions;
        const q = this.searchQuery.toLowerCase();
        return this.sessions.filter(session => {
            const preview = this.getSessionPreview(session).toLowerCase();
            const date = this.formatDate(session.createdAt).toLowerCase();
            return preview.includes(q) || date.includes(q);
        });
    }

    // The stored lists are parts of one conversation, not separate ones: a brief turn, its detailed twin
    // and the screenshot summary of an image question all carry that question's sequence number as
    // `order`, and a block of the candidate's own speech carries the one it was committed with. So rows
    // are grouped by `order` and read as one timeline.
    //
    // Ordering the rows by `order` rather than by timestamp is deliberate. Answers stream concurrently and
    // finish out of order, so a timestamp sort would replay the interview in the order the model happened
    // to finish answering rather than the order the questions were asked — orders 3 and 5 in one recorded
    // session are a real instance of the two disagreeing.
    //
    // The candidate's speech keeps its place because the pipeline allocates its sequence number before
    // the question that interrupted it: the block reads above that question, exactly where it was seen.
    collectTimeline(session) {
        const groups = new Map();
        const groupFor = (order, timestamp) => {
            // `order` is absent or zero only in sessions written before it existed. Those fall back to
            // being keyed by their own timestamp, so they stay separate rows instead of collapsing into
            // one, and they sort last rather than jumping to the front.
            const numbered = Number.isFinite(order) && order > 0;
            const key = numbered ? `o${order}` : `t${timestamp}`;
            if (!groups.has(key)) {
                groups.set(key, { order: numbered ? order : Infinity, parts: [] });
            }
            return groups.get(key);
        };

        // The transcript and the detail turn both store the same question text for the same `order`, so
        // only the first one seen is kept: the alternative is the page showing every question twice.
        const parts = [
            ...(session.conversationHistory || []).map(turn => ({
                role: 'question',
                content: turn.transcription,
                timestamp: turn.timestamp,
                order: turn.order,
            })),
            ...(session.conversationHistory || []).map(turn => ({
                role: 'brief',
                content: turn.ai_response,
                timestamp: turn.timestamp,
                order: turn.order,
            })),
            ...(session.detailHistory || []).map(turn => ({
                role: 'question',
                content: turn.question,
                timestamp: turn.timestamp,
                order: turn.order,
            })),
            ...(session.detailHistory || []).map(turn => ({
                role: 'detail',
                content: turn.ai_response,
                timestamp: turn.timestamp,
                order: turn.order,
                usedKnowledge: turn.used_knowledge || [],
            })),
            ...(session.screenAnalysisHistory || []).map(entry => ({
                role: 'screen',
                content: entry.response,
                timestamp: entry.timestamp,
                order: entry.order,
            })),
            // Absent from sessions recorded before the candidate's own speech was written out, which is
            // why this list is tolerated missing rather than treated as a broken file.
            ...(session.candidateHistory || []).map(entry => ({
                role: 'candidate',
                content: entry.text,
                timestamp: entry.timestamp,
                order: entry.order,
            })),
        ];

        parts.forEach(part => {
            if (!part.content) return;
            const group = groupFor(part.order, part.timestamp);
            if (part.role === 'question' && group.parts.some(existing => existing.role === 'question')) return;
            group.parts.push(part);
        });

        // The question opens its row; the answers follow in the order they were actually produced, which
        // is why the screenshot summary can sit ahead of the detailed answer for the same image.
        const rank = part => (part.role === 'question' ? 0 : 1);
        return [...groups.values()]
            .map(group => this._dropRepeatedQuestion(group))
            .filter(group => group.parts.length > 0)
            .sort((a, b) => a.order - b.order || this._firstTimestamp(a) - this._firstTimestamp(b))
            .map(group => {
                group.parts.sort((a, b) => rank(a) - rank(b) || a.timestamp - b.timestamp);
                // Where the markdown pass finds each answer again. The parts are already in their final
                // order here, so position is enough to tell two of the same role apart, and the pass
                // recomputes the same list, which is what makes the key stable between the two.
                group.parts.forEach((part, index) => {
                    part.key = `${group.order}:${part.role}:${index}`;
                });
                return group;
            });
    }

    // An answer is markdown, and markdown cannot be expressed in the template without re-parsing it on
    // every update, so the body is filled in after the fact — the same pass the live view runs, minus the
    // streaming: a recorded session renders once, and the memo keeps a selection or a search from
    // re-parsing anything that has not changed.
    updated() {
        if (!this.selectedSession) return;

        for (const group of this.collectTimeline(this.selectedSession)) {
            for (const part of group.parts) {
                if (part.role === 'question' || part.role === 'candidate') continue;

                const el = this.renderRoot.querySelector(`[data-timeline-id="${part.key}"]`);
                if (!el || el._renderedText === part.content) continue;

                el.innerHTML = renderMarkdown(part.content);
                el._renderedText = part.content;
            }
        }
    }

    // An image question is stored twice over: the detail turn's `question` is the screenshot summary line
    // verbatim, and the same line is what the screen entry holds. Once the question is there to carry it,
    // the screen copy is dropped — otherwise the row prints one identical line twice.
    _dropRepeatedQuestion(group) {
        const question = group.parts.find(part => part.role === 'question');
        if (question) {
            const text = question.content.trim();
            group.parts = group.parts.filter(part => part.role === 'question' || part.content.trim() !== text);
        }
        return group;
    }

    _firstTimestamp(group) {
        return Math.min(...group.parts.map(part => part.timestamp || 0));
    }

    // Folded away by default: the profile and prompt are what the session was set up with, not part of
    // what was said in it, and every session of this app carries the same profile anyway.
    renderContextStrip() {
        const profile = this.selectedSession.profile;
        const prompt = this.selectedSession.customPrompt;
        if (!profile && !prompt) return '';

        const hint = [profile && 'profile', prompt && 'prompt'].filter(Boolean).join(' · ');
        return html`
            <div class="context-strip">
                <button class="context-toggle" @click=${() => { this.showContext = !this.showContext; }}>
                    <span>${this.showContext ? '▾' : '▸'} Context</span>
                    <span>${hint}</span>
                </button>
                ${this.showContext ? html`
                    <div class="context-body">
                        ${profile ? html`
                            <div class="context-row">
                                <span class="context-key">Profile</span>
                                <span class="context-value">${this.getProfileNames()[profile] || profile}</span>
                            </div>
                        ` : ''}
                        ${prompt ? html`
                            <div class="context-row">
                                <span class="context-key">Prompt</span>
                                <span class="context-value">${prompt}</span>
                            </div>
                        ` : ''}
                    </div>
                ` : ''}
            </div>
        `;
    }

    renderTimeline() {
        const rows = this.collectTimeline(this.selectedSession);
        if (!rows.length) return html`<div class="empty">No conversation data.</div>`;
        // Grouped so the gap between turns is the timeline's own and not the one that would otherwise
        // open up between a meta line and the bubble it belongs to.
        return rows.map(group => html`<div class="turn">${group.parts.map(part => this.renderPart(part))}</div>`);
    }

    // The sides are the live transcript's: the interviewer on the left, the candidate's own speech and the
    // assistant's answers on the right. Without the label the two answers would read as one interrupted
    // answer, since they are two replies to the same question.
    renderPart(part) {
        const time = this.formatTime(part.timestamp);

        if (part.role === 'question') {
            return html`
                <div class="part">
                    <div class="meta-row left"><span class="message-meta">${time}</span></div>
                    <div class="message-row interviewer">
                        <div class="message-body plain">${part.content}</div>
                    </div>
                </div>
            `;
        }

        if (part.role === 'candidate') {
            return html`
                <div class="part">
                    <div class="meta-row right"><span class="message-meta">${time}</span></div>
                    <div class="message-row user">
                        <div class="message-body plain">${part.content}</div>
                    </div>
                </div>
            `;
        }

        const labels = { brief: 'Brief answer', detail: 'Detailed answer', screen: 'Screen' };
        const references = part.usedKnowledge?.length ? part.usedKnowledge.join(', ') : '';
        return html`
            <div class="part">
                <div class="meta-row right">
                    <span class="message-label">${labels[part.role] || part.role}</span>
                    <span class="message-meta">${time}${references ? ` · ${references}` : ''}</span>
                </div>
                <div class="message-row assistant">
                    <div class="message-body markdown" data-timeline-id=${part.key}></div>
                </div>
            </div>
        `;
    }

    renderListView() {
        const filteredSessions = this.getFilteredSessions();
        return html`
            <div class="page-title">History</div>

            <div class="search-wrap">
                <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="11" cy="11" r="8"/>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input
                    class="control"
                    type="text"
                    placeholder="Search sessions..."
                    .value=${this.searchQuery}
                    @input=${this.handleSearchInput}
                />
            </div>

            <section class="list-shell">
                ${this.renderSelectionBar(filteredSessions)}
                <div class="sessions-list">
                    ${this.loading ? html`<div class="empty" style="margin:var(--space-md);">Loading sessions...</div>` : ''}
                    ${!this.loading && filteredSessions.length === 0 ? html`<div class="empty" style="margin:var(--space-md);">No matching sessions.</div>` : ''}
                    ${!this.loading ? filteredSessions.map(session => html`
                        <div
                            class="session-card ${this.isSelected(session.sessionId) ? 'selected' : ''}"
                            @click=${event => this.handleCardClick(event, session.sessionId)}
                        >
                            <input
                                class="session-check"
                                type="checkbox"
                                .checked=${this.isSelected(session.sessionId)}
                                @change=${() => this.toggleSelect(session.sessionId)}
                            />
                            <div class="session-left">
                                <span class="session-profile">${this._getProfileLabel(session)}</span>
                                <span class="session-date">${this.formatDate(session.createdAt)} · ${this.formatTime(session.createdAt)}</span>
                            </div>
                            ${session.messageCount > 0 ? html`<span class="session-badge">${session.messageCount}</span>` : ''}
                        </div>
                    `) : ''}
                </div>
            </section>
        `;
    }

    // Only there once something is selected, and the delete button's first click only arms it: the second
    // click is the confirmation. There is no separate dialog to escape from, which matters in a window
    // that floats above everything else.
    renderSelectionBar(filteredSessions) {
        if (this.statusMessage && !this.selectedIds.length) {
            return html`<div class="selection-note ${this.statusType}">${this.statusMessage}</div>`;
        }
        if (!this.selectedIds.length) return '';

        const count = this.selectedIds.length;
        const allSelected = filteredSessions.length > 0 && filteredSessions.every(session => this.isSelected(session.sessionId));

        return html`
            <div class="selection-bar">
                ${this.confirmingDelete
                    ? html`<span class="selection-count danger">Delete ${count} session${count === 1 ? '' : 's'}? This cannot be undone.</span>`
                    : html`<span class="selection-count">${count} selected</span>`}
                <div class="bar-actions">
                    ${this.confirmingDelete
                        ? html`
                            <button class="bar-btn" @click=${() => { this.confirmingDelete = false; }}>Cancel</button>
                            <button class="bar-btn danger" @click=${this.deleteSelected}>Delete</button>
                        `
                        : html`
                            <button class="bar-btn" @click=${() => this.toggleSelectAll(filteredSessions)}>
                                ${allSelected ? 'Deselect all' : 'Select all'}
                            </button>
                            <button class="bar-btn" @click=${this.clearSelection}>Clear</button>
                            <button class="bar-btn" @click=${this.exportSelected}>Export JSON</button>
                            <button class="bar-btn danger" @click=${() => { this.confirmingDelete = true; }}>Delete</button>
                        `}
                </div>
            </div>
            ${this.statusMessage ? html`<div class="selection-note ${this.statusType}">${this.statusMessage}</div>` : ''}
        `;
    }

    renderDetailView() {
        return html`
            <div class="page-title">Session Detail</div>
            <div class="detail-top">
                <button class="back-btn" @click=${this.closeSession}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="15 18 9 12 15 6"/>
                    </svg>
                </button>
                <span class="detail-info">${this._getProfileLabel(this.selectedSession)} · ${this.formatDate(this.selectedSession.createdAt)} · ${this.formatTime(this.selectedSession.createdAt)}</span>
            </div>
            <section class="details-scroll">
                ${this.renderContextStrip()}
                ${this.renderTimeline()}
            </section>
        `;
    }

    render() {
        return html`
            <div class="unified-page">
                <div class="unified-wrap">
                    ${this.selectedSession ? this.renderDetailView() : this.renderListView()}
                </div>
            </div>
        `;
    }
}

customElements.define('history-view', HistoryView);
