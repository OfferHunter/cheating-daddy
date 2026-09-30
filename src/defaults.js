const CONFIG_VERSION = 1;

// Default values
const DEFAULT_CONFIG = Object.freeze({
    configVersion: CONFIG_VERSION,
    onboarded: false,
    layout: 'normal',
    // The chat endpoint is any OpenAI-compatible API. The model and key names are historical.
    chatBaseUrl: 'https://api.deepseek.com',
    deepseekModel: 'deepseek-flash',
    bailianWsUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    bailianModel: 'fun-asr-realtime-2026-02-28',
});

const DEFAULT_CREDENTIALS = Object.freeze({
    deepseekApiKey: '',
    bailianApiKey: '',
});

// These are the maintainer's own tuned values, so a fresh install, a reset and a wiped config
// directory all come up ready to use instead of generic. The comments below each key explain what
// the value means, not why it is this one.
const DEFAULT_PREFERENCES = Object.freeze({
    uiLanguage: 'zh-CN',
    customPrompt: ``,
    // A directory the user owns, holding one .md per knowledge entry. The model sees only the summaries;
    // the content is read on demand. Empty means the feature is off, and nothing else reads it — which
    // is why it is a preference the "restore defaults" action deliberately skips, like customPrompt.
    knowledgeDir: '',
    // Answer each question twice: a short speakable one in the transcript, and a fuller one in the side
    // pane that may consult the knowledge directory. A knob, not content, so restoring defaults does
    // reset it.
    detailMode: true,
    // Text answers skip reasoning by default to reduce time to the first visible token.
    briefThinking: false,
    detailThinking: false,
    // Screenshot answers enable reasoning by default, independently of text answers.
    screenshotThinking: true,
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
});

// Saved values override defaults; false, zero and empty strings are intentional values.
function mergeDefaults(defaults, saved) {
    const overrides = Object.fromEntries(Object.entries(saved || {}).filter(([, value]) => value != null));
    return { ...defaults, ...overrides };
}

// Preserve user content and the independently managed split-pane layout on reset.
function getResetPreferences() {
    const { customPrompt, knowledgeDir, detailPaneWidth, ...settings } = DEFAULT_PREFERENCES;
    return settings;
}

module.exports = { CONFIG_VERSION, DEFAULT_CONFIG, DEFAULT_CREDENTIALS, DEFAULT_PREFERENCES, mergeDefaults, getResetPreferences };
