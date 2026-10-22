// 手机提词:在同一局域网里架一个 HTTP + WebSocket 服务,让手机浏览器连上来看实时回答。采集、ASR、对话
// 全部留在桌面,手机只是第二块显示屏——回答不出现在被面试软件录屏的那块屏上,这才是它相对桌面悬浮窗的意义。
//
// 服务本身常驻(app 运行期间),这样面试前就能把手机配对好、页面开着;真正有内容可推只在会话进行时。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { WebSocketServer } = require('ws');
const storage = require('../storage');

const DEFAULT_PORT = 8765;
// 自检要读 Windows 防火墙规则。NetSecurity 那套 cmdlet 查一次要 5 秒以上(还要加载模块),而注册表里是
// 同一份数据,0.5 秒就读完;键名和值格式与系统语言无关,中文/英文系统解析结果一致。
const FIREWALL_POLICY_KEY = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy';
const FIREWALL_PROBE_TIMEOUT_MS = 8000;
// 一张真实的 Wi-Fi 卡 + 一张 VMware/Hyper-V/WSL/VPN 虚拟卡是常态。地址排序把真实网卡放前面,虚拟网卡和
// 169.254 的自动私有地址放最后——后者手机永远到不了,只配当「换一个试试」的候选。
const WIFI_ADAPTER_RE = /wi-?fi|wlan|wireless|无线/i;
const ETHERNET_ADAPTER_RE = /ethernet|以太网/i;
const VIRTUAL_ADAPTER_RE = /vmware|vmnet|virtualbox|vbox|hyper-?v|vethernet|docker|wsl|tailscale|zerotier|vpn|npcap|bluetooth|virtual|loopback/i;
const LINK_LOCAL_RE = /^169\.254\./;

