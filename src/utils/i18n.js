import { css, LitElement } from '../assets/lit-core-2.7.4.min.js';

export const UI_LANGUAGE_EVENT = 'offer-hunter-ui-language-change';

const { DEFAULT_PREFERENCES } = window.require('./defaults');
let uiLanguage = DEFAULT_PREFERENCES.uiLanguage;

const zh = {
    'offer hunter': '海王AI面试助手',
    Home: '主页',
    History: '历史记录',
    Settings: '设置',
    Help: '帮助',
    'Help & Support': '帮助和支持',
    Feedback: '反馈',
    Customize: '自定义',
    'AI Settings': 'AI 设置',
    'AI Customization': 'AI 自定义',
    'AI Context': 'AI 上下文',
    'New Session': '新建会话',
    'Start Session': '开始会话',
    'End Session': '结束会话',
    'Clear context': '清除上下文',
    'Toggle pause': '暂停或继续',
    'Hide window': '隐藏窗口',
    'Quit application': '退出应用',
    'Search conversation content...': '搜索对话内容…',
    'Loading sessions...': '正在加载会话…',
    'No matching sessions.': '没有匹配的会话。',
    'Session Detail': '会话详情',
    'No conversation data.': '暂无会话数据。',
    'Brief answer': '简短回答',
    'Detailed answer': '详细回答',
    'Select all': '全选',
    'Deselect all': '取消全选',
    Clear: '清除',
    'Export JSON': '导出 JSON',
    Delete: '删除',
    Cancel: '取消',
    Context: '上下文',
    Prompt: '提示词',
    Profile: '配置',
    Language: '语言',
    'Interface Language': '界面语言',
    'Speech Language': '语音语言',
    Chinese: '中文',
    English: '英文',
    'English (US)': '英语（美国）',
    'English (UK)': '英语（英国）',
    'English (Australia)': '英语（澳大利亚）',
    'English (India)': '英语（印度）',
    'German (Germany)': '德语（德国）',
    'Spanish (US)': '西班牙语（美国）',
    'Spanish (Spain)': '西班牙语（西班牙）',
    'French (France)': '法语（法国）',
    'French (Canada)': '法语（加拿大）',
    'Hindi (India)': '印地语（印度）',
    'Portuguese (Brazil)': '葡萄牙语（巴西）',
    'Arabic (Generic)': '阿拉伯语',
    'Indonesian (Indonesia)': '印度尼西亚语',
    'Italian (Italy)': '意大利语',
    'Japanese (Japan)': '日语',
    'Turkish (Turkey)': '土耳其语',
    'Vietnamese (Vietnam)': '越南语',
    'Bengali (India)': '孟加拉语',
    'Gujarati (India)': '古吉拉特语',
    'Kannada (India)': '卡纳达语',
    'Malayalam (India)': '马拉雅拉姆语',
    'Marathi (India)': '马拉地语',
    'Tamil (India)': '泰米尔语',
    'Telugu (India)': '泰卢固语',
    'Dutch (Netherlands)': '荷兰语',
    'Korean (South Korea)': '韩语',
    'Mandarin Chinese (China)': '普通话（中国）',
    'Polish (Poland)': '波兰语',
    'Russian (Russia)': '俄语',
    'Thai (Thailand)': '泰语',
    Answers: '回答',
    Appearance: '外观',
    Theme: '主题',
    Dark: '深色',
    Light: '浅色',
    'Midnight Blue': '午夜蓝',
    Sepia: '复古棕',
    'Catppuccin Mocha': 'Catppuccin 摩卡',
    'Gruvbox Dark': 'Gruvbox 深色',
    'Rosé Pine': 'Rosé Pine',
    'Solarized Dark': 'Solarized 深色',
    'Tokyo Night': '东京夜',
    'Audio Input': '音频输入',
    'Speaker (interviewer)': '扬声器（面试官）',
    'Microphone (Me)': '麦克风（我）',
    "Don't use Microphone": '不使用麦克风',
    'System default': '系统默认',
    Microphone: '麦克风',
    'Image Quality': '图像质量',
    'High Quality': '高质量',
    'Medium Quality': '中等质量',
    'Low Quality': '低质量',
    'Sentence Silence (ms)': '语句静音时长（毫秒）',
    'My Sentence Silence (ms)': '我的语句静音时长（毫秒）',
    'Speaker Gate (dBFS)': '扬声器门限（dBFS）',
    'Speaker Gate Hold (ms)': '扬声器门限保持（毫秒）',
    'Speaker audio always follows the Windows default playback device. A microphone here adds your own voice as a second, right-hand column: it never triggers an answer on its own, it only tells the assistant what you have already said.':
        '扬声器音频始终使用 Windows 默认播放设备。启用麦克风后，你的声音会显示在右侧栏；它不会单独触发回答，只用于告诉助手你已经说过什么。',
    'How much silence ends a question and sends it. Lower is faster but may split it. 200-6000.':
        '一段静音持续多久后结束并发送问题。数值越低响应越快，但可能拆分句子。范围 200–6000。',
    'The same wait for your own microphone, and usually worth keeping longer: stumbling over a word splits one answer into several fragments on screen. Only affects your column. 200-6000. Takes effect on the next session.':
        '麦克风使用的静音等待时间，通常建议稍长；说话停顿可能把一条回答拆成多个片段。仅影响你的内容。范围 200–6000，下次会话生效。',
    "While the speaker is louder than this the microphone is ignored, so the interviewer's voice cannot leak into your column. Higher (closer to 0) gates more aggressively; -80 effectively turns it off.":
        '扬声器音量高于此值时忽略麦克风，防止面试官声音混入你的内容。数值越接近 0，抑制越强；-80 相当于关闭。',
    'How long the speaker level must stay on one side of the threshold before the microphone is muted or unmuted. Higher is steadier and less choppy but slower to react. 0-2000. The microphone is also muted while the speaker is still mid-sentence, whatever the level does.':
        '扬声器音量持续越过门限多久后才静音或恢复麦克风。数值越高越稳定，但反应更慢。范围 0–2000；扬声器仍在一句话中时也会保持麦克风静音。',
    'Detailed side answer': '显示详细回答侧栏',
    'Answer each question twice: a short line for the transcript, and a longer one in the side pane that may consult the knowledge folder. Takes effect on the next session.':
        '每个问题生成两份回答：转录区显示简短回答，侧栏显示可查阅知识库的详细回答。下次会话生效。',
    'Thinking in the fast reply': '简短回答启用思考',
    'Thinking in the detailed reply': '详细回答启用思考',
    'Thinking in the screenshot reply': '截图回答启用思考',
    'Thinking before answering trades a second of wait for a better answer. Leave it off in the fast reply, which is read out the moment it appears, and on in the detailed one, which is read in the gap afterwards. The screenshot reply has its own switch because it is the one request carrying an image, and its thinking is spent inside the request timeout — a screenshot of a whole problem statement can run out the clock and come back empty. Takes effect on the next session.':
        '回答前思考会增加少量等待，但通常能提高质量。建议简短回答关闭、详细回答开启。截图回答单独控制，因为图片请求的思考也占用超时时间；复杂截图可能在输出正文前就耗尽时间。下次会话生效。',
    'Context Turns': '上下文轮数',
    'How many previous turns are replayed to the model, in both the fast and the detailed answer. Higher keeps more of the interview in view but makes every request larger and slower. 1-100. Takes effect on the next session.':
        '简短和详细回答会向模型重放的历史轮数。数值越高，保留的面试内容越多，但请求更大、更慢。范围 1–100，下次会话生效。',
    'Max Tokens': '最大 Token 数',
    'The ceiling on a single reply, thinking included — a thinking reply is charged for its reasoning from this same number, and a hard question can spend all of a low one before writing anything, which arrives as an empty answer. Leave it high and the model stops on its own. Takes effect on the next turn.':
        '单次回答的 Token 上限，思考过程也计入其中。上限过低时，复杂问题可能在输出正文前耗尽额度，最终显示为空回答。建议保持较高数值，让模型自行停止。下一轮生效。',
    'Component Transparency': '控件透明度',
    'Panels, bubbles, inputs and borders. Lower means more of what is behind the window shows through.':
        '控制面板、气泡、输入框和边框的透明度。数值越低，窗口后方内容越清晰。',
    'Text Transparency': '文字透明度',
    'All text, including the answers in the live transcript. Independent of the panels.':
        '所有文字的透明度，包括实时转录中的回答；与面板透明度相互独立。',
    'Response Font Size': '回答字号',
    'Keyboard Shortcuts': '键盘快捷键',
    'Reset to defaults': '恢复默认快捷键',
    'Privacy and Data': '隐私与数据',
    'Restore all settings': '恢复全部设置',
    'Restoring...': '正在恢复…',
    'Delete all data': '删除全部数据',
    'Clearing...': '正在清除…',
    'All settings restored to defaults': '已恢复全部默认设置',
    'Successfully cleared all local data': '已清除全部本地数据',
    'Closing application...': '正在关闭应用…',
    'Press key combination...': '请按下快捷键组合…',
    'Listening to the interview...': '正在聆听面试…',
    Latest: '最新',
    Detailed: '详细回答',
    Reference: '参考资料',
    'Reference:': '参考资料：',
    'Answer cut off at the length limit': '回答因长度限制被截断',
    'Previous detailed answer': '上一条详细回答',
    'Next detailed answer': '下一条详细回答',
    'Jump to latest': '跳到最新',
    'Drag to resize the detailed answers': '拖动调整详细回答区域大小',
    'Type a message...': '输入消息…',
    'Analyze Screen': '分析屏幕',
    Start: '开始',
    Stop: '停止',
    Save: '保存',
    Saving: '正在保存',
    'Save Changes': '保存更改',
    'API Configuration': 'API 配置',
    'Custom Prompt': '自定义提示词',
    'Knowledge Folder': '知识库文件夹',
    Knowledge: '知识库',
    'Custom Instructions': '自定义指令',
    'Resume details, role requirements, constraints...': '简历信息、职位要求、约束条件…',
    'Sent as context at session start. Keep it short.': '会在会话开始时作为上下文发送，请尽量简短。',
    'No Knowledge Directories Selected': '尚未选择知识库目录',
    'Change folder': '更换目录',
    'Choose folder': '选择目录',
    Refresh: '刷新',
    Preview: '预览',
    Close: '关闭',
    'Show file': '显示文件',
    'Could not read the knowledge folder': '读取知识目录失败',
    'Could not select the folder': '选择目录失败',
    '(No summary)': '（无摘要）',
    'Loading…': '读取中…',
    Browse: '浏览',
    Remove: '移除',
    'Choose Folder': '选择文件夹',
    'Send Feedback': '发送反馈',
    'Report an issue or suggest an improvement.': '报告问题或提出改进建议。',
    Documentation: '使用文档',
    'Getting Started': '快速开始',
    'Keyboard shortcuts': '键盘快捷键',
    'Need help?': '需要帮助？',
    Support: '支持',
    Website: '网站',
    'Contact Us': '联系我们',
    'QQ Group: To be added': 'QQ群：待补充',
    'Frequently Asked Questions': '常见问题和解答',
    'How do I start a session?': '如何开始一次会话？',
    'Configure the chat and transcription API keys on the Home page, then click Start.': '在主页配置对话和语音转录 API 密钥，然后点击“开始”。',
    'Feedback Form': '反馈表单',
    'OpenAI-compatible chat with live transcription': '支持实时转录的 AI 对话助手',
    'Chat model': '对话模型',
    'Any OpenAI-compatible API': '任意 OpenAI 兼容接口',
    'API Base URL': 'API 基础地址',
    'Requests go to <base url>/chat/completions.': '请求将发送到 <基础地址>/chat/completions。',
    'API Key': 'API 密钥',
    Required: '必填',
    'Get API Key': '获取 API 密钥',
    Model: '模型',
    'Write the model name exactly as the endpoint expects it.': '请填写接口所要求的准确模型名称。',
    Transcription: '语音转录',
    'Aliyun Bailian streaming': '阿里云百炼实时转录',
    'Bailian API Key': '百炼 API 密钥',
    'WebSocket URL': 'WebSocket 地址',
    'Use the wss:// API Host for the same region and workspace as the API Key and model.':
        '请填写与 API 密钥及模型属于同一地域和业务空间的 wss:// API Host。',
    'WebSocket Documentation': 'WebSocket 文档',
    'Bailian Model': '百炼模型',
    'Speech is streamed live to Aliyun and transcribed as you talk.': '语音会实时传输至阿里云，并在你说话时同步转录。',
    'Speech Model Marketplace': '语音识别模型广场',
    Interview: '面试',
    'Add context': '添加上下文',
    'Resume, job description, notes...': '简历、职位描述、备注…',
    'Get Started': '开始使用',
    Continue: '继续',
    Back: '返回',
    'Real-time AI that listens, watches, and helps during interviews, meetings, and exams.':
        '实时聆听、观察，并在面试、会议和考试中提供帮助的 AI 助手。',
    'Paste your resume or any info the AI should know. You can skip this and add it later.':
        '粘贴简历或其他需要 AI 了解的信息。也可以跳过，稍后再添加。',
    'Move Window Up': '窗口上移',
    'Move Window Down': '窗口下移',
    'Move Window Left': '窗口左移',
    'Move Window Right': '窗口右移',
    'Toggle Visibility': '显示或隐藏窗口',
    'Toggle Click-through': '切换鼠标穿透',
    'Ask Next Step': '询问下一步',
    'Scroll Response Up': '向上滚动回答',
    'Scroll Response Down': '向下滚动回答',
    'Previous Detailed Answer': '上一条详细回答',
    'Next Detailed Answer': '下一条详细回答',
    'Toggle Light/Dark Theme': '切换明暗主题',
    'Emergency Erase': '紧急清除',
    Quit: '退出',
    Pause: '暂停',
    Resume: '继续',
    'Update available': '有可用更新',
    'Connecting...': '正在连接…',
    'Listening...': '正在聆听…',
    'Reconnecting...': '正在重新连接…',
    'Reconnecting transcription...': '正在重新连接语音转录…',
    Paused: '已暂停',
    Live: '实时',
    'Generating response...': '正在生成回答…',
    'Analyzing image...': '正在分析图像…',
    'Message sent...': '消息已发送…',
    error: '错误',
    '[click through]': '［鼠标穿透］',
    Session: '会话',
    'Empty session': '空会话',
};

