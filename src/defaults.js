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
    // 语音识别服务二选一：'bailian'（阿里云百炼）或 'tencent'（腾讯云）。两个都可以各自配好，
    // 会话只用选中的这一个——语言也各存各的，因为两家支持的语种不一样。
    asrProvider: 'bailian',
    // 百炼的语言提示（ISO-639-1）。下拉里给的是全集，模型不支持的语种由服务端报错。
    bailianLanguage: 'zh',
    // 腾讯云的识别引擎型号，它同时也决定语言/方言（16k_zh 中文通用、16k_en 英文…）。
    tencentEngineModel: '16k_zh',
    // 手机提词的局域网服务端口。被别的程序占用时启动会退到系统分配的临时端口,并把实际端口写回这里,这样
    // 手机上的地址能稳定下来。teleprompterToken 是配对一次后换来的长效令牌,首次运行生成后落盘。
    teleprompterPort: 8765,
    teleprompterToken: '',
});

const DEFAULT_CREDENTIALS = Object.freeze({
    deepseekApiKey: '',
    bailianApiKey: '',
    // 腾讯云签名鉴权要三件套：AppID（放 URL 路径）、SecretId（放 query）、SecretKey（算签名）。
    tencentAppId: '',
    tencentSecretId: '',
    tencentSecretKey: '',
});

// These are the maintainer's own tuned values, so a fresh install, a reset and a wiped config
// directory all come up ready to use instead of generic. The comments below each key explain what
// the value means, not why it is this one.
const DEFAULT_PREFERENCES = Object.freeze({
    uiLanguage: 'zh-CN',
    customPrompt: ``,
    // 用户对系统提示词各段的覆盖，键对应 prompts.js 的 DEFAULT_PROMPT_SEGMENTS，缺失的键用默认文案。
    // 空对象表示全部用默认。是内容而非开关，所以和 customPrompt 一样，「恢复默认」刻意跳过它。
    promptOverrides: {},
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
    // 截图到达时并发一个小请求，把图概括成一行文字，这行就是它在对话记录里显示的内容、也是它在之后每个提示词
    // 里唯一的痕迹（图本身不进上下文）。关闭后不再发这个请求，对话记录里只留「[屏幕截图]」，这一轮也不会被
    // 回放给模型；截图本身的作答（详细面板）不受影响。是开关而非内容，所以「恢复默认」会重置它。
    screenshotSummary: true,
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
    // 实时视图（会话界面）默认不可聚焦：Win 下 setFocusable(false) 即 WS_EX_NOACTIVATE，点面板上的按钮不会把
    // 焦点从背后的视频/会议窗口夺走。代价是实时视图收不到键盘输入（Type a message 打不了字）。做成开关是因为
    // 部分网站/会议软件会检测窗口聚焦率，那种场合要关掉、让窗口恢复可聚焦。是开关而非内容，「恢复默认」会重置。
    nonFocusableSession: true,
});

// Saved values override defaults; false, zero and empty strings are intentional values.
function mergeDefaults(defaults, saved) {
    const overrides = Object.fromEntries(Object.entries(saved || {}).filter(([, value]) => value != null));
    return { ...defaults, ...overrides };
}

// Preserve user content and the independently managed split-pane layout on reset.
function getResetPreferences() {
    const { customPrompt, promptOverrides, knowledgeDir, detailPaneWidth, ...settings } = DEFAULT_PREFERENCES;
    return settings;
}

// 把偏好落到某个对象上，`target[field] = prefs[key] ?? DEFAULT_PREFERENCES[key]`。这一行以前在四个视图里各抄了
// 一遍（构造函数初值、从存储加载、恢复默认），抄漏一个键就会在某个视图里静默用错默认值——#9/#10 就是这么来的。
// `keys` 显式列出要落地的键，不强加全部默认值，免得把 customPrompt、knowledgeDir 这些不属于该视图的字段也塞进来。
// 条目是 'field'（字段名与偏好键同名）或 ['prefKey', 'field']（两者不同名）。
function applyPreferences(target, prefs, keys) {
    for (const entry of keys) {
        const [prefKey, field] = typeof entry === 'string' ? [entry, entry] : entry;
        target[field] = prefs?.[prefKey] ?? DEFAULT_PREFERENCES[prefKey];
    }
    return target;
}

module.exports = {
    CONFIG_VERSION,
    DEFAULT_CONFIG,
    DEFAULT_CREDENTIALS,
    DEFAULT_PREFERENCES,
    mergeDefaults,
    getResetPreferences,
    applyPreferences,
};
