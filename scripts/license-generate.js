// 签发侧工具：拿用户的机器码，用私钥签出激活码。这个脚本随"源码"一起发布也无所谓——它读的私钥在
// .license-private/ 里，那份永不进仓库、也不进安装包，所以别人拿到脚本也签不出码。
//
//   npm run license                      交互式：问机器码，再问有效期
//   npm run license -- <机器码>           交互式：只问有效期
//   npm run license -- <机器码> <天数|L>  全参数：末位是天数或 L（终身）
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { canonicalizeMachineCode, isValidMachineCode, signCode } = require('../src/utils/license-format');

const KEY_PATH = path.join(__dirname, '..', '.license-private', 'private-key.pem');
const DAY_MS = 24 * 60 * 60 * 1000;

function loadPrivateKey() {
    if (!fs.existsSync(KEY_PATH)) {
        console.error(`找不到私钥：${KEY_PATH}`);
        console.error('私钥不在仓库里，请从离线备份恢复到 .license-private/private-key.pem。');
        process.exit(1);
    }
    return crypto.createPrivateKey(fs.readFileSync(KEY_PATH, 'utf8'));
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => (rl.close(), resolve(answer))));
}

// 有效期输入：空或 L/lifetime/终身 = 终身；正整数 = 从今天起算的天数。
function parseValidity(input) {
    const value = String(input).trim();
    if (!value) return { ok: true, expiresAt: null, days: null };
    if (/^(l|lifetime|forever|终身|永久)$/i.test(value)) return { ok: true, expiresAt: null, days: null };
    if (/^\d+$/.test(value)) {
        const days = Number(value);
        if (days > 0) return { ok: true, expiresAt: Date.now() + days * DAY_MS, days };
    }
    return { ok: false };
}

// 命令行参数里，末位若是"天数 或 L"就当作有效期，剩下的才是机器码（机器码本身不含空格）。
function isValidityToken(token) {
    return /^\d+$/.test(token) || /^(l|lifetime|forever|终身|永久)$/i.test(token);
}

function describeValidity({ expiresAt, days }) {
    if (expiresAt == null) return '终身';
    return `${days} 天（到期 ${new Date(expiresAt).toISOString().slice(0, 10)}）`;
}

async function main() {
    const args = process.argv.slice(2);
    const validityArg = args.length && isValidityToken(args[args.length - 1]) ? args.pop() : null;
    let machineCode = args.join(' ').trim();

    if (!machineCode) machineCode = (await ask('机器码 (machine code): ')).trim();
    if (!machineCode) {
        console.error('未提供机器码。');
        process.exit(1);
    }

    // 校验位能挡住抄错一个字符的机器码，省掉一次"签完发回去才发现验不过"的往返。
    if (!isValidMachineCode(machineCode)) {
        console.error('机器码格式不正确（长度或校验位不对），请让用户重新复制，不要手打。');
        process.exit(1);
    }

    const validity = validityArg != null ? parseValidity(validityArg) : parseValidity(await ask('有效期：输入天数（如 365），或 L/回车 表示终身: '));
    if (!validity.ok) {
        console.error('有效期格式不正确，请输入正整数天数或 L。');
        process.exit(1);
    }

    const canonical = canonicalizeMachineCode(machineCode);
    const code = signCode(canonical, loadPrivateKey(), validity.expiresAt);
    console.log('');
    console.log('机器码:', canonical);
    console.log('有效期:', describeValidity(validity));
    console.log('激活码:');
    console.log(code);
    console.log('');
}

main();
