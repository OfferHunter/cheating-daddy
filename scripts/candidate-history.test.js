const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(preferences = {}) {
    const events = [];
    const asr = { created: 0, closed: 0 };
    const session = { module: { exports: {} }, console: { log() {} }, require(name) {
        if (name === 'electron') return { BrowserWindow: { getAllWindows: () => [{ webContents: { send: (channel, data) => events.push({ channel, data }) } }] } };
        // sendToRenderer 会把每条推送再交给手机提词器一份,这里只需要一个不炸的桩。
        if (name === './teleprompter') return { broadcast() {} };
        return {};
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/utils/session'), 'utf8') + '\ncurrentSessionId = "test-session";', session);
    const context = { module: { exports: {} }, Buffer, console: { log() {} }, require(name) {
        if (name === '../defaults') return require('../src/defaults');
        if (name === './session') return session.module.exports;
        if (name === '../storage') return { getPreferences: () => preferences };
        // 暂停恢复会按默认设置重连识别器，这里只需要一个不会真的联网的桩。
        if (name === './asr') return {
            createRealtimeAsr: () => {
                asr.created += 1;
                return { start() {}, sendAudio() {}, close() { asr.closed += 1; } };
            },
        };
        return {};
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/utils/pipeline'), 'utf8') + `
        isLocalActive = true;
        module.exports.fragment = text => { streams[CANDIDATE].turnText = text; flushTurn(CANDIDATE); };
        module.exports.interim = text => { streams[CANDIDATE].interimText = text; };
        module.exports.commit = commitCandidateSpeech;
        module.exports.connect = startAsrClients;
    `, context);
    return {
        pipeline: context.module.exports,
        history: () => events.filter(event => event.channel === 'save-candidate-speech').at(-1)?.data.fullHistory || [],
        asr,
    };
}

test('final microphone utterance is saved immediately, without a following question', () => {
    const { pipeline, history } = harness();
    pipeline.fragment('这是我的最后一句话');
    assert.equal(history()[0].text, '这是我的最后一句话');
    pipeline.closeLocalSession();
    assert.equal(history().length, 1);
});

test('fragments update the same history block and a new block stays separate', () => {
    const { pipeline, history } = harness();
    pipeline.fragment('这是我的回答');
    pipeline.fragment('还有一些补充');
    assert.equal(history().length, 1);
    assert.equal(history()[0].text, '这是我的回答还有一些补充');
    pipeline.commit();
    pipeline.fragment('这是下一段回答');
    pipeline.closeLocalSession();
    assert.equal(history().length, 2);
    assert.ok(history()[0].order < history()[1].order);
});

test('a short microphone fragment is archived even though it stays off screen', () => {
    const { pipeline, history } = harness();
    pipeline.fragment('好。');
    assert.equal(history()[0].text, '好。');
});

test('ending a session saves the recognized interim tail exactly once', () => {
    const { pipeline, history } = harness();
    pipeline.interim('还没有定稿的最后一句');
    pipeline.closeLocalSession();
    pipeline.closeLocalSession();
    assert.equal(history().length, 1);
    assert.equal(history()[0].text, '还没有定稿的最后一句');
});

test('pause preserves the tail and resume starts a separate speech block', () => {
    const { pipeline, history } = harness();
    pipeline.interim('暂停之前说的话');
    pipeline.setPaused(true);
    assert.equal(history()[0].text, '暂停之前说的话');
    pipeline.setPaused(false);
    pipeline.fragment('恢复以后说的话');
    assert.equal(history().length, 2);
});

test('pause disconnects the transcriptions by default and resume reconnects them', () => {
    const { pipeline, asr } = harness();
    pipeline.connect();
    assert.equal(asr.created, 1);

    pipeline.setPaused(true);
    assert.equal(asr.closed, 1);

    pipeline.setPaused(false);
    assert.equal(asr.created, 2);
});

test('keeping the transcriptions connected while paused is opt-out', () => {
    const { pipeline, asr } = harness({ pauseDisconnectsAsr: false });
    pipeline.connect();

    pipeline.setPaused(true);
    assert.equal(asr.closed, 0);

    pipeline.setPaused(false);
    assert.equal(asr.created, 1);
});
