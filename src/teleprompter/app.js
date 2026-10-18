// 手机提词页。独立浏览器上下文,拿不到 Electron 的 window.require,所以一切自包含:本地文案表、
// 自己的 markdown 调用(靠 /marked.min.js 挂在 window.marked 上)、自己的重连与跟随逻辑。
'use strict';

const TOKEN_KEY = 'offerHunterTeleprompterToken';
// 问题与回答各存一个字号。旧版只有一个 offerHunterTeleprompterFontSize,读到时当两边的初始值,升级不丢。
const QUESTION_FONT_KEY = 'offerHunterTeleprompterQuestionFont';
const ANSWER_FONT_KEY = 'offerHunterTeleprompterAnswerFont';
const LEGACY_FONT_KEY = 'offerHunterTeleprompterFontSize';
// 默认取滑块最小档:提词时字号小一点,一屏能多放几轮,需要更大再自己调。
const DEFAULT_FONT = 12;
// 「兼有」档(左右两栏同时铺开)的记忆,以及右栏占整宽的比例(对齐电脑端 detailPaneWidth 的做法)。
const SPLIT_KEY = 'offerHunterTeleprompterSplit';
const SPLIT_FRACTION_KEY = 'offerHunterTeleprompterSplitFraction';
// 只带问题、还没被回答收养的占位块用这个 id。收养那一刻它会被换成答案真正的 id。
const OPEN_ID = '__open_question__';

const STRINGS = {
    zh: {
        pairTitle: '连接桌面端',
        pairHint: '在桌面端「设置 → 手机提词」查看地址与 6 位配对码',
        pairBtn: '配对',
        badCode: '配对码不正确',
        locked: '尝试次数过多，请等待 30 秒后重试',
        networkError: '连接失败，请确认手机与电脑在同一网络',
        modeBrief: '精要',
        modeDetail: '详细',
        modeBoth: '兼有',
        online: '已连接',
        offline: '重连中',
        waiting: '等待面试开始…',
        waitingWritten: '等待笔试题目…',
        detailError: '（详细回答生成失败）',
        qLabel: '问',
        settingsTitle: '设置',
        questionFontLabel: '问题字体大小',
        answerFontLabel: '回答字体大小',
        fontSampleQuestion: '这是问题示例',
        fontSampleAnswer: '这是回答示例',
        shotBtn: '截图',
        shotSendBtn: '截图并发送',
        cacheBtn: '截图进入缓存',
        shotQuestion: '截图',
    },
    en: {
        pairTitle: 'Connect to desktop',
        pairHint: 'Find the address and 6-digit code under Settings → Phone teleprompter on the desktop app',
        pairBtn: 'Pair',
        badCode: 'Wrong code',
        locked: 'Too many attempts. Try again in 30 seconds.',
        networkError: 'Could not reach the desktop. Make sure both devices share the same network.',
        modeBrief: 'Brief',
        modeDetail: 'Detailed',
        modeBoth: 'Both',
        online: 'Connected',
        offline: 'Disconnected, reconnecting…',
        waiting: 'Waiting for the session to start…',
        waitingWritten: 'Waiting for the written question…',
        detailError: '(detailed answer failed)',
        qLabel: 'Q',
        settingsTitle: 'Settings',
        questionFontLabel: 'Question font size',
        answerFontLabel: 'Answer font size',
        fontSampleQuestion: 'This is a question',
        fontSampleAnswer: 'This is an answer',
        shotBtn: 'Screenshot',
        shotSendBtn: 'Screenshot & send',
        cacheBtn: 'Screenshot to cache',
        shotQuestion: 'Screenshot',
    },
};

