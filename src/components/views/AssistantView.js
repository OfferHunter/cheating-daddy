const { DEFAULT_PREFERENCES } = window.require('./defaults');
import { html, css } from '../../assets/lit-core-2.7.4.min.js';
import { LocalizedLitElement, t } from '../../utils/i18n.js';
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

            /* 左侧导航浮在正文左边,和笔试一样要给它让出 20px,否则短横线会压在气泡上。 */
            .chat-list.with-nav {
                padding-left: 28px;
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
            /* 笔试与面试共用同一颗向下箭头:贴底时淡下去当提示,不在底端时点击回到底端并恢复跟随。 */
            .jump-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 32px;
                height: 32px;
                padding: 0;
                color: var(--text-primary);
                background: var(--bg-elevated);
                border: 1px solid var(--border);
                border-radius: var(--radius-md);
                cursor: pointer;
                transition: opacity 0.15s;
            }

            .jump-btn:hover {
                border-color: var(--accent);
            }

            .jump-btn.at-bottom {
                opacity: 0.35;
            }

            .jump-btn svg {
                width: 16px;
                height: 16px;
            }

            /* 面试时它贴在转录区左下角,和手机提词页的箭头同一个位置。 */
            .chat-jump {
                position: absolute;
                left: 12px;
                bottom: 12px;
                z-index: 2;
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

            /* 笔试:一列长滚动代替翻页。答案之间用满宽的长横线分隔。 */
            .written-shell {
                flex: 1;
                min-height: 0;
                display: flex;
                flex-direction: column;
                position: relative;
            }

            .written-scroll {
                position: relative;
                flex: 1;
                min-width: 0;
                overflow-y: auto;
                /* 左边留出导航条(3px + 20px)的宽度,否则横线会从导航底下穿过去。 */
                padding: var(--space-md) var(--chat-gutter) var(--space-md) 28px;
                font-size: var(--response-font-size, 15px);
                line-height: var(--line-height);
                user-select: text;
                cursor: text;
            }

            /* 笔试与面试的详细列表共用:多条回答连续滚动时用满宽横线分段。 */
            .answer-block + .answer-block {
                margin-top: var(--space-md);
                padding-top: var(--space-md);
                border-top: 1px solid var(--border-strong);
            }

            .written-empty {
                height: 100%;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: var(--space-md);
                text-align: center;
                color: var(--text-muted);
                font-size: var(--font-size-sm);
            }

            /* 错误比「等待题目」更该被看到，所以用危险色并允许长文本换行、选中复制。 */
            .written-empty.error {
                color: var(--danger);
                max-width: 720px;
                margin: 0 auto;
                white-space: pre-wrap;
                overflow-wrap: anywhere;
                user-select: text;
                cursor: text;
            }

            /* 抄自手机提词页的左侧导航:一竖排短横线,悬浮在正文左侧、垂直居中;桌面上整体带透明度,
           免得压住正文。 */
            .written-nav {
                position: absolute;
                left: 3px;
                top: 50%;
                transform: translateY(-50%);
                z-index: 2;
                width: 20px;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: space-between;
                padding: 0;
                overflow: hidden;
                opacity: 0.55;
                transition: opacity 0.15s;
            }

            .written-nav:hover {
                opacity: 1;
            }

            .nav-dash {
                flex: none;
                width: 14px;
                height: 3px;
                padding: 0;
                border: none;
                border-radius: 2px;
                background: var(--text-muted);
                cursor: pointer;
                transition:
                    background 0.15s,
                    width 0.15s;
            }

            .nav-dash:hover {
                background: var(--text-secondary);
            }

            .nav-dash.active {
                width: 18px;
                background: var(--accent);
            }

            .written-actions {
                flex: none;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--space-sm);
                padding: var(--space-md) var(--chat-gutter);
            }

            .written-actions-right {
                display: flex;
                align-items: center;
                gap: var(--space-sm);
            }

            /* 与「截图并发送」同款外观,只是不发送、也没有点击后的波浪动画。 */
            .cache-btn {
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
            }

            .cache-btn:hover:not(:disabled) {
                border-color: var(--accent);
                background: var(--bg-surface);
            }

            .cache-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
        `,
    ];

    static properties = {
        // 'written' 时只剩详细面板，没有转录、分栏和输入栏。
        sessionMode: { type: String },
        // 笔试的暂停开关直接决定空白态那句话是「等待题目」还是「已暂停」。
        paused: { type: Boolean },
        // 笔试空态里的错误条：由 app 元素持有并传入，采集/发送失败时非空。
        writtenError: { type: String },
        // 「截图进入缓存」攒了几张。缓存在渲染端模块里,视图重建后从这里读回来。
        screenshotCacheCount: { type: Number, state: true },
        messages: { type: Array },
        onSendText: { type: Function },
        isAnalyzing: { type: Boolean, state: true },
        // 详细回答以及当前选中的那一条：两者都由 app 元素持有而不是本视图，因为每次导航本视图都会被拆掉重建，而
        // 回答必须活下来——`messages` 放在上层也是同一个原因。
        detailMessages: { type: Array },
        detailCurrent: { type: Number },
        // 用户在本视图里滚到某条详细回答时回报给 app，让翻页快捷键从眼前这一条继续走。
        onDetailFocus: { type: Function },
    };

    constructor() {
        super();
        this.sessionMode = 'interview';
        this.paused = false;
        this.writtenError = '';
        this.screenshotCacheCount = 0;
        // 笔试的长滚动:贴底时跟着新 token 走;用户往上翻后就不再拽回去。导航高亮跟着滚动位置走。
        this._writtenPinned = true;
        this._writtenActive = 0;
        this._writtenCount = 0;
        this.messages = [];
        this.onSendText = () => {};
        this.isAnalyzing = false;
        this.detailMessages = [];
        this.detailCurrent = null;
        this.onDetailFocus = () => {};
        this._animFrame = null;
        this._pinned = true;
        // 面试长滚动:左侧转录与右侧详细列表各记一个阅读位置,用 turnSeq 对齐后互相带动。
        this._chatActive = 0;
        this._detailActive = 0;
        this._detailCount = 0;
        this._detailAtBottom = true;
        // 程序化滚动另一栏时置上,免得它的 scroll 处理器又反过来推回去,滚成一个环。
        this._peerSyncLock = false;
        // 最近一次经本视图回报的详细回答 id,用来区分「用户滚到这里」和「快捷键选中了另一条」。
        this._lastReportedDetailId = null;
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

    // 详细面板现在是长滚动:每条回答一个容器,所以像笔试那样一次同步全部,不能搭 _syncMarkdown 的便车
    // (它遍历的 this.messages 里根本没有详细回答)。
    _syncDetailListMarkdown() {
        for (const row of this.detailMessages) {
            const el = this.shadowRoot.querySelector(`.detail-answer[data-detail-id="${row.detailId}"] .detail-body`);
            syncMarkdownInto(el, `${row.detailId}:${row.text}`, row.text);
        }
    }

    // 笔试是长滚动:每条回答都有自己的 markdown 容器,一次同步全部。_renderedKey 仍然让没变的行不重解析。
    _syncWrittenMarkdown() {
        for (const row of this.detailMessages) {
            const el = this.shadowRoot.querySelector(`[data-written-id="${row.detailId}"]`);
            syncMarkdownInto(el, `${row.detailId}:${row.text}`, row.text);
        }
    }

    // 和手机端的导航规则一致:落在谁的地界里就点亮谁;滚到底时点亮最后一条,即使它顶不到最上沿。
    handleWrittenScroll() {
        const container = this.shadowRoot.querySelector('.written-scroll');
        if (!container) return;

        const pinned = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
        // 贴底状态同时决定向下箭头的浓淡,所以它的变化也要触发重渲;只在导航高亮变了才渲会让箭头停在旧样子。
        const pinnedChanged = pinned !== this._writtenPinned;
        this._writtenPinned = pinned;

        const top = container.scrollTop;
        const maxTop = container.scrollHeight - container.clientHeight;
        let active = 0;
        if (maxTop > 0 && top >= maxTop - 2) {
            active = this.detailMessages.length - 1;
        } else {
            container.querySelectorAll('.written-answer').forEach((node, index) => {
                if (node.offsetTop <= top + 8) active = index;
            });
        }

        if (active !== this._writtenActive || pinnedChanged) {
            this._writtenActive = active;
            this.requestUpdate();
        }
    }

    _scrollWrittenToBottom() {
        const container = this.shadowRoot.querySelector('.written-scroll');
        if (container) container.scrollTop = container.scrollHeight;
    }

    // 向下箭头:回到底端并恢复跟随,之后的流式 token 会继续把视图带走。
    _jumpWrittenToBottom() {
        this._writtenPinned = true;
        this._writtenActive = Math.max(0, this.detailMessages.length - 1);
        this._scrollWrittenToBottom();
        this.requestUpdate();
    }

    _jumpToWritten(index) {
        const container = this.shadowRoot.querySelector('.written-scroll');
        const node = container?.querySelectorAll('.written-answer')[index];
        if (!container || !node) return;
        // 跳转即停止跟随,否则下一批 token 又把人拽回末尾。
        this._writtenActive = index;
        container.scrollTop = node.offsetTop;
        // 内容不足一屏时 scrollTop 会被夹到 0,此刻其实就贴底;按真实位置算,箭头才不会停成「可下拉」的样子。
        this._writtenPinned = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
        this.requestUpdate();
    }

    // 与手机端同一条间距规则:先按固定间距排,总长超过视口 1/3 就压到 1/3。笔试与面试共用。
    _navHeight(count) {
        const natural = count * 3 + Math.max(0, count - 1) * 8;
        return Math.min(natural, Math.round(window.innerHeight / 3));
    }

    // 转录里的「轮次」= 一条带 turnId 的面试官消息(截图那行没有 turnId,用它的 blockId)。详细回答的 turnSeq
    // 与它们是同一个计数器,所以这个 seq 就是左右两栏对齐的钥匙。
    _turnSeqOf(message) {
        if (message.role !== 'interviewer') return null;
        return message.turnId ?? message.blockId ?? null;
    }

    _interviewTurns() {
        return this.messages
            .map(message => ({ seq: this._turnSeqOf(message) }))
            .filter(turn => turn.seq !== null);
    }

    _hasInterviewNav() {
        return this.messages.some(message => this._turnSeqOf(message) !== null);
    }

    // 元素相对滚动容器内容顶部的偏移。用 rect 相减而不是 offsetTop:offsetParent 可能是外层 flex 壳,
    // 内边距一改就对不上。
    _offsetWithin(container, node) {
        return node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    }

    // 与手机端同一条高亮规则:滚动位置落在谁的地界里就点亮谁;滚到底时点亮最后一条,即使它顶不到最上沿。
    _activeIndex(container, nodes) {
        const top = container.scrollTop;
        const maxTop = container.scrollHeight - container.clientHeight;
        if (maxTop > 0 && top >= maxTop - 2) return nodes.length - 1;

        let active = 0;
        nodes.forEach((node, index) => {
            if (this._offsetWithin(container, node) <= top + 8) active = index;
        });
        return active;
    }

    // 程序化滚动另一栏后短暂上锁,免得它的 scroll 事件又反过来把这一栏推走。rAF 足够覆盖同一帧里的派发。
    _lockPeerSync() {
        this._peerSyncLock = true;
        requestAnimationFrame(() => {
            this._peerSyncLock = false;
        });
    }

    _reportDetailFocus(detailId) {
        if (this._lastReportedDetailId === detailId) return;
        this._lastReportedDetailId = detailId;
        this.onDetailFocus?.(detailId);
    }

    // 转录滚动:更新高亮与贴底状态;用户往回翻时让右侧详细面板跟到同一轮。贴底时不联动——流式 token 每来
    // 一批都会把转录瞬移到底部,跟着联动会不断把详细面板拽回最后一轮的开头。
    handleScroll() {
        const container = this.shadowRoot.querySelector('.chat-scroll');
        if (!container) return;

        const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
        let changed = atBottom !== this._pinned;
        this._pinned = atBottom;

        const turns = [...container.querySelectorAll('.turn-marker')];
        if (turns.length) {
            const active = this._activeIndex(container, turns);
            if (active !== this._chatActive) {
                this._chatActive = active;
                changed = true;
            }
            if (!this._peerSyncLock && !atBottom) {
                this._syncDetailToTurn(Number(turns[active].dataset.turnSeq));
            }
        }

        if (changed) this.requestUpdate();
    }

    _scrollToBottom() {
        const container = this.shadowRoot.querySelector('.chat-scroll');
        if (container) {
            container.scrollTop = container.scrollHeight;
        }
    }

    // 详细列表滚动:更新当前条与贴底状态;用户往回翻时把转录带到对应轮次,并回报给 app 供快捷键接续。
    handleDetailScroll() {
        const container = this.shadowRoot.querySelector('.detail-scroll');
        if (!container) return;

        const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
        let changed = atBottom !== this._detailAtBottom;
        this._detailAtBottom = atBottom;

        const rows = [...container.querySelectorAll('.detail-answer')];
        if (!rows.length) {
            if (changed) this.requestUpdate();
            return;
        }

        const active = this._activeIndex(container, rows);
        if (active !== this._detailActive) {
            this._detailActive = active;
            changed = true;
        }

        if (!this._peerSyncLock && !atBottom) {
            const row = rows[active];
            this._syncChatToTurn(Number(row.dataset.detailTurn));
            this._reportDetailFocus(Number(row.dataset.detailId));
        }

        if (changed) this.requestUpdate();
    }

    _scrollDetailToBottom() {
        const container = this.shadowRoot.querySelector('.detail-scroll');
        if (container) container.scrollTop = container.scrollHeight;
    }

    // 左侧滚到哪一轮,右侧就贴到同一轮的详细回答顶部;详细回答还没到(晚于转录)就贴底。
    _syncDetailToTurn(seq) {
        const container = this.shadowRoot.querySelector('.detail-scroll');
        if (!container || !this.detailMessages.length) return;

        const rows = [...container.querySelectorAll('.detail-answer')];
        const target = rows.find(row => Number(row.dataset.detailTurn) === seq);
        this._lockPeerSync();
        container.scrollTop = target ? this._offsetWithin(container, target) : container.scrollHeight;
        // 同步更新贴底标记:下一次重渲若还当它贴着底,又会把人拽回列表末尾。
        this._detailAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;

        if (!target) return;
        const index = rows.indexOf(target);
        if (index !== -1 && index !== this._detailActive) {
            this._detailActive = index;
            this.requestUpdate();
        }
        this._reportDetailFocus(Number(target.dataset.detailId));
    }

    // 右侧滚到哪一轮,左侧就贴到那道问题;没有对应问题(理论上截图轮也有)就不动。
    _syncChatToTurn(seq) {
        const container = this.shadowRoot.querySelector('.chat-scroll');
        const node = container?.querySelector(`.turn-marker[data-turn-seq="${seq}"]`);
        if (!container || !node) return;

        this._lockPeerSync();
        container.scrollTop = this._offsetWithin(container, node);
        this._pinned = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
        const turns = [...container.querySelectorAll('.turn-marker')];
        const index = turns.indexOf(node);
        if (index !== -1 && index !== this._chatActive) {
            this._chatActive = index;
            this.requestUpdate();
        }
    }

    // 快捷键选中一条详细回答:右侧滚到它,左侧跟到同一轮。
    _scrollDetailToRow(detailId, syncChat = true) {
        const container = this.shadowRoot.querySelector('.detail-scroll');
        const target = container?.querySelector(`.detail-answer[data-detail-id="${detailId}"]`);
        if (!container || !target) return;

        const rows = [...container.querySelectorAll('.detail-answer')];
        const index = rows.indexOf(target);
        this._lockPeerSync();
        container.scrollTop = this._offsetWithin(container, target);
        this._detailAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
        if (index !== -1) {
            this._detailActive = index;
            const seq = Number(target.dataset.detailTurn);
            if (syncChat && seq) this._syncChatToTurn(seq);
        }
        this.requestUpdate();
    }

    // 点左侧导航:两栏一起跳到同一轮。跳转即停止跟随,否则下一批流式 token 又把人拽回末尾。
    _jumpToTurn(seq, index) {
        const container = this.shadowRoot.querySelector('.chat-scroll');
        const node = container?.querySelector(`.turn-marker[data-turn-seq="${seq}"]`);
        if (!container || !node) return;

        this._pinned = false;
        this._chatActive = index;
        container.scrollTop = this._offsetWithin(container, node);
        this._syncDetailToTurn(seq);
        // 内容不足一屏时 scrollTop 会被夹住,此刻其实就贴底;按真实位置重算,箭头才不会停成「可下拉」的样子。
        this._pinned = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
        this.requestUpdate();
    }

    // 左侧底部的向下箭头:两栏一起回到底端并恢复跟随。
    _jumpInterviewToBottom() {
        this._pinned = true;
        this._detailAtBottom = true;
        this._chatActive = Math.max(0, this._interviewTurns().length - 1);
        this._detailActive = Math.max(0, this.detailMessages.length - 1);
        this._lockPeerSync();
        this._scrollToBottom();
        this._scrollDetailToBottom();
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

        this.handleScrollUp = () => this.scrollResponseUp();
        this.handleScrollDown = () => this.scrollResponseDown();
        this.handleCacheShortcut = () => this.handleScreenshotToCache();

        ipcRenderer.on('scroll-response-up', this.handleScrollUp);
        ipcRenderer.on('scroll-response-down', this.handleScrollDown);
        ipcRenderer.on('cache-screenshot', this.handleCacheShortcut);
        // 视图会被导航重建,缓存活在渲染端模块里,重建时把已有张数读回来。
        this.screenshotCacheCount = window.getScreenshotCacheCount?.() ?? 0;
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._stopWaveformAnimation();

        if (this.handleScrollUp) ipcRenderer.removeListener('scroll-response-up', this.handleScrollUp);
        if (this.handleScrollDown) ipcRenderer.removeListener('scroll-response-down', this.handleScrollDown);
        if (this.handleCacheShortcut) ipcRenderer.removeListener('cache-screenshot', this.handleCacheShortcut);
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
        // 成功发送后渲染端会清空缓存;失败时保留,这里都按实际张数刷新。
        this.screenshotCacheCount = window.getScreenshotCacheCount?.() ?? 0;
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

    // 只抓当前屏放进缓存，不发请求。长题目分几屏时先攒前几屏，最后一次「截图并发送」带上。
    async handleScreenshotToCache() {
        if (this.isAnalyzing || !window.captureScreenshotToCache) return;
        const result = await window.captureScreenshotToCache();
        if (result && typeof result.count === 'number') {
            this.screenshotCacheCount = result.count;
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

    // 面试长滚动的每帧收尾:同步 markdown、贴底跟随,并把快捷键选中的回答滚进视野。
    _syncInterview(changedProperties) {
        this._syncMarkdown();
        this._syncDetailListMarkdown();

        // 用瞬移而不是平滑滚动：每个 token 触发一次平滑滚动永远追不上自己，还会和上一次动画互相打断。
        if (this._pinned) this._scrollToBottom();

        const rows = this.detailMessages;
        if (this._detailCount !== rows.length) {
            this._detailCount = rows.length;
            if (!rows.length) {
                this._detailActive = 0;
                this._detailAtBottom = true;
            } else if (this._detailAtBottom) {
                const last = rows[rows.length - 1];
                // 还在流式的回答跟随底部；整条到达的完成回答停在开头，和以前「已完成就回到顶部」一致。
                // 新行不联动左侧:转录此时已经贴底，拽到问题顶部反而把最新内容挤出视野。
                if (last.final) this._scrollDetailToRow(last.detailId, false);
                else this._scrollDetailToBottom();
                this._detailActive = rows.length - 1;
            }
        } else if (this._detailAtBottom) {
            this._scrollDetailToBottom();
        }

        // 翻页快捷键变成「滚到上一条/下一条详细回答」：app 只改 detailCurrent，这里负责把它滚进视野。
        // 本视图上报过的滚动不算，否则用户每滚一下都会被拽回同一条的顶部。
        if (changedProperties.has('detailCurrent') && this.detailCurrent !== null && this.detailCurrent !== this._lastReportedDetailId) {
            this._scrollDetailToRow(this.detailCurrent);
        }
    }

    updated(changedProperties) {
        super.updated(changedProperties);

        // 笔试长滚动和面试分栏的滚动语义不同,分开处理,免得一方的贴底判断改到另一方的状态。
        if (this.sessionMode === 'written') {
            this._syncWrittenMarkdown();
            const count = this.detailMessages.length;
            if (count !== this._writtenCount) {
                this._writtenCount = count;
                if (this._writtenPinned) this._writtenActive = Math.max(0, count - 1);
            }
            // 用瞬移而不是平滑滚动:每个 token 触发一次平滑滚动永远追不上自己。
            if (this._writtenPinned) this._scrollWrittenToBottom();
        } else {
            this._syncInterview(changedProperties);
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
            // 带轮次序号的行是左右两栏联动的锚点:turnId 来自普通提问,blockId 来自截图那行。
            const seq = this._turnSeqOf(message);
            return html`
                <div class="message-row interviewer ${seq !== null ? 'turn-marker' : ''}" data-turn-seq=${seq ?? ''}>
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

    // 面试的详细面板改成连续长滚动:所有回答按顺序排开,不再一次只显示一条、用 ‹ › 翻页。
    renderDetailAnswer(row) {
        const notes = [];
        if (row.usedKnowledge && row.usedKnowledge.length) {
            notes.push(html`<div class="detail-note">Reference: ${row.usedKnowledge.join(', ')}</div>`);
        }
        if (row.truncated) {
            notes.push(html`<div class="detail-note">Answer cut off at the length limit</div>`);
        }
        if (row.error) {
            notes.push(html`<div class="detail-note danger">${row.error}</div>`);
        }

        return html`
            <div class="detail-answer answer-block" data-detail-id=${row.detailId} data-detail-turn=${row.turnSeq ?? ''}>
                ${row.question ? html`<div class="detail-question">${row.question}</div>` : ''}
                <div class="detail-body message-body markdown ${row.final ? '' : 'streaming'}"></div>
                ${notes}
            </div>
        `;
    }

    renderDetailPane() {
        const rows = this.detailMessages;
        if (!rows.length) return html``;

        return html`
            <div class="detail-head">
                <span>Detailed</span>
                <span>${Math.min(this._detailActive + 1, rows.length)} / ${rows.length}</span>
            </div>

            <div class="detail-scroll" @scroll=${this.handleDetailScroll}>${rows.map(row => this.renderDetailAnswer(row))}</div>
        `;
    }

    // 笔试只显示答案:固定问句、图片概括和编号都不渲染,多段答案靠 CSS 的长横线分隔。
    renderWrittenAnswer(row) {
        return html`
            <div class="written-answer answer-block">
                <div class="detail-body message-body markdown ${row.final ? '' : 'streaming'}" data-written-id=${row.detailId}></div>
                ${row.truncated ? html`<div class="detail-note">Answer cut off at the length limit</div>` : ''}
                ${row.error ? html`<div class="detail-note danger">${row.error}</div>` : ''}
            </div>
        `;
    }

    // 左侧导航:一道问题一根短横线,和手机提词页同一套样式。条数来自转录里带轮次序号的行。
    renderInterviewNav() {
        const turns = this._interviewTurns();
        if (!turns.length) return html``;

        return html`
            <nav class="written-nav" style="height:${this._navHeight(turns.length)}px" aria-label=${t('Turns', '轮次')}>
                ${turns.map(
                    (turn, index) => html`
                        <button
                            type="button"
                            class="nav-dash ${index === this._chatActive ? 'active' : ''}"
                            @click=${() => this._jumpToTurn(turn.seq, index)}
                        ></button>
                    `
                )}
            </nav>
        `;
    }

    // 笔试没有转录、分栏和输入栏:一列长滚动答案 + 左侧导航 + 底部截图按钮。
    renderWritten() {
        const rows = this.detailMessages;

        return html`
            <div class="written-shell">
                <div class="written-scroll" @scroll=${this.handleWrittenScroll}>
                    ${
                        rows.length === 0
                            ? html`<div class="written-empty ${this.writtenError ? 'error' : ''}">
                                  ${this.writtenError
                                      ? this.writtenError
                                      : this.paused
                                        ? t('Auto screenshot paused', '自动截图已暂停')
                                        : t('Waiting for the written question...', '正在等待笔试题目…')}
                              </div>`
                            : rows.map(row => this.renderWrittenAnswer(row))
                    }
                </div>

                ${
                    rows.length
                        ? html`
                              <nav class="written-nav" style="height:${this._navHeight(rows.length)}px" aria-label=${t('Answers', '回答')}>
                                  ${rows.map(
                                      (row, index) => html`
                                          <button
                                              type="button"
                                              class="nav-dash ${index === this._writtenActive ? 'active' : ''}"
                                              @click=${() => this._jumpToWritten(index)}
                                          ></button>
                                      `
                                  )}
                              </nav>
                          `
                        : ''
                }

                <div class="written-actions">
                    <button
                        type="button"
                        class="written-jump jump-btn ${this._writtenPinned ? 'at-bottom' : ''}"
                        aria-label=${t('Jump to latest', '跳到最新')}
                        @click=${() => this._jumpWrittenToBottom()}
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <path d="M6 9l6 6 6-6" />
                        </svg>
                    </button>
                    <div class="written-actions-right">
                        ${this.renderCacheButton()}
                        ${this.renderScreenshotSendButton()}
                    </div>
                </div>
            </div>
        `;
    }

    renderCacheButton() {
        return html`
            <button class="cache-btn" ?disabled=${this.isAnalyzing} @click=${this.handleScreenshotToCache}>
                <span class="analyze-btn-content">
                    ${t('Screenshot to cache', '截图进入缓存')}${this.screenshotCacheCount ? ` (${this.screenshotCacheCount})` : ''}
                </span>
            </button>
        `;
    }

    renderScreenshotSendButton() {
        return html`
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
                    ${t('Screenshot & send', '截图并发送')}
                </span>
            </button>
        `;
    }

    render() {
        if (this.sessionMode === 'written') return this.renderWritten();

        // 拖拽未松手时宽度归指针管：否则流式回答引发的那次重渲会把分隔条弹回原位，和指针打架。
        const paneWidth = `${((this._splitDrag?.fraction ?? paneFraction) * 100).toFixed(1)}%`;

        return html`
            <div class="live-split">
                <div class="chat-wrap">
                    <div class="chat-scroll" @scroll=${this.handleScroll}>
                        ${
                            this.messages.length === 0
                                ? html`<div class="chat-empty">Listening to the interview...</div>`
                                : html`<div class="chat-list ${this._hasInterviewNav() ? 'with-nav' : ''}">
                                      ${this.messages.map(message => this.renderMessage(message))}
                                  </div>`
                        }
                    </div>

                    ${this.renderInterviewNav()}

                    <button
                        type="button"
                        class="chat-jump jump-btn ${this._pinned ? 'at-bottom' : ''}"
                        aria-label=${t('Jump to latest', '跳到最新')}
                        @click=${() => this._jumpInterviewToBottom()}
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <path d="M6 9l6 6 6-6" />
                        </svg>
                    </button>
                </div>

                <div
                    class="split-handle"
                    ?hidden=${this.detailMessages.length === 0}
                    role="separator"
                    aria-orientation="vertical"
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
                ${this.renderCacheButton()}
                ${this.renderScreenshotSendButton()}
            </div>
        `;
    }
}

customElements.define('assistant-view', AssistantView);
