// 笔试自动截图的判定链验证:加载真实的 pipeline.js,只把主进程依赖换成桩,断言首帧直接作答、同一帧不重发、
// 比对请求的形状(两帧、关思考、16 token)、SAME/CHANGED 的分流、暂停与面试模式的守卫。
// 提示词和默认值用真模块:比对消息的内容必须和线上一致,桩一份提示词就等于没测。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const defaults = require('../src/defaults');
const prompts = require('../src/utils/prompts');

function loadPipeline() {
    const calls = [];
    const events = [];
    const savedDetails = [];
    // judgeReply 可以是字符串,也可以是 Error(模拟比对请求失败)。
    const state = { judgeReply: 'SAME', answerText: '答案' };

    const requestChat = async (messages, onChunk, options = {}) => {
        calls.push({ messages, options });
        if (options.maxTokens === 16) {
            if (state.judgeReply instanceof Error) throw state.judgeReply;
            return { text: state.judgeReply, finishReason: 'stop', rounds: 0 };
        }
        return { text: state.answerText, finishReason: 'stop', rounds: 0 };
    };

    const prefs = {
        knowledgeDir: '',
        promptOverrides: {},
        detailMode: true,
        briefThinking: false,
        detailThinking: false,
        screenshotThinking: false,
        screenshotSummary: true,
        audioInputDeviceId: 'none',
    };

    const context = {
        require: name => {
            switch (name) {
                case '../defaults':
                    return defaults;
                case './prompts':
                    return prompts;
                case './session':
                    return {
                        sendToRenderer: (channel, payload) => events.push({ channel, payload }),
                        initializeNewSession: () => {},
                        saveConversationTurn: () => {},
                        saveDetailTurn: (...args) => savedDetails.push(args),
                        saveCandidateSpeech: () => {},
                    };
                case './chat':
                    return { getChatModel: () => 'test-model', requestChat };
                case './knowledge':
                    return {
                        KNOWLEDGE_TOOL_NAME: 'kb',
                        KNOWLEDGE_TOOL_SPEC: {},
                        listKnowledgeEntries: () => [],
                        formatKnowledgeSummary: () => '',
                        readKnowledgeById: () => ({ ok: false, error: 'missing' }),
                        executeKnowledgeTool: () => 'missing',
                    };
                case './asr':
                    return { createRealtimeAsr: () => ({ start() {}, close() {}, sendAudio() {} }) };
                case './transportLogger':
                    return { logTransportEvent: () => {} };
                case '../storage':
                    return {
                        getPreferences: () => prefs,
                        getMaxSentenceSilenceMs: () => 1500,
                        getMicMaxSentenceSilenceMs: () => 2000,
                        getMicGateDb: () => -45,
                        getMicGateDwellMs: () => 300,
                        getChatContextTurns: () => 15,
                    };
                default:
                    throw new Error('unexpected require: ' + name);
            }
        },
        module: { exports: {} },
        Buffer,
        console: { log() {}, warn() {}, error() {} },
        setTimeout,
        clearTimeout,
    };

    const source = fs.readFileSync(require.resolve('../src/utils/pipeline'), 'utf8');
    vm.runInNewContext(source, context, { filename: 'pipeline.js' });
    return { pipeline: context.module.exports, calls, events, savedDetails, state };
}

// 作答链是 fire-and-forget 的 IIFE,让它把请求发出去、把完成事件收完再断言。
const drain = () => new Promise(resolve => setImmediate(resolve));
const isJudge = call => call.options.maxTokens === 16;
const isAnswer = call => !isJudge(call);
const statuses = events => events.filter(e => e.channel === 'update-status').map(e => e.payload);

test('the first written frame is answered without a comparison request', async () => {
    const h = loadPipeline();
    h.pipeline.initializeChatSession(null, 'written');

    const result = await h.pipeline.autoScreenshot('frameA');
    assert.deepEqual({ ...result }, { success: true, changed: true, first: true });
    await drain();

    assert.equal(h.calls.filter(isJudge).length, 0);
    const answers = h.calls.filter(isAnswer);
    assert.equal(answers.length, 1);
    // 截图作答链关掉思考,且消息里带的是当前帧。
    assert.equal(answers[0].options.thinking, false);
    // vm 里造出来的数组不是本 realm 的 Array,先转成宿主数组再比。
    assert.deepEqual(
        Array.from(answers[0].messages.at(-1).content.filter(part => part.type === 'image_url').map(part => part.image_url.url)),
        ['data:image/jpeg;base64,frameA']
    );
});

test('an identical frame is skipped without any request and the baseline stays put', async () => {
    const h = loadPipeline();
    h.pipeline.initializeChatSession(null, 'written');
    await h.pipeline.autoScreenshot('frameA');
    await drain();
    const before = h.calls.length;

    const result = await h.pipeline.autoScreenshot('frameA');
    assert.equal(result.changed, false);
    assert.equal(h.calls.length, before);
});

