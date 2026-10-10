const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const format = require('../src/utils/license-format');

const SAMPLE = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

test('机器码为 26 位数据加 1 位校验位，并分组显示', () => {
    const machineCode = format.formatMachineCode(SAMPLE);
    assert.match(machineCode, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}-[0-9A-Z]{2}$/);
    assert.equal(machineCode.replace(/-/g, '').length, 27);
    assert.ok(format.isValidMachineCode(machineCode));
});

test('规范化幂等，并容忍大小写、空格与 Crockford 易混字符', () => {
    const machineCode = format.formatMachineCode(SAMPLE);
    assert.equal(format.canonicalizeMachineCode(machineCode), machineCode);
    assert.equal(format.canonicalizeMachineCode(machineCode.toLowerCase()), machineCode);
    assert.equal(format.canonicalizeMachineCode(machineCode.replace(/-/g, ' ')), machineCode);
    // 用户可能把不用的 I/L 看错成 1、O 看错成 0。
    assert.equal(format.canonicalizeMachineCode(machineCode.replace(/1/g, 'I').replace(/0/g, 'O')), machineCode);
});

test('校验位能挡住单字符抄错', () => {
    const machineCode = format.formatMachineCode(SAMPLE);
    const raw = machineCode.replace(/-/g, '');
    const mutated = raw.slice(0, 5) + (raw[5] === 'A' ? 'B' : 'A') + raw.slice(6);
    assert.equal(format.isValidMachineCode(mutated), false);
});

test('同一机器码签名可验签，换机器或改动激活码都会失败', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const machineCode = format.formatMachineCode(SAMPLE);
    const code = format.signCode(machineCode, privateKey);

    assert.deepEqual(format.verifyCodeWithKey(code, machineCode, publicKey), { ok: true });

    const otherMachine = format.formatMachineCode(crypto.createHash('sha256').update('other').digest().subarray(0, 16));
    assert.deepEqual(format.verifyCodeWithKey(code, otherMachine, publicKey), { ok: false, reason: 'machine' });

    assert.deepEqual(format.verifyCodeWithKey(code + 'x', machineCode, publicKey), { ok: false, reason: 'format' });
    assert.deepEqual(format.verifyCodeWithKey(code.slice(0, -3) + 'AAA', machineCode, publicKey), { ok: false, reason: 'signature' });
    assert.deepEqual(format.verifyCodeWithKey('garbage', machineCode, publicKey), { ok: false, reason: 'format' });
});

// 只有当签名私钥在本机（未被 gitignore 掉的那台）时才跑：这条守住"内嵌公钥必须与 .license-private 里的私钥配对"。
test('内嵌公钥与本机私钥配对', { skip: !fs.existsSync(path.join(__dirname, '..', '.license-private', 'private-key.pem')) }, () => {
    const license = require('../src/utils/license');
    const privateKey = crypto.createPrivateKey(fs.readFileSync(path.join(__dirname, '..', '.license-private', 'private-key.pem'), 'utf8'));

    const machineCode = license.getMachineCode();
    assert.ok(format.isValidMachineCode(machineCode), `生成的机器码应合法：${machineCode}`);

    const code = format.signCode(machineCode, privateKey);
    assert.deepEqual(license.verifyCode(code), { ok: true });
    assert.deepEqual(license.verifyCode(code, format.formatMachineCode(SAMPLE)), { ok: false, reason: 'machine' });
});
