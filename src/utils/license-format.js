// 激活码的纯格式与签名逻辑。客户端 (license.js) 与签发脚本 (scripts/license-generate.js) 共用一份，
// 避免两处实现校验位或 payload 时慢慢走样。这里不读注册表、不读文件、不含任何私钥，只有 crypto 与字符串处理。
const crypto = require('crypto');

// Crockford Base32：去掉了 I、L、O、U，手抄或截图不容易混淆。
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// 激活码前缀兼版本号。payload 恒为 `<PREFIX>.<机器码>`，格式将来要变时改这里即可。
const PREFIX = 'OH1';
// 机器码 = 26 位数据 + 1 位校验位。
const DATA_CHARS = 26;

function base32Encode(buffer) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

// 一位加权校验字符：抄错任意一个字符，客户端当场就能报"格式不对"，省掉一次白跑签发的往返。
function checksumChar(dataChars) {
    let sum = 0;
    for (let i = 0; i < dataChars.length; i++) {
        sum = (sum + (i + 1) * ALPHABET.indexOf(dataChars[i])) % 32;
    }
    return ALPHABET[sum];
}

// 把一串无分隔字符按 5-5-5-5-5-2 分组，方便人念、抄。
function group(chars) {
    const groups = [];
    for (let i = 0; i < chars.length; i += 5) groups.push(chars.slice(i, i + 5));
    return groups.join('-');
}

// 用户抄来的机器码可能大小写不一、被 IM 插了空格、或把 Crockford 里本就不用的 I/L/O 看错成 1/0。
function sanitize(value) {
    return String(value)
        .toUpperCase()
        .replace(/[IL]/g, '1')
        .replace(/O/g, '0')
        .replace(/[^0-9A-Z]/g, '');
}

// 从 16 字节（128 位）生成客户端展示用的机器码。
function formatMachineCode(bytes16) {
    const data = base32Encode(bytes16);
    return group(data + checksumChar(data));
}

// 把任意形态的机器码归一成客户端展示的那种带连字符的规范形式。签发与核验都以这个形式为准。
function canonicalizeMachineCode(value) {
    return group(sanitize(value));
}

function isValidMachineCode(value) {
    const raw = sanitize(value);
    if (raw.length !== DATA_CHARS + 1) return false;
    if ([...raw].some(char => !ALPHABET.includes(char))) return false;
    return checksumChar(raw.slice(0, DATA_CHARS)) === raw[DATA_CHARS];
}

function payloadFor(machineCode) {
    return `${PREFIX}.${machineCode}`;
}

// 用私钥（仅签发侧有）对机器码签名，产出交给用户的激活码。
function signCode(machineCode, privateKey) {
    const payload = payloadFor(machineCode);
    const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey);
    return `${payload}.${signature.toString('base64url')}`;
}

// 用公钥核验激活码是否为本机签发。reason 供 UI 区分：format（格式坏）、machine（机器不符）、signature（签名不对）。
function verifyCodeWithKey(code, machineCode, publicKey) {
    if (typeof code !== 'string') return { ok: false, reason: 'format' };

    const parts = code.trim().split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: 'format' };
    if (parts[1] !== machineCode) return { ok: false, reason: 'machine' };

    const signature = Buffer.from(parts[2], 'base64url');
    if (signature.length !== 64) return { ok: false, reason: 'format' };

    try {
        return crypto.verify(null, Buffer.from(payloadFor(parts[1]), 'utf8'), publicKey, signature)
            ? { ok: true }
            : { ok: false, reason: 'signature' };
    } catch {
        return { ok: false, reason: 'signature' };
    }
}

module.exports = {
    ALPHABET,
    PREFIX,
    DATA_CHARS,
    base32Encode,
    checksumChar,
    formatMachineCode,
    canonicalizeMachineCode,
    isValidMachineCode,
    payloadFor,
    signCode,
    verifyCodeWithKey,
};
