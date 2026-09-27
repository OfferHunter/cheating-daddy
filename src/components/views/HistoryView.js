import { html, css } from '../../assets/lit-core-2.7.4.min.js';
import { LocalizedLitElement, isChinese } from '../../utils/i18n.js';
import { scrollbarStyles, unifiedPageStyles } from './sharedPageStyles.js';
import { conversationStyles, syncMarkdownInto } from './conversationStyles.js';

export class HistoryView extends LocalizedLitElement {
    static styles = [
        unifiedPageStyles,
        scrollbarStyles,
        // 转录的外观与实时视图共用：录下来的会话要显示成同一场对话，两边不能漂移。本地规则放在后面。
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

            /* 占掉剩余空间：标签贴着复选框，徽章被推到最右。只用 space-between 会把标签居中。 */
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
                appearance: none;
                display: grid;
                place-content: center;
                border: 1px solid var(--border-strong);
                border-radius: 50%;
                background: var(--bg-surface);
                cursor: pointer;
            }

            .session-check::after {
                content: '';
                width: 7px;
                height: 7px;
                border-radius: 50%;
                background: var(--text-primary);
                transform: scale(0);
                transition: transform var(--transition);
            }

            .session-check:checked {
                border-color: var(--text-primary);
            }

            .session-check:checked::after {
                transform: scale(1);
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

            /* 这个 basis 决定确认句还读不读得通：换成 flex:1（basis 0）又不换行时，下面那排 nowrap 按钮压不掉
               自身文字宽度，计数只剩 min-content，句子会一词一行。240px 撑不下时按钮被顶到下一行，句子独占整宽。 */
            .selection-count {
                flex: 1 1 240px;
                min-width: 0;
                color: var(--text-secondary);
                font-size: var(--font-size-sm);
            }

            /* 整组只有一个元素，所以换行时它整体下移，而不会被拆开。 */
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

            /* 字号与可选中范围跟实时转录一模一样（那也是挂在滚动容器上而非气泡上）：录下来的会话读起来和当时
               一致，并且跟随字号设置。 */
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

            /* 一轮：若干 part，每个是 meta 行 + 气泡。气泡本身（朝向、外观、markdown）来自 conversationStyles，
               与实时视图是同一份规则。 */
            .turn {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }

            .part {
                display: flex;
                flex-direction: column;
            }

            /* 标签、时间和引用放在气泡上方而不是里面：回答是 markdown，渲染时整块替换正文，写进正文的内容下一
               轮就没了。 */
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
                /* overflow:hidden 去掉了基于内容的自动最小高度：没有 flex-shrink:0 它会在时间线的 flex 列里缩成
                   1px 边框，把开关裁掉。 */
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
            // 删掉的会话不能继续计入工具栏；刷新前建立的选中项也不能指向列表里已经没有的 id。
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
        this.selectedIds = this.isSelected(sessionId) ? this.selectedIds.filter(id => id !== sessionId) : [...this.selectedIds, sessionId];
        this.confirmingDelete = false;
        this.statusMessage = '';
    }

    // 只作用于搜索当前显示出来的行：所以「全选」指的是用户看得见的那些，而不是磁盘上的全部会话。
    toggleSelectAll(visibleSessions) {
        const visibleIds = visibleSessions.map(session => session.sessionId);
        const allSelected = visibleIds.length > 0 && visibleIds.every(id => this.isSelected(id));
        this.selectedIds = allSelected ? this.selectedIds.filter(id => !visibleIds.includes(id)) : [...new Set([...this.selectedIds, ...visibleIds])];
        this.confirmingDelete = false;
        this.statusMessage = '';
    }

    clearSelection() {
        this.selectedIds = [];
        this.confirmingDelete = false;
        this.statusMessage = '';
    }

    // 行主体打开会话；里面的复选框是唯一不该打开的那次点击。
    handleCardClick(event, sessionId) {
        if (event.target.closest('.session-check')) return;
        this.openSession(sessionId);
    }

