const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// storage 的配置目录由 os.homedir() 决定：把 HOME/USERPROFILE 指到临时目录，绝不碰真实会话。
const ISOLATED = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-tmp-'));
fs.mkdirSync(path.join(ISOLATED, 'AppData', 'Roaming'), { recursive: true });
process.env.USERPROFILE = ISOLATED;
process.env.HOME = ISOLATED;

const storage = require('../src/storage');
const ID = '1790000000000';

test('rename survives later saves and shows up in the summary', () => {
    storage.initializeStorage();
    storage.saveSession(ID, { profile: 'interview', conversationHistory: [{ transcription: 'q', ai_response: 'a', order: 1 }] });
    assert.equal(storage.renameSession(ID, '  字节 一面 '), true);

    // 普通保存(例如新的麦克风发言)不能把名字冲掉。
    storage.saveSession(ID, { candidateHistory: [{ text: '我说的', order: 2, timestamp: 1 }] });
    const session = storage.getSession(ID);
    assert.equal(session.title, '字节 一面');
    assert.equal(session.candidateHistory.length, 1);
    assert.equal(storage.getAllSessions()[0].title, '字节 一面');

    // 名字参与搜索。
    assert.match(storage.getAllSessions()[0].searchText, /字节 一面/);
});

test('rename keeps unknown legacy fields instead of dropping them', () => {
    // 新的 id,避免碰到上一条用例在进程内缓存里的文件。
    const legacyId = '1790000000001';
    const legacy = {
        sessionId: legacyId,
        createdAt: Number(legacyId),
        lastUpdated: Number(legacyId),
        profile: 'interview',
        conversationHistory: [],
        detailHistory: [],
        candidateHistory: [],
        screenAnalysisHistory: [{ legacy: true }],
    };
    const file = path.join(
        ISOLATED,
        'AppData',
        'Roaming',
        'offer-hunter-config',
        'history',
        `${legacyId}.json`
    );
    fs.writeFileSync(file, JSON.stringify(legacy), 'utf8');
    assert.equal(storage.renameSession(legacyId, '旧会话'), true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(onDisk.screenAnalysisHistory, [{ legacy: true }]);
    assert.equal(onDisk.title, '旧会话');
});

test('empty rename clears the name back to the profile label', () => {
    assert.equal(storage.renameSession(ID, '   '), true);
    assert.equal(storage.getSession(ID).title, null);
    assert.equal(storage.getAllSessions().find(item => item.sessionId === ID).title, null);
});

test('rename rejects path-like ids and missing sessions', () => {
    assert.equal(storage.renameSession('../../evil', 'x'), false);
    assert.equal(storage.renameSession('1234567890123', 'x'), false);
});

test('export filename helper follows the stored name, then profile+date', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const start = source.indexOf('const PROFILE_FILE_LABELS');
    const end = source.indexOf('function setupStorageIpcHandlers');
    assert.ok(start > 0 && end > start);
    const build = new Function(
        'storage',
        `${source.slice(start, end)}\nreturn { sanitizeFileName, sessionFileBase };`
    );
    const zh = build({ getPreferences: () => ({ uiLanguage: 'zh-CN' }) });
    const en = build({ getPreferences: () => ({ uiLanguage: 'en-US' }) });
    const createdAt = new Date(2026, 9, 18).getTime();

    assert.equal(zh.sessionFileBase({ title: '字节一面', profile: 'interview', createdAt }), '字节一面');
    assert.equal(zh.sessionFileBase({ title: '  ', profile: 'interview', createdAt }), '求职面试-2026-10-18');
    assert.equal(en.sessionFileBase({ title: null, profile: 'exam', createdAt }), 'Exam Assistant-2026-10-18');
    const unsafe = zh.sessionFileBase({ title: 'a/b:c*?"<>|d', createdAt });
    assert.doesNotMatch(unsafe, /[\\/:*?"<>|]/);
    assert.match(unsafe, /^a-b-c/);
    assert.equal(zh.sanitizeFileName('...'), 'session');
    assert.equal(zh.sessionFileBase({ title: null, profile: 'interview', createdAt }), '求职面试-2026-10-18');
});