const FIREWALL_PROBE_SCRIPT = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$base = '${FIREWALL_POLICY_KEY}'`,
    '$profiles = [ordered]@{}',
    "foreach ($pair in @(@('Domain', 'DomainProfile'), @('Private', 'StandardProfile'), @('Public', 'PublicProfile'))) {",
    "    $value = (Get-ItemProperty -Path ($base + '\\' + $pair[1]) -Name EnableFirewall).EnableFirewall",
    '    $profiles[$pair[0]] = ($value -eq 1)',
    '}',
    '$rules = @()',
    "$props = Get-ItemProperty -Path ($base + '\\FirewallRules')",
    'foreach ($prop in $props.PSObject.Properties) {',
    "    if ($prop.Name.StartsWith('PS')) { continue }",
    '    $raw = [string]$prop.Value',
    "    if ($raw -notmatch '(^|\\|)Dir=In(\\||$)') { continue }",
    "    if ($raw -notmatch '(^|\\|)Active=TRUE(\\||$)') { continue }",
    "    if ($raw -notmatch '(^|\\|)Action=Allow(\\||$)') { continue }",
    '    $rules += $raw',
    '}',
    '$networks = @(Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{ alias = $_.InterfaceAlias; category = [string]$_.NetworkCategory } })',
    '[pscustomobject]@{ profiles = $profiles; networks = $networks; rules = $rules } | ConvertTo-Json -Compress -Depth 4',
].join('\n');
// 首选端口被占时往后顺延试多少个相邻端口,试完仍不行才退到系统临时端口。
const PORT_SCAN_SPAN = 10;
// 连续猜错这么多次就换码并锁一段时间。配对码只有 6 位,同网段暴力猜的门槛全靠这里。
const MAX_PAIR_ATTEMPTS = 5;
const PAIR_LOCK_MS = 30 * 1000;
// 单个已鉴权客户端一直不读时,ws 会把待发数据无限堆在进程内存里(流式回答推得越多堆得越多)。超过这个量
// 就断开它——手机会自动重连,回放窗口足以补齐画面,好过让一条死连接把主进程拖垮。
const MAX_BUFFERED_BYTES = 1 << 20;
// 连上但一直不鉴权的连接,超时就切断,免得空连接堆积。
const AUTH_TIMEOUT_MS = 10 * 1000;
// 断线重连(手机锁屏、切后台)后要能把画面补齐,所以留一小段最近事件做回放。小到不值得担心内存。
const REPLAY_LIMIT = 80;

// 手机能下达的指令白名单。手机是显示器,这几条是它唯一被允许反过来驱动桌面的动作,所以只认精确字符串,
// 且必须来自已鉴权的连接。
const COMMANDS = new Set(['screenshot', 'screenshot-to-cache', 'clear-context', 'toggle-pause', 'end-session']);

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
    'session-mode',
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
// 每个来源 IP 各记各的失败次数与锁定截止时间。一个全局计数会被同网段任何一台机器刷满,把真正的用户一起锁
// 在门外;按 IP 分开后,攻击者只锁得住自己。
const pairState = new Map(); // ip -> { attempts, lockedUntil }
let replay = [];
// 最近一次会话模式。模式事件只在开局/结束时发一次,重连时它通常早就被 80 条回放窗口挤掉了,
// 但手机必须一上来就知道该铺面试页还是笔试页,所以单独留一份当前值在鉴权后先补发。
let sessionModeEvent = null;
// 最近一条状态。暂停/恢复只靠 update-status 播报;手机重连时若它已滚出回放窗口,暂停键就会显示错,
// 所以同样留一份当前值在鉴权后先去重放之前补发。
let lastStatus = null;
const clients = new Set();

// 桌面当前主题的解析令牌,渲染端在每次换主题时推来。手机页拿不到桌面的 :root,只能靠这里把它渲染成
// /theme.css 交过去。非会话状态,stop 时不清理。
let themeTokens = null;

// 主进程注册进来的指令处理器:手机点了截图/清空上下文,这里转成桌面上的实际动作。服务本身不懂 Electron,
// 保持可独立测试——没注册时指令被静默丢弃。
let commandHandler = null;

function setCommandHandler(handler) {
    commandHandler = handler;
}

function setTheme(tokens) {
    themeTokens = tokens && typeof tokens === 'object' ? tokens : null;
}

// 由背景亮度定 color-scheme:亮主题下让表单控件、滚动条也走亮色,而不是 html 里写死的 dark。
function prefersDark(tokens) {
    const match = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec((tokens && tokens['--bg-app']) || '');
    if (!match) return true;
    return (Number(match[1]) + Number(match[2]) + Number(match[3])) / 3 <= 128;
}

function themeCss() {
    if (!themeTokens) return ':root{}';
    const decls = Object.entries(themeTokens)
        .map(([name, value]) => `${name}:${value};`)
        .join('');
    return `:root{color-scheme:${prefersDark(themeTokens) ? 'dark' : 'light'};${decls}}`;
}

function adapterRank(name, address) {
    if (LINK_LOCAL_RE.test(address)) return 4;
    if (VIRTUAL_ADAPTER_RE.test(name)) return 3;
    if (WIFI_ADAPTER_RE.test(name)) return 0;
    if (ETHERNET_ADAPTER_RE.test(name)) return 1;
    return 2;
}

// 所有可能被手机访问到的地址,而不是只取第一个。机器上同时有 Wi-Fi、有线、VMware/WSL/VPN 网卡时,
// 任何一个自动选择都可能挑错;列出来让用户从第一个开始试,比猜错一次就判定「连不上」可靠。
function listLanAddresses() {
    const found = [];
    for (const [name, entries] of Object.entries(os.networkInterfaces())) {
        for (const entry of entries || []) {
            if (entry.family !== 'IPv4' || entry.internal) continue;
            if (found.some(item => item.address === entry.address)) continue;
            found.push({ name, address: entry.address });
        }
    }
    found.sort((a, b) => adapterRank(a.name, a.address) - adapterRank(b.name, b.address));
    return found.map(item => ({ ...item, url: `http://${item.address}:${port}` }));
}

