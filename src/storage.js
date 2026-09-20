const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_VERSION = 1;

// Default values
const DEFAULT_CONFIG = {
    configVersion: CONFIG_VERSION,
    onboarded: false,
    layout: 'normal',
    // The chat endpoint is any OpenAI-compatible API. The model and key names are historical.
    chatBaseUrl: 'https://api.deepseek.com',
    deepseekModel: 'deepseek-flash',
    bailianModel: 'paraformer-realtime-v2',
};

const DEFAULT_CREDENTIALS = {
    deepseekApiKey: '',
    bailianApiKey: '',
};

// These are the maintainer's own tuned values, so a fresh install, a reset and a wiped config
// directory all come up ready to use instead of generic. The comments below each key explain what
// the value means, not why it is this one.
const DEFAULT_PREFERENCES = {
    customPrompt: ``,
    // Mandarin's value in the language dropdown is 'cmn-CN', not 'zh-CN'.
    selectedLanguage: 'cmn-CN',
    selectedScreenshotInterval: '5',
    selectedImageQuality: 'medium',
    // 'none' captures no microphone at all; any other value is a deviceId from enumerateDevices()
    // ('default' and 'communications' are Chromium's own pseudo-devices for the system defaults).
    audioInputDeviceId: 'default',
    fontSize: 16,
    // Legacy key name: this is the component/panel alpha shown as "Component Transparency" in
    // Settings. Renaming it would silently reset the value of every existing preferences.json.
    backgroundTransparency: 0.48,
    textTransparency: 0.83,
    // How much silence ends a sentence on the ASR server. It is added to every turn's latency, so
    // it trades directly against the server splitting one question into fragments.
    maxSentenceSilenceMs: 1500,
    // The same knob for the microphone, and deliberately a larger one: the candidate stutters, so a
    // short silence would cut one answer into many fragments. Fragments are not charged per turn,
    // but each one is a bubble on screen, so a longer wait buys a calmer transcript.
    micMaxSentenceSilenceMs: 2000,
    // Speaker gate, in dBFS: while the loopback level is above this the microphone is muted, so the
    // interviewer's voice cannot leak into the candidate column. -80 is effectively digital silence,
    // which is how the gate is turned off.
    micGateDb: -45,
    // How long the loopback level must stay on one side of micGateDb before the gate flips. Without
    // it, jitter around the threshold chops the microphone on and off inside a single sentence.
    micGateDwellMs: 300,
    // Written by the theme picker in Settings, which is why it lives here and not in config.json.
    theme: 'gruvbox',
};

// Legal range for DashScope's max_sentence_silence parameter.
const MAX_SENTENCE_SILENCE_RANGE = { min: 200, max: 6000 };

const MIC_GATE_RANGE = { min: -80, max: 0 };
const MIC_GATE_DWELL_RANGE = { min: 0, max: 2000 };

const DEFAULT_KEYBINDS = null; // null means use system defaults

// Get the config directory path based on OS
function getConfigDir() {
    const platform = os.platform();
    let configDir;

    if (platform === 'win32') {
        configDir = path.join(os.homedir(), 'AppData', 'Roaming', 'cheating-daddy-config');
    } else if (platform === 'darwin') {
        configDir = path.join(os.homedir(), 'Library', 'Application Support', 'cheating-daddy-config');
    } else {
        configDir = path.join(os.homedir(), '.config', 'cheating-daddy-config');
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

// Helper to read JSON file safely
function readJsonFile(filePath, defaultValue) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.warn(`Error reading ${filePath}:`, error.message);
    }
    return defaultValue;
}

// Helper to write JSON file safely
function writeJsonFile(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
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

// Wipe and reinitialize the config directory
function resetConfigDir() {
    const configDir = getConfigDir();

    console.log('Resetting config directory...');

    // Remove existing directory if it exists
    if (fs.existsSync(configDir)) {
        fs.rmSync(configDir, { recursive: true, force: true });
    }

    // Create fresh directory structure
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(getHistoryDir(), { recursive: true });

    // Initialize with defaults
    writeJsonFile(getConfigPath(), DEFAULT_CONFIG);
    writeJsonFile(getCredentialsPath(), DEFAULT_CREDENTIALS);
    writeJsonFile(getPreferencesPath(), DEFAULT_PREFERENCES);

    console.log('Config directory initialized with defaults');
}

// Initialize storage - call this on app startup
function initializeStorage() {
    if (needsReset()) {
        resetConfigDir();
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
    return { ...DEFAULT_CONFIG, ...saved };
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
    return readJsonFile(getCredentialsPath(), DEFAULT_CREDENTIALS);
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
    return { ...DEFAULT_PREFERENCES, ...saved };
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
        screenAnalysisHistory: data.screenAnalysisHistory || existingSession?.screenAnalysisHistory || [],
    };
    return writeJsonFile(sessionPath, sessionData);
}

function getSession(sessionId) {
    return readJsonFile(getSessionPath(sessionId), null);
}

function getAllSessions() {
    const historyDir = getHistoryDir();

    try {
        if (!fs.existsSync(historyDir)) {
            return [];
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

        return files
            .map(file => {
                const sessionId = file.replace('.json', '');
                const data = readJsonFile(path.join(historyDir, file), null);
                if (data) {
                    return {
                        sessionId,
                        createdAt: data.createdAt,
                        lastUpdated: data.lastUpdated,
                        messageCount: data.conversationHistory?.length || 0,
                        screenAnalysisCount: data.screenAnalysisHistory?.length || 0,
                        profile: data.profile || null,
                        customPrompt: data.customPrompt || null,
                    };
                }
                return null;
            })
            .filter(Boolean);
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
                fs.unlinkSync(path.join(historyDir, file));
            });
        }
        return true;
    } catch (error) {
        console.error('Error deleting all sessions:', error.message);
        return false;
    }
}

// ============ CLEAR ALL DATA ============

function clearAllData() {
    resetConfigDir();
    return true;
}

module.exports = {
    // Initialization
    initializeStorage,
    getConfigDir,

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
