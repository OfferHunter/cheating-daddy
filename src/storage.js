const fs = require('fs');
const path = require('path');
const os = require('os');

const { CONFIG_VERSION, DEFAULT_CONFIG, DEFAULT_CREDENTIALS, DEFAULT_PREFERENCES, mergeDefaults } = require('./defaults');

// Legal range for DashScope's max_sentence_silence parameter.
const MAX_SENTENCE_SILENCE_RANGE = { min: 200, max: 6000 };

const MIC_GATE_RANGE = { min: -80, max: 0 };
const MIC_GATE_DWELL_RANGE = { min: 0, max: 2000 };
const CHAT_CONTEXT_TURNS_RANGE = { min: 1, max: 100 };
// Deliberately no upper bound: where the ceiling is depends on the endpoint, and one that rejects the
// value says so in a 400 the chat layer already knows how to retry past. The floor is real, though —
// reasoning is charged to this same budget, so a value a few hundred tokens large is spent before a
// single visible token is written, and the turn arrives empty for no reason the user can see.
const CHAT_MAX_TOKENS_FLOOR = 1024;

const DEFAULT_KEYBINDS = null; // null means use system defaults

// 进程内解析缓存，filePath -> 解析后的原始 JSON（未 merge）。config/preferences/credentials/keybinds 在每个回合、
// 每个视图里被反复读，每次都 readFileSync + JSON.parse 是纯浪费。缓存只省掉重复读：写入一律使其失效，磁盘始终
// 是唯一真相。这些文件只有本进程写（license.json 走 writeJsonFile 但由 license 自己读），不会出现外部改动。
const jsonCache = new Map();
// history 目录的摘要列表（getAllSessions）。任何会话写入/删除都作废它，下一次调用重建。
let sessionsSummaryCache = null;

// Get the config directory path based on OS
function getConfigDir() {
    const platform = os.platform();
    let configDir;

    if (platform === 'win32') {
        configDir = path.join(os.homedir(), 'AppData', 'Roaming', 'offer-hunter-config');
    } else if (platform === 'darwin') {
        configDir = path.join(os.homedir(), 'Library', 'Application Support', 'offer-hunter-config');
    } else {
        configDir = path.join(os.homedir(), '.config', 'offer-hunter-config');
    }

    return configDir;
}

// File paths
function getConfigPath() {
    return path.join(getConfigDir(), 'config.json');
}

function getCredentialsPath() {
    return path.join(getConfigDir(), 'credentials.json');
}

function getPreferencesPath() {
    return path.join(getConfigDir(), 'preferences.json');
}

function getKeybindsPath() {
    return path.join(getConfigDir(), 'keybinds.json');
}

function getHistoryDir() {
    return path.join(getConfigDir(), 'history');
}