function runFirewallProbe() {
    return new Promise(resolve => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', FIREWALL_PROBE_SCRIPT],
            { windowsHide: true, timeout: FIREWALL_PROBE_TIMEOUT_MS, maxBuffer: 4 << 20, encoding: 'utf8' },
            (error, stdout) => {
                // 探测失败只说明「不知道」,不说明「连不上」。宁可放行让用户自己试地址,也不要用一次失败的
                // 探测把人挡在配对码前面——检测脚本本身出问题的概率远高于防火墙配置错误的概率。
                if (error) {
                    console.warn('[Teleprompter] firewall probe failed:', error.message);
                    resolve(null);
                    return;
                }
                try {
                    resolve(JSON.parse(stdout));
                } catch {
                    resolve(null);
                }
            }
        );
    });
}

function parseFirewallRule(raw) {
    // pfn/svc 也要记:没有 App 但有 PFN 的规则是某个 UWP 包专用的,不是「任意程序」——漏了这条会把
    // 系统自带的包规则当成放行本程序,自检就永远通过,失去意义。
    const rule = { profiles: [], app: null, pfn: null, service: null, ports: null, protocol: null };
    for (const field of String(raw).split('|')) {
        const eq = field.indexOf('=');
        if (eq < 1) continue;
        const key = field.slice(0, eq).toLowerCase();
        const value = field.slice(eq + 1);
        if (key === 'profile') rule.profiles.push(value.toLowerCase());
        else if (key === 'app') rule.app = value;
        else if (key === 'pfn') rule.pfn = value;
        else if (key === 'svc') rule.service = value;
        else if (key === 'lport') rule.ports = value;
        else if (key === 'protocol') rule.protocol = value;
    }
    return rule;
}

function portListIncludes(list, port) {
    const text = String(list).trim().toLowerCase();
    if (text === 'any' || text === '*') return true;
    for (const part of text.split(',')) {
        const item = part.trim();
        const dash = item.indexOf('-');
        if (dash > 0) {
            const from = Number(item.slice(0, dash));
            const to = Number(item.slice(dash + 1));
            if (Number.isFinite(from) && Number.isFinite(to) && port >= from && port <= to) return true;
        } else if (Number(item) === port) {
            return true;
        }
    }
    return false;
}

