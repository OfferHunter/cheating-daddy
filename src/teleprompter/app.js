// 手机提词页。独立浏览器上下文,拿不到 Electron 的 window.require,所以一切自包含:本地文案表、
// 自己的 markdown 调用(靠 /marked.min.js 挂在 window.marked 上)、自己的重连与跟随逻辑。
'use strict';

const TOKEN_KEY = 'offerHunterTeleprompterToken';
const FONT_KEY = 'offerHunterTeleprompterFontSize';
const DEFAULT_FONT = 17;
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
        stayHint: '建议关闭手机自动锁屏以保持常亮',
        online: '已连接',
        offline: '已断开，正在重连…',
        waiting: '等待面试开始…',
        detailError: '（详细回答生成失败）',
        qLabel: '问',
        settingsTitle: '设置',
        fontSizeLabel: '字体大小',
        fontSample: '问题和回答都按这个大小显示',
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
        stayHint: 'Consider turning off auto-lock to keep the screen on',
        online: 'Connected',
        offline: 'Disconnected, reconnecting…',
        waiting: 'Waiting for the session to start…',
        detailError: '(detailed answer failed)',
        qLabel: 'Q',
        settingsTitle: 'Settings',
        fontSizeLabel: 'Font size',
        fontSample: 'Question and answer both render at this size',
    },
};

const langFromLocale = code => (String(code || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
let lang = langFromLocale(navigator.language);
let S = STRINGS[lang];

const state = {
    screen: 'pair',
    answerMode: 'brief',
    following: true,
    authed: false,
    token: readToken(),
    briefs: [],
    details: [],
    pendingQuestion: '',
    // 当前这个问题是否已经收到 transcription-final。定稿之后再来新文本,就说明是下一轮提问了。
    pendingQuestionFinal: false,
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
    modeBrief: document.getElementById('modeBrief'),
    modeDetail: document.getElementById('modeDetail'),
    stayHint: document.getElementById('stayHint'),
    settingsBtn: document.getElementById('settingsBtn'),
    settingsClose: document.getElementById('settingsClose'),
    fontRange: document.getElementById('fontRange'),
    fontValue: document.getElementById('fontValue'),
};

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
            window.marked.setOptions({ breaks: true, gfm: true, sanitize: false });
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

// ---------- 数据合并 ----------

function findEntry(mode, id) {
    const list = mode === 'brief' ? state.briefs : state.details;
    return list.find(entry => entry.id === id);
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
    if (question && !open.question) open.question = question;
    open.text = text;
    const node = blockEls.get(oldKey);
    if (node) {
        blockEls.delete(oldKey);
        blockEls.set(`${mode}:${id}`, node);
    }
    return open;
}

// 问题比它的回答早到几百毫秒到几秒。先给这一轮立一个只有问题的占位块,问题就能像回答一样逐字流式出现;
// 回答到达时由 claimEntry 收养同一个块。
function handleQuestion(text, final) {
    state.pendingQuestion = text;

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
                rebuild();
            }
            return;

        case 'transcription-update':
        case 'transcription-final':
            if (!data || data.speaker === 'user') return;
            handleQuestion(data.text || '', channel === 'transcription-final');
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
            return;
        }

        case 'detail-response-complete': {
            if (!data) return;
            const entry = findEntry('detail', String(data.detailId));
            if (!entry) return;
            entry.final = true;
            if (data.ok === false) entry.error = true;
            updateBlock('detail', entry);
            return;
        }

        default:
            return;
    }
}

// ---------- 渲染 ----------

const blockEls = new Map();
let anchor = 0;
let suppressScroll = false;

function activeList() {
    return state.answerMode === 'brief' ? state.briefs : state.details;
}

function rebuild() {
    if (state.screen !== 'stage') return;
    dom.feed.innerHTML = '';
    blockEls.clear();

    const list = activeList();
    if (!list.length) {
        dom.feed.innerHTML = `<p class="empty">${esc(S.waiting)}</p>`;
        return;
    }
    for (const entry of list) upsertNode(state.answerMode, entry);
    if (state.following) anchorToLast();
}

function upsertNode(mode, entry) {
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
        dom.feed.appendChild(el);
        node = { el, questionEl, answerEl };
        blockEls.set(key, node);
    }

    const rawQuestion = entry.question || '';
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
    if (state.screen !== 'stage' || state.answerMode !== mode) return;

    const placeholder = dom.feed.firstElementChild;
    if (placeholder && placeholder.classList.contains('empty')) dom.feed.innerHTML = '';

    upsertNode(mode, entry);
    if (state.following) anchorToLast();
}

// 跟随的是「最新一块的顶部」而不是底部:提词器要让人从这一轮回答的第一个字开始读,而不是读它的结尾。
function anchorToLast() {
    const last = dom.feed.lastElementChild;
    if (!last || last.classList.contains('empty')) return;

    suppressScroll = true;
    anchor = last.offsetTop;
    dom.feed.scrollTop = anchor;
    requestAnimationFrame(() => {
        suppressScroll = false;
    });
}

function setMode(mode) {
    if (state.answerMode === mode) return;
    state.answerMode = mode;
    dom.modeBrief.classList.toggle('active', mode === 'brief');
    dom.modeDetail.classList.toggle('active', mode === 'detail');
    state.following = true;
    rebuild();
}

// ---------- 屏幕常亮 ----------

// http://192.168.x.x 不是安全上下文,navigator.wakeLock 通常不存在,所以拿不到时只提示用户手动关自动锁屏,
// 不再套一层循环静音视频的 hack(那个在不同机型上并不可靠,反而更难排查)。
async function keepAwake() {
    if (!navigator.wakeLock) {
        dom.stayHint.hidden = false;
        return;
    }
    try {
        await navigator.wakeLock.request('screen');
    } catch {
        dom.stayHint.hidden = false;
        return;
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') navigator.wakeLock.request('screen').catch(() => {});
    });
}

// ---------- 设置 ----------

// 字号存在 localStorage 并写进 :root 的 --font-size,问题和回答都读它,所以调一处两边一起变。
function readFont() {
    try {
        const value = Number(localStorage.getItem(FONT_KEY));
        return value > 0 ? value : DEFAULT_FONT;
    } catch {
        return DEFAULT_FONT;
    }
}

function applyFont(px) {
    document.documentElement.style.setProperty('--font-size', `${px}px`);
    dom.fontValue.textContent = `${px}px`;
}

function saveFont(px) {
    try {
        localStorage.setItem(FONT_KEY, String(px));
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

// ---------- 启动 ----------

dom.feed.addEventListener('scroll', () => {
    if (suppressScroll) return;
    state.following = Math.abs(dom.feed.scrollTop - anchor) <= 32;
});

dom.modeBrief.addEventListener('click', () => setMode('brief'));
dom.modeDetail.addEventListener('click', () => setMode('detail'));
dom.pairBtn.addEventListener('click', () => tryPair(dom.code.value.trim()));
dom.code.addEventListener('input', () => {
    dom.code.value = dom.code.value.replace(/\D/g, '').slice(0, 6);
    if (dom.code.value.length === 6) tryPair(dom.code.value);
});

dom.settingsBtn.addEventListener('click', openSettings);
dom.settingsClose.addEventListener('click', closeSettings);
dom.fontRange.addEventListener('input', () => {
    const px = Number(dom.fontRange.value);
    applyFont(px);
    saveFont(px);
});

const initialFont = readFont();
dom.fontRange.value = String(initialFont);
applyFont(initialFont);

localize();
if (state.token) {
    showStage();
    connect();
} else {
    showPairing();
}
