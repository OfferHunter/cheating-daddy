const util = require('util');

// 日志里最没用的一条是 `TypeError: fetch failed`：真正的原因（ENOTFOUND、ECONNREFUSED、连接被重置、
// 证书错误）在 error.cause 里，而 .stack 不带它。这里把 Error 展开成「栈 + cause 链 + 诊断字段」，
// 主进程的落盘日志和渲染端的转发日志共用同一份格式。
const INSPECT_OPTIONS = { depth: 5, breakLength: Infinity, maxArrayLength: 100 };
// 这些字段只有错误对象上有，且 stack 里通常没有：undici 的连接失败、Node 的 fs/网络错误都靠它们区分。
const DETAIL_KEYS = ['code', 'errno', 'syscall', 'address', 'port', 'status'];

// DOMException 不是 Error 的子类（getUserMedia 的 NotAllowedError 就是它），但同样有 name/message/stack，
// 按 Error 处理才能把名字和消息都带出来，而不是 JSON.stringify 成一个空对象。
function isErrorLike(value) {
    return (
        value instanceof Error ||
        (value !== null &&
            typeof value === 'object' &&
            typeof value.message === 'string' &&
            typeof value.name === 'string' &&
            typeof value.stack === 'string')
    );
}

function describeSingle(error) {
    const lines = [error.stack || `${error.name}: ${error.message}`];
    for (const key of DETAIL_KEYS) {
        const value = error[key];
        if (value !== undefined && value !== null) lines.push(`${key}: ${value}`);
    }
    // AggregateError：双栈并发连接时 undici 会把每个地址各自的失败原因放在这里，主错误本身只有一句
    // fetch failed。
    if (Array.isArray(error.errors)) {
        error.errors.forEach((inner, index) => {
            const text = isErrorLike(inner) ? describeSingle(inner) : util.inspect(inner, INSPECT_OPTIONS);
            lines.push(`errors[${index}]: ${text}`);
        });
    }
    return lines.join('\n');
}

function describeError(error) {
    const seen = new Set();
    let text = '';
    let current = error;
    // cause 可以是任意值而不是 Error，也可能被指回自己。逐层展开并记住走过的对象，避免死循环。
    while (current !== undefined && current !== null) {
        if (seen.has(current)) {
            text += '\nCaused by: [circular]';
            break;
        }
        seen.add(current);
        const line = isErrorLike(current) ? describeSingle(current) : util.inspect(current, INSPECT_OPTIONS);
        text += (text ? '\nCaused by: ' : '') + line;
        current = current.cause;
    }
    return text;
}

module.exports = {
    describeError,
    isErrorLike,
};