// 一条入站放行规则是否覆盖「手机从 category 这类网络访问 port」。规则里没有 Profile 就是不限网络类型,
// 没有 App 就是不限程序;Protocol 缺省同样表示任意协议。
function ruleAllows(rule, category, exe, port) {
    if (rule.profiles.length && !rule.profiles.includes(category.toLowerCase())) return false;
    const protocol = (rule.protocol || '').toLowerCase();
    if (protocol && !['6', 'tcp', 'any', '256'].includes(protocol)) return false;
    if (rule.ports && !portListIncludes(rule.ports, port)) return false;
    if (!rule.app) return !rule.pfn && !rule.service;
    const normalize = value => value.replace(/^"|"$/g, '').replace(/\//g, '\\').toLowerCase();
    return normalize(rule.app) === normalize(exe);
}

// 进入「电脑+移动端」页时的自检:服务在跑、有局域网地址、防火墙放行。前两条是本机就能确定的;防火墙
// 只对 Windows 做,而且只检查「手机可能进来的那几张网卡」对应的网络类型(公用/专用),不同网卡的类型
// 互相独立,不能拿另一张卡的放行规则来证明这张卡通。AP 隔离发生在路由器上,电脑侧探测不到,不在这里判断。
async function selfCheck() {
    const running = Boolean(port);
    const paired = [...clients].some(client => client.authed && client.ws.readyState === 1);
    const addresses = running ? listLanAddresses() : [];
    const result = {
        ok: false,
        running,
        paired,
        urls: addresses.map(item => item.url),
        failures: [],
        firewall: 'skipped',
        networkCategories: [],
    };

    if (!running) result.failures.push('service-down');
    else if (!addresses.length) result.failures.push('no-lan-address');

    // 手机已经连上,就不该再被防火墙探测拦住;探测本身也可能误判,所以这三种情况直接按「服务可用」处理。
    if (!running || !addresses.length || paired || process.platform !== 'win32') {
        result.ok = result.failures.length === 0;
        if (running && addresses.length) result.firewall = 'unknown';
        return result;
    }

    const probe = await runFirewallProbe();
    if (!probe) {
        result.firewall = 'unknown';
        result.ok = true;
        return result;
    }

    // 只认和候选地址同一张网卡的网络类型。虚拟网卡/已断开网卡的残留地址查不到网络配置,查不到就放行。
    // 域网络在连接配置里叫 DomainAuthenticated,防火墙配置里叫 Domain,不归一化会永远匹配不上规则。
    const interfaces = new Set(addresses.map(item => item.name));
    const categories = [
        ...new Set(
            probe.networks
                .filter(item => interfaces.has(item.alias))
                .map(item => (item.category === 'DomainAuthenticated' ? 'Domain' : item.category))
        ),
    ];
    result.networkCategories = categories;
    if (!categories.length) {
        result.firewall = 'unknown';
        result.ok = true;
        return result;
    }

    const rules = (probe.rules || []).map(parseFirewallRule);
    const exe = process.execPath;
    const reachable = categories.some(category => {
        if (probe.profiles[category] === false) return true;
        return rules.some(rule => ruleAllows(rule, category, exe, port));
    });

    result.firewall = reachable ? 'pass' : 'blocked';
    if (!reachable) result.failures.push('firewall');
    result.ok = reachable;
    return result;
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
}

// 只放行 localhost 与 IP 字面量(含 IPv6,形如 [::1]:8765)。攻击面是 DNS rebinding:恶意网页把自己的域名
// 解析到本机的局域网地址,再以「同源」方式请求本服务读取响应;此时浏览器发出的 Host 是那个域名,而非 IP,
// 这一步就把它挡在门外。合法用户看到的地址本来就是 IP,不受影响。
function hostAllowed(hostHeader) {
    if (!hostHeader) return false;
    const ipv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(hostHeader);
    const host = ipv6 ? ipv6[1] : hostHeader.replace(/:\d+$/, '');
    return host === 'localhost' || net.isIP(host) !== 0;
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
    // 只接受 JSON。text/plain 这类「简单请求」不触发 CORS 预检,是 DNS rebinding 里常用的载体;配合上面的
    // Host 校验,rebinding 才被真正挡死。
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        sendJson(res, 415, { error: 'unsupported-media-type' });
        return;
    }

    const ip = req.socket.remoteAddress || '';
    const state = pairState.get(ip) || { attempts: 0, lockedUntil: 0 };
    if (Date.now() < state.lockedUntil) {
        sendJson(res, 429, { error: 'locked', retryAfterMs: state.lockedUntil - Date.now() });
        return;
    }

    let body = '';
    req.on('data', chunk => {
        body += chunk;
        // 配对请求只可能是 {code} 这么点东西,超了就直接断,不给它机会撑爆缓冲。
        if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
        let code = '';
        try {
            code = String(JSON.parse(body).code || '');
        } catch {
            code = '';
        }

        if (code !== pairingCode) {
            state.attempts += 1;
            if (state.attempts >= MAX_PAIR_ATTEMPTS) {
                // 刷够次数就换码(顺带让可能已泄露的旧码失效),并只锁这个 IP。
                rotateCode();
                state.lockedUntil = Date.now() + PAIR_LOCK_MS;
                state.attempts = 0;
            }
            pairState.set(ip, state);
            sendJson(res, 401, { error: 'bad-code' });
            return;
        }

        pairState.delete(ip);
        sendJson(res, 200, { token: ensureToken(), lang: storage.getPreferences().uiLanguage || 'zh-CN' });
    });
}