const en = Object.fromEntries(Object.entries(zh).map(([english, chinese]) => [chinese, english]));
const normalize = value => value.replace(/\s+/g, ' ').trim();
const normalizedZh = Object.fromEntries(Object.entries(zh).map(([english, chinese]) => [normalize(english), chinese]));
const normalizedEn = Object.fromEntries(Object.entries(en).map(([chinese, english]) => [normalize(chinese), english]));

export function getUiLanguage() {
    return uiLanguage;
}

export function isChinese() {
    return uiLanguage !== 'en-US';
}

export function t(english, chinese = zh[english]) {
    return isChinese() ? chinese || english : english;
}

export function setUiLanguage(language, { notify = true } = {}) {
    uiLanguage = language === 'en-US' ? 'en-US' : 'zh-CN';
    document.documentElement.lang = uiLanguage;
    document.title = t('offer hunter');
    if (notify) window.dispatchEvent(new CustomEvent(UI_LANGUAGE_EVENT, { detail: uiLanguage }));
}

function translateValue(value) {
    const map = isChinese() ? normalizedZh : normalizedEn;
    if (map[value]) return map[value];
    const trimmed = value.trim();
    const translated = map[normalize(trimmed)];
    if (!translated) return value;
    return value.replace(trimmed, translated);
}