    showStatus(message, type) {
        this.statusMessage = message;
        this.statusType = type;
        clearTimeout(this._statusTimer);
        this._statusTimer = setTimeout(() => {
            this.statusMessage = '';
            this.requestUpdate();
        }, 4000);
    }

    disconnectedCallback() {
        clearTimeout(this._statusTimer);
        super.disconnectedCallback();
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
            this.showStatus(
                failed
                    ? isChinese()
                        ? `${count} 个会话中有 ${failed} 个删除失败。`
                        : `${failed} of ${count} sessions could not be deleted.`
                    : isChinese()
                      ? `已删除 ${count} 个会话。`
                      : `Deleted ${count} session${count === 1 ? '' : 's'}.`,
                failed ? 'error' : 'success'
            );
        } catch (error) {
            console.error('Error deleting sessions:', error);
            this.confirmingDelete = false;
            this.showStatus(isChinese() ? `删除会话失败：${error.message}` : `Error deleting sessions: ${error.message}`, 'error');
        } finally {
            this.requestUpdate();
        }
    }

    async exportSelected() {
        if (!this.selectedIds.length) return;
        try {
            const result = await cheatingDaddy.storage.exportSessions(this.selectedIds);
            // 取消对话框不算需要报告的结果；选中状态保持不变。
            if (result.canceled) return;
            this.showStatus(
                result.success
                    ? isChinese()
                        ? `已将 ${result.count} 个会话导出到 ${result.dir}`
                        : `Exported ${result.count} session${result.count === 1 ? '' : 's'} to ${result.dir}`
                    : isChinese()
                      ? `导出失败：${result.error || '未知错误'}`
                      : `Export failed: ${result.error || 'unknown error'}`,
                result.success ? 'success' : 'error'
            );
        } catch (error) {
            console.error('Error exporting sessions:', error);
            this.showStatus(isChinese() ? `导出失败：${error.message}` : `Export failed: ${error.message}`, 'error');
        } finally {
            this.confirmingDelete = false;
            this.requestUpdate();
        }
    }

    formatDate(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleDateString(isChinese() ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString(isChinese() ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
    }

    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleString(isChinese() ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    getProfileNames() {
        return isChinese()
            ? { interview: '求职面试', sales: '销售通话', meeting: '商务会议', presentation: '演示汇报', negotiation: '谈判', exam: '考试助手' }
            : {
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
        if (session.profile) {
            const profileNames = this.getProfileNames();
            parts.push(profileNames[session.profile] || session.profile);
        }
        return parts.length > 0 ? parts.join(' · ') : 'Empty session';
    }

    getFilteredSessions() {
        if (!this.searchQuery.trim()) return this.sessions;
        const q = this.searchQuery.trim().toLocaleLowerCase();
        return this.sessions.filter(session => {
            const searchableContent = [this.getSessionPreview(session), this.formatDate(session.createdAt), session.customPrompt, session.searchText]
                .filter(Boolean)
                .join('\n')
                .toLocaleLowerCase();
            return searchableContent.includes(q);
        });
    }

    // 落盘的几份列表是同一场对话的不同部分，不是彼此独立的：精简轮、它的详细孪生、以及对图片提问的截图摘要，
    // 都带着那个问题的序号 `order`；面试者自己的一段话带着它提交时的序号。所以行按 `order` 分组，读作一条时间线。
    //
    // 按 `order` 而不是时间戳排序是刻意的：回答并发流式返回、结束顺序是乱的，按时间戳排就会按「模型答完」的顺序
    // 回放面试，而不是按提问顺序；某个已录会话里 order 3 和 5 就是两者不一致的真实例子。
    //
    // 面试者的话能留在原位，是因为 pipeline 在打断它的那个问题之前就把它的序号分配好了：这段话读起来就在那个
    // 问题上面，和当时看到的位置一致。
    collectTimeline(session) {
        const groups = new Map();
        const groupFor = (order, timestamp) => {
            // `order` 缺失或为 0 只出现在引入它之前写下的会话里：那些按自身时间戳做 key，于是仍是各自独立的一行
            // 而不是挤成一坨，并且排在最后，而不是跳到最前。
            const numbered = Number.isFinite(order) && order > 0;
            const key = numbered ? `o${order}` : `t${timestamp}`;
            if (!groups.has(key)) {
                groups.set(key, { order: numbered ? order : Infinity, parts: [] });
            }
            return groups.get(key);
        };

        // 转录和详细轮为同一个 `order` 都存了同一句提问，所以只留先见到的那个：否则页面上每个问题会出现两次。
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
            // 在面试者发言开始落盘之前录下的会话里没有这份列表，所以这里容忍它缺失，而不是当成损坏的文件。
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

        // 提问开一行，回答按实际产生的先后跟在后面——所以截图摘要可以排在同一张图的详细回答前面。
        const rank = part => (part.role === 'question' ? 0 : 1);
        return [...groups.values()]
            .filter(group => group.parts.length > 0)
            .sort((a, b) => a.order - b.order || this._firstTimestamp(a) - this._firstTimestamp(b))
            .map(group => {
                group.parts.sort((a, b) => rank(a) - rank(b) || a.timestamp - b.timestamp);
                // markdown 那一轮靠这个 key 把每个回答找回来。此时顺序已定，位置就足以区分同角色的两条；那一轮
                // 会重算出同一个列表，这正是两边 key 稳定的原因。
                group.parts.forEach((part, index) => {
                    part.key = `${group.order}:${part.role}:${index}`;
                });
                return group;
            });
    }

    // 回答是 markdown，写进模板就意味着每次更新都重解析，所以正文事后填充——和实时视图同一套，只是没有流式：
    // 录下来的会话只渲染一次，memo 让选中和搜索都不会重解析没变过的内容。
    updated() {
        super.updated();
        if (!this.selectedSession) return;

        for (const group of this.collectTimeline(this.selectedSession)) {
            for (const part of group.parts) {
                if (part.role === 'question' || part.role === 'candidate') continue;

                syncMarkdownInto(this.renderRoot.querySelector(`[data-timeline-id="${part.key}"]`), part.content, part.content);
            }
        }
    }

    _firstTimestamp(group) {
        return Math.min(...group.parts.map(part => part.timestamp || 0));
    }

    // 默认折叠：profile 和 prompt 是会话建立时的设定，不是说过的话；何况这个应用每个会话的档位都一样。
    renderContextStrip() {
        const profile = this.selectedSession.profile;
        const prompt = this.selectedSession.customPrompt;
        if (!profile && !prompt) return '';

        const hint = [profile && 'profile', prompt && 'prompt'].filter(Boolean).join(' · ');
        return html`
            <div class="context-strip">
                <button
                    class="context-toggle"
                    @click=${() => {
                        this.showContext = !this.showContext;
                    }}
                >
                    <span>${this.showContext ? '▾' : '▸'} Context</span>
                    <span>${hint}</span>
                </button>
                ${
                    this.showContext
                        ? html`
                              <div class="context-body">
                                  ${
                                      profile
                                          ? html`
                                                <div class="context-row">
                                                    <span class="context-key">Profile</span>
                                                    <span class="context-value">${this.getProfileNames()[profile] || profile}</span>
                                                </div>
                                            `
                                          : ''
                                  }
                                  ${
                                      prompt
                                          ? html`
                                                <div class="context-row">
                                                    <span class="context-key">Prompt</span>
                                                    <span class="context-value">${prompt}</span>
                                                </div>
                                            `
                                          : ''
                                  }
                              </div>
                          `
                        : ''
                }
            </div>
        `;
    }

    renderTimeline() {
        const rows = this.collectTimeline(this.selectedSession);
        if (!rows.length) return html`<div class="empty">No conversation data.</div>`;
        // 这样轮与轮之间的间距属于时间线本身，而不是 meta 行和它所属气泡之间多出来的那道缝。
        return rows.map(group => html`<div class="turn">${group.parts.map(part => this.renderPart(part))}</div>`);
    }

    // 两侧与实时转录一致：面试官在左，面试者自己的话和助手的回答在右。没有标签，同一问题的两份回答会读成一份
    // 被打断的回答。
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

        const labels = isChinese() ? { brief: '简短回答', detail: '详细回答' } : { brief: 'Brief answer', detail: 'Detailed answer' };
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
                <svg
                    class="search-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                    class="control"
                    type="text"
                    placeholder="Search conversation content..."
                    .value=${this.searchQuery}
                    @input=${this.handleSearchInput}
                />
            </div>

            <section class="list-shell">
                ${this.renderSelectionBar(filteredSessions)}
                <div class="sessions-list">
                    ${this.loading ? html`<div class="empty" style="margin:var(--space-md);">Loading sessions...</div>` : ''}
                    ${!this.loading && filteredSessions.length === 0 ? html`<div class="empty" style="margin:var(--space-md);">No matching sessions.</div>` : ''}
                    ${
                        !this.loading
                            ? filteredSessions.map(
                                  session => html`
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
                                              <span class="session-date"
                                                  >${this.formatDate(session.createdAt)} · ${this.formatTime(session.createdAt)}</span
                                              >
                                          </div>
                                          ${session.messageCount > 0 ? html`<span class="session-badge">${session.messageCount}</span>` : ''}
                                      </div>
                                  `
                              )
                            : ''
                    }
                </div>
            </section>
        `;
    }

    // 只有选中了东西才出现；删除按钮首次点击只是上膛，第二次才是确认。没有单独的对话框要退出——对一个浮在所有
    // 窗口之上的窗口来说，这点很重要。
    renderSelectionBar(filteredSessions) {
        if (!this.selectedIds.length) return '';

        const count = this.selectedIds.length;
        const allSelected = filteredSessions.length > 0 && filteredSessions.every(session => this.isSelected(session.sessionId));

        return html`
            <div class="selection-bar">
                ${
                    this.confirmingDelete
                        ? html`<span class="selection-count danger"
                              >${isChinese() ? `删除 ${count} 个会话？此操作无法撤销。` : `Delete ${count} session${count === 1 ? '' : 's'}? This cannot be undone.`}</span
                          >`
                        : html`<span class="selection-count">${isChinese() ? `已选择 ${count} 个` : `${count} selected`}</span>`
                }
                <div class="bar-actions">
                    ${
                        this.confirmingDelete
                            ? html`
                                  <button
                                      class="bar-btn"
                                      @click=${() => {
                                          this.confirmingDelete = false;
                                      }}
                                  >
                                      Cancel
                                  </button>
                                  <button class="bar-btn danger" @click=${this.deleteSelected}>Delete</button>
                              `
                            : html`
                                  <button class="bar-btn" @click=${() => this.toggleSelectAll(filteredSessions)}>
                                      ${allSelected ? 'Deselect all' : 'Select all'}
                                  </button>
                                  <button class="bar-btn" @click=${this.clearSelection}>Clear</button>
                                  <button class="bar-btn" @click=${this.exportSelected}>Export JSON</button>
                                  <button
                                      class="bar-btn danger"
                                      @click=${() => {
                                          this.confirmingDelete = true;
                                      }}
                                  >
                                      Delete
                                  </button>
                              `
                    }
                </div>
            </div>
        `;
    }

    renderDetailView() {
        return html`
            <div class="page-title">Session Detail</div>
            <div class="detail-top">
                <button class="back-btn" @click=${this.closeSession}>
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <polyline points="15 18 9 12 15 6" />
                    </svg>
                </button>
                <span class="detail-info"
                    >${this._getProfileLabel(this.selectedSession)} · ${this.formatDate(this.selectedSession.createdAt)} ·
                    ${this.formatTime(this.selectedSession.createdAt)}</span
                >
            </div>
            <section class="details-scroll">${this.renderContextStrip()} ${this.renderTimeline()}</section>
        `;
    }

    render() {
        return html`
            <div class="unified-page">
                ${this.statusMessage ? html`<div class="page-toast ${this.statusType}" role="status">${this.statusMessage}</div>` : ''}
                <div class="unified-wrap">${this.selectedSession ? this.renderDetailView() : this.renderListView()}</div>
            </div>
        `;
    }
}

customElements.define('history-view', HistoryView);
