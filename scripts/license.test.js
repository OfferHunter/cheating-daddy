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

    assert.deepEqual(format.verifyCodeWithKey(code, machineCode, publicKey), { ok: true, expiresAt: null });

    const otherMachine = format.formatMachineCode(crypto.createHash('sha256').update('other').digest().subarray(0, 16));
    assert.deepEqual(format.verifyCodeWithKey(code, otherMachine, publicKey), { ok: false, reason: 'machine' });

    assert.deepEqual(format.verifyCodeWithKey(code + 'x', machineCode, publicKey), { ok: false, reason: 'format' });
    assert.deepEqual(format.verifyCodeWithKey(code.slice(0, -3) + 'AAA', machineCode, publicKey), { ok: false, reason: 'signature' });
    assert.deepEqual(format.verifyCodeWithKey('garbage', machineCode, publicKey), { ok: false, reason: 'format' });
});

test('带到期日的激活码把到期时间写进签名，改不动', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const machineCode = format.formatMachineCode(SAMPLE);
    // 用整秒构造，验签回来应还原成同一毫秒时间戳。
    const expiresAt = 1830000000 * 1000;
    const code = format.signCode(machineCode, privateKey, expiresAt);

    assert.deepEqual(format.verifyCodeWithKey(code, machineCode, publicKey), { ok: true, expiresAt });

    // 把 payload 里的到期秒改大（想续命）会让签名失配。
    const tampered = code.replace('.1830000000.', '.2099000000.');
    assert.deepEqual(format.verifyCodeWithKey(tampered, machineCode, publicKey), { ok: false, reason: 'signature' });
});

test('终身码到期字段为 0，isExpired 永不为真', () => {
    assert.equal(format.isExpired(null, Date.now()), false);
    assert.equal(format.isExpired(null, Number.MAX_SAFE_INTEGER), false);
    assert.equal(format.isExpired(Date.now() - 1), true);
    assert.equal(format.isExpired(Date.now() + 60_000), false);
});

test('旧 OH1 激活码仍验得过，且当作终身', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const machineCode = format.formatMachineCode(SAMPLE);
    // 模拟改版前发出的码：payload 不带到期字段。
    const payload = `OH1.${machineCode}`;
    const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url');
    const code = `${payload}.${signature}`;

    assert.deepEqual(format.verifyCodeWithKey(code, machineCode, publicKey), { ok: true, expiresAt: null });
});

// 只有当签名私钥在本机（未被 gitignore 掉的那台）时才跑：这条守住"内嵌公钥必须与 .license-private 里的私钥配对"。
test('内嵌公钥与本机私钥配对', { skip: !fs.existsSync(path.join(__dirname, '..', '.license-private', 'private-key.pem')) }, () => {
    const license = require('../src/utils/license');
    const privateKey = crypto.createPrivateKey(fs.readFileSync(path.join(__dirname, '..', '.license-private', 'private-key.pem'), 'utf8'));

    const machineCode = license.getMachineCode();
    assert.ok(format.isValidMachineCode(machineCode), `生成的机器码应合法：${machineCode}`);

    const code = format.signCode(machineCode, privateKey);
    assert.deepEqual(license.verifyCode(code), { ok: true, expiresAt: null });
    assert.deepEqual(license.verifyCode(code, format.formatMachineCode(SAMPLE)), { ok: false, reason: 'machine' });
    // 已过期的码验签本身没问题（签名、机器都对），但要靠 isExpired 才拦得下。
    const expired = format.signCode(machineCode, privateKey, Date.now() - 1000);
    const expiredResult = license.verifyCode(expired);
    assert.equal(expiredResult.ok, true);
    assert.equal(format.isExpired(expiredResult.expiresAt), true);
});