function handleRequest(req, res) {
    if (!hostAllowed(req.headers.host)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }

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

    // 动态路由:主题令牌由渲染端推来,不能进静态表。手机页用 <link> 引它,打开时取一次。
    if (req.method === 'GET' && pathname === '/theme.css') {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
        res.end(themeCss());
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

function handleSocket(ws, req) {
    // 与 HTTP 同一道门:Host 不是本机 IP/localhost 就断开,堵住经由 WebSocket 的 DNS rebinding。
    if (!hostAllowed(req && req.headers ? req.headers.host : '')) {
        ws.close();
        return;
    }

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
            // 先把当前会话模式补上(它可能已滚出回放窗口),再补事件:手机一睁眼就该是正确的那一页。
            // 本进程还没开过会话(可能刚重启)就明确发一次面试态,免得页面停在上一轮的笔试布局里。
            ws.send(JSON.stringify(sessionModeEvent || { channel: 'session-mode', data: { mode: '', paused: false } }));
            if (lastStatus) ws.send(JSON.stringify({ channel: 'update-status', data: lastStatus }));
            // 回放区间用标记包起来:手机端据此知道这一段是补历史,不据此重建问题占位块——块早就存在,
            // 重建会让同一个轮次出现两份、导航条数也对不上。
            if (replay.length) {
                ws.send(JSON.stringify({ type: 'replay-start' }));
                for (const event of replay) {
                    ws.send(JSON.stringify(event));
                }
                ws.send(JSON.stringify({ type: 'replay-end' }));
            }
            return;
        }

        // 指令只认已鉴权的连接。否则同网段任何人都能让桌面截图——那等于把屏幕内容喂给攻击者。
        if (message.type === 'command' && client.authed && COMMANDS.has(message.action)) {
            if (commandHandler) commandHandler(message.action);
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
    sessionModeEvent = null;
    lastStatus = null;

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

    console.log('Teleprompter listening on', listLanAddresses().map(item => item.url));
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
    sessionModeEvent = null;
    lastStatus = null;
    if (wss) wss.close();
    if (server) server.close();
    wss = null;
    server = null;
    port = null;
    pairingCode = null;
    pairState.clear();
}

// sendToRenderer 的唯一旁路点:白名单之外的一切在这里被丢掉。
function broadcast(channel, data) {
    if (!FORWARDED_CHANNELS.has(channel)) return;

    const event = { channel, data };
    if (channel === 'session-mode') sessionModeEvent = event;
    if (channel === 'update-status') lastStatus = data;
    replay.push(event);
    if (replay.length > REPLAY_LIMIT) replay.shift();

    const payload = JSON.stringify(event);
    for (const client of clients) {
        if (client.authed && client.ws.readyState === 1) {
            // 背压:客户端卡住(锁屏、切后台、网络半死)时 ws.send 只会往 bufferedAmount 里堆,流式回答推得
            // 越多,主进程内存涨得越多。超阈就断开——手机会自动重连,回放窗口足以把画面补齐。
            if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
                client.ws.close();
                continue;
            }
            client.ws.send(payload);
        }
    }
}

function getStatus() {
    // paired:当前有没有已鉴权的手机连着。桌面主页靠它决定「开始面试 / 开始笔试」能不能按——这一模式里手机才是显示端,
    // 没配对就开会话等于对着一个没人看的窗口说话。
    const paired = [...clients].some(client => client.authed && client.ws.readyState === 1);
    const addresses = port ? listLanAddresses() : [];
    return {
        running: Boolean(port),
        port,
        urls: addresses.map(item => item.url),
        code: pairingCode || '',
        paired,
    };
}

function regenerateCode() {
    rotateCode();
    pairState.clear();
    return getStatus();
}

module.exports = { startTeleprompter, stopTeleprompter, broadcast, getStatus, selfCheck, regenerateCode, setCommandHandler, setTheme };