test('a new frame is compared against the last answered frame with both images', async () => {
    const h = loadPipeline();
    h.pipeline.initializeChatSession(null, 'written');
    await h.pipeline.autoScreenshot('frameA');
    await drain();
    h.state.judgeReply = 'SAME';

    const result = await h.pipeline.autoScreenshot('frameB');
    assert.equal(result.changed, false);

    const judge = h.calls.filter(isJudge).at(-1);
    assert.equal(judge.options.thinking, false);
    assert.equal(judge.options.maxTokens, 16);
    assert.equal(judge.messages[0].content, prompts.getScreenChangePrompt());
    assert.deepEqual(
        Array.from(judge.messages[1].content.filter(part => part.type === 'image_url').map(part => part.image_url.url)),
        ['data:image/jpeg;base64,frameA', 'data:image/jpeg;base64,frameB']
    );
});

test('CHANGED answers the new frame, then the baseline advances to it', async () => {
    const h = loadPipeline();
    h.pipeline.initializeChatSession(null, 'written');
    await h.pipeline.autoScreenshot('frameA');
    await drain();
    h.state.judgeReply = 'CHANGED';

    const result = await h.pipeline.autoScreenshot('frameC');
    assert.equal(result.changed, true);
    await drain();

    assert.equal(h.calls.filter(isAnswer).length, 2);
    // 首帧和变化后的帧各落一条详细回答。
    assert.equal(h.savedDetails.length, 2);
    // 作答完成后状态行回到等待题目,而不是卡在「正在分析图像…」。
    assert.equal(statuses(h.events).at(-1), 'Waiting for the question...');

    // 基线已推进到 frameC:同一帧再拍一拍,连比对请求都不发。
    const judgeCount = h.calls.filter(isJudge).length;
    const again = await h.pipeline.autoScreenshot('frameC');
    assert.equal(again.changed, false);
    assert.equal(h.calls.filter(isJudge).length, judgeCount);
});

test('a frame without a complete question keeps the previous answer', async () => {
    const h = loadPipeline();
    h.pipeline.initializeChatSession(null, 'written');
    await h.pipeline.autoScreenshot('frameA');
    await drain();
    h.state.judgeReply = 'NO_QUESTION';

    const result = await h.pipeline.autoScreenshot('frameB');
    assert.equal(result.changed, false);
    assert.equal(result.skipped, 'no-question');
    assert.equal(h.calls.filter(isAnswer).length, 1);

    // 基线没有被「没有题目的帧」推进:下一帧仍然和 frameA 比。
    h.state.judgeReply = 'CHANGED';
    await h.pipeline.autoScreenshot('frameC');
    const judge = h.calls.filter(isJudge).at(-1);
    assert.equal(judge.messages[1].content[1].image_url.url, 'data:image/jpeg;base64,frameA');
});

test('manual send combines cached frames with the current one in order', async () => {
    const h = loadPipeline();
    h.pipeline.initializeChatSession(null, 'written');

    const result = await h.pipeline.sendLocalImage(['cachedA', 'cachedB', 'currentC']);
    assert.equal(result.success, true);
    await drain();

    // 笔试不发概述请求:只有一条详细作答。
    assert.equal(h.calls.length, 1);
    const content = h.calls[0].messages.at(-1).content;
    assert.deepEqual(
        Array.from(content.filter(part => part.type === 'image_url').map(part => part.image_url.url)),
        ['data:image/jpeg;base64,cachedA', 'data:image/jpeg;base64,cachedB', 'data:image/jpeg;base64,currentC']
    );
    assert.ok(Array.from(content).some(part => part.type === 'text' && part.text.includes('3 张连续截图')));
    // 笔试不写对话记录,只落详细回答。
    assert.equal(h.savedDetails.length, 1);
});

test('a failed comparison counts as unchanged so the same question is not re-answered', async () => {
    const h = loadPipeline();
    h.pipeline.initializeChatSession(null, 'written');
    await h.pipeline.autoScreenshot('frameA');
    await drain();
    h.state.judgeReply = new Error('network down');

    const result = await h.pipeline.autoScreenshot('frameB');
    assert.equal(result.changed, false);
    assert.equal(h.calls.filter(isAnswer).length, 1);
});

test('a paused written session skips the frame', async () => {
    const h = loadPipeline();
    h.pipeline.initializeChatSession(null, 'written');
    await h.pipeline.autoScreenshot('frameA');
    await drain();
    const before = h.calls.length;

    h.pipeline.setPaused(true);
    const result = await h.pipeline.autoScreenshot('frameB');
    assert.equal(result.changed, false);
    assert.equal(result.skipped, 'paused');
    assert.equal(h.calls.length, before);

    // 恢复后仍会和「上一次答过的那一帧」比,暂停期间的帧没有悄悄变成基线。
    h.pipeline.setPaused(false);
    h.state.judgeReply = 'SAME';
    await h.pipeline.autoScreenshot('frameB');
    const judge = h.calls.filter(isJudge).at(-1);
    assert.equal(judge.messages[1].content[1].image_url.url, 'data:image/jpeg;base64,frameA');
});

test('auto screenshot refuses to run outside a written session', async () => {
    const h = loadPipeline();
    h.pipeline.initializeChatSession(null, 'interview');

    const result = await h.pipeline.autoScreenshot('frameA');
    assert.equal(result.success, false);
    assert.equal(result.error, 'Not a written session');
    assert.equal(h.calls.length, 0);
});
