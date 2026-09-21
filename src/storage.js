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
    // A directory the user owns, holding one .md per knowledge entry. The model sees only the summaries;
    // the content is read on demand. Empty means the feature is off, and nothing else reads it — which
    // is why it is a preference the "restore defaults" action deliberately skips, like customPrompt.
    knowledgeDir: '',
    // Answer each question twice: a short speakable one in the transcript, and a fuller one in the side
    // pane that may consult the knowledge directory. A knob, not content, so restoring defaults does
    // reset it.
    detailMode: true,
    // Whether each chain lets the model think before answering. The model is a reasoning model
    // streaming a scratchpad this app never shows, so thinking is dead wait in front of the first
    // visible token — worth it in the detail pane, which is read in the gap between questions, and not
    // in the brief line that has to be read aloud right now. Knobs, so restoring defaults resets both.
    briefThinking: false,
    detailThinking: true,
    // The screenshot's own switch, deliberately not tied to detailThinking above. Its request is the one
    // that carries an image, and reasoning is spent before the first visible token, inside the client's
    // own request timeout — a whole problem statement plus a picture can spend that budget in the
    // scratchpad and come back as no answer at all. Off is the default for that reason.
    screenshotThinking: false,
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
    // How many earlier turns are replayed to the model. Each one is a question with whatever context
    // came with it, so this trades prompt size and latency against how much of the interview the model
    // can see. Both answer chains read the same number, and it is snapshotted at session start.
    chatContextTurns: 15,
    // The output cap on every request, reasoning included. On this endpoint a `thinking` request is
    // charged for its reasoning against the same budget, and a hard question can spend the whole of
    // it before emitting one visible token — which reaches the app as an empty answer. The endpoint
    // accepts up to 393216, so a high number here means the model stops on its own. Read per request.
    chatMaxTokens: 128000,
    // How much of the live split the detailed-answer pane takes, as a fraction rather than a pixel count
    // so that resizing the window keeps the proportion the user chose. Written by the divider between the
    // transcript and the pane when a drag ends. A fraction, so the value is inherently bounded by the
    // pane's own clamps; a stored one outside them is treated as absent, not clamped.
    detailPaneWidth: 0.38,
    // Written by the theme picker in Settings, which is why it lives here and not in config.json.
    theme: 'gruvbox',
};

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
                        detailCount: data.detailHistory?.length || 0,
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
