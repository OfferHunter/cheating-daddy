// 手机提词:在同一局域网里架一个 HTTP + WebSocket 服务,让手机浏览器连上来看实时回答。采集、ASR、对话
// 全部留在桌面,手机只是第二块显示屏——回答不出现在被面试软件录屏的那块屏上,这才是它相对桌面悬浮窗的意义。
//
// 服务本身常驻(app 运行期间),这样面试前就能把手机配对好、页面开着;真正有内容可推只在会话进行时。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const storage = require('../storage');

const DEFAULT_PORT = 8765;
// 首选端口被占时往后顺延试多少个相邻端口,试完仍不行才退到系统临时端口。
const PORT_SCAN_SPAN = 10;
// 连续猜错这么多次就换码并锁一段时间。配对码只有 6 位,同网段暴力猜的门槛全靠这里。
const MAX_PAIR_ATTEMPTS = 5;
const PAIR_LOCK_MS = 30 * 1000;
// 连上但一直不鉴权的连接,超时就切断,免得空连接堆积。
const AUTH_TIMEOUT_MS = 10 * 1000;
// 断线重连(手机锁屏、切后台)后要能把画面补齐,所以留一小段最近事件做回放。小到不值得担心内存。
const REPLAY_LIMIT = 80;

// 只有这些频道会外发。这是安全边界而不是过滤优化:`save-session-context` 带 customPrompt、任何凭证都
// 不在此列,一律不出主进程。
const FORWARDED_CHANNELS = new Set([
    'new-response',
    'update-response',
    'response-complete',
    'new-detail-response',
    'update-detail-response',
    'detail-response-complete',
    'transcription-update',
    'transcription-final',
    'update-status',
    'session-initializing',
]);

// 精确白名单,不接受拼接——路径穿越在第一步就被挡掉。marked 复用渲染端那份,手机页因此不必自带解析器。
const STATIC_ROUTES = {
    '/': { file: '../teleprompter/index.html', type: 'text/html; charset=utf-8' },
    '/index.html': { file: '../teleprompter/index.html', type: 'text/html; charset=utf-8' },
    '/app.js': { file: '../teleprompter/app.js', type: 'text/javascript; charset=utf-8' },
    '/app.css': { file: '../teleprompter/app.css', type: 'text/css; charset=utf-8' },
    '/marked.min.js': { file: '../assets/marked-4.3.0.min.js', type: 'text/javascript; charset=utf-8' },
};

let server = null;
let wss = null;
let port = null;
let pairingCode = null;
let pairAttempts = 0;
let lockedUntil = 0;
let replay = [];
const clients = new Set();

function getLanUrl() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const entry of interfaces[name] || []) {
            if (entry.family === 'IPv4' && !entry.internal) {
                return `http://${entry.address}:${port}`;
            }
        }
    }
    return `http://localhost:${port}`;
}

// 长效令牌存在 config.json:它是局域网共享秘密,配对一次之后手机不用再输码。credential.json 里的 API Key
// 与它无关,永远不出主进程。
function ensureToken() {
    const existing = storage.getConfig().teleprompterToken;
    if (existing) return existing;

    const token = crypto.randomBytes(24).toString('hex');
    storage.updateConfig('teleprompterToken', token);
    return token;
}

function rotateCode() {
    pairingCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    pairAttempts = 0;
}

function readAsset(relative) {
    return fs.readFileSync(path.join(__dirname, relative));
}

function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
}

function handlePair(req, res) {
    let body = '';
    req.on('data', chunk => {
        body += chunk;
        // 配对请求只可能是 {code} 这么点东西,超了就直接断,不给它机会撑爆缓冲。
        if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
        if (Date.now() < lockedUntil) {
            sendJson(res, 429, { error: 'locked', retryAfterMs: lockedUntil - Date.now() });
            return;
        }

        let code = '';
        try {
            code = String(JSON.parse(body).code || '');
        } catch {
            code = '';
        }

        if (code !== pairingCode) {
            pairAttempts += 1;
            if (pairAttempts >= MAX_PAIR_ATTEMPTS) {
                rotateCode();
                lockedUntil = Date.now() + PAIR_LOCK_MS;
            }
            sendJson(res, 401, { error: 'bad-code' });
            return;
        }

        sendJson(res, 200, { token: ensureToken(), lang: storage.getPreferences().uiLanguage || 'zh-CN' });
    });
}

function handleRequest(req, res) {
    let pathname;
    try {
        pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
        pathname = '';
    }

    if (req.method === 'POST' && pathname === '/api/pair') {
        handlePair(req, res);
        return;
    }

    const route = req.method === 'GET' ? STATIC_ROUTES[pathname] : null;
    if (!route) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
    }

    try {
        const data = readAsset(route.file);
        res.writeHead(200, { 'content-type': route.type, 'cache-control': 'no-store' });
        res.end(data);
    } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Read error');
    }
}

