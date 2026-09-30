const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
    const events = [];
    const session = { module: { exports: {} }, console: { log() {} }, require(name) {
        if (name === 'electron') return { BrowserWindow: { getAllWindows: () => [{ webContents: { send: (channel, data) => events.push({ channel, data }) } }] } };
        return {};
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/utils/session'), 'utf8') + '\ncurrentSessionId = "test-session";', session);
    const context = { module: { exports: {} }, Buffer, console: { log() {} }, require(name) {
        if (name === '../defaults') return require('../src/defaults');
        if (name === './session') return session.module.exports;
        return {};
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/utils/pipeline'), 'utf8') + `
        isLocalActive = true;
        module.exports.fragment = text => { streams[CANDIDATE].turnText = text; flushTurn(CANDIDATE); };
        module.exports.interim = text => { streams[CANDIDATE].interimText = text; };
        module.exports.commit = commitCandidateSpeech;
    `, context);
    return {
        pipeline: context.module.exports,
        history: () => events.filter(event => event.channel === 'save-candidate-speech').at(-1)?.data.fullHistory || [],
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
