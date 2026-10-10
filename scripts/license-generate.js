// 签发侧工具：拿用户的机器码，用私钥签出激活码。这个脚本随"源码"一起发布也无所谓——它读的私钥在
// .license-private/ 里，那份永不进仓库、也不进安装包，所以别人拿到脚本也签不出码。
//
//   npm run license:generate              交互式，粘贴机器码
//   npm run license:generate -- <机器码>   直接带参
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { canonicalizeMachineCode, isValidMachineCode, signCode } = require('../src/utils/license-format');

const KEY_PATH = path.join(__dirname, '..', '.license-private', 'private-key.pem');

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

async function main() {
    let machineCode = process.argv.slice(2).join(' ').trim();
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

    const code = signCode(canonicalizeMachineCode(machineCode), loadPrivateKey());
    console.log('');
    console.log('机器码:', canonicalizeMachineCode(machineCode));
    console.log('激活码:');
    console.log(code);
    console.log('');
}

main();
