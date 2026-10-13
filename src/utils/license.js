// 离线激活：机器码是本机指纹，激活码是商家用私钥对它做的 Ed25519 签名。客户端只持公钥，验签即可，
// 不联网、不需要服务器。私钥永不进这里——它只在 .license-private/ 与签发脚本里。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const storage = require('../storage');
const format = require('./license-format');

// 与 .license-private/private-key.pem 配对的公钥。公钥进客户端是安全的：它只能验签，不能签发。
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEACMVZKbwD5cyDZIQr9KiLsT3wnT/O+d4CMoET2paqKd8=
-----END PUBLIC KEY-----
`;
const publicKey = crypto.createPublicKey(PUBLIC_KEY_PEM);

// Windows 的 MachineGuid 在装系统时生成，重装系统前一直不变，是这里最稳的锚点；换内存、换硬盘、换网卡都不动它，
// 所以拿它做绑定最"宽松"，用户几乎不会遇到要重新激活的情况。
function readMachineGuid() {
    if (process.platform !== 'win32') return '';
    try {
        const output = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
            encoding: 'utf8',
            windowsHide: true,
        });
        const match = output.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
        return match ? match[1].toLowerCase() : '';
    } catch {
        return '';
    }
}

function fingerprint() {
    const guid = readMachineGuid();
    if (guid) return `win|${guid}`;
    // 非 Windows 或读不到注册表时的兜底：仍有区分度，但主机名会被用户改，稳定性不如 MachineGuid。
    return [process.platform, os.arch(), os.hostname(), os.cpus()[0]?.model || ''].join('|');
}

function getMachineCode() {
    const digest = crypto.createHash('sha256').update(fingerprint()).digest();
    return format.formatMachineCode(digest.subarray(0, 16));
}

function getLicensePath() {
    return path.join(storage.getConfigDir(), 'license.json');
}

function readLicense() {
    try {
        return JSON.parse(fs.readFileSync(getLicensePath(), 'utf8'));
    } catch {
        return null;
    }
}

function writeLicense(data) {
    // Reuse storage's atomic writer so a crash mid-write cannot truncate license.json and silently
    // de-activate the machine.
    if (!storage.writeJsonFile(getLicensePath(), data)) {
        throw new Error('Failed to write license file');
    }
}

// 关键：永远拿"当前机器实时算出的机器码"去验签，而不是信 license.json 里存的那个。否则用户把整个配置目录
// 拷到另一台机器就能白嫖。存下来的机器码只用于展示/排查。
function verifyCode(code, machineCode = getMachineCode()) {
    return format.verifyCodeWithKey(code, machineCode, publicKey);
}

function isActivated() {
    const license = readLicense();
    if (!license || typeof license.code !== 'string') return false;
    const result = verifyCode(license.code);
    return result.ok && !format.isExpired(result.expiresAt);
}

function activate(code) {
    const machineCode = getMachineCode();
    const result = verifyCode(code, machineCode);
    if (!result.ok) return { success: false, error: result.reason };
    if (format.isExpired(result.expiresAt)) return { success: false, error: 'expired' };

    writeLicense({ machineCode, code: String(code).trim(), activatedAt: Date.now(), expiresAt: result.expiresAt });
    return { success: true };
}

module.exports = {
    getMachineCode,
    verifyCode,
    isActivated,
    activate,
    getLicensePath,
};
