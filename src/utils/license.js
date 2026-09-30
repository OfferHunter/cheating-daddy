const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PRODUCT_ID = 'offerhunter-cheating-daddy';
const CHALLENGE_PREFIX = 'CDCH1';
const LICENSE_PREFIX = 'CDLIC1';
const MAX_CODE_LENGTH = 16 * 1024;

function base64UrlEncode(value) {
    return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
    return Buffer.from(value, 'base64url');
}

function getRawMachineId() {
    try {
        if (process.platform === 'win32') {
            const output = execFileSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
                encoding: 'utf8',
                windowsHide: true,
            });
            const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
            if (match) return match[1].trim();
        }

        if (process.platform === 'linux') {
            for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
                if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
            }
        }

        if (process.platform === 'darwin') {
            const output = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
            const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
            if (match) return match[1];
        }
    } catch (error) {
        console.warn('Could not read the operating system machine identifier:', error.message);
    }

    // This is less durable than the OS identifier, but keeps activation usable on unusual systems.
    return [os.hostname(), os.platform(), os.arch(), os.cpus()[0]?.model || 'unknown'].join('|');
}

function getDeviceId() {
    const digest = crypto.createHash('sha256').update(`${PRODUCT_ID}|${getRawMachineId()}`).digest('hex').slice(0, 32).toUpperCase();
    return digest.match(/.{1,4}/g).join('-');
}

function getLicensePath(configDir) {
    return path.join(configDir, 'license.json');
}

function getChallengePath(configDir) {
    return path.join(configDir, 'activation-challenge.json');
}

function getOrCreateChallenge(configDir) {
    const challengePath = getChallengePath(configDir);
    let nonce = '';

    try {
        const saved = JSON.parse(fs.readFileSync(challengePath, 'utf8'));
        if (typeof saved.nonce === 'string' && saved.nonce.length >= 16) nonce = saved.nonce;
    } catch {}

    if (!nonce) {
        nonce = crypto.randomBytes(18).toString('base64url');
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(challengePath, JSON.stringify({ nonce }, null, 2), 'utf8');
    }

    const payload = { v: 1, product: PRODUCT_ID, deviceId: getDeviceId(), nonce };
    return `${CHALLENGE_PREFIX}.${base64UrlEncode(JSON.stringify(payload))}`;
}

function parseLicenseCode(code) {
    if (typeof code !== 'string' || code.length > MAX_CODE_LENGTH) throw new Error('激活码格式无效');
    const normalized = code.trim().replace(/\s+/g, '');
    const parts = normalized.split('.');
    if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) throw new Error('激活码格式无效');

    let payload;
    try {
        payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
    } catch {
        throw new Error('激活码内容无效');
    }
    return { normalized, payloadPart: parts[1], signature: base64UrlDecode(parts[2]), payload };
}

function verifyLicenseCode(code, publicKeyPem, configDir) {
    try {
        const parsed = parseLicenseCode(code);
        const validSignature = crypto.verify(null, Buffer.from(parsed.payloadPart, 'utf8'), publicKeyPem, parsed.signature);
        if (!validSignature) return { valid: false, error: '激活码签名无效' };

        const challenge = getOrCreateChallenge(configDir);
        const expectedChallenge = challenge.slice(challenge.indexOf('.') + 1);
        const expected = JSON.parse(base64UrlDecode(expectedChallenge).toString('utf8'));
        if (
            parsed.payload?.v !== 1 ||
            parsed.payload?.product !== PRODUCT_ID ||
            parsed.payload?.deviceId !== expected.deviceId ||
            parsed.payload?.nonce !== expected.nonce
        ) {
            return { valid: false, error: '该激活码不属于这台设备' };
        }

        return { valid: true, license: parsed.payload, normalized: parsed.normalized };
    } catch (error) {
        return { valid: false, error: error.message || '激活码无效' };
    }
}

function readPublicKey() {
    return fs.readFileSync(path.join(__dirname, '../license/public-key.pem'), 'utf8');
}

function getLicenseStatus(configDir) {
    try {
        const saved = JSON.parse(fs.readFileSync(getLicensePath(configDir), 'utf8'));
        const result = verifyLicenseCode(saved.code, readPublicKey(), configDir);
        return result.valid ? { valid: true, license: result.license } : result;
    } catch {
        return { valid: false, error: '尚未激活' };
    }
}

function installLicense(code, configDir) {
    const result = verifyLicenseCode(code, readPublicKey(), configDir);
    if (!result.valid) return result;

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(getLicensePath(configDir), JSON.stringify({ code: result.normalized }, null, 2), { encoding: 'utf8', mode: 0o600 });
    return { valid: true, license: result.license };
}

module.exports = {
    PRODUCT_ID,
    CHALLENGE_PREFIX,
    LICENSE_PREFIX,
    base64UrlEncode,
    base64UrlDecode,
    getDeviceId,
    getOrCreateChallenge,
    getLicenseStatus,
    installLicense,
};