const langFromLocale = code => (String(code || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
let lang = langFromLocale(navigator.language);
let S = STRINGS[lang];

const state = {
    screen: 'pair',
    // 桌面端当前会话的类型。笔试页没有精要/详细之分:一列回答、不显示问题、暂停键管的是自动截图。
    sessionMode: 'interview',
    answerMode: 'brief',
    // 是否贴在最新底端。用户滚上去就翻成 false,新内容便不再把他拽回去;滚回/点箭头到底端又翻回 true。
    following: true,
    // 桌面音源是否暂停。桌面每换一次状态都会用 update-status 播报,这里跟着它走,不自己当权威。
    paused: false,
    // 是否「兼有」:左右两栏同时铺开。由顶栏三档滑块的第三档控制;单栏时看精要还是详细由 answerMode 决定。
    split: readSplit(),
    authed: false,
    token: readToken(),
    briefs: [],
    details: [],
    pendingQuestion: '',
    // 当前这个问题是否已经收到 transcription-final。定稿之后再来新文本,就说明是下一轮提问了。
    pendingQuestionFinal: false,
    // 是否正在重放最近事件(auth-ok 之后的一组)。重放不重建占位块,只补已有块。
    replaying: false,
};

const dom = {
    pairing: document.getElementById('pairing'),
    stage: document.getElementById('stage'),
    settings: document.getElementById('settings'),
    code: document.getElementById('code'),
    pairBtn: document.getElementById('pairBtn'),
    pairError: document.getElementById('pairError'),
    feed: document.getElementById('feed'),
    conn: document.getElementById('conn'),
    refreshBtn: document.getElementById('refreshBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    endBtn: document.getElementById('endBtn'),
    splitView: document.getElementById('splitView'),
    feedBrief: document.getElementById('feedBrief'),
    feedDetail: document.getElementById('feedDetail'),
    splitHandle: document.getElementById('splitHandle'),
    nav: document.getElementById('nav'),
    modeBrief: document.getElementById('modeBrief'),
    modeDetail: document.getElementById('modeDetail'),
    modeBoth: document.getElementById('modeBoth'),
    settingsBtn: document.getElementById('settingsBtn'),
    settingsBack: document.getElementById('settingsBack'),
    questionRange: document.getElementById('questionRange'),
    questionValue: document.getElementById('questionValue'),
    answerRange: document.getElementById('answerRange'),
    answerValue: document.getElementById('answerValue'),
    shotBtn: document.getElementById('shotBtn'),
    shotLabel: document.getElementById('shotLabel'),
    shotSendLabel: document.getElementById('shotSendLabel'),
    cacheBtn: document.getElementById('cacheBtn'),
    scrollBtn: document.getElementById('scrollBtn'),
};

const isWritten = () => state.sessionMode === 'written';

const esc = value =>
    String(value ?? '').replace(
        /[&<>"]/g,
        char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]
    );

function readToken() {
    try {
        return localStorage.getItem(TOKEN_KEY) || '';
    } catch {
        return '';
    }
}

function saveToken(token) {
    state.token = token;
    try {
        localStorage.setItem(TOKEN_KEY, token);
    } catch {
        // 隐私模式下写不进去:本次仍可用,刷新后需重新配对。
    }
}

function clearToken() {
    state.token = '';
    try {
        localStorage.removeItem(TOKEN_KEY);
    } catch {
        // 同上。
    }
}

function md(text) {
    if (window.marked) {
        try {
            // sanitize:true 把裸 HTML 转义、清掉 javascript: 类 URL：回答是模型输出，这里又直接 innerHTML，
            // 不消毒就是一条现成的 XSS 通道；手机页虽无 node 权限，但能窃取配对令牌。silent 抑制废弃警告。
            window.marked.setOptions({ breaks: true, gfm: true, sanitize: true, silent: true });
            return window.marked.parse(text || '');
        } catch {
            return esc(text);
        }
    }
    return esc(text);
}

// ---------- 配对 ----------

function localize() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (S[key]) el.textContent = S[key];
    });
    setConn('offline');
}

// 语言以桌面端设置为准:那是用户在应用里明确选过的,比手机系统语言更能代表他想读什么。配对响应带回
// uiLanguage,取到就切过去;取不到仍用 navigator.language(启动时已按它渲染过一遍)。
function applyLang(code) {
    const next = langFromLocale(code);
    if (next === lang) return;
    lang = next;
    S = STRINGS[lang];
    localize();
}

function showPairing() {
    state.screen = 'pair';
    dom.pairing.hidden = false;
    dom.stage.hidden = true;
}

function showStage() {
    state.screen = 'stage';
    dom.pairing.hidden = true;
    dom.stage.hidden = false;
    rebuild();
}

function showPairError(message) {
    dom.pairError.textContent = message;
    dom.pairError.hidden = false;
}

async function tryPair(code) {
    dom.pairBtn.disabled = true;
    dom.pairError.hidden = true;
    try {
        const response = await fetch('/api/pair', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code }),
        });

        if (response.ok) {
            const { token, lang: serverLang } = await response.json();
            saveToken(token);
            applyLang(serverLang);
            showStage();
            connect();
            keepAwake();
            return;
        }

        const body = await response.json().catch(() => ({}));
        showPairError(response.status === 429 || body.error === 'locked' ? S.locked : S.badCode);
    } catch {
        showPairError(S.networkError);
    } finally {
        dom.pairBtn.disabled = false;
    }
}

// ---------- 连接 ----------

let socket = null;
let reconnectTimer = null;
let authTimer = null;

function setConn(status) {
    dom.conn.textContent = status === 'online' ? S.online : S.offline;
    dom.conn.className = `conn ${status}`;
}