function handleSocket(ws) {
    const client = { ws, authed: false };
    clients.add(client);

    const authTimer = setTimeout(() => {
        if (!client.authed) ws.close();
    }, AUTH_TIMEOUT_MS);

    ws.on('message', raw => {
        let message;
        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }
        if (message.type === 'auth' && client.authed === false && message.token === ensureToken()) {
            client.authed = true;
            clearTimeout(authTimer);
            // 回放最近事件:手机锁屏或切后台后重连,画面直接补齐到当前状态,而不是等下一个问题才有内容。
            ws.send(JSON.stringify({ type: 'auth-ok' }));
            for (const event of replay) {
                ws.send(JSON.stringify(event));
            }
        }
    });

    ws.on('close', () => {
        clearTimeout(authTimer);
        clients.delete(client);
    });

    ws.on('error', () => {});
}

// 单次尝试:绑上就 resolve 实际端口,端口被占就 resolve null(好让上层换一个再试),
// 其他错误直接 reject。同一个 server 在 EADDRINUSE 之后可以继续 listen,失败尝试不会把它弄脏。
function tryListen(instance, candidatePort) {
    return new Promise((resolve, reject) => {
        const onError = error => {
            instance.removeListener('error', onError);
            if (error.code === 'EADDRINUSE') {
                resolve(null);
                return;
            }
            reject(error);
        };

        instance.once('error', onError);
        instance.listen(candidatePort, '0.0.0.0', () => {
            instance.removeListener('error', onError);
            resolve(instance.address().port);
        });
    });
}

// 端口自适应:从配置里的首选端口开始,依次往后试 PORT_SCAN_SPAN 个(本机别的程序、或上一次没退干净的
// 实例都可能占着),全被占才退到系统分配的临时端口。选相邻端口而不是直接跳临时端口,是因为地址更短、更好
// 记、也更像「这台机器上这个应用的」——用户在手机上敲一次之后就固定在配置里了。
async function listen(instance, preferredPort) {
    if (preferredPort !== 0) {
        for (let candidate = preferredPort; candidate < preferredPort + PORT_SCAN_SPAN; candidate += 1) {
            const bound = await tryListen(instance, candidate);
            if (bound !== null) return bound;
        }
    }
    return tryListen(instance, 0);
}

async function startTeleprompter() {
    if (server) return getStatus();

    ensureToken();
    rotateCode();
    replay = [];

    const preferred = Number(storage.getConfig().teleprompterPort) || DEFAULT_PORT;
    const instance = http.createServer(handleRequest);

    // 先把端口定下来,再挂 WebSocket。ws 会把底层 server 的 error 直接转发成自己的 error 事件,而它自己
    // 没监听 error 时 EventEmitter 会把错误原样抛出——那个抛出会打断这次 error 派发,于是 listen 里
    // EADDRINUSE 换临时端口的兜底根本跑不到,服务就此卡住。绑好端口再挂 ws,兜底路径就不被它挡。
    port = await listen(instance, preferred);

    const socketServer = new WebSocketServer({ server: instance });
    socketServer.on('connection', handleSocket);
    // 这个监听不只是为了记日志:缺了它,ws 转发的任何底层 error 都会被 EventEmitter 抛出,掀翻退出流程。
    socketServer.on('error', error => console.error('[Teleprompter] socket server error:', error.message));

    server = instance;
    wss = socketServer;
    if (port !== preferred) storage.updateConfig('teleprompterPort', port);

    console.log('Teleprompter listening on', getLanUrl());
    return getStatus();
}

function stopTeleprompter() {
    for (const client of clients) {
        try {
            client.ws.close();
        } catch {
            // 关一个已经死掉的 socket 不值得中断退出流程。
        }
    }
    clients.clear();
    replay = [];
    if (wss) wss.close();
    if (server) server.close();
    wss = null;
    server = null;
    port = null;
    pairingCode = null;
}

// sendToRenderer 的唯一旁路点:白名单之外的一切在这里被丢掉。
function broadcast(channel, data) {
    if (!FORWARDED_CHANNELS.has(channel)) return;

    const event = { channel, data };
    replay.push(event);
    if (replay.length > REPLAY_LIMIT) replay.shift();

    const payload = JSON.stringify(event);
    for (const client of clients) {
        if (client.authed && client.ws.readyState === 1) client.ws.send(payload);
    }
}

function getStatus() {
    // paired:当前有没有已鉴权的手机连着。桌面主页靠它决定「开始会话」能不能按——这一模式里手机才是显示端,
    // 没配对就开会话等于对着一个没人看的窗口说话。
    const paired = [...clients].some(client => client.authed && client.ws.readyState === 1);
    return {
        running: Boolean(port),
        port,
        url: port ? getLanUrl() : '',
        code: pairingCode || '',
        paired,
    };
}

function regenerateCode() {
    rotateCode();
    lockedUntil = 0;
    return getStatus();
}

module.exports = { startTeleprompter, stopTeleprompter, broadcast, getStatus, regenerateCode };
