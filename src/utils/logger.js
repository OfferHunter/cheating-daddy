const fs = require('fs');
const path = require('path');
const util = require('util');
const { getConfigDir } = require('../storage');
const { describeError, isErrorLike } = require('./errorText');

// 打包后没有终端，主进程的 console.* 全部无处可看——故障机上唯一能带回来的证据就是文件。所以这里不新增
// 一套 log.info()/log.error() 调用点，而是直接接管 console：现有成百条 console.* 一行不改就都落盘了。
// 装在 index.js 最前面，早于任何会打日志的模块加载。
const MAX_LOG_BYTES = 2 * 1024 * 1024;

let logFilePath = null;
let installed = false;
// 写日志自身若又触发 console（比如 fs 抛错时我们想记一条），会被重入。这个闸口让它记一次就够了。
let writing = false;

function getLogFilePath() {
    return path.join(getConfigDir(), 'logs', 'app.log');
}

// 只留一代历史：超过上限就把当前文件改名成 .1，新的从空开始。轮转失败不该挡住启动，退化成继续追加。
function rotateIfNeeded(filePath) {
    let size;
    try {
        size = fs.statSync(filePath).size;
    } catch {
        return;
    }
    if (size < MAX_LOG_BYTES) return;

    try {
        fs.rmSync(`${filePath}.1`, { force: true });
        fs.renameSync(filePath, `${filePath}.1`);
    } catch {
        // 忽略：原文件被占用时（杀软扫描等）继续往它追加即可。
    }
}

// Error 走 describeError：除了 stack（含错误名，NotAllowedError / NotFoundError 这类名字本身就是诊断关键），
// 还展开 cause 链和 code/errno 等字段——`fetch failed` 的真正原因只在那里。其余交给 util.inspect，它能吃
// 循环引用，JSON.stringify 会当场抛。
function stringify(value) {
    if (isErrorLike(value)) return describeError(value);
    if (typeof value === 'string') return value;
    return util.inspect(value, { depth: 5, breakLength: Infinity, maxArrayLength: 100 });
}

function appendLine(level, text) {
    if (!logFilePath) return;
    const line = `[${new Date().toISOString()}] ${level} ${text}\n`;
    try {
        fs.appendFileSync(logFilePath, line, 'utf8');
    } catch {
        // 记日志失败绝不能带走主流程。
    }
}

function install() {
    if (installed) return logFilePath;
    installed = true;
    logFilePath = getLogFilePath();

    try {
        fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
        rotateIfNeeded(logFilePath);
    } catch {
        // 目录建不出来时 appendLine 会静默失败，主流程照常。
    }

    const levels = { log: 'INFO', info: 'INFO', debug: 'DEBUG', warn: 'WARN', error: 'ERROR' };
    for (const [method, level] of Object.entries(levels)) {
        const original = console[method].bind(console);
        console[method] = (...args) => {
            original(...args);
            if (writing) return;
            writing = true;
            try {
                appendLine(level, args.map(stringify).join(' '));
            } finally {
                writing = false;
            }
        };
    }

    appendLine('INFO', `=== logger started, file=${logFilePath} ===`);
    return logFilePath;
}

module.exports = {
    install,
    getLogFilePath,
};