function connect() {
    if (!state.token || state.screen !== 'stage') return;

    clearTimeout(reconnectTimer);
    setConn('offline');

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}`);

    socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'auth', token: state.token }));
        // 服务端始终没认这个令牌(配置被清过、令牌被重新生成)就丢掉本地令牌回到配对页,而不是无限重连空等。
        authTimer = setTimeout(() => {
            if (state.authed) return;
            clearToken();
            socket.close();
            showPairing();
        }, 5000);
    };

    socket.onmessage = event => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }

        if (message.type === 'auth-ok') {
            state.authed = true;
            clearTimeout(authTimer);
            setConn('online');
            return;
        }
        if (message.type === 'replay-start') {
            state.replaying = true;
            return;
        }
        if (message.type === 'replay-end') {
            state.replaying = false;
            return;
        }
        if (message.channel) applyEvent(message);
    };

    socket.onclose = () => {
        state.authed = false;
        setConn('offline');
        scheduleReconnect();
    };

    socket.onerror = () => {};
}

function scheduleReconnect() {
    if (state.screen !== 'stage' || !state.token) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1500);
}

// 手机上点了需要桌面动手的按钮时走这里。没连上就静默丢弃:指令没有补发语义,重连后再点一次即可。
function sendCommand(action) {
    if (!socket || socket.readyState !== WebSocket.OPEN || !state.authed) return;
    socket.send(JSON.stringify({ type: 'command', action }));
}

// ---------- 数据合并 ----------

function findEntry(mode, id) {
    const list = mode === 'brief' ? state.briefs : state.details;
    return list.find(entry => entry.id === id);
}

// 截图那一轮在手机的精要里单开一块:按轮次 id(turnSeq)寻址,和普通轮次同一套 id 空间。问题行用固定标签
// (图里问的是什么由摘要负责,那块不进这里);直接建立而不是走 claimEntry 收养,免得顶替掉旁边还开着的提问占位块。
function upsertScreenshotBrief(turnSeq, text, final, error) {
    // 笔试页直接把详细列表当正文显示,截图回答跟普通回答一样落在那里;再并进精要就会重复一份。
    if (isWritten() || turnSeq == null) return;
    const id = String(turnSeq);
    let entry = findEntry('brief', id);
    if (!entry) {
        entry = { id, question: S.shotQuestion, text: '', final: false, error: false, open: false, questionFinal: true };
        state.briefs.push(entry);
    }
    if (text != null) entry.text = text;
    if (final) entry.final = true;
    if (error) entry.error = true;
    updateBlock('brief', entry);
}

function upsertEntry(mode, id, text, question) {
    const list = mode === 'brief' ? state.briefs : state.details;
    let entry = list.find(candidate => candidate.id === id);
    if (!entry) {
        entry = { id, question: question || '', text: '', final: false, error: false, open: false, questionFinal: true };
        list.push(entry);
    } else if (question && !entry.question) {
        entry.question = question;
    }
    entry.text = text;
    return entry;
}

// 回答到达时优先收养刚流式出来的问题占位块——它本来就是这个问题的块,复用后问题不会先消失再重画一遍。
// 收养只是把占位块的 id 换成答案的 id,并把 blockEls 里的键一起挪过去,同一个 DOM 节点留在原地。
function claimEntry(mode, id, text, question) {
    const list = mode === 'brief' ? state.briefs : state.details;
    const existing = list.find(candidate => candidate.id === id);
    if (existing) {
        existing.text = text;
        if (question && !existing.question) existing.question = question;
        return existing;
    }

    const open = list.find(candidate => candidate.open);
    if (!open) return upsertEntry(mode, id, text, question);

    const oldKey = `${mode}:${open.id}`;
    open.id = id;
    open.open = false;
    open.questionFinal = true;
    // 收养时以事件带来的问题为准:快速连问下这个占位块可能是别的问题留下的,原样留着会把错的问题带给这条回答。
    if (question) open.question = question;
    open.text = text;
    const node = blockEls.get(oldKey);
    if (node) {
        blockEls.delete(oldKey);
        blockEls.set(`${mode}:${id}`, node);
    }
    return open;
}

// 问题比它的回答早到几百毫秒到几秒。先给这一轮立一个只有问题的占位块,问题就能像回答一样逐字流式出现。
// 精要列表的回答靠轮次 id(turnId)寻址,所以问题一定稿就顺手把占位块改名成那个 id:回答到达时按 id 精确
// 配对——连续快速提问时,靠「谁是开着的那个块」去认必然认错。详细列表的回答用的是另一个 id(detailId),
// 且问题文本随 detail 事件一起来,所以它保持可收养状态,仍交给 claimEntry。
function handleQuestion(text, final, turnId) {
    if (isWritten()) return;
    state.pendingQuestion = text;

    // 重连重放:这些块在这一段之前就已经存在了,只就地补问题/定稿,绝不再立占位块——同一个 id 出现两条
    // 会让导航条数多出来。详细块由按 detailId 寻址的答案事件建立,这里不用管。
    if (state.replaying) {
        const briefId = final && turnId != null ? String(turnId) : null;
        const existing = briefId ? findEntry('brief', briefId) : null;
        if (existing) {
            existing.question = text;
            existing.questionFinal = Boolean(final);
            updateBlock('brief', existing);
        }
        if (final) state.pendingQuestionFinal = true;
        return;
    }

    // 上一个问题已定稿却还没被任何回答收养(那一轮没派发出回答),又来新文本 → 这是下一轮提问了:把旧占位
    // 封口,让它留在原地当「只有问题」的一块,别把新问题叠进去。
    if (state.pendingQuestionFinal) {
        for (const list of [state.briefs, state.details]) {
            const open = list.find(entry => entry.open);
            if (open) open.open = false;
        }
    }
    state.pendingQuestionFinal = false;

    for (const [mode, list] of [
        ['brief', state.briefs],
        ['detail', state.details],
    ]) {
        let open = list.find(entry => entry.open);
        if (!open) {
            open = { id: OPEN_ID, question: '', text: '', final: false, error: false, open: true, questionFinal: false };
            list.push(open);
        }
        open.question = text;
        open.questionFinal = Boolean(final);

        if (mode === 'brief' && final && turnId != null && open.id !== String(turnId)) {
            const oldKey = `${mode}:${open.id}`;
            const node = blockEls.get(oldKey);
            if (node) {
                blockEls.delete(oldKey);
                blockEls.set(`${mode}:${String(turnId)}`, node);
            }
            open.id = String(turnId);
            open.open = false;
        }

        updateBlock(mode, open);
    }

    if (final) state.pendingQuestionFinal = true;
}

function applyEvent({ channel, data }) {
    switch (channel) {
        case 'session-initializing':
            if (data === true) {
                state.briefs = [];
                state.details = [];
                state.pendingQuestion = '';
                state.pendingQuestionFinal = false;
                state.following = true;
                state.paused = false;
                renderPause();
                rebuild();
            }
            return;

        // 桌面把音源状态念出来,这里跟着点亮/熄灭暂停键。认的是原始英文串,不受手机语言影响。
        // 笔试下这颗键管的是自动截图,桌面暂停/恢复同样会走 update-status,所以状态依旧由它说了算。
        case 'update-status':
            state.paused = data === 'Paused';
            renderPause();
            return;

        // 会话模式随开局广播;重连时由服务端补发当前值。笔试带初始暂停位(设置里关了自动截图时开局即暂停),
        // 好让手机上的暂停键和桌面按钮从第一帧起就一致。
        case 'session-mode': {
            const mode = data && data.mode === 'written' ? 'written' : 'interview';
            if (data && typeof data.paused === 'boolean') {
                state.paused = data.paused;
                renderPause();
            }
            if (mode !== state.sessionMode) {
                state.sessionMode = mode;
                applySessionMode();
            }
            return;
        }

        case 'transcription-update':
        case 'transcription-final':
            // 笔试没有转录。
            if (isWritten()) return;
            // 候选人的话('user')是背景,屏幕截图('screen')是一道被作答的题而不是面试官的提问:两者都
            // 不该在手机上当成待读的提问。手动输入的消息不带 speaker,要照常显示。
            if (!data || data.speaker === 'user' || data.speaker === 'screen') return;
            handleQuestion(data.text || '', channel === 'transcription-final', data.turnId);
            return;

        case 'new-response':
        case 'update-response': {
            if (!data) return;
            const entry = claimEntry('brief', String(data.turnId), data.text || '', state.pendingQuestion);
            updateBlock('brief', entry);
            return;
        }

        case 'response-complete': {
            if (!data) return;
            const entry = findEntry('brief', String(data.turnId));
            if (!entry) return;
            entry.final = true;
            updateBlock('brief', entry);
            return;
        }

        case 'new-detail-response':
        case 'update-detail-response': {
            if (!data) return;
            const entry = claimEntry('detail', String(data.detailId), data.text || '', data.question || state.pendingQuestion);
            updateBlock('detail', entry);
            // 截图作答带 screenshot 标记:手机端也把它并进精要(桌面端一直只让它进详情面板)。
            if (data.screenshot) upsertScreenshotBrief(data.turnSeq, data.text || '', false, false);
            return;
        }

        case 'detail-response-complete': {
            if (!data) return;
            const entry = findEntry('detail', String(data.detailId));
            if (entry) {
                entry.final = true;
                if (data.ok === false) entry.error = true;
                updateBlock('detail', entry);
            }
            if (data.screenshot) upsertScreenshotBrief(data.turnSeq, null, true, data.ok === false);
            return;
        }

        default:
            return;
    }
}

// ---------- 渲染 ----------

const blockEls = new Map();
// 左侧导航的一条条短横线,与 navList() 一一对应(占位块也算一条)。
let navEls = [];
let suppressScroll = false;
// 判定「已贴底」的容差(px):滚到最底常差几个像素,不留余量会让跟随状态在真/假之间抖。
const BOTTOM_THRESHOLD = 24;
// 双栏联动滚动时置上,免得程序化滚动另一栏又反过来触发它的 scroll 处理器,滚成一个环。
let syncGuard = false;

// 笔试只有一份内容(详细列表),没有精要/详细之分。
function activeList() {
    if (isWritten()) return state.details;
    return state.answerMode === 'brief' ? state.briefs : state.details;
}

// 单栏时,精要/详细共用一个 #feed,由 answerMode 决定装哪一份;双栏时各有各的容器,两份同时在场。
// 笔试强制单栏,详细回答直接进 #feed。
function feedFor(mode) {
    if (isWritten()) return mode === 'detail' ? dom.feed : null;
    if (state.split) return mode === 'brief' ? dom.feedBrief : dom.feedDetail;
    return mode === state.answerMode ? dom.feed : null;
}

// 导航跟着精要走:单栏看当前模式那一份,双栏固定在左栏(精要);笔试跟着唯一的那列回答走。
function navList() {
    if (isWritten()) return state.details;
    return state.split ? state.briefs : activeList();
}

function navMode() {
    if (isWritten()) return 'detail';
    return state.split ? 'brief' : state.answerMode;
}

function navFeed() {
    if (isWritten()) return dom.feed;
    return state.split ? dom.feedBrief : dom.feed;
}

function rebuild() {
    if (state.screen !== 'stage') return;
    for (const el of [dom.feed, dom.feedBrief, dom.feedDetail]) el.innerHTML = '';
    blockEls.clear();
    navEls = [];
    dom.nav.innerHTML = '';

    // 笔试永远单栏:即使面试时停在「兼有」,这里也不能把分栏铺回来。
    const split = state.split && !isWritten();
    if (split) {
        for (const entry of state.briefs) upsertNode('brief', entry);
        for (const entry of state.details) upsertNode('detail', entry);
        if (!state.briefs.length) dom.feedBrief.innerHTML = `<p class="empty">${esc(S.waiting)}</p>`;
    } else {
        const list = activeList();
        if (list.length) {
            for (const entry of list) upsertNode(isWritten() ? 'detail' : state.answerMode, entry);
        } else {
            dom.feed.innerHTML = `<p class="empty">${esc(isWritten() ? S.waitingWritten : S.waiting)}</p>`;
        }
    }
    syncNav();
    if (state.following) anchorToLast();
    updateFollowBtn();
}

function upsertNode(mode, entry) {
    const parent = feedFor(mode);
    if (!parent) return null;
    const key = `${mode}:${entry.id}`;
    let node = blockEls.get(key);

    if (!node) {
        const el = document.createElement('div');
        el.className = 'turn';
        const questionEl = document.createElement('p');
        questionEl.className = 'question';
        const answerEl = document.createElement('div');
        answerEl.className = 'answer';
        el.append(questionEl, answerEl);
        parent.appendChild(el);
        node = { el, questionEl, answerEl };
        blockEls.set(key, node);
    }

    // 笔试只显示回答:固定问句和截图概括都不渲染,问题行整行为空(CSS 里也再挡一层)。
    const rawQuestion = isWritten() ? '' : entry.question || '';
    if (node.questionEl.dataset.raw !== rawQuestion) {
        node.questionEl.innerHTML = rawQuestion ? `<span class="tag">${esc(S.qLabel)}</span>${esc(rawQuestion)}` : '';
        node.questionEl.dataset.raw = rawQuestion;
    }

    // 问题也逐字进来,所以它也闪光标;收到 transcription-final 后停。非占位块的问题都是定稿的。
    const questionStreaming = Boolean(rawQuestion) && !entry.questionFinal;
    if (node.questionEl.dataset.streaming !== String(questionStreaming)) {
        node.questionEl.classList.toggle('cursor', questionStreaming);
        node.questionEl.dataset.streaming = String(questionStreaming);
    }

    const isError = Boolean(entry.error);
    if (node.answerEl.dataset.raw !== entry.text || node.answerEl.dataset.error !== String(isError)) {
        node.answerEl.innerHTML = isError ? `<span class="error">${esc(S.detailError)}</span>` : md(entry.text);
        node.answerEl.dataset.raw = entry.text;
        node.answerEl.dataset.error = String(isError);
    }

    // 光标跟着「还在流式」而不是跟着正文变化:定稿那一拍text常常没变,只在正文的 if 里切光标会让它一直闪。
    // 占位块只有问题还没有答案,这时不该在空白的回答区也闪一个光标,所以要求正文非空。
    const streaming = String(!entry.final && !isError && Boolean(entry.text));
    if (node.answerEl.dataset.streaming !== streaming) {
        node.answerEl.classList.toggle('cursor', streaming === 'true');
        node.answerEl.dataset.streaming = streaming;
    }

    return node;
}

function updateBlock(mode, entry) {
    if (state.screen !== 'stage') return;
    // 单栏时只画当前模式那一份,双栏时两份都画;feedFor 在这两种情形下各自给出该进的容器或 null。
    const parent = feedFor(mode);
    if (!parent) return;

    const placeholder = parent.firstElementChild;
    if (placeholder && placeholder.classList.contains('empty')) parent.innerHTML = '';

    upsertNode(mode, entry);
    syncNav();
    if (state.following) anchorToLast();
}

// 只在用户本来就贴着底端时才跟随:新内容到来就把画面顶到最新底端。用户往上翻(翻成不跟随)后,新内容只
// 安静地加在下面,不再把他拽回去——要不要回到最新,交给那颗向下箭头。双栏时两栏一起贴底:详细回答常比精要
// 晚到,硬把它们对齐到同一轮反而会让右栏停在空中。
function anchorToLast() {
    suppressScroll = true;
    scrollFeedToBottom(navFeed());
    if (state.split && !isWritten()) scrollFeedToBottom(dom.feedDetail);
    requestAnimationFrame(() => {
        suppressScroll = false;
    });
    updateNavActive();
    updateFollowBtn();
}

function scrollFeedToBottom(feed) {
    feed.scrollTop = feed.scrollHeight - feed.clientHeight;
}

// 「在不在最底端」以导航那一栏为准(单栏就是唯一那栏,双栏是左栏)。
function isAtBottom(feed) {
    return feed.scrollHeight - feed.clientHeight - feed.scrollTop <= BOTTOM_THRESHOLD;
}

// 向下箭头:不在最底端时点它,滚到最新底端并恢复跟随。已在底端时点了也无妨(仍旧贴底)。
function scrollToBottom() {
    state.following = true;
    anchorToLast();
}

// 贴底时把箭头淡下去——没有可追的新内容,留着当提示即可。
function updateFollowBtn() {
    dom.scrollBtn.classList.toggle('at-bottom', isAtBottom(navFeed()));
}

// 导航条与 navList() 同源。条数变了才重建(重建会重挂点击,条目对象在同一列表里是稳定的,收养只改
// 字段不换对象);条数没变只把条目指针挪一挪,免得每次流式更新都重造一遍 DOM。
function syncNav() {
    const list = navList();
    if (navEls.length !== list.length) {
        dom.nav.innerHTML = '';
        navEls = list.map(entry => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'nav-dash';
            el.addEventListener('click', () => jumpTo(entry));
            dom.nav.appendChild(el);
            return { entry, el };
        });
    } else {
        navEls.forEach((item, index) => {
            item.entry = list[index];
        });
    }
    layoutNav();
    updateNavActive();
}

// 悬浮导航的间距规则:先按「一段固定的小间距」排;一旦这样排出来的总长超过屏幕高的 1/3,就改用灵活间距,
// 把总长压到 1/3。高度交给 flex 的 space-between 去分配,这里只算该给多高——所以固定间距写成常量,
// 灵活间距由 CSS 自己摊。NAV_FIXED_GAP 是先给的经验值,后面按观感调。
const NAV_FIXED_GAP = 8;
const NAV_DASH_HEIGHT = 3;

function layoutNav() {
    if (navEls.length === 0) return;
    const span = Math.round(window.innerHeight / 3);
    const natural = navEls.length * NAV_DASH_HEIGHT + (navEls.length - 1) * NAV_FIXED_GAP;
    dom.nav.style.height = `${Math.min(natural, span)}px`;
}

// 点某条横线就把它那块滚到顶部。跳转即停止跟随,否则下一次流式更新会把视线又拽回末尾。双栏时另一栏也跟
// 到同一轮——两栏是同一个问题的两种回答,分头滚会让人对不上号。
function jumpTo(entry) {
    const feed = navFeed();
    const node = blockEls.get(`${navMode()}:${entry.id}`);
    if (!node) return;
    state.following = false;
    feed.scrollTop = node.el.offsetTop;
    if (state.split && !isWritten()) syncPeerToIndex(feed, indexOfTurn(feed, node.el));
    updateNavActive();
}

// 一轮在某栏 DOM 里的序号。两栏装着同样顺序的轮次,序号就是跨栏对齐的钥匙。
function indexOfTurn(feed, el) {
    return [...feed.querySelectorAll('.turn')].indexOf(el);
}

// 两栏联动:source 滚到哪一轮,peer 就贴到同序号的轮次顶部;peer 还没有那一轮(详细回答晚到)就贴到底。
function syncPeerToIndex(source, index) {
    const peer = source === dom.feedBrief ? dom.feedDetail : dom.feedBrief;
    const turns = peer.querySelectorAll('.turn');
    syncGuard = true;
    peer.scrollTop = turns[index] ? turns[index].offsetTop : peer.scrollHeight;
    requestAnimationFrame(() => {
        syncGuard = false;
    });
}

// 用户滚某一栏时算出它压在顶上的那一轮,再让另一栏跟过去。滚到底时对面也贴到底,别因序号对齐而停在半空。
function syncPeerFromScroll(source) {
    const turns = source.querySelectorAll('.turn');
    if (!turns.length) return;
    const top = source.scrollTop;
    let index = 0;
    turns.forEach((el, i) => {
        if (el.offsetTop <= top + 8) index = i;
    });
    if (top >= source.scrollHeight - source.clientHeight - 2) {
        const peer = source === dom.feedBrief ? dom.feedDetail : dom.feedBrief;
        syncGuard = true;
        peer.scrollTop = peer.scrollHeight;
        requestAnimationFrame(() => {
            syncGuard = false;
        });
        return;
    }
    syncPeerToIndex(source, index);
}

// 高亮「当前压在顶部的那一块」:滚动位置落在谁的地界里就点亮谁;都没越过时点亮第一条。滚到底部时最后
// 一块往往顶不到最上沿(下面没内容了),这时按「到底了」处理,点亮最后一条而不是上面那条。
function updateNavActive() {
    if (!navEls.length) return;
    const feed = navFeed();
    const top = feed.scrollTop;
    const maxTop = feed.scrollHeight - feed.clientHeight;
    let activeIndex = 0;
    if (maxTop > 0 && top >= maxTop - 2) {
        activeIndex = navEls.length - 1;
    } else {
        navEls.forEach((item, index) => {
            const node = blockEls.get(`${navMode()}:${item.entry.id}`);
            if (node && node.el.offsetTop <= top + 8) activeIndex = index;
        });
    }
    navEls.forEach((item, index) => item.el.classList.toggle('active', index === activeIndex));
}

// 手机端「清空上下文」:和桌面一致,只留下还在流式的回答——截断半句是唯一绝不能做的事。判断要看回答是否
// 真的开始了(有正文且未定稿),而不是只看未定稿:只有问题的占位块也是未定稿的,留着就会在清空后孤零零地
// 挂一个「考官问题」。
const stillStreaming = entry => !entry.final && Boolean(entry.text);

function clearConversation() {
    state.briefs = state.briefs.filter(stillStreaming);
    state.details = state.details.filter(stillStreaming);
    state.following = true;
    rebuild();
}

// 顶栏三档滑块:精要/详细走单栏,兼有走双栏。三档共用一个状态——split 表示「兼有」,answerMode 记单栏看哪一份。
function currentViewMode() {
    return state.split ? 'both' : state.answerMode;
}

function updateModeButtons() {
    const mode = currentViewMode();
    dom.modeBrief.classList.toggle('active', mode === 'brief');
    dom.modeDetail.classList.toggle('active', mode === 'detail');
    dom.modeBoth.classList.toggle('active', mode === 'both');
}

function setViewMode(mode) {
    if (mode === currentViewMode()) return;
    if (mode === 'both') {
        applySplit(true);
        saveSplit(true);
    } else {
        state.answerMode = mode;
        if (state.split) {
            applySplit(false);
            saveSplit(false);
        } else {
            state.following = true;
            rebuild();
        }
    }
    updateModeButtons();
}

// ---------- 屏幕常亮 ----------

// http://192.168.x.x 不是安全上下文,navigator.wakeLock 通常不存在,那就什么都做不了——不套循环静音视频的
// hack(那个在不同机型上并不可靠,反而更难排查)。拿得到就申请,页面重新可见时再申请一次。
async function keepAwake() {
    if (!navigator.wakeLock) return;
    try {
        await navigator.wakeLock.request('screen');
    } catch {
        return;
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') navigator.wakeLock.request('screen').catch(() => {});
    });
}

// ---------- 设置 ----------

// 两个字号各存 localStorage 并分别写进 :root 的 --q-font-size / --a-font-size,问题读前者、回答读后者,
// 互不影响。
function readStoredFont(key) {
    try {
        const value = Number(localStorage.getItem(key));
        return value > 0 ? value : null;
    } catch {
        return null;
    }
}

// 首次打开读一次:各自的键优先,缺了回落到旧版的单键(等于把升级前的字号原样保留给两边),都没有才用默认。
function readInitialFonts() {
    const legacy = readStoredFont(LEGACY_FONT_KEY);
    return {
        question: readStoredFont(QUESTION_FONT_KEY) || legacy || DEFAULT_FONT,
        answer: readStoredFont(ANSWER_FONT_KEY) || legacy || DEFAULT_FONT,
    };
}

function applyQuestionFont(px) {
    document.documentElement.style.setProperty('--q-font-size', `${px}px`);
    dom.questionValue.textContent = `${px}px`;
}

function applyAnswerFont(px) {
    document.documentElement.style.setProperty('--a-font-size', `${px}px`);
    dom.answerValue.textContent = `${px}px`;
}

function saveFont(key, px) {
    try {
        localStorage.setItem(key, String(px));
    } catch {
        // 隐私模式下写不进去:本次仍生效,刷新后回默认。
    }
}

function openSettings() {
    dom.settings.hidden = false;
}

function closeSettings() {
    dom.settings.hidden = true;
}

// ---------- 双栏(平板) ----------

// 右栏占整宽的比例,与电脑端 detailPaneWidth 同一套做法:比例而不是像素,窗口变了份量不变。上下限靠 CSS 与
// 这里一起卡,往左拖到底也不至于剩一条读不了的窄栏。
const PANE_DEFAULT_FRACTION = 0.38;
const PANE_MIN_FRACTION = 0.18;
const PANE_MAX_FRACTION = 0.72;
const clampFraction = f => Math.min(PANE_MAX_FRACTION, Math.max(PANE_MIN_FRACTION, f));
let paneFraction = PANE_DEFAULT_FRACTION;

function readSplit() {
    try {
        return localStorage.getItem(SPLIT_KEY) === '1';
    } catch {
        return false;
    }
}

function saveSplit(value) {
    try {
        localStorage.setItem(SPLIT_KEY, value ? '1' : '0');
    } catch {
        // 隐私模式下写不进去:本次仍生效,刷新后回默认。
    }
}

function readFraction() {
    try {
        const value = Number(localStorage.getItem(SPLIT_FRACTION_KEY));
        return Number.isFinite(value) && value > 0 ? clampFraction(value) : PANE_DEFAULT_FRACTION;
    } catch {
        return PANE_DEFAULT_FRACTION;
    }
}

function saveFraction(f) {
    try {
        localStorage.setItem(SPLIT_FRACTION_KEY, String(Math.round(f * 1000) / 1000));
    } catch {
        // 同上。
    }
}

// 右栏宽度直接写到元素上。拖拽的每一帧都走这里,不重跑整套 rebuild。
function applyPaneFraction(f) {
    paneFraction = clampFraction(f);
    dom.feedDetail.style.width = `${(paneFraction * 100).toFixed(1)}%`;
}

function applySplit(value) {
    state.split = Boolean(value);
    // 单栏 #feed 与双栏 #splitView 互斥显隐,顶栏滑块在三档之间始终可见。笔试没有「兼有」,
    // 无论记忆里的选择是什么都铺单栏。
    const split = state.split && !isWritten();
    dom.feed.hidden = split;
    dom.splitView.hidden = !split;
    state.following = true;
    applyPaneFraction(paneFraction);
    rebuild();
}

// 会话模式切换:笔试收走三档滑块、露出「截图进入缓存」,并把原截图键改名为「截图并发送」;
// 回到面试时原样还原。可见性交给 CSS 类,按钮文案由 localize() 写好的两份交替显示。
function applySessionMode() {
    const written = isWritten();
    dom.stage.classList.toggle('written-mode', written);
    dom.cacheBtn.hidden = !written;
    dom.shotLabel.hidden = written;
    dom.shotSendLabel.hidden = !written;
    updateModeButtons();
    applySplit(state.split);
}

// 分隔条拖拽:按下捕获指针(拖出这 6px 也还在拖),每帧把右栏宽度写到元素上,松手才落盘。
let splitDrag = null;

dom.splitHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const width = dom.splitView.getBoundingClientRect().width;
    if (!width) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add('dragging');
    event.preventDefault();
    splitDrag = {
        startX: event.clientX,
        startFraction: dom.feedDetail.getBoundingClientRect().width / width,
        moved: false,
    };
});

dom.splitHandle.addEventListener('pointermove', event => {
    if (!splitDrag) return;
    const width = dom.splitView.getBoundingClientRect().width;
    if (!width) return;
    splitDrag.moved = true;
    // 右栏在右侧:往左拖是加宽,所以是减号。
    applyPaneFraction(splitDrag.startFraction - (event.clientX - splitDrag.startX) / width);
});

function endSplitDrag(event) {
    if (!splitDrag) return;
    const moved = splitDrag.moved;
    splitDrag = null;
    dom.splitHandle.classList.remove('dragging');
    if (dom.splitHandle.hasPointerCapture(event.pointerId)) dom.splitHandle.releasePointerCapture(event.pointerId);
    // 没真的拖动就不落盘,也不留一个内联宽度逼着以后每次渲染都跟它走。
    if (moved) saveFraction(paneFraction);
}

dom.splitHandle.addEventListener('pointerup', endSplitDrag);
dom.splitHandle.addEventListener('pointercancel', endSplitDrag);

// ---------- 暂停键 ----------

// 桌面每换一次音源状态都会用 update-status 播报,这里跟着点亮/熄灭:标 .paused 换成播放图标。
function renderPause() {
    dom.pauseBtn.classList.toggle('paused', state.paused);
    dom.pauseBtn.setAttribute('aria-label', state.paused ? 'Resume' : 'Pause');
}

// ---------- 启动 ----------

// 跟随基准锚在「导航那一栏」(单栏就是唯一那栏,双栏是左栏):滚右栏不改判「是否仍在跟随」,只把左栏带过去。
function onFeedScroll(source) {
    if (!suppressScroll && source === navFeed()) {
        state.following = isAtBottom(source);
    }
    updateNavActive();
    updateFollowBtn();
    if (state.split && !isWritten() && !syncGuard) syncPeerFromScroll(source);
}

dom.feed.addEventListener('scroll', () => onFeedScroll(dom.feed));
dom.feedBrief.addEventListener('scroll', () => onFeedScroll(dom.feedBrief));
dom.feedDetail.addEventListener('scroll', () => onFeedScroll(dom.feedDetail));

// 横竖屏切换、地址栏收放都会改窗口高,导航的 1/3 上限跟着重算。
window.addEventListener('resize', layoutNav);

dom.modeBrief.addEventListener('click', () => setViewMode('brief'));
dom.modeDetail.addEventListener('click', () => setViewMode('detail'));
dom.modeBoth.addEventListener('click', () => setViewMode('both'));
dom.pairBtn.addEventListener('click', () => tryPair(dom.code.value.trim()));
dom.code.addEventListener('input', () => {
    dom.code.value = dom.code.value.replace(/\D/g, '').slice(0, 6);
    if (dom.code.value.length === 6) tryPair(dom.code.value);
});

// 刷新即「清空上下文」:请桌面把模型记忆清掉,本地同步丢掉已定稿的块,两边看到的一致。
dom.refreshBtn.addEventListener('click', () => {
    sendCommand('clear-context');
    clearConversation();
});

dom.shotBtn.addEventListener('click', () => sendCommand('screenshot'));

// 笔试专有:只抓一帧攒进桌面缓存,不发送。长题目分几屏时先把上半部分存起来,最后再一次性「截图并发送」。
dom.cacheBtn.addEventListener('click', () => sendCommand('screenshot-to-cache'));

dom.settingsBtn.addEventListener('click', openSettings);
dom.settingsBack.addEventListener('click', closeSettings);
dom.questionRange.addEventListener('input', () => {
    const px = Number(dom.questionRange.value);
    applyQuestionFont(px);
    saveFont(QUESTION_FONT_KEY, px);
});
dom.answerRange.addEventListener('input', () => {
    const px = Number(dom.answerRange.value);
    applyAnswerFont(px);
    saveFont(ANSWER_FONT_KEY, px);
});
dom.scrollBtn.addEventListener('click', scrollToBottom);

// 乐观翻转:真状态由桌面的 update-status 回播校正;没会话时桌面会拒绝,下一次播报就把它拨回来。
dom.pauseBtn.addEventListener('click', () => {
    state.paused = !state.paused;
    renderPause();
    sendCommand('toggle-pause');
});

// 结束会话:让桌面端收尾当前会话并回到主页(不退出应用)。页面不做乐观清空——新一轮开启时桌面会推
// session-initializing 把这里清干净;没会话时桌面端自行拒绝,这里什么都不用回滚。
dom.endBtn.addEventListener('click', () => sendCommand('end-session'));

const initialFonts = readInitialFonts();
dom.questionRange.value = String(initialFonts.question);
dom.answerRange.value = String(initialFonts.answer);
applyQuestionFont(initialFonts.question);
applyAnswerFont(initialFonts.answer);

paneFraction = readFraction();
applySplit(state.split);
updateModeButtons();
renderPause();

localize();
if (state.token) {
    showStage();
    connect();
} else {
    showPairing();
}