export function localizeTree(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
        if (
            node.parentElement?.closest(
                'style, script, .message-body, .context-value, .preview, .entry-name, .entry-desc, .dir-path, [data-no-localize]'
            )
        ) {
            continue;
        }
        node.nodeValue = translateValue(node.nodeValue);
    }
    root.querySelectorAll('[placeholder], [title], [aria-label]').forEach(element => {
        for (const attribute of ['placeholder', 'title', 'aria-label']) {
            if (element.hasAttribute(attribute)) element.setAttribute(attribute, translateValue(element.getAttribute(attribute)));
        }
    });
}

const baseStyles = css`
    * {
        scrollbar-width: thin;
        scrollbar-color: var(--scrollbar-thumb, var(--border-strong)) transparent;
    }

    ::-webkit-scrollbar {
        width: 4px;
        height: 4px;
    }

    ::-webkit-scrollbar-track {
        background: transparent;
    }

    ::-webkit-scrollbar-thumb {
        background: var(--scrollbar-thumb, var(--border-strong));
        border-radius: 999px;
    }

    ::-webkit-scrollbar-thumb:hover {
        background: var(--scrollbar-thumb-hover, #444444);
    }
`;

export class LocalizedLitElement extends LitElement {
    static finalizeStyles(styles) {
        return super.finalizeStyles([baseStyles, styles]);
    }

    connectedCallback() {
        super.connectedCallback();
        this.__languageChanged = event => {
            this.uiLanguage = event.detail;
            this.requestUpdate();
        };
        window.addEventListener(UI_LANGUAGE_EVENT, this.__languageChanged);
    }

    disconnectedCallback() {
        window.removeEventListener(UI_LANGUAGE_EVENT, this.__languageChanged);
        super.disconnectedCallback();
    }

    updated() {
        localizeTree(this.renderRoot);
    }
}