// Helper to read JSON file safely. Parsed results are memoized in jsonCache (see declaration above); a
// parse error returns the fallback without caching, so a file fixed on disk is picked up next call.
function readJsonFile(filePath, defaultValue) {
    if (jsonCache.has(filePath)) {
        return jsonCache.get(filePath);
    }
    let value = defaultValue;
    try {
        if (fs.existsSync(filePath)) {
            value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (error) {
        console.warn(`Error reading ${filePath}:`, error.message);
        return defaultValue;
    }
    jsonCache.set(filePath, value);
    return value;
}

// Helper to write JSON file safely. Writes to a sibling temp file and renames it into place: a crash
// or power loss mid-write then leaves the old file intact instead of a truncated one, and every file
// here (config, credentials, preferences, sessions, license) is read back on the next launch.
function writeJsonFile(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const tempPath = `${filePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tempPath, filePath);
        // 写成功后直接以写入值为准刷新缓存，省掉下次读回来的一次 disk 读。getX() 拿到的仍是 merge 出的新对象，
        // 这里缓存的原始值不会被调用方就地改动。
        jsonCache.set(filePath, data);
        return true;
    } catch (error) {
        console.error(`Error writing ${filePath}:`, error.message);
        return false;
    }
}

// Check if we need to reset (no configVersion or wrong version)
function needsReset() {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
        return true;
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return !config.configVersion || config.configVersion !== CONFIG_VERSION;
    } catch {
        return true;
    }
}

// Reinitialize the config files with defaults. Deliberately does not remove the directory: history/
// and license.json live beside these files, and a corrupt config.json used to trigger a full wipe that
// took both of them with it.
function resetConfigFiles() {
    console.log('Initializing config with defaults...');

    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.mkdirSync(getHistoryDir(), { recursive: true });

    writeJsonFile(getConfigPath(), DEFAULT_CONFIG);
    writeJsonFile(getCredentialsPath(), DEFAULT_CREDENTIALS);
    writeJsonFile(getPreferencesPath(), DEFAULT_PREFERENCES);
}

// Initialize storage - call this on app startup
function initializeStorage() {
    if (needsReset()) {
        resetConfigFiles();
    } else {
        // Ensure history directory exists
        const historyDir = getHistoryDir();
        if (!fs.existsSync(historyDir)) {
            fs.mkdirSync(historyDir, { recursive: true });
        }
    }
}

// ============ CONFIG ============

function getConfig() {
    const saved = readJsonFile(getConfigPath(), {});
    return mergeDefaults(DEFAULT_CONFIG, saved);
}

function setConfig(config) {
    const current = getConfig();
    const updated = { ...current, ...config, configVersion: CONFIG_VERSION };
    return writeJsonFile(getConfigPath(), updated);
}

function updateConfig(key, value) {
    const config = getConfig();
    config[key] = value;
    return writeJsonFile(getConfigPath(), config);
}

// ============ CREDENTIALS ============

function getCredentials() {
    return mergeDefaults(DEFAULT_CREDENTIALS, readJsonFile(getCredentialsPath(), {}));
}

function setCredentials(credentials) {
    const current = getCredentials();
    const updated = { ...current, ...credentials };
    return writeJsonFile(getCredentialsPath(), updated);
}

function getDeepseekApiKey() {
    return getCredentials().deepseekApiKey || '';
}

function setDeepseekApiKey(deepseekApiKey) {
    return setCredentials({ deepseekApiKey });
}

function getBailianApiKey() {
    return getCredentials().bailianApiKey || '';
}

function setBailianApiKey(bailianApiKey) {
    return setCredentials({ bailianApiKey });
}

// ============ PREFERENCES ============

function getPreferences() {
    const saved = readJsonFile(getPreferencesPath(), {});
    return mergeDefaults(DEFAULT_PREFERENCES, saved);
}

function setPreferences(preferences) {
    const current = getPreferences();
    const updated = { ...current, ...preferences };
    return writeJsonFile(getPreferencesPath(), updated);
}

function updatePreference(key, value) {
    const preferences = getPreferences();
    preferences[key] = value;
    return writeJsonFile(getPreferencesPath(), preferences);
}

// Clamped on read so a hand-edited preferences file cannot push the ASR server outside its legal
// range. Consumers derive their own timeouts from this, so it stays the single source of truth.
function getMaxSentenceSilenceMs() {
    const value = Number(getPreferences().maxSentenceSilenceMs);
    const resolved = Number.isFinite(value) ? value : DEFAULT_PREFERENCES.maxSentenceSilenceMs;
    return Math.min(MAX_SENTENCE_SILENCE_RANGE.max, Math.max(MAX_SENTENCE_SILENCE_RANGE.min, resolved));
}

function getMicMaxSentenceSilenceMs() {
    const value = Number(getPreferences().micMaxSentenceSilenceMs);
    const resolved = Number.isFinite(value) ? value : DEFAULT_PREFERENCES.micMaxSentenceSilenceMs;
    return Math.min(MAX_SENTENCE_SILENCE_RANGE.max, Math.max(MAX_SENTENCE_SILENCE_RANGE.min, resolved));
}

function getMicGateDb() {
    const value = Number(getPreferences().micGateDb);
    const resolved = Number.isFinite(value) ? value : DEFAULT_PREFERENCES.micGateDb;
    return Math.min(MIC_GATE_RANGE.max, Math.max(MIC_GATE_RANGE.min, resolved));
}

function getMicGateDwellMs() {
    const value = Number(getPreferences().micGateDwellMs);
    const resolved = Number.isFinite(value) ? value : DEFAULT_PREFERENCES.micGateDwellMs;
    return Math.min(MIC_GATE_DWELL_RANGE.max, Math.max(MIC_GATE_DWELL_RANGE.min, resolved));
}

// Clamped on read for a sharper reason than the timeouts above: the pipeline cuts the history with
// slice(-n), and slice(-0) is slice(0) — a hand-edited 0 would replay *every* turn ever recorded
// instead of none.
function getChatContextTurns() {
    const value = Number(getPreferences().chatContextTurns);
    const resolved = Number.isFinite(value) ? value : DEFAULT_PREFERENCES.chatContextTurns;
    return Math.min(CHAT_CONTEXT_TURNS_RANGE.max, Math.max(CHAT_CONTEXT_TURNS_RANGE.min, Math.round(resolved)));
}

function getChatMaxTokens() {
    const value = Number(getPreferences().chatMaxTokens);
    const resolved = Number.isFinite(value) ? value : DEFAULT_PREFERENCES.chatMaxTokens;
    return Math.max(CHAT_MAX_TOKENS_FLOOR, Math.round(resolved));
}

// ============ KEYBINDS ============

function getKeybinds() {
    return readJsonFile(getKeybindsPath(), DEFAULT_KEYBINDS);
}

function setKeybinds(keybinds) {
    return writeJsonFile(getKeybindsPath(), keybinds);
}

// ============ HISTORY ============

function getSessionPath(sessionId) {
    return path.join(getHistoryDir(), `${sessionId}.json`);
}

function saveSession(sessionId, data) {
    const sessionPath = getSessionPath(sessionId);

    // Load existing session to preserve metadata
    const existingSession = readJsonFile(sessionPath, null);

    const sessionData = {
        sessionId,
        createdAt: existingSession?.createdAt || parseInt(sessionId),
        lastUpdated: Date.now(),
        // Profile context - set once when session starts
        profile: data.profile || existingSession?.profile || null,
        customPrompt: data.customPrompt || existingSession?.customPrompt || null,
        // Conversation data
        conversationHistory: data.conversationHistory || existingSession?.conversationHistory || [],
        detailHistory: data.detailHistory || existingSession?.detailHistory || [],
        // Absent from every session recorded before the candidate's own speech was written out, so the
        // History page has to tolerate the key missing rather than expect an empty list.
        candidateHistory: data.candidateHistory || existingSession?.candidateHistory || [],
    };
    const written = writeJsonFile(sessionPath, sessionData);
    // 会话内容变了，history 摘要列表作废，下一次 getAllSessions 重建。
    if (written) sessionsSummaryCache = null;
    return written;
}

function getSession(sessionId) {
    return readJsonFile(getSessionPath(sessionId), null);
}

function getAllSessions() {
    // History 列表要读遍每个会话再拼 searchText，是最重的读路径。缓存整份摘要列表，任何会话写入/删除都作废它
    // （见 saveSession/deleteSession/deleteAllSessions/clearAllData）。返回的数组经 IPC 序列化给渲染端，内部无人就地改。
    if (sessionsSummaryCache) {
        return sessionsSummaryCache;
    }

    const historyDir = getHistoryDir();

    try {
        if (!fs.existsSync(historyDir)) {
            sessionsSummaryCache = [];
            return sessionsSummaryCache;
        }

        const files = fs
            .readdirSync(historyDir)
            .filter(f => f.endsWith('.json'))
            .sort((a, b) => {
                // Sort by timestamp descending (newest first)
                const tsA = parseInt(a.replace('.json', ''));
                const tsB = parseInt(b.replace('.json', ''));
                return tsB - tsA;
            });

        sessionsSummaryCache = files
            .map(file => {
                const sessionId = file.replace('.json', '');
                const data = readJsonFile(path.join(historyDir, file), null);
                if (data) {
                    const searchableValues = [];
                    const collectSearchableValues = value => {
                        if (typeof value === 'string') {
                            searchableValues.push(value);
                            return;
                        }
                        if (Array.isArray(value)) {
                            value.forEach(collectSearchableValues);
                            return;
                        }
                        if (value && typeof value === 'object') {
                            Object.values(value).forEach(collectSearchableValues);
                        }
                    };
                    collectSearchableValues(data.customPrompt);
                    collectSearchableValues(data.conversationHistory);
                    collectSearchableValues(data.detailHistory);
                    collectSearchableValues(data.candidateHistory);

                    return {
                        sessionId,
                        createdAt: data.createdAt,
                        lastUpdated: data.lastUpdated,
                        messageCount: data.conversationHistory?.length || 0,
                        detailCount: data.detailHistory?.length || 0,
                        profile: data.profile || null,
                        customPrompt: data.customPrompt || null,
                        searchText: searchableValues.join('\n'),
                    };
                }
                return null;
            })
            .filter(Boolean);
        return sessionsSummaryCache;
    } catch (error) {
        console.error('Error reading sessions:', error.message);
        return [];
    }
}

function deleteSession(sessionId) {
    const sessionPath = getSessionPath(sessionId);
    try {
        if (fs.existsSync(sessionPath)) {
            fs.unlinkSync(sessionPath);
            jsonCache.delete(sessionPath);
            sessionsSummaryCache = null;
            return true;
        }
    } catch (error) {
        console.error('Error deleting session:', error.message);
    }
    return false;
}

function deleteAllSessions() {
    const historyDir = getHistoryDir();
    try {
        if (fs.existsSync(historyDir)) {
            const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
            files.forEach(file => {
                const fullPath = path.join(historyDir, file);
                fs.unlinkSync(fullPath);
                jsonCache.delete(fullPath);
            });
        }
        sessionsSummaryCache = null;
        return true;
    } catch (error) {
        console.error('Error deleting all sessions:', error.message);
        return false;
    }
}

// ============ CLEAR ALL DATA ============

// Wipe the user's own data: history, credentials, preferences and keybinds, with the config reset to
// defaults. license.json is deliberately left in place — the activation is a purchased, machine-bound
// license rather than user data, and removing it would force a needless re-activation.
function clearAllData() {
    const historyDir = getHistoryDir();
    try {
        if (fs.existsSync(historyDir)) {
            for (const file of fs.readdirSync(historyDir).filter(name => name.endsWith('.json'))) {
                const fullPath = path.join(historyDir, file);
                fs.unlinkSync(fullPath);
                jsonCache.delete(fullPath);
            }
        }
    } catch (error) {
        console.error('Error clearing history:', error.message);
    }
    sessionsSummaryCache = null;

    writeJsonFile(getConfigPath(), DEFAULT_CONFIG);
    writeJsonFile(getCredentialsPath(), DEFAULT_CREDENTIALS);
    writeJsonFile(getPreferencesPath(), DEFAULT_PREFERENCES);
    if (fs.existsSync(getKeybindsPath())) {
        fs.unlinkSync(getKeybindsPath());
    }
    // keybinds.json 是直接删的（不经过 writeJsonFile），缓存里可能还留着旧值，单独摘掉。
    jsonCache.delete(getKeybindsPath());

    return true;
}

module.exports = {
    // Initialization
    initializeStorage,
    getConfigDir,
    writeJsonFile,

    // Config
    getConfig,
    setConfig,
    updateConfig,

    // Credentials
    getCredentials,
    setCredentials,
    getDeepseekApiKey,
    setDeepseekApiKey,
    getBailianApiKey,
    setBailianApiKey,

    // Preferences
    getPreferences,
    setPreferences,
    updatePreference,
    getMaxSentenceSilenceMs,
    getMicMaxSentenceSilenceMs,
    getMicGateDb,
    getMicGateDwellMs,
    getChatContextTurns,
    getChatMaxTokens,

    // Keybinds
    getKeybinds,
    setKeybinds,

    // History
    saveSession,
    getSession,
    getAllSessions,
    deleteSession,
    deleteAllSessions,

    // Clear all
    clearAllData,
};
