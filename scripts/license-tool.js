const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const root = path.join(__dirname, '..');
const privateDir = path.join(root, '.license-private');
const privateKeyPath = path.join(privateDir, 'private-key.pem');
const publicKeyPath = path.join(root, 'src', 'license', 'public-key.pem');
const PRODUCT_ID = 'offerhunter-cheating-daddy';

function encode(value) {
    return Buffer.from(value).toString('base64url');
}

function decodeChallenge(challenge) {
    const normalized = challenge.trim().replace(/\s+/g, '');
    const [prefix, data, extra] = normalized.split('.');
    if (prefix !== 'CDCH1' || !data || extra) throw new Error('挑战码格式无效');
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.v !== 1 || payload.product !== PRODUCT_ID || !payload.deviceId || !payload.nonce) throw new Error('挑战码内容无效');
    return payload;
}

function initializeKeys() {
    if (fs.existsSync(privateKeyPath)) throw new Error(`私钥已经存在：${privateKeyPath}`);
    const password = process.env.LICENSE_KEY_PASSWORD;
    const privateKeyEncoding = password
        ? { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: password }
        : { type: 'pkcs8', format: 'pem' };
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
        privateKeyEncoding,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    fs.mkdirSync(privateDir, { recursive: true });
    fs.mkdirSync(path.dirname(publicKeyPath), { recursive: true });
    fs.writeFileSync(privateKeyPath, privateKey, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(publicKeyPath, publicKey, 'utf8');
    fs.writeFileSync(
        path.join(privateDir, 'README.txt'),
        'private-key.pem 是唯一能够签发激活码的私钥。不要发送、提交或打包它；请另做加密离线备份。\r\n双击“生成激活码.cmd”，依次粘贴挑战码、客户名称和订单编号。\r\n',
        'utf8'
    );
    fs.writeFileSync(
        path.join(privateDir, '生成激活码.cmd'),
        '@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0.."\r\nnpm run license:generate\r\npause\r\n',
        'utf8'
    );
    console.log(`密钥已生成。\n私钥（保密）：${privateKeyPath}\n公钥（随客户端发布）：${publicKeyPath}`);
}

async function generateLicense() {
    if (!fs.existsSync(privateKeyPath)) throw new Error('未找到私钥，请先运行 npm run license:init');
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
        const challenge = decodeChallenge(await rl.question('粘贴用户的挑战码：'));
        const customer = (await rl.question('客户名称（可留空）：')).trim();
        const orderId = (await rl.question('订单编号（可留空）：')).trim();
        const payload = {
            v: 1,
            product: PRODUCT_ID,
            deviceId: challenge.deviceId,
            nonce: challenge.nonce,
            issuedAt: new Date().toISOString(),
            ...(customer ? { customer } : {}),
            ...(orderId ? { orderId } : {}),
        };
        const payloadPart = encode(JSON.stringify(payload));
        const privateKeyOptions = {
            key: fs.readFileSync(privateKeyPath, 'utf8'),
            format: 'pem',
        };
        if (process.env.LICENSE_KEY_PASSWORD) privateKeyOptions.passphrase = process.env.LICENSE_KEY_PASSWORD;
        const privateKey = crypto.createPrivateKey(privateKeyOptions);
        const signature = crypto.sign(null, Buffer.from(payloadPart, 'utf8'), privateKey).toString('base64url');
        console.log(`\n激活码：\nCDLIC1.${payloadPart}.${signature}\n`);
    } finally {
        rl.close();
    }
}

async function main() {
    const command = process.argv[2];
    if (command === 'init') return initializeKeys();
    if (command === 'generate') return generateLicense();
    throw new Error('用法：npm run license:init 或 npm run license:generate');
}

main().catch(error => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
});
